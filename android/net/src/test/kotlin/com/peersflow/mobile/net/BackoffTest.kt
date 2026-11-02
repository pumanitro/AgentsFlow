package com.peersflow.mobile.net

import com.peersflow.mobile.wire.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class BackoffTest {
    /** nextDouble() = 0.5 ⇒ zero jitter. */
    private val centered = object : Random() {
        override fun nextBits(bitCount: Int): Int = 0
        override fun nextDouble(): Double = 0.5
    }

    @Test
    fun appDownDoublesToTheCap() {
        val b = Backoff(centered)
        val seq = List(5) { b.next(ConnectionState.APP_DOWN) }
        assertEquals(listOf(15_000L, 30_000L, 60_000L, 120_000L, 120_000L), seq)
    }

    @Test
    fun macOffPausedAndZeroStates() {
        val b = Backoff(centered)
        assertEquals(listOf(120_000L, 240_000L, 480_000L, 600_000L, 600_000L), List(5) { b.next(ConnectionState.MAC_OFF) })
        assertEquals(listOf(120_000L, 120_000L, 120_000L), List(3) { b.next(ConnectionState.PAUSED) })
        assertEquals(0L, b.next(ConnectionState.ONLINE))
        assertEquals(0L, b.next(ConnectionState.UNPAIRED))
        assertEquals(0L, b.next(ConnectionState.UNAUTHORIZED))
    }

    @Test
    fun categoryChangeAndResetRestartTheSequence() {
        val b = Backoff(centered)
        b.next(ConnectionState.APP_DOWN)
        b.next(ConnectionState.APP_DOWN)
        assertEquals(120_000L, b.next(ConnectionState.MAC_OFF))
        assertEquals(15_000L, b.next(ConnectionState.APP_DOWN))
        b.next(ConnectionState.APP_DOWN)
        b.reset()
        assertEquals(15_000L, b.next(ConnectionState.APP_DOWN))
    }

    @Test
    fun jitterStaysWithinTenPercent() {
        val b = Backoff(Random(42))
        repeat(200) {
            b.reset()
            val v = b.next(ConnectionState.APP_DOWN)
            assertTrue("$v", v in 13_500L..16_500L)
        }
    }
}
