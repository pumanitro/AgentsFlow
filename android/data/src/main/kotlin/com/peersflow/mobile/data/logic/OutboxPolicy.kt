package com.peersflow.mobile.data.logic

import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.ReplyResponse
import com.peersflow.mobile.wire.SpawnConversationResponse

/**
 * What a flush does with one outbox item after the server answered (or did not).
 *
 * Exactly-once rule: an item leaves the outbox ONLY on [Remove], which only follows an `Ok`. Every
 * retry re-sends the same clientId (= item id), and the server's idempotency turns a retry of a
 * request that already landed into `duplicate = true`.
 */
sealed interface Decision {
    /** Delivered. [duplicate] = the server had already seen this clientId. */
    data class Remove(val duplicate: Boolean) : Decision

    /** Answered but not delivered; try again on the next flush. */
    data class Keep(val attempts: Int, val lastError: String?) : Decision

    /** Cannot be delivered as-is (chat not running / gone); the user must decide (retarget or remove). Skipped by flush. */
    data class KeepNeedsDecision(val lastError: String?) : Decision

    /** Stop the whole flush, leave this and every later item untouched. [transport] = no HTTP answer at all. */
    data class StopFlush(val transport: Boolean, val reason: String) : Decision
}

object OutboxPolicy {
    private val STOP_CODES = setOf("unauthorized", "forbidden", "paused")

    /** An item that cannot even be sent (missing target) — checked before any API call. Null = sendable. */
    fun precheck(item: OutboxItem): Decision? = when (item.kind) {
        OutboxKind.REPLY, OutboxKind.ANSWER ->
            if (item.conversationId == null) Decision.KeepNeedsDecision("no conversation to send to") else null
        OutboxKind.SPAWN ->
            if (item.peerId == null) Decision.KeepNeedsDecision("no peer to start a chat with") else null
    }

    fun decide(item: OutboxItem, result: ApiResult<*>): Decision = when (result) {
        is ApiResult.Ok -> when (val v = result.value) {
            is ReplyResponse ->
                if (v.ok) Decision.Remove(v.duplicate)
                else Decision.Keep(item.attempts + 1, v.error ?: "not delivered")
            is SpawnConversationResponse -> Decision.Remove(v.duplicate)
            else -> Decision.Remove(false)
        }
        is ApiResult.Err -> when {
            result.transport -> Decision.StopFlush(transport = true, reason = result.message)
            result.code == "conflict" -> Decision.KeepNeedsDecision(result.message)
            result.code == "not_found" && item.kind == OutboxKind.REPLY -> Decision.KeepNeedsDecision(result.message)
            result.code in STOP_CODES -> Decision.StopFlush(transport = false, reason = result.code)
            else -> Decision.Keep(item.attempts + 1, result.message)
        }
    }
}
