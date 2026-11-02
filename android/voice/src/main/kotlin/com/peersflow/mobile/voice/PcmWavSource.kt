package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.AudioSource
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.io.File

/** Replays a 16-bit mono WAV in 20 ms frames, paced in real time when [realtime] is true. Used by tests and debug. */
class PcmWavSource(private val file: File, private val realtime: Boolean = true) : AudioSource {
    private val decoded by lazy { WavCodec.read(file.readBytes()) }

    override val sampleRate: Int get() = decoded.first

    override fun frames(): Flow<ShortArray> = flow {
        val (rate, pcm) = decoded
        val frame = rate / 50
        val t0 = System.nanoTime()
        var i = 0
        var n = 0
        while (i < pcm.size) {
            val end = minOf(i + frame, pcm.size)
            emit(pcm.copyOfRange(i, end))
            i = end
            n++
            if (realtime) {
                val due = t0 + n * 20_000_000L
                val waitMs = (due - System.nanoTime()) / 1_000_000L
                if (waitMs > 0) delay(waitMs)
            }
        }
    }
}
