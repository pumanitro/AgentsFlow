package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttProvider
import com.peersflow.mobile.wire.SttResult
import com.peersflow.mobile.wire.SttSession
import com.peersflow.mobile.wire.Tts
import com.peersflow.mobile.wire.TtsHandle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

class VoiceEngineImplTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun tearDown() = scope.cancel()

    private class Recording(override val id: String, val text: String = "from $id") : SttProvider {
        val frames = CopyOnWriteArrayList<ShortArray>()
        var configs = CopyOnWriteArrayList<SttConfig>()
        override suspend fun start(config: SttConfig): SttSession {
            configs += config
            return object : SttSession {
                override val partial: StateFlow<String> = MutableStateFlow("")
                override suspend fun feed(pcm16: ShortArray) { frames += pcm16 }
                override suspend fun finish() = SttResult(text, null, id, frames.size * 20L)
                override fun cancel() {}
            }
        }
    }

    private class Failing(override val id: String, val failAfter: Int, val dropped: Boolean) : SttProvider {
        override suspend fun start(config: SttConfig): SttSession = object : SttSession {
            val fed = ArrayList<ShortArray>()
            override val partial: StateFlow<String> = MutableStateFlow("par")
            override suspend fun feed(pcm16: ShortArray) {
                if (fed.size >= failAfter) {
                    if (dropped) throw SttDropped(fed.toList()) else throw SttUnavailable("live connect timeout")
                }
                fed += pcm16
            }
            override suspend fun finish(): SttResult = throw SttUnavailable("unused")
            override fun cancel() {}
        }
    }

    private fun engine(live: SttProvider?, file: SttProvider?, onDevice: SttProvider? = null, online: Boolean = true,
                       cloud: Tts? = null, device: Tts? = null, vocab: List<String>? = null) =
        VoiceEngineImpl(live, file, onDevice, cloud, device, { vocab }, { online }, scope)

    private suspend fun listenAll(e: VoiceEngineImpl, frames: List<ShortArray>, file: Recording): SttResult {
        val handle = e.listen(SttConfig(), TestAudio.ListSource(frames)) {}
        withTimeout(5000) { while (file.frames.size < frames.size) delay(5) }
        return handle.finish()
    }

    @Test
    fun liveUnavailableFallsBackToFileWithEveryFrame() = runBlocking {
        val file = Recording("openai-file")
        val frames = TestAudio.numbered(40)
        val result = listenAll(engine(Failing("openai-live", failAfter = 0, dropped = false), file), frames, file)
        assertEquals("from openai-file", result.text)
        assertEquals(frames.size, file.frames.size)
        frames.forEachIndexed { i, f -> assertArrayEquals(f, file.frames[i]) }
    }

    @Test
    fun liveDroppedMidUtteranceFallsBackWithBufferedPlusRest() = runBlocking {
        val file = Recording("openai-file")
        val frames = TestAudio.numbered(40)
        val result = listenAll(engine(Failing("openai-live", failAfter = 12, dropped = true), file), frames, file)
        assertEquals("openai-file", result.provider)
        assertEquals(frames.map { it[0] }, file.frames.map { it[0] })
    }

    @Test
    fun liveDisabledOrOfflinePicksTheRightProvider() = runBlocking {
        val live = Recording("openai-live")
        val file = Recording("openai-file")
        val onDevice = Recording("on-device")
        val disabled = VoiceEngineImpl(live, file, onDevice, null, null, { null }, { true }, scope, liveEnabled = { false })
        assertEquals("openai-file", disabled.listen(SttConfig(), TestAudio.ListSource(emptyList())) {}.finish().provider)
        val offline = engine(live, file, onDevice, online = false)
        assertEquals("on-device", offline.listen(SttConfig(), TestAudio.ListSource(emptyList())) {}.finish().provider)
        val normal = engine(live, file, onDevice)
        assertEquals("openai-live", normal.listen(SttConfig(), TestAudio.ListSource(emptyList())) {}.finish().provider)
    }

    @Test
    fun vocabularyMergesIntoKeywordsAndVadEmitsEndOfSpeech() = runBlocking {
        val file = Recording("openai-file")
        val e = engine(null, file, vocab = listOf("Peers Flow", " LISA ", "Peers Flow"))
        withTimeout(2000) { e.vocabulary.first { it.isNotEmpty() } }
        assertEquals(listOf("KSeF", "Peers Flow", "LISA"), e.configWithVocabulary(SttConfig(keywords = listOf("KSeF"))).keywords)
        val frames = TestAudio.frames(TestAudio.silence(300) + TestAudio.tone(800) + TestAudio.silence(1500))
        val handle = e.listen(SttConfig(), TestAudio.ListSource(frames)) {}
        withTimeout(2000) { handle.endOfSpeech.first() }
        handle.finish()
        assertEquals(listOf("Peers Flow", "LISA"), file.configs.single().keywords)
    }

    @Test
    fun speakFallsBackToDeviceOnCloudFailure() = runBlocking {
        val spoken = CopyOnWriteArrayList<String>()
        val cloud = object : Tts {
            override val id = "openai-realtime"
            override suspend fun speak(text: String, voice: String?): TtsHandle = throw IOException("down")
        }
        val device = object : Tts {
            override val id = "on-device"
            override suspend fun speak(text: String, voice: String?): TtsHandle {
                spoken += text
                return object : TtsHandle {
                    override suspend fun await() {}
                    override fun stop() {}
                }
            }
        }
        engine(null, null, cloud = cloud, device = device).speak("hej", null).await()
        engine(null, null, cloud = cloud, device = device, online = false).speak("offline", null).await()
        assertEquals(listOf("hej", "offline"), spoken)
    }
}
