package com.peersflow.mobile.data.repos

import com.peersflow.mobile.data.db.DataDaos
import com.peersflow.mobile.data.db.KvEntity
import com.peersflow.mobile.data.db.Mappers
import com.peersflow.mobile.data.db.PeersFlowDb
import com.peersflow.mobile.data.logic.PageState
import com.peersflow.mobile.data.logic.Paging
import com.peersflow.mobile.data.logic.SummaryReducer
import com.peersflow.mobile.wire.AnswerRequest
import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.EventStream
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.MessagesPage
import com.peersflow.mobile.wire.Outbox
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.ReplyRequest
import com.peersflow.mobile.wire.ReplyResponse
import com.peersflow.mobile.wire.SendResult
import com.peersflow.mobile.wire.ServerEvent
import com.peersflow.mobile.wire.ServerStatusRepository
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.SpawnConversationRequest
import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import java.util.UUID

/**
 * The local DB is the source of truth for every Flow, so offline the UI shows the last-known state.
 * Live events and REST answers only ever write to the DB.
 *
 * Feed events are NOT handled here: [OutcomesRepositoryImpl] collects `events.events` itself for `Feed`.
 *
 * Two constructors: the Room one (what the app calls) and one over [DataDaos], which JVM tests use with
 * in-memory DAO implementations.
 */
class ConversationRepositoryImpl(
    private val daos: DataDaos,
    private val api: ApiClient,
    private val events: EventStream,
    @Suppress("unused") private val session: SessionStore,
    private val outbox: Outbox,
    private val status: ServerStatusRepository,
    private val scope: CoroutineScope,
    private val json: Json = WireJson,
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) : ConversationRepository {

    // Strictly increasing queue stamps: two messages sent in the same millisecond keep the order they were typed in.
    private var lastStamp = 0L
    @Synchronized private fun nextStamp(): Long { val t = maxOf(clock(), lastStamp + 1); lastStamp = t; return t }

    constructor(
        db: PeersFlowDb, api: ApiClient, events: EventStream, session: SessionStore, outbox: Outbox,
        status: ServerStatusRepository, scope: CoroutineScope, json: Json = WireJson,
    ) : this(db.daos(), api, events, session, outbox, status, scope, json)

    private val _lastSpawnedId = MutableStateFlow<String?>(null)

    /** Conversation id of the most recent successful [startChat], for navigation. */
    val lastSpawnedId: StateFlow<String?> = _lastSpawnedId.asStateFlow()

    private var collector: Job? = null

    // ---- the desktop pinned list (cached in kv so it shows offline) ----
    private val pinned = kotlinx.coroutines.flow.MutableStateFlow<com.peersflow.mobile.wire.PinnedListResponse?>(null)
    private var pinnedJob: kotlinx.coroutines.Job? = null
    override fun pinnedList(): Flow<com.peersflow.mobile.wire.PinnedListResponse?> = pinned
    // Picks up a speech key set on the Mac after pairing, without re-pairing.
    private suspend fun syncVoiceKey() {
        val key = (api.voiceKey() as? ApiResult.Ok)?.value?.takeIf { it.isNotBlank() } ?: return
        val s = session.session.value ?: return
        if (s.sttKey != key) session.save(s.copy(sttKey = key))
    }

    private fun refreshPinnedSoon() {
        pinnedJob?.cancel()
        pinnedJob = scope.launch {
            kotlinx.coroutines.delay(300)   // coalesce event bursts
            val r = api.pinned() as? ApiResult.Ok ?: return@launch
            pinned.value = r.value
            runCatching { daos.kv.put(com.peersflow.mobile.data.db.KvEntity("pinned", json.encodeToString(com.peersflow.mobile.wire.PinnedListResponse.serializer(), r.value))) }
        }
    }

    /** Starts applying live events to the DB. Idempotent; call once (WP-30). */
    @Synchronized
    fun start() {
        if (collector != null) return
        scope.launch {
            if (pinned.value == null) runCatching {
                daos.kv.get("pinned")?.let { pinned.value = json.decodeFromString(com.peersflow.mobile.wire.PinnedListResponse.serializer(), it) }
            }
        }
        collector = scope.launch {
            events.events.collect { e -> runCatching { apply(e) } }
        }
    }

    private suspend fun apply(e: ServerEvent) {
        when (e) {
            is ServerEvent.ConversationsUpdated -> storeSummaries(e.summaries)
            is ServerEvent.ConversationUpdated -> daos.conversations.upsertAll(listOf(Mappers.conversation(e.summary, json)))
            is ServerEvent.ConversationDetailEvent -> storeDetail(e.detail)
            is ServerEvent.MessagesAppended -> {
                storeMessages(e.conversationId, e.entries)
                storeEnd(e.conversationId, e.end)
            }
            is ServerEvent.Welcome -> scope.launch { refresh() }
            else -> Unit
        }
        when (e) {
            is ServerEvent.Welcome -> { refreshPinnedSoon(); scope.launch { syncVoiceKey() } }
            is ServerEvent.ConversationsUpdated, is ServerEvent.ConversationUpdated -> refreshPinnedSoon()
            is ServerEvent.Unknown -> if (e.type == "pinned.updated") refreshPinnedSoon()
            else -> Unit
        }
    }

    // ---- reads (DB) ----

    override fun peers(): Flow<List<PeerSummary>> =
        daos.peers.observeAll().map { rows -> rows.mapNotNull { Mappers.peer(it, json) } }

    override fun summaries(): Flow<List<ConversationSummary>> =
        daos.conversations.observeAll().map { rows -> SummaryReducer.sort(rows.mapNotNull { Mappers.conversation(it, json) }) }

    override fun detail(id: String): Flow<ConversationDetail?> =
        daos.details.observe(id).map { row -> row?.let { Mappers.detail(it, json) } }

    override fun messages(id: String): Flow<List<MessageEntry>> =
        daos.messages.observe(id).map { rows -> rows.mapNotNull { Mappers.message(it, json) } }

    // ---- REST -> DB ----

    override suspend fun refresh(): Boolean {
        val peers = api.peers() as? ApiResult.Ok ?: return false
        val convs = api.conversations() as? ApiResult.Ok ?: return false
        daos.peers.replaceAll(peers.value.map { Mappers.peer(it, json) })
        storeSummaries(convs.value)
        refreshPinnedSoon()
        return true
    }

    override fun open(id: String) {
        events.subscribe(setOf(id))
        scope.launch {
            (api.conversation(id) as? ApiResult.Ok)?.let { storeDetail(it.value) }
            (api.messages(id, null, PAGE) as? ApiResult.Ok)?.let { storePage(id, it.value, isNewest = true) }
        }
    }

    override fun close(id: String) = events.unsubscribe(setOf(id))

    override suspend fun loadOlder(id: String): Boolean {
        val state = pageState(id)
        val before = Paging.nextBefore(state ?: PageState(null, true))
        val page = when {
            state == null -> api.messages(id, null, PAGE)     // never opened: load the newest page first
            before == null -> return false
            else -> api.messages(id, before, PAGE)
        }
        val ok = page as? ApiResult.Ok ?: return false
        storePage(id, ok.value, isNewest = state == null)
        return ok.value.hasMore
    }

    // ---- writes ----

    override suspend fun send(id: String, text: String, source: String): SendResult {
        val clientId = newId()
        val queued = OutboxItem(clientId, OutboxKind.REPLY, id, null, text, source, createdAt = nextStamp())
        if (!online()) return enqueue(queued)
        return replyResult(api.reply(id, ReplyRequest(text, source, clientId)), queued)
    }

    override suspend fun answer(id: String, questionId: String?, text: String, source: String): SendResult {
        val clientId = newId()
        // A queued answer loses its questionId (OutboxItem has no field for it); the server treats it as free text.
        val queued = OutboxItem(clientId, OutboxKind.ANSWER, id, null, text, source, createdAt = nextStamp())
        if (!online()) return enqueue(queued)
        return replyResult(api.answer(id, AnswerRequest(questionId, text, source, clientId)), queued)
    }

    override suspend fun stop(id: String): SendResult = action { api.stop(id) }
    override suspend fun done(id: String): SendResult = action { api.done(id) }
    override suspend fun reopen(id: String): SendResult = action { api.reopen(id) }

    override suspend fun startChat(peerId: String, prompt: String, kind: String, spokenAt: String?, source: String): SendResult {
        val clientId = newId()
        val queued = OutboxItem(clientId, OutboxKind.SPAWN, null, peerId, prompt, source, chatKind = kind, spokenAt = spokenAt, createdAt = nextStamp())
        if (!online()) return enqueue(queued)
        val req = SpawnConversationRequest(
            peerId = peerId, prompt = prompt, kind = kind, model = null,
            contract = if (kind == "voice") "until-done" else null,
            clientId = clientId, spokenAt = spokenAt, source = source,
        )
        return when (val r = api.spawn(req)) {
            is ApiResult.Ok -> {
                _lastSpawnedId.value = r.value.conversationId
                refresh()
                SendResult.Sent(null)
            }
            is ApiResult.Err -> if (r.transport) enqueue(queued) else SendResult.Failed(r.message)
        }
    }

    // ---- helpers ----

    private fun online() = status.state.value == ConnectionState.ONLINE

    private suspend fun enqueue(item: OutboxItem): SendResult {
        outbox.enqueue(item)
        return SendResult.Queued(item.id)
    }

    private suspend fun replyResult(r: ApiResult<ReplyResponse>, queued: OutboxItem): SendResult = when (r) {
        is ApiResult.Ok -> when {
            !r.value.ok -> SendResult.Failed(r.value.error ?: "not delivered")
            r.value.duplicate -> SendResult.Duplicate
            else -> SendResult.Sent(r.value.via)
        }
        is ApiResult.Err -> when {
            r.transport -> enqueue(queued)   // may have landed; the clientId makes the flush retry safe
            r.code == "conflict" -> SendResult.Failed(r.message, notRunning = true)
            else -> SendResult.Failed(r.message)
        }
    }

    private suspend fun action(call: suspend () -> ApiResult<Unit>): SendResult {
        if (!online()) return SendResult.Failed(OFFLINE)
        return when (val r = call()) {
            is ApiResult.Ok -> {
                refresh()
                SendResult.Sent(null)
            }
            is ApiResult.Err -> SendResult.Failed(r.message, notRunning = r.code == "conflict")
        }
    }

    private suspend fun storeSummaries(list: List<ConversationSummary>) =
        daos.conversations.replaceAll(SummaryReducer.full(emptyList(), list).map { Mappers.conversation(it, json) })

    private suspend fun storeDetail(d: ConversationDetail) {
        daos.details.upsert(Mappers.detail(d, json))
        daos.conversations.upsertAll(listOf(Mappers.conversation(d.summary, json)))
    }

    private suspend fun storeMessages(convId: String, entries: List<MessageEntry>) {
        if (entries.isNotEmpty()) daos.messages.upsertAll(entries.map { Mappers.message(convId, it, json) })
    }

    private suspend fun storeEnd(convId: String, end: Long) {
        val prev = daos.kv.get(Paging.endKey(convId))?.toLongOrNull()
        daos.kv.put(KvEntity(Paging.endKey(convId), Paging.nextEnd(prev, end).toString()))
    }

    private suspend fun storePage(convId: String, page: MessagesPage, isNewest: Boolean) {
        storeMessages(convId, page.entries)
        storeEnd(convId, page.end)
        val next = Paging.afterPage(pageState(convId), page.cursor, page.hasMore, isNewest)
        daos.kv.put(KvEntity(Paging.cursorKey(convId), next.cursor.toString()))
        daos.kv.put(KvEntity(Paging.hasMoreKey(convId), next.hasMore.toString()))
    }

    private suspend fun pageState(convId: String): PageState? {
        val cursor = daos.kv.get(Paging.cursorKey(convId))?.toLongOrNull() ?: return null
        val hasMore = daos.kv.get(Paging.hasMoreKey(convId))?.toBooleanStrictOrNull() ?: true
        return PageState(cursor, hasMore)
    }

    private companion object {
        const val PAGE = 50
        const val OFFLINE = "The Mac is not reachable right now"
    }
}
