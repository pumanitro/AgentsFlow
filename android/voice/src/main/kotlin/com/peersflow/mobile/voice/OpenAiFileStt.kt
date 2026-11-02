package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttProvider
import com.peersflow.mobile.wire.SttSession
import com.peersflow.mobile.wire.WireJson
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient

/** Buffers the utterance and POSTs one WAV to `/v1/audio/transcriptions` (model `gpt-transcribe`) on finish. */
class OpenAiFileStt(
    private val key: () -> String?,
    private val client: OkHttpClient,
    private val json: Json = WireJson,
    private val model: String = "gpt-transcribe",
    private val baseUrl: String = "https://api.openai.com",
    private val log: VoiceLog = VoiceLog.NONE,
) : SttProvider {
    override val id: String = "openai-file"

    override suspend fun start(config: SttConfig): SttSession =
        OpenAiFileSttSession(key, client, json, model, baseUrl, config, log)
}
