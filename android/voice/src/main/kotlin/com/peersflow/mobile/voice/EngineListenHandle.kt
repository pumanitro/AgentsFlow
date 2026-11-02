package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.ListenHandle
import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttProvider
import com.peersflow.mobile.wire.SttResult
import com.peersflow.mobile.wire.SttSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch

/**
 * One listening turn. Keeps its own copy of every captured frame so a failed live session can be redone on the
 * file provider. The on-device recognizer captures the mic itself, so the source is not collected for it.
 */
internal class EngineListenHandle(
    private val config: SttConfig,
    private val source: AudioSource,
    private val onPartial: (String) -> Unit,
    primary: SttProvider?,
    private val fallback: SttProvider?,
    private val scope: CoroutineScope,
    private val log: VoiceLog,
) : ListenHandle {
    private val end = MutableSharedFlow<Unit>(replay = 1, extraBufferCapacity = 1)
    override val endOfSpeech: Flow<Unit> = end
    private val captured = ArrayList<ShortArray>()
    private val vad = Vad(config.sampleRate)
    @Volatile private var provider: SttProvider? = primary
    @Volatile private var session: SttSession? = null
    @Volatile private var failure: Throwable? = null
    @Volatile private var partialJob: Job? = null
    // ATOMIC + NonCancellable start: a finish() straight after listen() still gets a session to finish.
    private val pump: Job = scope.launch(start = CoroutineStart.ATOMIC) { run(primary) }

    private suspend fun run(primary: SttProvider?) {
        if (primary == null) {
            failure = IllegalStateException("no speech-to-text provider available")
            return
        }
        val ok = withContext(NonCancellable) {
            try {
                attach(primary, primary.start(config))
                true
            } catch (e: Exception) {
                switchToFallback(e)
            }
        }
        if (!ok) return
        if (provider?.id == "on-device") return
        try {
            source.frames().collect { frame ->
                synchronized(captured) { captured += frame }
                if (vad.push(frame) == VadEvent.SpeechEnd) end.tryEmit(Unit)
                feed(frame)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            log.log("audio source failed: ${e.javaClass.simpleName}: ${e.message}")
        }
    }

    private fun attach(p: SttProvider, s: SttSession) {
        provider = p
        session = s
        partialJob?.cancel()
        partialJob = scope.launch {
            s.partial.collect { if (it.isNotEmpty()) onPartial(it) }
        }
    }

    private suspend fun feed(frame: ShortArray) {
        val s = session ?: return
        try {
            s.feed(frame)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            switchToFallback(e)
        }
    }

    /** Moves to the file provider and replays every captured frame. Returns false when there is nowhere to go. */
    private suspend fun switchToFallback(cause: Exception): Boolean {
        val fb = fallback
        val from = provider
        session?.cancel()
        session = null
        if (fb == null || fb === from || (cause !is SttUnavailable && cause !is SttDropped)) {
            failure = cause
            return false
        }
        log.log("${from?.id} failed (${cause.message}); falling back to ${fb.id}")
        val frames = synchronized(captured) {
            if (cause is SttDropped) cause.buffered + captured.drop(cause.buffered.size) else captured.toList()
        }
        return try {
            val s = fb.start(config)
            attach(fb, s)
            for (f in frames) s.feed(f)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e
            session = null
            false
        }
    }

    override suspend fun finish(): SttResult {
        pump.cancelAndJoin()
        try {
            val s = session ?: throw (failure ?: IllegalStateException("speech-to-text not started"))
            return try {
                s.finish()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (!switchToFallback(e)) throw e
                (session ?: throw e).finish()
            }
        } finally {
            partialJob?.cancel()
        }
    }

    override fun cancel() {
        pump.cancel()
        session?.cancel()
        partialJob?.cancel()
    }
}
