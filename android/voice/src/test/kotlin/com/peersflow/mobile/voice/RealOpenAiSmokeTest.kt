package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit

/**
 * Costs real money (a few cents per run). Skipped without the key file or with PEERSFLOW_SKIP_REAL set.
 * The key is read here and handed to the providers as a lambda; it is never printed.
 */
class RealOpenAiSmokeTest {
    private val keyFile = File("/Users/iij/Desktop/LISA/.env.local")
    private val client = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
    private val key: () -> String? = { dotenv(keyFile)["OPENAI_API_KEY"] }

    private fun dotenv(f: File): Map<String, String> = f.readLines().mapNotNull { raw ->
        val line = raw.trim().removePrefix("export ").trim()
        if (line.isEmpty() || line.startsWith("#") || !line.contains('=')) return@mapNotNull null
        val k = line.substringBefore('=').trim()
        var v = line.substringAfter('=').trim()
        if (v.length >= 2 && (v.startsWith('"') && v.endsWith('"') || v.startsWith('\'') && v.endsWith('\''))) v = v.substring(1, v.length - 1)
        else v = v.substringBefore(" #").trim()
        k to v
    }.toMap()

    private val config = SttConfig(languages = listOf("pl", "en"), keywords = listOf("Peers Flow", "LISA"))

    private fun ms(fromNs: Long) = (System.nanoTime() - fromNs) / 1_000_000

    private suspend fun fileMode(name: String): String {
        val (rate, pcm) = WavCodec.read(TestAudio.resource(name).readBytes())
        val session = OpenAiFileStt(key, client).start(config.copy(sampleRate = rate))
        TestAudio.frames(pcm, rate).forEach { session.feed(it) }
        val t0 = System.nanoTime()
        val r = session.finish()
        println("transcript[file $name]: \"${r.text}\" language=${r.language} roundTripMs=${ms(t0)} audioMs=${r.durationMs}")
        return r.text
    }

    @Test
    fun realOpenAi() = runBlocking {
        Assume.assumeTrue(keyFile.exists() && System.getenv("PEERSFLOW_SKIP_REAL") == null)
        Assume.assumeTrue(!key().isNullOrBlank())

        // 1 · file mode
        val pl = fileMode("sample-pl.wav")
        val en = fileMode("sample-en.wav")
        assertTrue("file mode heard \"peers flow\" (pl: $pl / en: $en)",
            pl.contains("peers flow", ignoreCase = true) || en.contains("peers flow", ignoreCase = true))

        // 2 · live mode, real-time pacing
        val source = PcmWavSource(TestAudio.resource("sample-en.wav"), realtime = true)
        val live = OpenAiLiveStt(key, client, connectTimeoutMs = 3000).start(config.copy(sampleRate = source.sampleRate))
        val tStart = System.nanoTime()
        var firstPartialMs = -1L
        val watcher = launch { live.partial.first { it.isNotEmpty() }; firstPartialMs = ms(tStart) }
        source.frames().collect { live.feed(it) }
        val tCommit = System.nanoTime()
        val r = live.finish()
        watcher.cancel()
        println("transcript[live sample-en.wav]: \"${r.text}\" firstPartialMs=$firstPartialMs finalAfterCommitMs=${ms(tCommit)} totalMs=${ms(tStart)}")
        assertTrue("live transcript non-empty", r.text.isNotBlank())

        // 3 · TTS through the Realtime API
        val sink = CollectingSink()
        val cacheDir = Files.createTempDirectory("tts-cache").toFile()
        val tts = OpenAiRealtimeTts(key, client, player = sink, cache = TtsCache(cacheDir))
        val tSpeak = System.nanoTime()
        val handle = tts.speak("Peers Flow is ready on your phone.", null)
        val firstByteMs = (sink.firstWriteAtNs!! - tSpeak) / 1_000_000
        withTimeout(30_000) { handle.await() }
        val bytes = sink.bytes.size
        println("bytes[tts]: $bytes (${bytes / 48} ms of audio) firstByteMs=$firstByteMs totalMs=${ms(tSpeak)} cached=${cacheDir.listFiles()!!.size}")
        cacheDir.deleteRecursively()
        assertTrue("tts bytes > 20000", bytes > 20_000)
    }
}
