package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttResult
import com.peersflow.mobile.wire.SttSession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

internal class OpenAiFileSttSession(
    private val key: () -> String?,
    private val client: OkHttpClient,
    private val json: Json,
    private val model: String,
    private val baseUrl: String,
    private val config: SttConfig,
    private val log: VoiceLog,
) : SttSession {
    private val frames = ArrayDeque<ShortArray>()
    private var samples = 0L
    private var warned = false
    @Volatile private var cancelled = false
    override val partial: StateFlow<String> = MutableStateFlow("")

    override suspend fun feed(pcm16: ShortArray) {
        synchronized(frames) {
            frames.addLast(pcm16)
            samples += pcm16.size
            while (samples > MAX_SAMPLES && frames.size > 1) {
                samples -= frames.removeFirst().size
                if (!warned) {
                    warned = true
                    log.log("openai-file: clip over 25 MB, dropping the oldest audio")
                }
            }
        }
    }

    override suspend fun finish(): SttResult {
        if (cancelled) throw SttUnavailable("cancelled")
        val apiKey = key()?.takeIf { it.isNotBlank() } ?: throw SttUnavailable("no OpenAI key")
        val pcm = synchronized(frames) { PcmUtil.concat(frames.toList()) }
        val wav = WavCodec.write(pcm, config.sampleRate)
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("model", model)
            .addFormDataPart("file", "speech.wav", wav.toRequestBody("audio/wav".toMediaType()))
            .addFormDataPart("response_format", "json")
        val keywords = SttText.keywords(config.keywords)
        val prompt = config.prompt?.takeIf { it.isNotBlank() } ?: keywords.joinToString(", ").takeIf { it.isNotEmpty() }
        prompt?.let { body.addFormDataPart("prompt", it) }
        keywords.forEach { body.addFormDataPart("keywords[]", it) }
        SttText.languages(config.languages).forEach { body.addFormDataPart("languages[]", it) }
        val request = Request.Builder()
            .url("$baseUrl/v1/audio/transcriptions")
            .header("Authorization", "Bearer $apiKey")
            .post(body.build())
            .build()
        val response = try {
            client.newCall(request).await()
        } catch (e: IOException) {
            throw SttUnavailable("file transcription failed: ${Redact.text(e.message)}")
        }
        val text = response.use { r ->
            val raw = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw SttUnavailable("file transcription HTTP ${r.code}: ${Redact.text(raw.take(300))}")
            raw
        }
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            ?: throw SttUnavailable("file transcription returned non-JSON")
        val transcript = (obj["text"] as? JsonPrimitive)?.contentOrNull ?: ""
        val language = ((obj["languages"] as? JsonArray)?.firstOrNull() as? JsonObject)
            ?.let { (it["code"] as? JsonPrimitive)?.contentOrNull }
            ?: (obj["language"] as? JsonPrimitive)?.contentOrNull
        return SttResult(transcript.trim(), language, "openai-file", pcm.size * 1000L / config.sampleRate)
    }

    override fun cancel() {
        cancelled = true
    }

    companion object {
        /** 25 MB upload cap minus the 44-byte header, in 16-bit samples. */
        const val MAX_SAMPLES = (25L * 1000 * 1000 - 44) / 2
    }
}
