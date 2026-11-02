package com.peersflow.mobile.net

import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.EventCodec
import com.peersflow.mobile.wire.EventStream
import com.peersflow.mobile.wire.ServerEvent
import com.peersflow.mobile.wire.Session
import com.peersflow.mobile.wire.SessionStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicReference

/**
 * The `/api/v1/events` WebSocket (PLAN C1, §4.4) with a self-healing connect loop.
 *
 * - On open it sends `hello(lastSeq, subscriptions)`; the `welcome` frame flips [state] to ONLINE.
 * - When the socket drops it asks [ApiClient.probe] which state to show (APP_DOWN, MAC_OFF, PAUSED, UNAUTHORIZED)
 *   and waits [Backoff.next] before reconnecting. [kick] cuts that wait short.
 * - A 401/403 handshake (a revoked device) shows UNAUTHORIZED and does not retry on its own until [kick] or a new session.
 * - A session that goes null closes the socket and shows UNPAIRED; a replaced session reconnects at once.
 * - Keepalive: a `ping` every 25 s; no `pong` within 10 s closes the socket with code 4001 and the loop reconnects.
 *
 * The loop never ends on its own; only [stop] or cancelling [scope] ends it.
 */
class OkHttpEventStream(
    private val session: SessionStore,
    private val api: ApiClient,
    private val client: OkHttpClient,
    private val scope: CoroutineScope,
    private val clock: Clock = Clock.SYSTEM,
    private val logger: NetLogger = NetLogger.NONE,
) : EventStream {

    private val _events = MutableSharedFlow<ServerEvent>(
        replay = 0,
        extraBufferCapacity = 256,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )
    override val events: SharedFlow<ServerEvent> = _events.asSharedFlow()

    private val _state = MutableStateFlow(
        if (session.session.value == null) ConnectionState.UNPAIRED else ConnectionState.APP_DOWN,
    )
    override val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val lock = Any()
    private val subscriptions = LinkedHashSet<String>() // guarded by lock
    private var loopJob: Job? = null // guarded by lock
    private val current = AtomicReference<Connection?>(null)
    private val kicks = Channel<String>(Channel.CONFLATED)

    // Touched only by the connect loop.
    private val backoff = Backoff()
    private var quickRetryUsed = false

    override fun start() {
        synchronized(lock) {
            if (loopJob?.isActive == true) return
            loopJob = scope.launch { runLoop() }
        }
    }

    override fun stop() {
        val job = synchronized(lock) { loopJob.also { loopJob = null } }
        job?.cancel()
        current.getAndSet(null)?.close(NORMAL_CLOSURE, "stop")
    }

    override fun kick(reason: String) {
        if (current.get()?.open == true) return
        logger.d("events: kick ($reason)")
        kicks.trySend(reason)
    }

    override fun subscribe(ids: Set<String>) {
        if (ids.isEmpty()) return
        synchronized(lock) { subscriptions.addAll(ids) }
        current.get()?.takeIf { it.open }?.send(EventCodec.subscribe(ids))
    }

    override fun unsubscribe(ids: Set<String>) {
        if (ids.isEmpty()) return
        synchronized(lock) { subscriptions.removeAll(ids) }
        current.get()?.takeIf { it.open }?.send(EventCodec.unsubscribe(ids))
    }

    // ---- connect loop ----

    private suspend fun runLoop() {
        while (currentCoroutineContext().isActive) {
            val s = session.session.value
            if (s == null) {
                _state.value = ConnectionState.UNPAIRED
                session.session.first { it != null }
                continue
            }
            when (val end = connectOnce(s)) {
                End.SessionChanged -> continue
                End.Unauthorized -> {
                    logger.w("events: handshake refused (401/403); waiting for kick or a new session")
                    _state.value = ConnectionState.UNAUTHORIZED
                    waitForWake(null, s)
                }
                is End.Dropped -> afterDrop(s, end)
            }
        }
    }

    private suspend fun afterDrop(s: Session, end: End.Dropped) {
        if (end.welcomed) {
            backoff.reset()
            quickRetryUsed = false
        }
        val probed = api.probe()
        if (session.session.value != s) return
        logger.d("events: socket dropped (${end.why}); probe says $probed")
        when (probed) {
            ConnectionState.UNPAIRED -> return
            ConnectionState.UNAUTHORIZED -> {
                _state.value = ConnectionState.UNAUTHORIZED
                waitForWake(null, s)
            }
            ConnectionState.ONLINE -> {
                // HTTP answers but the socket died: one quick retry keeps a blip invisible, then the APP_DOWN schedule.
                if (end.welcomed && !quickRetryUsed) {
                    quickRetryUsed = true
                    waitForWake(QUICK_RETRY_MS, s)
                } else {
                    _state.value = ConnectionState.APP_DOWN
                    waitForWake(backoff.next(ConnectionState.APP_DOWN), s)
                }
            }
            ConnectionState.APP_DOWN, ConnectionState.MAC_OFF, ConnectionState.PAUSED -> {
                _state.value = probed
                waitForWake(backoff.next(probed), s)
            }
        }
    }

    /** Returns after [ms] (null = no timer), on a [kick], or when the session stops being [s]. */
    private suspend fun waitForWake(ms: Long?, s: Session) = coroutineScope {
        val timer = ms?.let { async { clock.delay(it) } }
        val sessionChange = async { session.session.first { it != s } }
        select<Unit> {
            timer?.onAwait { }
            kicks.onReceive { logger.d("events: woken by kick ($it)") }
            sessionChange.onAwait { }
        }
        coroutineContext.cancelChildren()
    }

    private suspend fun connectOnce(s: Session): End {
        val request = try {
            Http.builder(s.token).url(Http.eventsUrl(s.baseUrl)).build()
        } catch (e: IllegalArgumentException) {
            logger.w("events: bad server url", e)
            return End.Dropped(welcomed = false, why = "bad url")
        }
        val conn = Connection()
        current.set(conn)
        conn.ws = client.newWebSocket(request, conn)
        try {
            return coroutineScope {
                launch { keepalive(conn) }
                val sessionChange = async { session.session.first { it != s } }
                val end = select<End> {
                    conn.ended.onAwait { it }
                    sessionChange.onAwait { End.SessionChanged }
                }
                coroutineContext.cancelChildren()
                end
            }
        } finally {
            current.compareAndSet(conn, null)
            if (!conn.ended.isCompleted) conn.close(NORMAL_CLOSURE, "closing")
        }
    }

    private suspend fun keepalive(conn: Connection) {
        conn.opened.await()
        while (true) {
            clock.delay(PING_EVERY_MS)
            conn.awaitingPong = true
            if (!conn.send(EventCodec.ping())) return
            clock.delay(PONG_TIMEOUT_MS)
            if (conn.awaitingPong) {
                logger.w("events: no pong within ${PONG_TIMEOUT_MS / 1000} s; closing")
                conn.close(PONG_TIMEOUT_CLOSE, "pong timeout")
                // A dead peer never answers the close frame; do not wait OkHttp's 60 s close timeout.
                clock.delay(CLOSE_GRACE_MS)
                conn.ws?.cancel()
                return
            }
        }
    }

    private fun snapshotSubscriptions(): Set<String> = synchronized(lock) { LinkedHashSet(subscriptions) }

    private sealed interface End {
        data class Dropped(val welcomed: Boolean, val why: String) : End
        data object Unauthorized : End
        data object SessionChanged : End
    }

    private inner class Connection : WebSocketListener() {
        @Volatile var ws: WebSocket? = null

        @Volatile var open = false

        @Volatile var welcomed = false

        @Volatile var awaitingPong = false
        val opened = CompletableDeferred<Unit>()
        val ended = CompletableDeferred<End>()

        fun send(text: String): Boolean = ws?.send(text) ?: false

        fun close(code: Int, reason: String) {
            open = false
            ws?.close(code, reason)
        }

        private fun stale(): Boolean = current.get() !== this

        override fun onOpen(webSocket: WebSocket, response: Response) {
            ws = webSocket
            if (stale()) {
                webSocket.close(NORMAL_CLOSURE, "stale")
                return
            }
            open = true
            webSocket.send(EventCodec.hello(session.lastSeq(), snapshotSubscriptions()))
            opened.complete(Unit)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (stale()) return
            val event = try {
                EventCodec.decode(text)
            } catch (e: Exception) {
                logger.w("events: undecodable frame dropped (${text.length} chars)", e)
                return
            }
            when (event) {
                is ServerEvent.Welcome -> {
                    welcomed = true
                    _state.value = ConnectionState.ONLINE
                    kicks.tryReceive() // a kick queued while connecting is satisfied now
                }
                is ServerEvent.Pong -> awaitingPong = false
                else -> Unit
            }
            _events.tryEmit(event)
            if (event is ServerEvent.Feed) {
                val seq = event.item.seq
                if (seq > session.lastSeq()) session.setLastSeq(seq)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            open = false
            webSocket.close(NORMAL_CLOSURE, null)
            ended.complete(End.Dropped(welcomed, "server closed $code"))
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            open = false
            ended.complete(End.Dropped(welcomed, "closed $code"))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            val wasOpen = open
            open = false
            val code = response?.code
            val end = if (!wasOpen && !welcomed && (code == 401 || code == 403)) {
                End.Unauthorized
            } else {
                End.Dropped(welcomed, "failure ${t.javaClass.simpleName}${code?.let { " http $it" } ?: ""}")
            }
            ended.complete(end)
        }
    }

    private companion object {
        const val NORMAL_CLOSURE = 1000
        const val PONG_TIMEOUT_CLOSE = 4001
        const val PING_EVERY_MS = 25_000L
        const val PONG_TIMEOUT_MS = 10_000L
        const val CLOSE_GRACE_MS = 2_000L
        const val QUICK_RETRY_MS = 1_000L
    }
}
