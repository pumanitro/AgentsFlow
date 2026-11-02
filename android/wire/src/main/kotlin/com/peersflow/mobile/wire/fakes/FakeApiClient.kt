package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.AnswerRequest
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.MeResponse
import com.peersflow.mobile.wire.DeviceInfo
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.MessagesPage
import com.peersflow.mobile.wire.MobileNotification
import com.peersflow.mobile.wire.PairRequest
import com.peersflow.mobile.wire.PairResponse
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.ReplyRequest
import com.peersflow.mobile.wire.ReplyResponse
import com.peersflow.mobile.wire.Scopes
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.SpawnConversationRequest
import com.peersflow.mobile.wire.SpawnConversationResponse
import com.peersflow.mobile.wire.VocabularyResponse

/**
 * In-memory [com.peersflow.mobile.wire.ApiClient]. Tests mutate the public lists; [nextError] makes the next call fail once.
 * `pair` succeeds only for code [TEST_CODE] and returns token [TEST_TOKEN].
 */
class FakeApiClient(
    val peers: MutableList<PeerSummary> = mutableListOf(),
    val summaries: MutableList<ConversationSummary> = mutableListOf(),
    val details: MutableMap<String, ConversationDetail> = mutableMapOf(),
    val messages: MutableMap<String, MutableList<MessageEntry>> = mutableMapOf(),
    val feed: MutableList<FeedItem> = mutableListOf(),
    val notifications: MutableList<MobileNotification> = mutableListOf(),
    val vocabulary: MutableList<String> = mutableListOf(),
) : com.peersflow.mobile.wire.ApiClient {

    var nextError: ApiResult.Err? = null
    var health: ServerHealth = ServerHealth(hostname = "fake-mac", appVersion = "0.0.0", now = "1970-01-01T00:00:00Z")
    var probeState: ConnectionState = ConnectionState.ONLINE

    /** Every request body the fake received, newest last, so tests can assert what was sent. */
    val replies = mutableListOf<Pair<String, ReplyRequest>>()
    val answers = mutableListOf<Pair<String, AnswerRequest>>()
    val spawns = mutableListOf<SpawnConversationRequest>()
    val actions = mutableListOf<Pair<String, String>>()   // (action, conversationId): stop / done / reopen / dismiss

    private fun <T> answer(value: () -> T): ApiResult<T> {
        val err = nextError
        if (err != null) {
            nextError = null
            return err
        }
        return ApiResult.Ok(value())
    }

    override suspend fun pair(baseUrl: String, req: PairRequest): ApiResult<PairResponse> {
        val err = nextError
        if (err != null) {
            nextError = null
            return err
        }
        if (req.code != TEST_CODE) return ApiResult.Err("unauthorized", "pairing code rejected", 401)
        return ApiResult.Ok(
            PairResponse(
                token = TEST_TOKEN, deviceId = "fake-device", scopes = listOf(Scopes.VIEW, Scopes.TALK),
                serverName = health.hostname,
            ),
        )
    }

    override suspend fun ping(): ApiResult<Unit> = answer { }

    override suspend fun me(): ApiResult<MeResponse> = answer {
        MeResponse(
            device = DeviceInfo("fake-device", "Fake phone", listOf(Scopes.VIEW, Scopes.TALK), health.now, health.now),
            server = health,
        )
    }

    override suspend fun health(): ApiResult<ServerHealth> = answer { health }

    override suspend fun peers(): ApiResult<List<PeerSummary>> = answer { peers.toList() }

    override suspend fun conversations(filter: String?, peerId: String?): ApiResult<List<ConversationSummary>> = answer {
        summaries.filter { peerId == null || it.peerId == peerId }
    }

    override suspend fun conversation(id: String): ApiResult<ConversationDetail> {
        val detail = details[id] ?: summaries.firstOrNull { it.id == id }?.let { ConversationDetail(it) }
        if (detail == null && nextError == null) return ApiResult.Err("not_found", "no conversation $id", 404)
        return answer { detail!! }
    }

    override suspend fun messages(id: String, before: Long?, limit: Int): ApiResult<MessagesPage> = answer {
        val all = messages[id].orEmpty()
        val endIdx = before?.toInt()?.coerceIn(0, all.size) ?: all.size
        val startIdx = (endIdx - limit).coerceAtLeast(0)
        MessagesPage(all.subList(startIdx, endIdx).toList(), hasMore = startIdx > 0, cursor = startIdx.toLong(), end = all.size.toLong())
    }

    override suspend fun reply(id: String, req: ReplyRequest): ApiResult<ReplyResponse> = answer {
        replies += id to req
        ReplyResponse(ok = true, via = "open-chat")
    }

    override suspend fun answer(id: String, req: AnswerRequest): ApiResult<ReplyResponse> = answer {
        answers += id to req
        ReplyResponse(ok = true, via = "open-chat")
    }

    override suspend fun stop(id: String): ApiResult<Unit> = answer { actions += "stop" to id }

    override suspend fun done(id: String): ApiResult<Unit> = answer { actions += "done" to id }

    override suspend fun reopen(id: String): ApiResult<Unit> = answer { actions += "reopen" to id }

    override suspend fun spawn(req: SpawnConversationRequest): ApiResult<SpawnConversationResponse> = answer {
        spawns += req
        SpawnConversationResponse(conversationId = "fake-${spawns.size}")
    }

    override suspend fun outcomes(afterSeq: Long): ApiResult<List<FeedItem>> = answer { feed.filter { it.seq > afterSeq } }

    override suspend fun vocabulary(): ApiResult<VocabularyResponse> = answer { VocabularyResponse(vocabulary.toList(), health.now) }

    override suspend fun notifications(): ApiResult<List<MobileNotification>> = answer { notifications.toList() }

    override suspend fun dismissNotification(id: String): ApiResult<Unit> = answer {
        notifications.removeAll { it.id == id }
        actions += "dismiss" to id
    }

    override suspend fun probe(): ConnectionState = probeState

    companion object {
        const val TEST_CODE = "TEST-CODE"
        const val TEST_TOKEN = "t-test"
    }
}
