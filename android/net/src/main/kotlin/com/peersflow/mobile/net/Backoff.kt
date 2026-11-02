package com.peersflow.mobile.net

import com.peersflow.mobile.wire.ConnectionState
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * Reconnect delays per connection state (PLAN §4.4).
 *
 * - APP_DOWN: 15 s doubling to a 120 s cap.
 * - MAC_OFF: 120 s doubling to a 600 s cap.
 * - PAUSED: a fixed 120 s.
 * - ONLINE, UNPAIRED, UNAUTHORIZED: 0, the caller decides what to do.
 *
 * A change of state category restarts the sequence. Every delay gets ±10 % jitter computed as
 * `delay * 0.1 * (2 * random.nextDouble() - 1)`, so a test double whose `nextDouble()` returns 0.5 gives zero jitter.
 * Not thread-safe; the event stream calls it from its single connect loop.
 */
class Backoff(private val random: Random = Random.Default) {
    private var category: ConnectionState? = null
    private var attempt = 0

    fun next(state: ConnectionState): Long {
        val raw = when (state) {
            ConnectionState.APP_DOWN -> step(state, 15_000L, 120_000L)
            ConnectionState.MAC_OFF -> step(state, 120_000L, 600_000L)
            ConnectionState.PAUSED -> step(state, 120_000L, 120_000L)
            ConnectionState.ONLINE, ConnectionState.UNPAIRED, ConnectionState.UNAUTHORIZED -> return 0L
        }
        val jitter = raw * JITTER * (2.0 * random.nextDouble() - 1.0)
        return (raw + jitter).roundToLong().coerceAtLeast(0L)
    }

    fun reset() {
        category = null
        attempt = 0
    }

    private fun step(state: ConnectionState, base: Long, cap: Long): Long {
        if (state != category) {
            category = state
            attempt = 0
        }
        val value = min(cap, base shl min(attempt, 16))
        attempt++
        return value
    }

    private companion object {
        const val JITTER = 0.1
    }
}
