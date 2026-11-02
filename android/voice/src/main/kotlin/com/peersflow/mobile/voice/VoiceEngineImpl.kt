package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.ListenHandle
import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttProvider
import com.peersflow.mobile.wire.Tts
import com.peersflow.mobile.wire.TtsHandle
import com.peersflow.mobile.wire.VoiceEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Picks the speech providers. Listening: live when [online] and [liveEnabled], else file when [online], else
 * on-device; a live [SttUnavailable] or [SttDropped] restarts on the file provider with every captured frame.
 * Speaking: [cloudTts] when [online], else [deviceTts]; any cloud failure falls back to [deviceTts].
 * [online] means "internet reachable", not "Mac reachable". [voice] supplies the user's cloud voice (null = marin).
 */
class VoiceEngineImpl(
    private val live: SttProvider?,
    private val file: SttProvider?,
    private val onDevice: SttProvider?,
    private val cloudTts: Tts?,
    private val deviceTts: Tts?,
    private val vocabularyFetcher: suspend () -> List<String>?,
    private val online: () -> Boolean,
    private val scope: CoroutineScope,
    private val liveEnabled: () -> Boolean = { true },
    private val voice: () -> String? = { null },
    private val log: VoiceLog = VoiceLog.NONE,
    private val vocabularyRefreshMs: Long = 6 * 60 * 60 * 1000L,
) : VoiceEngine {
    private val _vocabulary = MutableStateFlow<List<String>>(emptyList())
    override val vocabulary: StateFlow<List<String>> = _vocabulary.asStateFlow()

    init {
        scope.launch {
            while (isActive) {
                refreshVocabulary()
                delay(vocabularyRefreshMs)
            }
        }
    }

    /** Fetches the vocabulary now; keeps the previous list when the fetch fails or returns null. */
    suspend fun refreshVocabulary(): Boolean {
        val fetched = try {
            vocabularyFetcher()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.log("vocabulary fetch failed: ${e.javaClass.simpleName}")
            null
        } ?: return false
        _vocabulary.value = fetched.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
        return true
    }

    fun configWithVocabulary(base: SttConfig): SttConfig =
        base.copy(keywords = (base.keywords + _vocabulary.value).map { it.trim() }.filter { it.isNotEmpty() }.distinct())

    override fun listen(config: SttConfig, source: AudioSource, onPartial: (String) -> Unit): ListenHandle {
        val cfg = configWithVocabulary(config).copy(sampleRate = source.sampleRate)
        val isOnline = online()
        val primary = when {
            isOnline && liveEnabled() && live != null -> live
            isOnline && file != null -> file
            else -> onDevice ?: file
        }
        // Fall back to OpenAI file transcription only when OpenAI is usable (online() includes "a key exists").
        // Without a key the fallback could only fail with "no OpenAI key" and would hide the phone
        // recognizer's real error — what the user saw on 2026-11-02.
        val fallback = file.takeIf { it !== primary && isOnline }
        return EngineListenHandle(cfg, source, onPartial, primary, fallback, scope, log)
    }

    override suspend fun speak(text: String, cacheKey: String?): TtsHandle {
        val cloud = cloudTts
        if (cloud != null && online()) {
            try {
                val handle = cloud.speak(text, voice())
                return FallbackTtsHandle(handle, log) { deviceTts?.speak(text, null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log.log("cloud TTS failed, using on-device: ${Redact.text(e.message)}")
            }
        }
        val device = deviceTts ?: throw IllegalStateException("no TTS available")
        return device.speak(text, null)
    }
}
