package com.peersflow.mobile.data.repos

import com.peersflow.mobile.data.db.DataDaos
import com.peersflow.mobile.data.db.Mappers
import com.peersflow.mobile.data.db.PeersFlowDb
import com.peersflow.mobile.data.logic.FeedReducer
import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.EventStream
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.OutcomesRepository
import com.peersflow.mobile.wire.ServerEvent
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import java.util.concurrent.atomic.AtomicLong

/**
 * Outcome / needs-you feed. Collects `events.events` itself for `Feed` (the conversation repo ignores them) and
 * replays everything newer than [latestSeq] on every `Welcome`. Items are stored once per seq, so a live event
 * and a replay of the same item never double up, and an item already seen stays seen.
 */
class OutcomesRepositoryImpl(
    private val daos: DataDaos,
    private val api: ApiClient,
    private val events: EventStream,
    private val session: SessionStore,
    private val scope: CoroutineScope,
    private val json: Json = WireJson,
    private val clock: () -> Long = System::currentTimeMillis,
) : OutcomesRepository {

    constructor(db: PeersFlowDb, api: ApiClient, events: EventStream, session: SessionStore, scope: CoroutineScope) :
        this(db.daos(), api, events, session, scope)

    /** Highest seq stored in the DB, cached so the non-suspend [latestSeq] does not hit the DB. */
    private val dbMaxSeq = AtomicLong(0L)
    private var collector: Job? = null

    @Synchronized
    fun start() {
        if (collector != null) return
        collector = scope.launch {
            dbMaxSeq.accumulateAndGet(daos.feed.maxSeq(), ::maxOf)
            events.events.collect { e ->
                runCatching {
                    when (e) {
                        is ServerEvent.Feed -> store(listOf(e.item))
                        is ServerEvent.Welcome -> scope.launch { replay() }
                        else -> Unit
                    }
                }
            }
        }
    }

    override fun feed(): Flow<List<FeedItem>> =
        daos.feed.observeAll().map { rows -> rows.mapNotNull { Mappers.feed(it, json) }.sortedByDescending { it.seq } }

    override fun unseenCount(): Flow<Int> = daos.feed.unseenCount()

    override suspend fun markSeen(uptoSeq: Long) = daos.feed.markSeenUpTo(uptoSeq, clock())

    override suspend fun replay(): Int {
        val r = api.outcomes(latestSeq()) as? ApiResult.Ok ?: return 0
        store(r.value)
        return r.value.size
    }

    override fun latestSeq(): Long = maxOf(dbMaxSeq.get(), session.lastSeq())

    private suspend fun store(items: List<FeedItem>) {
        if (items.isEmpty()) return
        daos.feed.insertNew(items.map { Mappers.feed(it, json) })
        val top = FeedReducer.maxSeq(items)
        dbMaxSeq.accumulateAndGet(top, ::maxOf)
        if (top > session.lastSeq()) session.setLastSeq(top)
    }
}
