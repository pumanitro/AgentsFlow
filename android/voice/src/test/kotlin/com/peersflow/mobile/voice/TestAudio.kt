package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.AudioSource
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.asFlow
import java.io.File
import kotlin.math.PI
import kotlin.math.sin

object TestAudio {
    fun resource(name: String): File =
        File(requireNotNull(TestAudio::class.java.classLoader!!.getResource(name)) { "missing resource $name" }.toURI())

    fun silence(ms: Int, rate: Int = 24000) = ShortArray(rate * ms / 1000)

    fun tone(ms: Int, rate: Int = 24000, hz: Double = 440.0, amp: Double = 3000.0) =
        ShortArray(rate * ms / 1000) { i -> (amp * sin(2 * PI * hz * i / rate)).toInt().toShort() }

    fun frames(pcm: ShortArray, rate: Int = 24000): List<ShortArray> =
        pcm.toList().chunked(rate / 50).map { it.toShortArray() }

    /** Frame i is filled with the value i, so order and completeness are easy to check. */
    fun numbered(count: Int, rate: Int = 24000): List<ShortArray> = List(count) { i -> ShortArray(rate / 50) { i.toShort() } }

    class ListSource(private val list: List<ShortArray>, override val sampleRate: Int = 24000) : AudioSource {
        override fun frames(): Flow<ShortArray> = list.asFlow()
    }
}
