package com.peersflow.mobile.data.repos

import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.EventStream
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.Outbox
import com.peersflow.mobile.wire.ServerEvent
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.ServerStatusRepository
import com.peersflow.mobile.wire.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Connection state, server health, "last seen" and the outbox count, plus the outbox flush triggers:
 *  - every transition into ONLINE from any other state (and at start when already ONLINE) flushes, and the
 *    report is published on [lastFlush] so the UI can say "Mac is back, 2 tasks started";
 *  - the outbox growing while ONLINE (a transport hiccup queued a send) flushes too; that report is published
 *    only when it delivered something.
 */
class ServerStatusRepositoryImpl(
    private val events: EventStream,
    private val session: SessionStore,
    private val outbox: Outbox,
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::currentTimeMillis,
) : ServerStatusRepository {

    override val state: StateFlow<ConnectionState> = events.state

    private val _health = MutableStateFlow<ServerHealth?>(null)
    override val health: StateFlow<ServerHealth?> = _health.asStateFlow()

    private val _lastSeenAt = MutableStateFlow(session.lastSeenAt())
    override val lastSeenAt: StateFlow<Long?> = _lastSeenAt.asStateFlow()

    override val outboxCount: StateFlow<Int> =
        outbox.items.map { it.size }.stateIn(scope, SharingStarted.Eagerly, 0)

    private val _lastFlush = MutableStateFlow<FlushReport?>(null)

    /** Report of the latest reconnect flush (or of an online flush that delivered something). */
    val lastFlush: StateFlow<FlushReport?> = _lastFlush.asStateFlow()

    private var lastPersistedAt = 0L
    private val jobs = mutableListOf<Job>()

    @Synchronized
    fun start() {
        if (jobs.isNotEmpty()) return
        jobs += scope.launch {
            var previous: ConnectionState? = null
            events.state.collect { now ->
                if (now == ConnectionState.ONLINE && previous != ConnectionState.ONLINE) {
                    _lastFlush.value = outbox.flush()
                }
                previous = now
            }
        }
        jobs += scope.launch {
            var previousCount = -1
            outbox.items.collect { list ->
                val grew = previousCount >= 0 && list.size > previousCount
                previousCount = list.size
                if (grew && events.state.value == ConnectionState.ONLINE) {
                    scope.launch {
                        val report = outbox.flush()
                        if (report.sent + report.duplicates > 0) _lastFlush.value = report
                    }
                }
            }
        }
        jobs += scope.launch {
            events.events.collect { e ->
                when (e) {
                    is ServerEvent.Welcome -> _health.value = e.health
                    is ServerEvent.Health -> _health.value = e.health
                    else -> Unit
                }
                seen()
            }
        }
    }

    private fun seen() {
        val now = clock()
        _lastSeenAt.value = now
        if (now - lastPersistedAt >= PERSIST_EVERY_MS) {
            lastPersistedAt = now
            session.setLastSeenAt(now)
        }
    }

    private companion object {
        const val PERSIST_EVERY_MS = 30_000L
    }
}
