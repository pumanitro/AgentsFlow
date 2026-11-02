package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.TtsHandle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.add
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.ByteArrayOutputStream
import java.io.IOException

internal class RealtimeTtsHandle(
    apiKey: String,
    client: OkHttpClient,
    private val json: Json,
    model: String,
    baseUrl: String,
    private val text: String,
    private val voice: String,
    private val player: PcmSink,
    private val log: VoiceLog,
    private val onComplete: (ByteArray) -> Unit,
) : TtsHandle {
    val firstAudio = CompletableDeferred<Unit>()
    private val done = CompletableDeferred<Unit>()
    private val buffer = ByteArrayOutputStream()
    @Volatile private var stopped = false
    private val socket: WebSocket

    init {
        val request = Request.Builder()
            .url("$baseUrl/v1/realtime?model=$model")
            .header("Authorization", "Bearer $apiKey")
            .build()
        socket = client.newWebSocket(request, Listener())
    }

    override suspend fun await() {
        done.await()
        if (!stopped) player.drain()
    }

    override fun stop() {
        stopped = true
        socket.close(1000, null)
        player.stop()
        firstAudio.completeExceptionally(IOException("stopped"))
        done.complete(Unit)
    }

    private fun fail(reason: String) {
        log.log("openai-realtime: $reason")
        val e = IOException("realtime TTS: $reason")
        firstAudio.completeExceptionally(e)
        done.completeExceptionally(e)
        socket.close(1000, null)
    }

    private fun sessionUpdate() = buildJsonObject {
        put("type", "session.update")
        putJsonObject("session") {
            put("type", "realtime")
            putJsonArray("output_modalities") { add("audio") }
            put("instructions", OpenAiRealtimeTts.INSTRUCTIONS)
            putJsonObject("audio") {
                putJsonObject("output") {
                    putJsonObject("format") {
                        put("type", "audio/pcm")
                        put("rate", 24000)
                    }
                    put("voice", voice)
                }
            }
        }
    }.toString()

    private fun itemCreate() = buildJsonObject {
        put("type", "conversation.item.create")
        putJsonObject("item") {
            put("type", "message")
            put("role", "user")
            putJsonArray("content") {
                addJsonObject {
                    put("type", "input_text")
                    put("text", text)
                }
            }
        }
    }.toString()

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(sessionUpdate())
            webSocket.send(itemCreate())
            webSocket.send("""{"type":"response.create"}""")
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (stopped) return
            val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            when (obj.str("type")) {
                "response.output_audio.delta", "response.audio.delta" -> {
                    val b64 = obj.str("delta") ?: return
                    val pcm = runCatching { PcmUtil.fromBase64(b64) }.getOrNull() ?: return
                    synchronized(buffer) { buffer.write(pcm) }
                    player.write(pcm)
                    firstAudio.complete(Unit)
                }
                "response.done" -> {
                    val response = obj["response"] as? JsonObject
                    val status = response?.str("status")
                    val pcm = synchronized(buffer) { buffer.toByteArray() }
                    webSocket.close(1000, null)
                    if (pcm.isEmpty()) {
                        fail("response finished without audio (status ${status ?: "?"})")
                        return
                    }
                    if (status == null || status == "completed") runCatching { onComplete(pcm) }
                    done.complete(Unit)
                }
                "error" -> {
                    val e = obj["error"] as? JsonObject
                    fail("server error: ${Redact.text(listOfNotNull(e?.str("code"), e?.str("message")).joinToString(": "))}")
                }
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (!done.isCompleted) fail("socket failure: ${Redact.text(t.message)} (http ${response?.code ?: 0})")
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            if (!done.isCompleted) fail("socket closed by server: $code ${Redact.text(reason)}")
        }
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.contentOrNull

}
