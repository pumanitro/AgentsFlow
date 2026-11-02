package com.peersflow.mobile.voice

/** Where synthesized PCM16 (little-endian, 24 kHz mono) goes. [write] must not block for long. */
interface PcmSink {
    fun write(bytes: ByteArray)

    fun stop()

    /** Suspends until everything written so far has been played. */
    suspend fun drain()
}
