package com.peersflow.mobile.net

/** Time source for the event stream, injected so tests never sleep. */
interface Clock {
    fun now(): Long

    /** Suspends for [ms]; must be cancellable, because `kick()` cancels a pending backoff delay. */
    suspend fun delay(ms: Long)

    companion object {
        val SYSTEM: Clock = object : Clock {
            override fun now(): Long = System.currentTimeMillis()
            override suspend fun delay(ms: Long) = kotlinx.coroutines.delay(ms)
        }
    }
}
