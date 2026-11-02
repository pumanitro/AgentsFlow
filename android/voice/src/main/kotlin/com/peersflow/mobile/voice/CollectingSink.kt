package com.peersflow.mobile.voice

import java.io.ByteArrayOutputStream

/** JVM sink that keeps every byte; used by tests and the smoke test. */
class CollectingSink : PcmSink {
    private val out = ByteArrayOutputStream()

    /** System.nanoTime() of the first write, or null. */
    @Volatile var firstWriteAtNs: Long? = null
        private set

    @Volatile var stopped = false
        private set

    val bytes: ByteArray get() = synchronized(out) { out.toByteArray() }

    override fun write(bytes: ByteArray) {
        synchronized(out) {
            if (firstWriteAtNs == null) firstWriteAtNs = System.nanoTime()
            out.write(bytes)
        }
    }

    override fun stop() {
        stopped = true
    }

    override suspend fun drain() {}
}
