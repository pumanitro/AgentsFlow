package com.peersflow.mobile.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WavCodecTest {
    @Test
    fun roundTrip() {
        val pcm = ShortArray(1000) { (it * 37 - 18000).toShort() }
        val wav = WavCodec.write(pcm, 24000)
        assertEquals(44 + 2000, wav.size)
        assertEquals("RIFF", String(wav, 0, 4))
        val (rate, back) = WavCodec.read(wav)
        assertEquals(24000, rate)
        assertArrayEquals(pcm, back)
    }

    @Test
    fun readsAfconvertFixturesWithExtraChunks() {
        for (name in listOf("sample-pl.wav", "sample-en.wav")) {
            val bytes = TestAudio.resource(name).readBytes()
            assertTrue("$name ≤ 300 KB", bytes.size <= 300 * 1024)
            val (rate, pcm) = WavCodec.read(bytes)
            assertEquals(24000, rate)
            val seconds = pcm.size / rate.toDouble()
            assertTrue("$name is $seconds s", seconds in 1.0..6.0)
            assertTrue("$name has signal", pcm.any { kotlin.math.abs(it.toInt()) > 1000 })
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsStereo() {
        val wav = WavCodec.write(ShortArray(10), 24000)
        wav[22] = 2
        WavCodec.read(wav)
    }
}
