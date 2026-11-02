package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OpenAiFileSttTest {
    private lateinit var server: MockWebServer

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
    fun postsMultipartWavAndParsesText() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"text":" Hi LISA, Peers Flow works. ","languages":[{"code":"en"}],"usage":{}}"""))
        val stt = OpenAiFileStt({ "test-key" }, OkHttpClient(), baseUrl = server.url("/").toString().trimEnd('/'))
        val session = stt.start(SttConfig(languages = listOf("pl", "en"), keywords = listOf("Peers Flow", "LISA")))
        repeat(10) { session.feed(ShortArray(480) { 100 }) }
        val result = session.finish()
        assertEquals("Hi LISA, Peers Flow works.", result.text)
        assertEquals("en", result.language)
        assertEquals("openai-file", result.provider)
        assertEquals(200L, result.durationMs)

        val req = server.takeRequest()
        assertEquals("/v1/audio/transcriptions", req.path)
        assertEquals("Bearer test-key", req.getHeader("Authorization"))
        assertTrue(req.getHeader("Content-Type")!!.startsWith("multipart/form-data"))
        val body = String(req.body.readByteArray(), Charsets.ISO_8859_1)
        fun part(name: String, value: String) =
            Regex("name=\"${Regex.escape(name)}\"[^\\n]*\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n${Regex.escape(value)}\\r\\n").containsMatchIn(body)
        assertTrue("model part", part("model", "gpt-transcribe"))
        assertTrue("prompt from keywords", part("prompt", "Peers Flow, LISA"))
        assertTrue("languages[] pl", part("languages[]", "pl"))
        assertTrue("languages[] en", part("languages[]", "en"))
        assertTrue("keywords[]", part("keywords[]", "Peers Flow"))
        assertTrue("file part", body.contains("name=\"file\"; filename=\"speech.wav\""))
        val riff = body.indexOf("RIFF")
        assertTrue("RIFF header in file part", riff > 0 && body.substring(riff + 8, riff + 12) == "WAVE")
        assertTrue("no singular language", !body.contains("name=\"language\""))
    }

    @Test
    fun httpErrorIsUnavailableAndRedactsKeys() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"message":"Incorrect API key provided: sk-abc123"}}"""))
        val session = OpenAiFileStt({ "k" }, OkHttpClient(), baseUrl = server.url("/").toString().trimEnd('/')).start(SttConfig())
        session.feed(ShortArray(480))
        try {
            session.finish()
            throw AssertionError("expected SttUnavailable")
        } catch (e: SttUnavailable) {
            assertTrue(e.message!!.contains("401"))
            assertTrue(!e.message!!.contains("sk-"))
        }
    }
}
