package com.peersflow.mobile.voice

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.peersflow.mobile.wire.Tts
import com.peersflow.mobile.wire.TtsHandle
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Offline / quiet-hours voice: Android TextToSpeech. Polish diacritics ⇒ pl-PL, otherwise en-US. */
class OnDeviceTts(private val ctx: Context) : Tts {
    override val id: String = "on-device"
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    private var engine: TextToSpeech? = null
    private var ready: CompletableDeferred<TextToSpeech>? = null

    private suspend fun tts(): TextToSpeech {
        val existing = synchronized(this) {
            ready ?: CompletableDeferred<TextToSpeech>().also { d ->
                ready = d
                withMainPost {
                    var created: TextToSpeech? = null
                    created = TextToSpeech(ctx) { status ->
                        val t = created
                        if (status == TextToSpeech.SUCCESS && t != null) {
                            t.setOnUtteranceProgressListener(listener)
                            d.complete(t)
                        } else {
                            synchronized(this) { ready = null }
                            d.completeExceptionally(IOException("TextToSpeech init failed: $status"))
                        }
                    }
                    engine = created
                }
            }
        }
        return existing.await()
    }

    private fun withMainPost(block: () -> Unit) {
        android.os.Handler(android.os.Looper.getMainLooper()).post(block)
    }

    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}

        override fun onDone(utteranceId: String?) {
            utteranceId?.let { pending.remove(it)?.complete(Unit) }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            utteranceId?.let { pending.remove(it)?.completeExceptionally(IOException("TextToSpeech error")) }
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            utteranceId?.let { pending.remove(it)?.completeExceptionally(IOException("TextToSpeech error $errorCode")) }
        }

        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            utteranceId?.let { pending.remove(it)?.complete(Unit) }
        }
    }

    override suspend fun speak(text: String, voice: String?): TtsHandle {
        val t = tts()
        val id = UUID.randomUUID().toString()
        val done = CompletableDeferred<Unit>()
        pending[id] = done
        val rc = withContext(Dispatchers.Main) {
            t.language = if (POLISH.containsMatchIn(text)) Locale("pl", "PL") else Locale.US
            t.speak(text, TextToSpeech.QUEUE_ADD, null, id)
        }
        if (rc != TextToSpeech.SUCCESS) {
            pending.remove(id)
            throw IOException("TextToSpeech.speak failed: $rc")
        }
        return object : TtsHandle {
            override suspend fun await() = done.await()

            override fun stop() {
                t.stop()
                pending.remove(id)?.complete(Unit)
            }
        }
    }

    companion object {
        private val POLISH = Regex("[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]")
    }
}
