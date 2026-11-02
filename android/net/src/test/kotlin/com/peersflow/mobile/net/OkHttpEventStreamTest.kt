package com.peersflow.mobile.net

import app.cash.turbine.test
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ServerEvent
import com.peersflow.mobile.wire.WireJson
import com.peersflow.mobile.wire.fakes.FakeApiClient
import com.peersflow.mobile.wire.fakes.InMemorySessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class OkHttpEventStreamTest {

    /** Routes `/api/v1/events` and `/api/v1/ping`; records what the client sends over the socket. */
    private class Gateway : Dispatcher() {
        val wsRequests = AtomicInteger()
        val pingRequests = AtomicInteger()
        val authHeaders = LinkedBlockingQueue<String>()
        val sockets = LinkedBlockingQueue<WebSocket>()
        val received = LinkedBlockingQueue<String>()
        val closeCodes = LinkedBlockingQueue<Int>()

        @Volatile var refuseHandshake = false

        @Volatile var pingCode = 500

        private val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                sockets.add(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                received.add(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                closeCodes.add(code)
                webSocket.close(1000, null)
            }
        }

        override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
            "/api/v1/events" -> {
                wsRequests.incrementAndGet()
                authHeaders.add(request.getHeader("Authorization").orEmpty())
                if (refuseHandshake) {
                    MockResponse().setResponseCode(401).setBody("""{"error":"revoked","code":"unauthorized"}""")
                } else {
                    MockResponse().withWebSocketUpgrade(listener)
                }
            }
            "/api/v1/ping" -> {
                pingRequests.incrementAndGet()
                MockResponse().setResponseCode(pingCode).setBody("""{"error":"down","code":"unavailable"}""")
            }
            else -> MockResponse().setResponseCode(404)
        }

        fun nextSocket(): WebSocket = sockets.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no WebSocket opened")
        fun nextFrame(): String = received.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no frame from the client")
    }

    private lateinit var server: MockWebServer
    private lateinit var gateway: Gateway
    private lateinit var store: InMemorySessionStore
    private lateinit var clock: FakeClock
    private lateinit var scope: CoroutineScope
    private lateinit var stream: OkHttpEventStream

    @Before
    fun setUp() {
        gateway = Gateway()
        server = MockWebServer().apply {
            dispatcher = gateway
            start()
        }
        store = InMemorySessionStore(TestData.session(server.url("/").toString()))
        clock = FakeClock()
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val client = TestData.client()
        stream = OkHttpEventStream(store, OkHttpApiClient(store, client), client, scope, clock)
    }

    @After
    fun tearDown() {
        stream.stop()
        scope.cancel()
        runCatching { server.shutdown() }
    }

    private fun awaitState(target: ConnectionState) = runBlocking {
        withTimeout(5_000) { stream.state.first { it == target } }
    }

    private fun awaitTrue(what: String, cond: () -> Boolean) {
        val end = System.currentTimeMillis() + 5_000
        while (!cond()) {
            if (System.currentTimeMillis() > end) throw AssertionError("timed out waiting for $what")
            Thread.sleep(10)
        }
    }

    /** Starts the stream, answers its hello with a welcome, returns the server side of the socket. */
    private fun connectOnline(): WebSocket {
        stream.start()
        val ws = gateway.nextSocket()
        assertEquals("hello", type(gateway.nextFrame()))
        ws.send(TestData.WELCOME)
        awaitState(ConnectionState.ONLINE)
        return ws
    }

    private fun type(frame: String) = WireJson.parseToJsonElement(frame).jsonObject["type"]!!.jsonPrimitive.content

    @Test
    fun initialStateFollowsTheSession() {
        assertEquals(ConnectionState.APP_DOWN, stream.state.value)
        val unpaired = OkHttpEventStream(InMemorySessionStore(), FakeApiClient(), TestData.client(), scope, clock)
        assertEquals(ConnectionState.UNPAIRED, unpaired.state.value)
    }

    @Test
    fun helloWelcomeFeedAndUpdatesFlowThrough() = runBlocking {
        store.setLastSeq(5)
        stream.subscribe(setOf("c1"))
        stream.events.test {
            stream.start()
            val ws = gateway.nextSocket()
            assertEquals("Bearer t-test", gateway.authHeaders.poll(5, TimeUnit.SECONDS))

            val hello = WireJson.parseToJsonElement(gateway.nextFrame()).jsonObject
            assertEquals("hello", hello["type"]!!.jsonPrimitive.content)
            assertEquals(5L, hello["lastSeq"]!!.jsonPrimitive.long)
            assertEquals(listOf("c1"), hello["subscribe"]!!.jsonArray.map { it.jsonPrimitive.content })

            ws.send(TestData.WELCOME)
            assertTrue(awaitItem() is ServerEvent.Welcome)
            assertEquals(ConnectionState.ONLINE, stream.state.value)

            ws.send(TestData.FEED_7)
            val feed = awaitItem()
            assertTrue("$feed", feed is ServerEvent.Feed && feed.item.seq == 7L)
            assertEquals(7L, store.lastSeq())

            ws.send(TestData.CONVS_UPDATED)
            val upd = awaitItem()
            assertTrue("$upd", upd is ServerEvent.ConversationsUpdated && upd.summaries.single().id == "c1")

            ws.send("""{"type":"something.new","x":1}""")
            assertTrue(awaitItem() is ServerEvent.Unknown)

            stream.subscribe(setOf("c2"))
            val sub = WireJson.parseToJsonElement(gateway.nextFrame()).jsonObject
            assertEquals("subscribe", sub["type"]!!.jsonPrimitive.content)
            assertEquals(listOf("c2"), sub["ids"]!!.jsonArray.map { it.jsonPrimitive.content })
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test
    fun serverCloseShowsAppDownAndBacksOff() {
        val ws = connectOnline()
        ws.close(1000, "bye")
        awaitState(ConnectionState.APP_DOWN)
        assertTrue(gateway.pingRequests.get() >= 1)
        val wait = clock.awaitPending { it in 13_500L..16_500L }
        assertTrue("first APP_DOWN backoff is 15 s ±10 %: $wait", wait in 13_500L..16_500L)
    }

    @Test
    fun kickDuringBackoffReconnectsImmediatelyAndResendsSubscriptions() {
        stream.subscribe(setOf("c1", "c2"))
        val ws = connectOnline()
        ws.close(1000, "bye")
        awaitState(ConnectionState.APP_DOWN)
        val wait = clock.awaitPending { it in 13_500L..16_500L }

        val kickedAt = System.currentTimeMillis()
        stream.kick("test")
        val ws2 = gateway.nextSocket()
        assertTrue("reconnect took ${System.currentTimeMillis() - kickedAt} ms", System.currentTimeMillis() - kickedAt < 1_500)
        assertTrue("cancelled=${clock.cancelled}", clock.cancelled.contains(wait))
        assertEquals(2, gateway.wsRequests.get())

        val hello = WireJson.parseToJsonElement(gateway.nextFrame()).jsonObject
        assertEquals(listOf("c1", "c2"), hello["subscribe"]!!.jsonArray.map { it.jsonPrimitive.content })
        ws2.send(TestData.WELCOME)
        awaitState(ConnectionState.ONLINE)
    }

    @Test
    fun refusedHandshakeIsUnauthorizedAndWaitsForKick() {
        gateway.refuseHandshake = true
        stream.start()
        awaitState(ConnectionState.UNAUTHORIZED)

        clock.advance(5_000)
        Thread.sleep(300)
        assertEquals(1, gateway.wsRequests.get())
        assertEquals(0, gateway.pingRequests.get())
        assertEquals(ConnectionState.UNAUTHORIZED, stream.state.value)

        gateway.refuseHandshake = false
        stream.kick("re-paired")
        awaitTrue("a second handshake") { gateway.wsRequests.get() == 2 }
    }

    @Test
    fun missingPongClosesWith4001AndReconnects() {
        connectOnline()
        clock.awaitPending { it == 25_000L }
        clock.advance(25_000)
        assertEquals("ping", type(gateway.nextFrame()))

        clock.awaitPending { it == 10_000L }
        clock.advance(10_000)
        assertEquals(4001, gateway.closeCodes.poll(5, TimeUnit.SECONDS))
        awaitState(ConnectionState.APP_DOWN)
    }

    @Test
    fun pongKeepsTheSocketOpen() {
        val ws = connectOnline()
        clock.awaitPending { it == 25_000L }
        clock.advance(25_000)
        assertEquals("ping", type(gateway.nextFrame()))
        ws.send("""{"type":"pong","serverTime":"2026-10-28T10:00:00Z"}""")
        Thread.sleep(200)
        clock.advance(10_000)
        clock.awaitPending { it == 25_000L }
        assertEquals(ConnectionState.ONLINE, stream.state.value)
        assertEquals(1, gateway.wsRequests.get())
    }

    @Test
    fun clearingTheSessionClosesAndShowsUnpaired() {
        connectOnline()
        store.clear()
        awaitState(ConnectionState.UNPAIRED)
        assertEquals(1000, gateway.closeCodes.poll(5, TimeUnit.SECONDS))
        Thread.sleep(200)
        assertEquals(1, gateway.wsRequests.get())
    }

    @Test
    fun stopClosesWithNormalClosureAndStartIsIdempotent() {
        stream.start()
        connectOnline()
        stream.start()
        stream.stop()
        assertEquals(1000, gateway.closeCodes.poll(5, TimeUnit.SECONDS))
        Thread.sleep(200)
        assertEquals(1, gateway.wsRequests.get())
    }
}
