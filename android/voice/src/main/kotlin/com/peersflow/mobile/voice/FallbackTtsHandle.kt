package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.TtsHandle
import kotlinx.coroutines.CancellationException

/** Wraps a cloud handle; if its playback fails, speaks the text again through [fallback]. */
internal class FallbackTtsHandle(
    private val primary: TtsHandle,
    private val log: VoiceLog,
    private val fallback: suspend () -> TtsHandle?,
) : TtsHandle {
    @Volatile private var stopped = false
    @Volatile private var second: TtsHandle? = null

    override suspend fun await() {
        try {
            primary.await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (stopped) return
            log.log("cloud TTS dropped mid-utterance, using on-device: ${Redact.text(e.message)}")
            val h = fallback() ?: throw e
            second = h
            if (stopped) h.stop() else h.await()
        }
    }

    override fun stop() {
        stopped = true
        primary.stop()
        second?.stop()
    }
}
