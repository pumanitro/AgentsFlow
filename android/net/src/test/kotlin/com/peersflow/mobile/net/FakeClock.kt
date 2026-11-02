package com.peersflow.mobile.net

import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.coroutines.resume

/** Manual clock: delays resume only when [advance] moves time past their deadline. Records requested and cancelled delays. */
class FakeClock : Clock {
    private class Waiter(val deadline: Long, val ms: Long, val cont: CancellableContinuation<Unit>)

    private val lock = Any()
    private var nowMs = 0L
    private val waiters = mutableListOf<Waiter>()
    val requested = CopyOnWriteArrayList<Long>()
    val cancelled = CopyOnWriteArrayList<Long>()

    override fun now(): Long = synchronized(lock) { nowMs }

    override suspend fun delay(ms: Long) {
        requested.add(ms)
        suspendCancellableCoroutine { cont ->
            val w = synchronized(lock) { Waiter(nowMs + ms, ms, cont).also { waiters.add(it) } }
            cont.invokeOnCancellation {
                synchronized(lock) { waiters.remove(w) }
                cancelled.add(ms)
            }
        }
    }

    fun advance(ms: Long) {
        val due = synchronized(lock) {
            nowMs += ms
            waiters.filter { it.deadline <= nowMs }.also { waiters.removeAll(it) }
        }
        due.forEach { it.cont.resume(Unit) }
    }

    fun pending(): List<Long> = synchronized(lock) { waiters.map { it.ms } }

    /** Polls (real time) until a pending delay matches [predicate]; returns it. */
    fun awaitPending(timeoutMs: Long = 5_000, predicate: (Long) -> Boolean): Long {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            pending().firstOrNull(predicate)?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("no pending delay matched; pending=${pending()} requested=$requested")
    }
}
