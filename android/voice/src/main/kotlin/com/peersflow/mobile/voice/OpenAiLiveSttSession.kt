package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttResult
import com.peersflow.mobile.wire.SttSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

internal class OpenAiLiveSttSession(
    apiKey: String,
    client: OkHttpClient,
    private val json: Json,
    private val model: String,
    connectTimeoutMs: Long,
    baseUrl: String,
    private val config: SttConfig,
    private val log: VoiceLog,
) : SttSession {
    private val lock = Any()
    private val fed = ArrayList<ShortArray>()          // every frame fed, for SttDropped
    private val pending = ArrayList<ShortArray>()      // not yet sent (socket closed, or batch not full)
    private var open = false
    private var failure: String? = null
    private var committed = false
    private var samples = 0L
    private val deadline = System.nanoTime() + connectTimeoutMs * 1_000_000L
    private val opened = CompletableDeferred<Boolean>()
    private val completed = CompletableDeferred<String>()
    private val _partial = MutableStateFlow("")
    override val partial: StateFlow<String> = _partial

    private val socket: WebSocket

    init {
        val request = Request.Builder()
            .url("$baseUrl/v1/realtime?intent=transcription")
            .header("Authorization", "Bearer $apiKey")
            .build()
        socket = client.newWebSocket(request, Listener())
    }

    private fun sessionUpdate(): String = buildJsonObject {
        put("type", "session.update")
        putJsonObject("session") {
            put("type", "transcription")
            putJsonObject("audio") {
                putJsonObject("input") {
                    putJsonObject("format") {
                        put("type", "audio/pcm")
                        put("rate", config.sampleRate)
                    }
                    putJsonObject("noise_reduction") { put("type", "near_field") }
                    putJsonObject("transcription") {
                        put("model", model)
                        val langs = SttText.languages(config.languages)
                        if (langs.isNotEmpty()) put("languages", JsonArray(langs.map(::JsonPrimitive)))
                        val kws = SttText.keywords(config.keywords)
                        if (kws.isNotEmpty()) put("keywords", JsonArray(kws.map(::JsonPrimitive)))
                        config.prompt?.takeIf { it.isNotBlank() }?.let { put("prompt", it) }
                        put("delay", "low")
                    }
                    put("turn_detection", JsonNull)
                }
            }
        }
    }.toString()

    private fun appendMessage(frames: List<ShortArray>): String =
        """{"type":"input_audio_buffer.append","audio":"${PcmUtil.base64(PcmUtil.concat(frames))}"}"""

    /** Sends full batches of [BATCH] frames; with [all] also the remainder. Caller holds [lock]. */
    private fun flushLocked(all: Boolean) {
        if (!open) return
        while (pending.size >= BATCH || (all && pending.isNotEmpty())) {
            val n = minOf(BATCH, pending.size)
            val batch = pending.subList(0, n).toList()
            pending.subList(0, n).clear()
            socket.send(appendMessage(batch))
        }
    }

    override suspend fun feed(pcm16: ShortArray) {
        synchronized(lock) {
            failure?.let { reason ->
                if (open) throw SttDropped(fed.toList(), "live dropped: $reason")
                throw SttUnavailable("live unavailable: $reason")
            }
            if (!open && System.nanoTime() > deadline) throw SttUnavailable("live connect timeout")
            fed += pcm16
            pending += pcm16
            samples += pcm16.size
            flushLocked(all = false)
        }
    }

    override suspend fun finish(): SttResult {
        val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
        val isOpen = try {
            withTimeout(maxOf(1L, remainingMs)) { opened.await() }
        } catch (_: TimeoutCancellationException) {
            false
        }
        synchronized(lock) {
            if (!isOpen || !open) {
                failure?.let { throw SttUnavailable("live unavailable: $it") }
                throw SttUnavailable("live connect timeout")
            }
            failure?.let { throw SttDropped(fed.toList(), "live dropped: $it") }
            flushLocked(all = true)
            committed = true
            socket.send("""{"type":"input_audio_buffer.commit"}""")
        }
        val text = try {
            withTimeout(FINAL_TIMEOUT_MS) { completed.await() }
        } catch (_: TimeoutCancellationException) {
            socket.close(1000, null)
            throw SttDropped(synchronized(lock) { fed.toList() }, "live final transcript timeout")
        }
        socket.close(1000, null)
        val durationMs = samples * 1000L / config.sampleRate
        return SttResult(text.trim(), null, "openai-live", durationMs)
    }

    override fun cancel() {
        socket.close(1000, null)
        synchronized(lock) { failure = failure ?: "cancelled" }
        opened.complete(false)
        completed.completeExceptionally(SttUnavailable("cancelled"))
    }

    private fun fail(reason: String) {
        val dropped = synchronized(lock) {
            if (failure == null) failure = reason
            log.log("openai-live: $reason")
            SttDropped(fed.toList(), "live dropped: $reason")
        }
        opened.complete(false)
        completed.completeExceptionally(dropped)
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                if (failure != null) return
                webSocket.send(sessionUpdate())
                open = true
                flushLocked(all = committed)
            }
            opened.complete(true)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            when (obj.str("type")) {
                "conversation.item.input_audio_transcription.delta" ->
                    obj.str("delta")?.let { d -> _partial.value = _partial.value + d }
                "conversation.item.input_audio_transcription.completed" ->
                    completed.complete(obj.str("transcript") ?: _partial.value)
                "conversation.item.input_audio_transcription.failed" ->
                    fail("transcription failed: ${Redact.text(errorMessage(obj))}")
                "error" -> fail("server error: ${Redact.text(errorMessage(obj))}")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            fail("socket failure: ${Redact.text(t.message)} (http ${response?.code ?: 0})")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            if (!completed.isCompleted) fail("socket closed by server: $code ${Redact.text(reason)}")
        }
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull

    private fun errorMessage(obj: JsonObject): String {
        val e = obj["error"] as? JsonObject ?: return "unknown"
        return listOfNotNull(e.str("code"), e.str("message")).joinToString(": ")
    }

    companion object {
        const val BATCH = 5
        const val FINAL_TIMEOUT_MS = 15_000L
    }
}
