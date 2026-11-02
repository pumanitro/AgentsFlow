package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.AudioSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** Emits [frameCount] all-zero 20 ms frames at 24 kHz (480 samples each). */
class SilentAudioSource(private val frameCount: Int = 50) : AudioSource {
    override val sampleRate: Int = 24_000

    override fun frames(): Flow<ShortArray> = flow {
        repeat(frameCount) { emit(ShortArray(sampleRate / 50)) }
    }
}
