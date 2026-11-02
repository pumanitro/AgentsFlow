package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttProvider
import com.peersflow.mobile.wire.SttSession
import com.peersflow.mobile.wire.WireJson
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

/**
 * Live transcription over `wss://…/v1/realtime?intent=transcription` (model `gpt-live-transcribe`, client-side VAD).
 * [start] never blocks on the network; frames fed before the socket opens are queued. If the socket is not open
 * [connectTimeoutMs] after [start], the next [SttSession.feed] (or [SttSession.finish]) throws [SttUnavailable].
 */
class OpenAiLiveStt(
    private val key: () -> String?,
    private val client: OkHttpClient,
    private val json: Json = WireJson,
    private val model: String = "gpt-live-transcribe",
    private val connectTimeoutMs: Long = 1500,
    private val baseUrl: String = "wss://api.openai.com",
    private val log: VoiceLog = VoiceLog.NONE,
) : SttProvider {
    override val id: String = "openai-live"

    override suspend fun start(config: SttConfig): SttSession {
        val k = key()?.takeIf { it.isNotBlank() } ?: throw SttUnavailable("no OpenAI key")
        return OpenAiLiveSttSession(k, client, json, model, connectTimeoutMs, baseUrl, config, log)
    }
}
