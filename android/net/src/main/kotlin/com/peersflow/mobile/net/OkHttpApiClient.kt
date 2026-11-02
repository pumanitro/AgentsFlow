package com.peersflow.mobile.net

import com.peersflow.mobile.wire.AnswerRequest
import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ApiErrorBody
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.FeedResponse
import com.peersflow.mobile.wire.MeResponse
import com.peersflow.mobile.wire.MessagesPage
import com.peersflow.mobile.wire.MobileNotification
import com.peersflow.mobile.wire.NotificationsResponse
import com.peersflow.mobile.wire.OkResponse
import com.peersflow.mobile.wire.PairRequest
import com.peersflow.mobile.wire.PairResponse
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.PeersResponse
import com.peersflow.mobile.wire.PinnedListResponse
import com.peersflow.mobile.wire.ReplyRequest
import com.peersflow.mobile.wire.ReplyResponse
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.SpawnConversationRequest
import com.peersflow.mobile.wire.SpawnConversationResponse
import com.peersflow.mobile.wire.SummariesResponse
import com.peersflow.mobile.wire.VocabularyResponse
import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import kotlin.coroutines.cancellation.CancellationException

/**
 * REST client for the desktop gateway (`/api/v1`, PLAN C2). Never throws: every failure becomes an [ApiResult.Err].
 *
 * - no HTTP answer at all (timeout, unknown host, TLS, reset) ⇒ `Err("transport", …, 0, transport = true)`
 * - non-2xx ⇒ the server's `ApiErrorBody` code, else `Err("http_<status>", body[:200], status)`
 * - 2xx that does not decode ⇒ `Err("decode", …, status)`
 */
class OkHttpApiClient(
    private val session: SessionStore,
    private val client: OkHttpClient,
    private val json: Json = WireJson,
    private val logger: NetLogger = NetLogger.NONE,
) : ApiClient {

    override suspend fun pair(baseUrl: String, req: PairRequest): ApiResult<PairResponse> {
        val url = Http.apiUrl(baseUrl, listOf("pair")) ?: return badUrl()
        return exchange(Http.post(url, json.encodeToString(PairRequest.serializer(), req), token = null), PairResponse.serializer()) { it }
    }

    override suspend fun ping(): ApiResult<Unit> = authed(GET, listOf("ping"), OkResponse.serializer()) { }

    override suspend fun me(): ApiResult<MeResponse> = authed(GET, listOf("me"), MeResponse.serializer()) { it }

    override suspend fun health(): ApiResult<ServerHealth> = authed(GET, listOf("health"), ServerHealth.serializer()) { it }

    override suspend fun peers(): ApiResult<List<PeerSummary>> =
        authed(GET, listOf("peers"), PeersResponse.serializer()) { it.peers }

    override suspend fun conversations(filter: String?, peerId: String?): ApiResult<List<ConversationSummary>> =
        authed(GET, listOf("conversations"), SummariesResponse.serializer(), query = listOf("filter" to filter, "peer" to peerId)) {
            it.summaries
        }

    override suspend fun conversation(id: String): ApiResult<ConversationDetail> =
        authed(GET, listOf("conversations", id), ConversationDetail.serializer()) { it }

    override suspend fun messages(id: String, before: Long?, limit: Int): ApiResult<MessagesPage> =
        authed(
            GET, listOf("conversations", id, "messages"), MessagesPage.serializer(),
            query = listOf("before" to before?.toString(), "limit" to limit.toString()),
        ) { it }

    override suspend fun reply(id: String, req: ReplyRequest): ApiResult<ReplyResponse> =
        authed(POST, listOf("conversations", id, "reply"), ReplyResponse.serializer(), body = json.encodeToString(ReplyRequest.serializer(), req)) { it }

    override suspend fun answer(id: String, req: AnswerRequest): ApiResult<ReplyResponse> =
        authed(POST, listOf("conversations", id, "answer"), ReplyResponse.serializer(), body = json.encodeToString(AnswerRequest.serializer(), req)) { it }

    override suspend fun stop(id: String): ApiResult<Unit> = postUnit(listOf("conversations", id, "stop"))

    override suspend fun done(id: String): ApiResult<Unit> = postUnit(listOf("conversations", id, "done"))

    override suspend fun reopen(id: String): ApiResult<Unit> = postUnit(listOf("conversations", id, "reopen"))

    override suspend fun spawn(req: SpawnConversationRequest): ApiResult<SpawnConversationResponse> =
        authed(
            POST, listOf("conversations"), SpawnConversationResponse.serializer(),
            body = json.encodeToString(SpawnConversationRequest.serializer(), req),
        ) { it }

    override suspend fun outcomes(afterSeq: Long): ApiResult<List<FeedItem>> =
        authed(GET, listOf("outcomes"), FeedResponse.serializer(), query = listOf("after" to afterSeq.toString())) { it.items }

    override suspend fun voiceKey(): ApiResult<String?> =
        authed(GET, listOf("voice-key"), com.peersflow.mobile.wire.VoiceKeyResponse.serializer()) { it.sttKey }

    override suspend fun pinned(): ApiResult<PinnedListResponse> =
        authed(GET, listOf("pinned"), PinnedListResponse.serializer()) { it }

    override suspend fun vocabulary(): ApiResult<VocabularyResponse> =
        authed(GET, listOf("vocabulary"), VocabularyResponse.serializer()) { it }

    override suspend fun notifications(): ApiResult<List<MobileNotification>> =
        authed(GET, listOf("notifications"), NotificationsResponse.serializer()) { it.notifications }

    override suspend fun dismissNotification(id: String): ApiResult<Unit> = postUnit(listOf("notifications", id, "dismiss"))

    /**
     * TCP connect to the gateway's host:port (3 s), then `GET /ping` with the bearer.
     * TCP failure ⇒ MAC_OFF (in dev mode on the emulator this also covers "app down", see [Reachability]).
     */
    override suspend fun probe(): ConnectionState {
        val s = session.session.value ?: return ConnectionState.UNPAIRED
        val (host, port) = try {
            Reachability.hostPort(s.baseUrl)
        } catch (_: IllegalArgumentException) {
            return ConnectionState.APP_DOWN
        }
        val open = withContext(Dispatchers.IO) { Reachability.tcpOpen(host, port, PROBE_TCP_TIMEOUT_MS) }
        if (!open) return ConnectionState.MAC_OFF
        return when (val r = ping()) {
            is ApiResult.Ok -> ConnectionState.ONLINE
            is ApiResult.Err -> when {
                r.status == 503 && r.code == "paused" -> ConnectionState.PAUSED
                r.status == 401 || r.status == 403 -> ConnectionState.UNAUTHORIZED
                else -> ConnectionState.APP_DOWN
            }
        }
    }

    // ---- plumbing ----

    private suspend fun postUnit(path: List<String>): ApiResult<Unit> =
        authed(POST, path, OkResponse.serializer(), body = "{}") { }

    private suspend fun <T, R> authed(
        method: String,
        path: List<String>,
        serializer: KSerializer<T>,
        query: List<Pair<String, String?>> = emptyList(),
        body: String? = null,
        map: (T) -> R,
    ): ApiResult<R> {
        val s = session.session.value ?: return ApiResult.Err("unauthorized", "not paired", 0)
        val url = Http.apiUrl(s.baseUrl, path, query) ?: return badUrl()
        val request = if (method == POST) Http.post(url, body ?: "{}", s.token) else Http.get(url, s.token)
        return exchange(request, serializer, map)
    }

    private suspend fun <T, R> exchange(request: Request, serializer: KSerializer<T>, map: (T) -> R): ApiResult<R> {
        val started = System.nanoTime()
        val raw = try {
            Http.await(client.newCall(request))
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            logger.w("${request.method} ${request.url.encodedPath} transport failure: ${e.javaClass.simpleName}")
            return ApiResult.Err("transport", e.message ?: e.javaClass.simpleName, 0, transport = true)
        } catch (e: Exception) {
            logger.w("${request.method} ${request.url.encodedPath} failed", e)
            return ApiResult.Err("transport", e.message ?: e.javaClass.simpleName, 0, transport = true)
        }
        val ms = (System.nanoTime() - started) / 1_000_000
        logger.d("${request.method} ${request.url.encodedPath} -> ${raw.status} in ${ms}ms")
        if (raw.status !in 200..299) return errorOf(raw)
        return try {
            val text = if (raw.body.isBlank() && serializer == OkResponse.serializer()) "{}" else raw.body
            ApiResult.Ok(map(json.decodeFromString(serializer, text)))
        } catch (e: Exception) {
            ApiResult.Err("decode", e.message ?: "undecodable body", raw.status)
        }
    }

    private fun errorOf(raw: Http.RawResponse): ApiResult.Err {
        val parsed = try {
            json.decodeFromString(ApiErrorBody.serializer(), raw.body)
        } catch (_: Exception) {
            null
        }
        return if (parsed != null) {
            ApiResult.Err(parsed.code, parsed.error, raw.status)
        } else {
            ApiResult.Err("http_${raw.status}", raw.body.take(200), raw.status)
        }
    }

    private fun badUrl(): ApiResult.Err = ApiResult.Err("bad_url", "the paired server URL is not a valid http(s) URL", 0)

    private companion object {
        const val GET = "GET"
        const val POST = "POST"
        const val PROBE_TCP_TIMEOUT_MS = 3_000
    }
}
