package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.concurrent.CopyOnWriteArrayList

class OpenAiRealtimeTtsTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var server: MockWebServer
    private val received = CopyOnWriteArrayList<JsonObject>()

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun streamsDeltasIntoSinkAndCaches() = runBlocking {
        val chunks = listOf(ByteArray(960) { 1 }, ByteArray(960) { 2 }, ByteArray(480) { 3 })
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val e = WireJson.parseToJsonElement(text).jsonObject
                received += e
                if (e["type"]!!.jsonPrimitive.content == "response.create") {
                    chunks.forEachIndexed { i, c ->
                        // the third uses the older event name, which the client also accepts
                        val type = if (i == 2) "response.audio.delta" else "response.output_audio.delta"
                        webSocket.send("""{"type":"$type","response_id":"r","item_id":"i","output_index":0,"content_index":0,"delta":"${PcmUtil.base64(c)}"}""")
                    }
                    webSocket.send("""{"type":"response.done","response":{"id":"r","status":"completed","output":[]}}""")
                }
            }
        }))
        val sink = CollectingSink()
        val cache = TtsCache(tmp.newFolder("tts"))
        val tts = OpenAiRealtimeTts({ "test-key" }, OkHttpClient(), player = sink, cache = cache,
            baseUrl = "ws://${server.hostName}:${server.port}")
        val handle = tts.speak("Peers Flow is ready.", null)
        withTimeout(5000) { handle.await() }

        val expected = chunks.fold(ByteArray(0)) { a, b -> a + b }
        assertArrayEquals(expected, sink.bytes)
        val file = cache.file(cache.key("Peers Flow is ready.", "marin"))
        assertTrue("cache file exists", file.exists())
        assertArrayEquals(expected, file.readBytes())

        val req = server.takeRequest()
        assertEquals("/v1/realtime?model=gpt-realtime-2.1-mini", req.path)
        assertEquals("Bearer test-key", req.getHeader("Authorization"))
        assertEquals(listOf("session.update", "conversation.item.create", "response.create"), received.map { it["type"]!!.jsonPrimitive.content })
        val s = received[0]["session"]!!.jsonObject
        assertEquals("realtime", s["type"]!!.jsonPrimitive.content)
        assertEquals(listOf("audio"), s["output_modalities"]!!.jsonArray.map { it.jsonPrimitive.content })
        val out = s["audio"]!!.jsonObject["output"]!!.jsonObject
        assertEquals("marin", out["voice"]!!.jsonPrimitive.content)
        assertEquals("audio/pcm", out["format"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        val item = received[1]["item"]!!.jsonObject
        assertEquals("user", item["role"]!!.jsonPrimitive.content)
        assertEquals("input_text", item["content"]!!.jsonArray[0].jsonObject["type"]!!.jsonPrimitive.content)

        // second call is served from the cache with no new connection
        val sink2Before = sink.bytes.size
        tts.speak("Peers Flow is ready.", null).await()
        assertEquals(sink2Before * 2, sink.bytes.size)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun errorBeforeAudioThrowsFromSpeak() = runBlocking {
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.contains("response.create")) webSocket.send("""{"type":"error","error":{"type":"invalid_request_error","message":"nope"}}""")
            }
        }))
        val tts = OpenAiRealtimeTts({ "k" }, OkHttpClient(), player = CollectingSink(), cache = null,
            baseUrl = "ws://${server.hostName}:${server.port}")
        try {
            tts.speak("x", "cedar")
            throw AssertionError("expected IOException")
        } catch (e: java.io.IOException) {
            assertTrue(e.message!!.contains("nope"))
        }
    }

    @Test
    fun cacheEvictsOldestOverLimit() {
        val dir = tmp.newFolder("lru")
        val cache = TtsCache(dir, maxBytes = 2500)
        cache.put("a", ByteArray(1000))
        cache.file("a").setLastModified(1_000)
        cache.put("b", ByteArray(1000))
        cache.file("b").setLastModified(2_000)
        cache.put("c", ByteArray(1000))
        assertTrue(!cache.file("a").exists())
        assertTrue(cache.file("b").exists() && cache.file("c").exists())
    }
}
