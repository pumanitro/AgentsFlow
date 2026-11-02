package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class OpenAiLiveSttTest {
    private lateinit var server: MockWebServer
    private val client = OkHttpClient()
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

    private fun base() = "ws://${server.hostName}:${server.port}"

    private fun scripted(onEvent: (WebSocket, JsonObject) -> Unit) = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            val obj = WireJson.parseToJsonElement(text).jsonObject
            received += obj
            onEvent(webSocket, obj)
        }

        override fun onOpen(webSocket: WebSocket, response: Response) {}

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }
    })

    private fun JsonObject.type() = this["type"]!!.jsonPrimitive.content

    @Test
    fun sessionUpdateBatchedAppendsCommitAndFinal() = runBlocking {
        var appends = 0
        server.enqueue(scripted { ws, e ->
            when (e.type()) {
                "input_audio_buffer.append" -> {
                    appends++
                    if (appends == 1) {
                        ws.send("""{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","content_index":0,"delta":"Hello"}""")
                        ws.send("""{"type":"conversation.item.input_audio_transcription.delta","item_id":"i1","content_index":0,"delta":" world"}""")
                    }
                }
                "input_audio_buffer.commit" -> ws.send(
                    """{"type":"conversation.item.input_audio_transcription.completed","item_id":"i1","content_index":0,"transcript":"Hello world."}""",
                )
            }
        })
        val stt = OpenAiLiveStt({ "test-key" }, client, connectTimeoutMs = 5000, baseUrl = base())
        val session = stt.start(SttConfig(languages = listOf("pl-PL", "en"), keywords = listOf("Peers Flow", "<bad>\nLISA")))
        repeat(12) { session.feed(ShortArray(480) { 7 }) }
        withTimeout(5000) { session.partial.first { it == "Hello world" } }
        val result = session.finish()
        assertEquals("Hello world.", result.text)
        assertEquals("openai-live", result.provider)
        assertEquals(240L, result.durationMs)

        val request = server.takeRequest()
        assertEquals("/v1/realtime?intent=transcription", request.path)
        assertEquals("Bearer test-key", request.getHeader("Authorization"))

        withTimeout(2000) { while (received.lastOrNull()?.type() != "input_audio_buffer.commit") delay(10) }
        val update = received[0]
        assertEquals("session.update", update.type())
        val session0 = update["session"]!!.jsonObject
        assertEquals("transcription", session0["type"]!!.jsonPrimitive.content)
        val input = session0["audio"]!!.jsonObject["input"]!!.jsonObject
        assertEquals(JsonNull, input["turn_detection"])
        assertEquals("audio/pcm", input["format"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(24000, input["format"]!!.jsonObject["rate"]!!.jsonPrimitive.content.toInt())
        val tr = input["transcription"]!!.jsonObject
        assertEquals("gpt-live-transcribe", tr["model"]!!.jsonPrimitive.content)
        assertEquals(listOf("pl", "en"), (tr["languages"] as JsonArray).map { it.jsonPrimitive.content })
        assertEquals(listOf("Peers Flow", "bad  LISA"), (tr["keywords"] as JsonArray).map { it.jsonPrimitive.content })
        assertEquals("low", tr["delay"]!!.jsonPrimitive.content)
        assertTrue("language (singular) must not be sent", tr["language"] == null)

        val appendMsgs = received.filter { it.type() == "input_audio_buffer.append" }
        assertEquals(3, appendMsgs.size) // 12 frames ⇒ 5 + 5 + 2 (remainder flushed before commit)
        val sizes = appendMsgs.map { PcmUtil.fromBase64(it["audio"]!!.jsonPrimitive.content).size }
        assertEquals(listOf(4800, 4800, 1920), sizes)
        assertEquals("input_audio_buffer.commit", received.last().type())
    }

    @Test
    fun errorMidUtteranceMakesFinishThrowDroppedWithEveryFrame() = runBlocking {
        server.enqueue(scripted { ws, e ->
            if (e.type() == "input_audio_buffer.append") {
                ws.send("""{"type":"error","event_id":"e1","error":{"type":"server_error","code":"boom","message":"x"}}""")
            }
        })
        val session = OpenAiLiveStt({ "k" }, client, connectTimeoutMs = 5000, baseUrl = base()).start(SttConfig())
        repeat(5) { session.feed(ShortArray(480)) }
        delay(300)
        var extra = 0
        try {
            repeat(3) { session.feed(ShortArray(480)); extra++ }
        } catch (_: SttDropped) {
        }
        try {
            session.finish()
            fail("expected SttDropped")
        } catch (e: SttDropped) {
            assertEquals(5 + extra, e.buffered.size)
        }
    }

    @Test
    fun connectTimeoutThrowsUnavailable() = runBlocking {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val session = OpenAiLiveStt({ "k" }, client, connectTimeoutMs = 200, baseUrl = base()).start(SttConfig())
        session.feed(ShortArray(480)) // queued, within the deadline
        delay(400)
        try {
            session.feed(ShortArray(480))
            fail("expected SttUnavailable")
        } catch (e: SttUnavailable) {
            assertEquals("live connect timeout", e.message)
        }
        session.cancel()
    }

    @Test(expected = SttUnavailable::class)
    fun noKeyIsUnavailable() = runBlocking<Unit> {
        OpenAiLiveStt({ null }, client, baseUrl = base()).start(SttConfig())
    }
}
