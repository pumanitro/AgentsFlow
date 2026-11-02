package com.peersflow.mobile.data

import com.peersflow.mobile.data.logic.Decision
import com.peersflow.mobile.data.logic.OutboxPolicy
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.ReplyResponse
import com.peersflow.mobile.wire.SpawnConversationResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class OutboxPolicyTest {
    private val reply = OutboxItem("r1", OutboxKind.REPLY, "c1", null, "hi", "phone", createdAt = 1, attempts = 2)
    private val answer = reply.copy(id = "a1", kind = OutboxKind.ANSWER)
    private val spawn = OutboxItem("s1", OutboxKind.SPAWN, null, "p1", "go", "voice", chatKind = "voice", createdAt = 1)

    private fun err(code: String, transport: Boolean = false) = ApiResult.Err(code, "msg-$code", transport = transport)

    @Test fun replyOkRemoves() =
        assertEquals(Decision.Remove(false), OutboxPolicy.decide(reply, ApiResult.Ok(ReplyResponse(ok = true))))

    @Test fun replyOkDuplicateRemovesAsDuplicate() =
        assertEquals(Decision.Remove(true), OutboxPolicy.decide(reply, ApiResult.Ok(ReplyResponse(ok = true, duplicate = true))))

    @Test fun replyOkFalseKeepsWithAttempt() =
        assertEquals(Decision.Keep(3, "no pty"), OutboxPolicy.decide(reply, ApiResult.Ok(ReplyResponse(ok = false, error = "no pty"))))

    @Test fun spawnOkRemoves() {
        assertEquals(Decision.Remove(false), OutboxPolicy.decide(spawn, ApiResult.Ok(SpawnConversationResponse("x"))))
        assertEquals(Decision.Remove(true), OutboxPolicy.decide(spawn, ApiResult.Ok(SpawnConversationResponse("x", duplicate = true))))
    }

    @Test fun transportStops() {
        for (item in listOf(reply, answer, spawn)) {
            assertEquals(Decision.StopFlush(true, "msg-transport"), OutboxPolicy.decide(item, err("transport", transport = true)))
        }
    }

    @Test fun conflictNeedsDecision() {
        for (item in listOf(reply, answer, spawn)) {
            assertEquals(Decision.KeepNeedsDecision("msg-conflict"), OutboxPolicy.decide(item, err("conflict")))
        }
    }

    @Test fun notFoundOnReplyNeedsDecisionElsewhereKeeps() {
        assertEquals(Decision.KeepNeedsDecision("msg-not_found"), OutboxPolicy.decide(reply, err("not_found")))
        assertEquals(Decision.Keep(3, "msg-not_found"), OutboxPolicy.decide(answer, err("not_found")))
        assertEquals(Decision.Keep(1, "msg-not_found"), OutboxPolicy.decide(spawn, err("not_found")))
    }

    @Test fun authAndPauseStop() {
        for (code in listOf("unauthorized", "forbidden", "paused")) {
            assertEquals(Decision.StopFlush(false, code), OutboxPolicy.decide(reply, err(code)))
        }
    }

    @Test fun otherErrorKeepsWithAttempt() =
        assertEquals(Decision.Keep(3, "msg-internal"), OutboxPolicy.decide(reply, err("internal")))

    @Test fun precheckRejectsMissingTarget() {
        assertNull(OutboxPolicy.precheck(reply))
        assertNull(OutboxPolicy.precheck(spawn))
        assert(OutboxPolicy.precheck(reply.copy(conversationId = null)) is Decision.KeepNeedsDecision)
        assert(OutboxPolicy.precheck(spawn.copy(peerId = null)) is Decision.KeepNeedsDecision)
    }
}
