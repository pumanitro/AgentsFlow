package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.SendResult
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

/** State-flow backed repository; tests set the flows directly. Every command answers `Sent("fake")`. */
class InMemoryConversationRepository(
    initialPeers: List<PeerSummary> = emptyList(),
    initialSummaries: List<ConversationSummary> = emptyList(),
) : ConversationRepository {
    val peerList = MutableStateFlow(initialPeers)
    val summaryList = MutableStateFlow(initialSummaries)
    val details = MutableStateFlow<Map<String, ConversationDetail>>(emptyMap())
    val messageMap = MutableStateFlow<Map<String, List<MessageEntry>>>(emptyMap())
    val opened = mutableSetOf<String>()

    /** Every command the repository received, newest last: (command, id-or-peer, text). */
    val commands = mutableListOf<Triple<String, String, String>>()

    override fun peers(): Flow<List<PeerSummary>> = peerList

    override fun summaries(): Flow<List<ConversationSummary>> = summaryList

    override fun detail(id: String): Flow<ConversationDetail?> = details.map { d ->
        d[id] ?: summaryList.value.firstOrNull { it.id == id }?.let { ConversationDetail(it) }
    }

    override fun messages(id: String): Flow<List<MessageEntry>> = messageMap.map { it[id].orEmpty() }

    override suspend fun refresh(): Boolean = true

    override suspend fun loadOlder(id: String): Boolean = false

    override fun open(id: String) {
        opened += id
    }

    override fun close(id: String) {
        opened -= id
    }

    override suspend fun send(id: String, text: String, source: String): SendResult = record("send", id, text)

    override suspend fun answer(id: String, questionId: String?, text: String, source: String): SendResult =
        record("answer", id, text)

    override suspend fun stop(id: String): SendResult = record("stop", id, "")

    override suspend fun done(id: String): SendResult = record("done", id, "")

    override suspend fun reopen(id: String): SendResult = record("reopen", id, "")

    override suspend fun startChat(peerId: String, prompt: String, kind: String, spokenAt: String?, source: String): SendResult =
        record("startChat", peerId, prompt)

    private fun record(cmd: String, id: String, text: String): SendResult {
        commands += Triple(cmd, id, text)
        return SendResult.Sent("fake")
    }
}
