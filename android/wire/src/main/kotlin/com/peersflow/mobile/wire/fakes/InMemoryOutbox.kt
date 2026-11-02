package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.Outbox
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import kotlinx.coroutines.flow.MutableStateFlow

/** List-backed outbox. [flush] hands each item, oldest first, to [sender]; a transport error stops the flush. */
class InMemoryOutbox(
    var sender: (OutboxItem) -> ApiResult<Unit> = { ApiResult.Ok(Unit) },
) : Outbox {
    override val items = MutableStateFlow<List<OutboxItem>>(emptyList())

    override suspend fun enqueue(item: OutboxItem) {
        items.value = items.value.filterNot { it.id == item.id } + item
    }

    override suspend fun remove(id: String) {
        items.value = items.value.filterNot { it.id == id }
    }

    override suspend fun retarget(id: String, peerId: String) {
        items.value = items.value.map {
            if (it.id == id) it.copy(kind = OutboxKind.SPAWN, peerId = peerId, conversationId = null, needsDecision = false) else it
        }
    }

    override suspend fun flush(): FlushReport {
        var sent = 0
        var failed = 0
        for (item in items.value.sortedBy { it.createdAt }) {
            when (val r = sender(item)) {
                is ApiResult.Ok -> {
                    sent++
                    remove(item.id)
                }
                is ApiResult.Err -> {
                    if (r.transport) return FlushReport(sent, 0, failed, stoppedOnTransport = true)
                    failed++
                    items.value = items.value.map {
                        if (it.id == item.id) it.copy(attempts = it.attempts + 1, lastError = r.message) else it
                    }
                }
            }
        }
        return FlushReport(sent, 0, failed, stoppedOnTransport = false)
    }
}
