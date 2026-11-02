package com.peersflow.mobile.data

import com.peersflow.mobile.data.db.Mappers
import com.peersflow.mobile.data.db.OutboxDao
import com.peersflow.mobile.data.logic.Decision
import com.peersflow.mobile.data.logic.OutboxPolicy
import com.peersflow.mobile.wire.AnswerRequest
import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.Outbox
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.ReplyRequest
import com.peersflow.mobile.wire.SpawnConversationRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.sync.Mutex
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Room-backed outbox. Items leave only after an `Ok` from the server (see [OutboxPolicy]); the item id is the
 * clientId, so a retry of a request whose response was lost comes back as `duplicate` and is still removed once.
 *
 * [flush] is single-flight: a call while another flush runs returns `FlushReport(0, 0, 0, false)` at once, and
 * the running flush makes one more pass so an item enqueued meanwhile is not left behind.
 */
class OutboxImpl(
    private val dao: OutboxDao,
    private val api: ApiClient,
    private val clock: () -> Long = System::currentTimeMillis,
) : Outbox {

    private val mutex = Mutex()
    private val again = AtomicBoolean(false)

    override val items: Flow<List<OutboxItem>> =
        dao.observeAll().map { rows -> rows.mapNotNull(Mappers::outbox).sortedBy { it.createdAt } }

    override suspend fun enqueue(item: OutboxItem) = dao.upsert(Mappers.outbox(item))

    override suspend fun remove(id: String) = dao.delete(id)

    override suspend fun retarget(id: String, peerId: String) {
        val row = dao.get(id)?.let(Mappers::outbox) ?: return
        val spawn = row.copy(
            kind = OutboxKind.SPAWN, conversationId = null, peerId = peerId,
            needsDecision = false, lastError = null,
        )
        dao.upsert(Mappers.outbox(spawn))
    }

    override suspend fun flush(): FlushReport {
        if (!mutex.tryLock()) {
            again.set(true)
            return FlushReport(0, 0, 0, false)
        }
        var total = FlushReport(0, 0, 0, false)
        try {
            do {
                again.set(false)
                val pass = onePass()
                total = FlushReport(
                    sent = total.sent + pass.report.sent,
                    duplicates = total.duplicates + pass.report.duplicates,
                    failed = total.failed + pass.report.failed,
                    stoppedOnTransport = pass.report.stoppedOnTransport,
                )
                if (pass.stopped) break
            } while (again.get())
        } finally {
            mutex.unlock()
        }
        return total
    }

    private class Pass(val report: FlushReport, val stopped: Boolean)

    private suspend fun onePass(): Pass {
        var sent = 0
        var duplicates = 0
        var failed = 0
        val queue = dao.all().mapNotNull(Mappers::outbox).filterNot { it.needsDecision }.sortedBy { it.createdAt }
        for (item in queue) {
            val decision = OutboxPolicy.precheck(item) ?: OutboxPolicy.decide(item, call(item))
            when (decision) {
                is Decision.Remove -> {
                    dao.delete(item.id)
                    if (decision.duplicate) duplicates++ else sent++
                }
                is Decision.Keep -> {
                    dao.markFailure(item.id, decision.attempts, decision.lastError, needsDecision = false)
                    failed++
                }
                is Decision.KeepNeedsDecision -> {
                    dao.markFailure(item.id, item.attempts, decision.lastError, needsDecision = true)
                    failed++
                }
                is Decision.StopFlush ->
                    return Pass(FlushReport(sent, duplicates, failed, stoppedOnTransport = decision.transport), stopped = true)
            }
        }
        return Pass(FlushReport(sent, duplicates, failed, false), stopped = false)
    }

    private suspend fun call(item: OutboxItem): ApiResult<*> = try {
        when (item.kind) {
            OutboxKind.REPLY -> api.reply(item.conversationId!!, ReplyRequest(item.text, item.source, clientId = item.id))
            OutboxKind.ANSWER -> api.answer(item.conversationId!!, AnswerRequest(null, item.text, item.source, item.id))
            OutboxKind.SPAWN -> api.spawn(
                SpawnConversationRequest(
                    peerId = item.peerId!!, prompt = item.text, kind = item.chatKind, model = null,
                    contract = if (item.chatKind == "voice") "until-done" else null,
                    clientId = item.id, spokenAt = item.spokenAt, source = item.source,
                ),
            )
        }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        // An ApiClient should never throw; if it does we cannot know whether the request landed, so treat it as
        // "no answer" — the item stays and the clientId makes the retry safe.
        ApiResult.Err("transport", e.message ?: e.toString(), transport = true)
    }
}
