package com.peersflow.mobile.net

import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.PairRequest
import com.peersflow.mobile.wire.PairResponse
import com.peersflow.mobile.wire.WireJson
import com.peersflow.mobile.wire.fakes.InMemorySessionStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OkHttpApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var store: InMemorySessionStore
    private lateinit var api: OkHttpApiClient

    @Before
    fun setUp() {
        server = MockWebServer().apply { start() }
        store = InMemorySessionStore(TestData.session(server.url("/").toString()))
        api = OkHttpApiClient(store, TestData.client())
    }

    @After
    fun tearDown() {
        runCatching { server.shutdown() }
    }

    private fun json(code: Int, body: String) =
        MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body)

    @Test
    fun pairPostsJsonWithoutBearerAndDecodesTheResponse() = runBlocking {
        store.clear()
        server.enqueue(json(200, """{"token":"tok","deviceId":"d9","scopes":["view","talk"],"serverName":"mac","extra":1}"""))

        val r = api.pair(server.url("/").toString(), PairRequest("ABCD-EFGH", "Pixel"))

        assertEquals(ApiResult.Ok(PairResponse("tok", "d9", listOf("view", "talk"), serverName = "mac")), r)
        val req = server.takeRequest()
        assertEquals("POST", req.method)
        assertEquals("/api/v1/pair", req.path)
        assertNull(req.getHeader("Authorization"))
        assertEquals("application/json; charset=utf-8", req.getHeader("Content-Type"))
        assertEquals("PeersFlowMobile/0.1 (Android)", req.getHeader("User-Agent"))
        val body = WireJson.parseToJsonElement(req.body.readUtf8()).jsonObject
        assertEquals("ABCD-EFGH", body["code"]!!.jsonPrimitive.content)
        assertEquals("Pixel", body["deviceName"]!!.jsonPrimitive.content)
    }

    @Test
    fun pairErrorBodyMapsToItsCode() = runBlocking {
        server.enqueue(json(404, """{"error":"no such pairing code","code":"not_found"}"""))
        val r = api.pair(server.url("/").toString(), PairRequest("XXXX-XXXX", "Pixel"))
        assertEquals(ApiResult.Err("not_found", "no such pairing code", 404), r)
    }

    @Test
    fun everyAuthedCallSendsTheBearer() = runBlocking {
        server.enqueue(json(200, """{"ok":true,"name":"peersflow-mobile","v":1}"""))
        server.enqueue(json(200, """{"peers":[{"id":"p1","name":"LISA","path":"/x"}]}"""))
        server.enqueue(json(200, """{"summaries":[${TestData.SUMMARY}]}"""))
        server.enqueue(json(200, """{"notifications":[]}"""))
        server.enqueue(json(200, """{"ok":true}"""))
        server.enqueue(json(200, """{"items":[]}"""))

        assertEquals(ApiResult.Ok(Unit), api.ping())
        assertEquals("LISA", (api.peers() as ApiResult.Ok).value.single().name)
        assertEquals("c1", (api.conversations() as ApiResult.Ok).value.single().id)
        assertEquals(ApiResult.Ok(emptyList<Any>()), api.notifications())
        assertEquals(ApiResult.Ok(Unit), api.stop("c1"))
        assertEquals(ApiResult.Ok(emptyList<Any>()), api.outcomes(3))

        val paths = mutableListOf<String>()
        repeat(6) {
            val req = server.takeRequest()
            paths += "${req.method} ${req.path}"
            assertEquals("Bearer t-test", req.getHeader("Authorization"))
            assertEquals("application/json", req.getHeader("Accept"))
        }
        assertEquals(
            listOf(
                "GET /api/v1/ping", "GET /api/v1/peers", "GET /api/v1/conversations", "GET /api/v1/notifications",
                "POST /api/v1/conversations/c1/stop", "GET /api/v1/outcomes?after=3",
            ),
            paths,
        )
    }

    @Test
    fun noSessionMeansUnauthorizedWithoutARequest() = runBlocking {
        store.clear()
        assertEquals(ApiResult.Err("unauthorized", "not paired", 0), api.peers())
        assertEquals(ConnectionState.UNPAIRED, api.probe())
        assertEquals(0, server.requestCount)
    }

    @Test
    fun queryStringsAreBuiltOnlyFromNonNullArguments() = runBlocking {
        repeat(3) { server.enqueue(json(200, """{"summaries":[]}""")) }
        server.enqueue(json(200, """{"entries":[],"hasMore":false,"cursor":0,"end":0}"""))

        api.conversations(filter = "needs", peerId = "p1")
        api.conversations(filter = "done")
        api.conversations()
        api.messages("c 1", before = 1234, limit = 20)

        assertEquals("/api/v1/conversations?filter=needs&peer=p1", server.takeRequest().path)
        assertEquals("/api/v1/conversations?filter=done", server.takeRequest().path)
        assertEquals("/api/v1/conversations", server.takeRequest().path)
        assertEquals("/api/v1/conversations/c%201/messages?before=1234&limit=20", server.takeRequest().path)
    }

    @Test
    fun noHttpAnswerIsATransportError() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        val r = api.health()
        assertTrue("$r", r is ApiResult.Err && r.transport && r.code == "transport" && r.status == 0)

        server.shutdown()
        val r2 = api.health()
        assertTrue("$r2", r2 is ApiResult.Err && r2.transport)
    }

    @Test
    fun undecodableBodiesMapToHttpStatusOrDecode() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>"))
        server.enqueue(json(200, """{"nope":1}"""))

        assertEquals(ApiResult.Err("http_502", "<html>bad gateway</html>", 502), api.health())
        val r = api.health()
        assertTrue("$r", r is ApiResult.Err && r.code == "decode" && r.status == 200 && !r.transport)
    }

    @Test
    fun probeMapsTcpAndPingAnswersToStates() = runBlocking {
        server.enqueue(json(200, """{"ok":true,"name":"peersflow-mobile","v":1}"""))
        assertEquals(ConnectionState.ONLINE, api.probe())

        server.enqueue(json(503, """{"error":"paused from the desktop","code":"paused"}"""))
        assertEquals(ConnectionState.PAUSED, api.probe())

        server.enqueue(json(401, """{"error":"revoked","code":"unauthorized"}"""))
        assertEquals(ConnectionState.UNAUTHORIZED, api.probe())

        server.enqueue(json(500, """{"error":"boom","code":"unavailable"}"""))
        assertEquals(ConnectionState.APP_DOWN, api.probe())
        assertEquals("Bearer t-test", server.takeRequest().getHeader("Authorization"))

        store.save(TestData.session("http://127.0.0.1:${TestData.closedPort()}"))
        assertEquals(ConnectionState.MAC_OFF, api.probe())
    }

    @Test
    fun reachabilityParsesDefaultPorts() {
        assertEquals("10.0.2.2" to 47821, Reachability.hostPort("http://10.0.2.2:47821"))
        assertEquals("mac.tail1234.ts.net" to 443, Reachability.hostPort("https://mac.tail1234.ts.net/"))
        assertEquals("mac" to 80, Reachability.hostPort("http://mac"))
        assertEquals(false, Reachability.tcpOpen("127.0.0.1", TestData.closedPort(), 500))
    }
}
