package com.peersflow.mobile.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttProvider
import com.peersflow.mobile.wire.SttResult
import com.peersflow.mobile.wire.SttSession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/**
 * Offline fallback: Android's SpeechRecognizer (on-device when available). It captures the mic itself, so
 * [SttSession.feed] is ignored. Recognizer errors become [SttUnavailable].
 */
class OnDeviceStt(private val ctx: Context) : SttProvider {
    override val id: String = "on-device"

    override suspend fun start(config: SttConfig): SttSession = withContext(Dispatchers.Main) {
        // The phone's standard recognizer first (Google speech services: free, no key, good Polish, uses the
        // network when it has it). The offline-only recognizer is the last resort: on Samsung it often has no
        // Polish model downloaded and fails with LANGUAGE_UNAVAILABLE — the "Could not transcribe" of 2026-11-02.
        val recognizer = if (SpeechRecognizer.isRecognitionAvailable(ctx)) {
            SpeechRecognizer.createSpeechRecognizer(ctx)
        } else if (SpeechRecognizer.isOnDeviceRecognitionAvailable(ctx)) {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(ctx)
        } else {
            throw SttUnavailable("no speech recognizer on this device")
        }
        val session = Session(recognizer)
        recognizer.setRecognitionListener(session)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale(config.languages.firstOrNull() ?: "pl"))
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, locale(config.languages.firstOrNull() ?: "pl"))
            .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
        recognizer.startListening(intent)
        session
    }

    private fun locale(lang: String): String = when (lang.lowercase()) {
        "pl" -> "pl-PL"
        "en" -> "en-US"
        else -> lang
    }

    private class Session(private val recognizer: SpeechRecognizer) : SttSession, RecognitionListener {
        private val startedAt = System.currentTimeMillis()
        private val _partial = MutableStateFlow("")
        override val partial: StateFlow<String> = _partial
        private val result = CompletableDeferred<String>()

        override suspend fun feed(pcm16: ShortArray) {}

        override suspend fun finish(): SttResult {
            withContext(Dispatchers.Main) { if (!result.isCompleted) recognizer.stopListening() }
            val text = try {
                withTimeout(10_000) { result.await() }
            } catch (_: TimeoutCancellationException) {
                throw SttUnavailable("on-device recognizer timeout")
            } finally {
                withContext(Dispatchers.Main) { recognizer.destroy() }
            }
            return SttResult(text.trim(), null, "on-device", System.currentTimeMillis() - startedAt)
        }

        override fun cancel() {
            result.completeExceptionally(SttUnavailable("cancelled"))
            android.os.Handler(android.os.Looper.getMainLooper()).post {
                recognizer.cancel()
                recognizer.destroy()
            }
        }

        private fun first(bundle: Bundle?): String? =
            bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

        override fun onResults(results: Bundle?) {
            result.complete(first(results) ?: _partial.value)
        }

        override fun onPartialResults(partialResults: Bundle?) {
            first(partialResults)?.let { _partial.value = it }
        }

        override fun onError(error: Int) {
            result.completeExceptionally(SttUnavailable("on-device recognizer error ${errorName(error)}"))
        }

        private fun errorName(e: Int) = when (e) {
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "NETWORK_TIMEOUT"
            SpeechRecognizer.ERROR_NETWORK -> "NETWORK"
            SpeechRecognizer.ERROR_AUDIO -> "AUDIO"
            SpeechRecognizer.ERROR_SERVER -> "SERVER"
            SpeechRecognizer.ERROR_CLIENT -> "CLIENT"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "SPEECH_TIMEOUT"
            SpeechRecognizer.ERROR_NO_MATCH -> "NO_MATCH"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "RECOGNIZER_BUSY"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "INSUFFICIENT_PERMISSIONS"
            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "LANGUAGE_NOT_SUPPORTED"
            SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "LANGUAGE_UNAVAILABLE"
            else -> e.toString()
        }

        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}
