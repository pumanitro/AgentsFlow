package com.peersflow.mobile.data

import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.ReplyResponse
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxImplTest {
    private val dao = MemOutboxDao()
    private val api = ScriptedApiClient()
    private val outbox = OutboxImpl(dao, api)

    private fun reply(id: String, at: Long) = OutboxItem(id, OutboxKind.REPLY, "c1", null, "text-$id", "phone", createdAt = at)

    @Test fun flushSendsInCreatedAtOrder() = runTest {
        outbox.enqueue(reply("b", 20))
        outbox.enqueue(reply("c", 30))
        outbox.enqueue(reply("a", 10))

        val report = outbox.flush()

        assertEquals(listOf("a", "b", "c"), api.calls.map { it.second })
        assertEquals(FlushReport(sent = 3, duplicates = 0, failed = 0, stoppedOnTransport = false), report)
        assertTrue(outbox.items.first().isEmpty())
    }

    @Test fun transportOnFirstItemSendsNothingAndKeepsAll() = runTest {
        outbox.enqueue(reply("a", 10))
        outbox.enqueue(reply("b", 20))
        api.replyScript += ApiResult.Err("transport", "timeout", transport = true)

        val report = outbox.flush()

        assertEquals(listOf("a"), api.calls.map { it.second })   // b never attempted
        assertEquals(FlushReport(0, 0, 0, stoppedOnTransport = true), report)
        val left = outbox.items.first()
        assertEquals(listOf("a", "b"), left.map { it.id })
        assertEquals(listOf(0, 0), left.map { it.attempts })     // untouched
    }

    @Test fun landedButResponseLostIsRemovedExactlyOnce() = runTest {
        outbox.enqueue(reply("a", 10))
        api.replyScript += ApiResult.Err("transport", "connection reset", transport = true)
        api.replyScript += ApiResult.Ok(ReplyResponse(ok = true, duplicate = true))

        val first = outbox.flush()
        assertTrue(first.stoppedOnTransport)
        assertEquals(1, outbox.items.first().size)

        val second = outbox.flush()
        assertEquals(FlushReport(sent = 0, duplicates = 1, failed = 0, stoppedOnTransport = false), second)
        assertTrue(outbox.items.first().isEmpty())

        // both attempts carried the same clientId, so the server could dedupe
        assertEquals(listOf("a", "a"), api.calls.map { it.second })
        val third = outbox.flush()
        assertEquals(FlushReport(0, 0, 0, false), third)
        assertEquals(2, api.calls.size)
    }

    @Test fun conflictNeedsDecisionThenRetargetSpawnsWithSameClientId() = runTest {
        outbox.enqueue(reply("a", 10))
        api.replyScript += ApiResult.Err("conflict", "chat is not running", status = 409)

        val report = outbox.flush()
        assertEquals(1, report.failed)
        val stuck = outbox.items.first().single()
        assertTrue(stuck.needsDecision)
        assertEquals("chat is not running", stuck.lastError)

        // needsDecision items are skipped by flush
        outbox.flush()
        assertEquals(1, api.calls.size)

        outbox.retarget("a", "peer-lisa")
        val retargeted = outbox.items.first().single()
        assertEquals(OutboxKind.SPAWN, retargeted.kind)
        assertEquals(null, retargeted.conversationId)
        assertEquals("peer-lisa", retargeted.peerId)

        val after = outbox.flush()
        assertEquals(1, after.sent)
        assertEquals(Triple("spawn", "a", "text-a"), api.calls.last())
        assertEquals("peer-lisa", api.spawnRequests.single().peerId)
        assertEquals("a", api.spawnRequests.single().clientId)
        assertTrue(outbox.items.first().isEmpty())
    }

    @Test fun okFalseKeepsAndCountsAttempt() = runTest {
        outbox.enqueue(reply("a", 10))
        api.replyScript += ApiResult.Ok(ReplyResponse(ok = false, error = "no PTY capacity"))

        val report = outbox.flush()

        assertEquals(1, report.failed)
        val kept = outbox.items.first().single()
        assertEquals(1, kept.attempts)
        assertEquals("no PTY capacity", kept.lastError)
    }

    @Test fun voiceSpawnCarriesUntilDoneContract() = runTest {
        outbox.enqueue(OutboxItem("v", OutboxKind.SPAWN, null, "p1", "do it", "voice", chatKind = "voice", spokenAt = "2026-10-28T08:00:00Z", createdAt = 1))
        outbox.flush()
        val req = api.spawnRequests.single()
        assertEquals("until-done", req.contract)
        assertEquals("2026-10-28T08:00:00Z", req.spokenAt)
        assertEquals("voice", req.kind)
    }
}
