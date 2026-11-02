package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.Tts
import com.peersflow.mobile.wire.TtsHandle
import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.io.IOException

/**
 * LISA's voice: one Realtime session per utterance (`gpt-realtime-2.1-mini`, text in, PCM16 24 kHz out).
 * [speak] returns once the first audio chunk is playing (or straight away on a cache hit) and throws if the
 * session fails before any audio, so a caller can fall back. [TtsHandle.await] returns when playback drains.
 */
class OpenAiRealtimeTts(
    private val key: () -> String?,
    private val client: OkHttpClient,
    private val json: Json = WireJson,
    private val model: String = "gpt-realtime-2.1-mini",
    private val player: PcmSink,
    private val cache: TtsCache?,
    private val baseUrl: String = "wss://api.openai.com",
    private val firstAudioTimeoutMs: Long = 10_000,
    private val log: VoiceLog = VoiceLog.NONE,
) : Tts {
    override val id: String = "openai-realtime"

    override suspend fun speak(text: String, voice: String?): TtsHandle {
        val v = voice?.takeIf { it.isNotBlank() } ?: DEFAULT_VOICE
        val cacheKey = cache?.key(text, v)
        if (cache != null && cacheKey != null) {
            cache.get(cacheKey)?.let { pcm ->
                player.write(pcm)
                return object : TtsHandle {
                    override suspend fun await() = player.drain()
                    override fun stop() = player.stop()
                }
            }
        }
        val apiKey = key()?.takeIf { it.isNotBlank() } ?: throw IOException("no OpenAI key")
        val handle = RealtimeTtsHandle(apiKey, client, json, model, baseUrl, text, v, player, log) { pcm ->
            if (cache != null && cacheKey != null) cache.put(cacheKey, pcm)
        }
        try {
            withTimeout(firstAudioTimeoutMs) { handle.firstAudio.await() }
        } catch (e: TimeoutCancellationException) {
            handle.stop()
            throw IOException("realtime TTS: no audio within $firstAudioTimeoutMs ms")
        } catch (e: Exception) {
            handle.stop()
            throw e
        }
        return handle
    }

    companion object {
        const val DEFAULT_VOICE = "marin"
        const val INSTRUCTIONS = "You are a text-to-speech engine. Read the user's message aloud exactly as written, " +
            "in its own language, with natural intonation. Do not add, omit, translate or comment."
    }
}
