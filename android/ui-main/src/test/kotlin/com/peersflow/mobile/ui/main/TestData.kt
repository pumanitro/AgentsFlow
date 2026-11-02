package com.peersflow.mobile.ui.main

import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.SendResult
import com.peersflow.mobile.wire.fakes.InMemoryConversationRepository

internal fun conv(
    id: String,
    peerId: String = "p1",
    state: String = "idle",
    needsYou: Boolean = false,
    pinned: Boolean = true,
    delegatedBy: String? = null,
) = ConversationSummary(
    id = id, peerId = peerId, peerName = peerId, title = "Title $id", state = state, needsYou = needsYou,
    pinned = pinned, createdAt = "2026-10-28T10:00:00Z", updatedAt = "2026-10-28T10:00:00Z", delegatedBy = delegatedBy,
)

internal fun peer(id: String) = PeerSummary(id = id, name = "Peer $id", path = "/tmp/$id")

/** Wraps the `:wire` in-memory repo so a test can script what each command answers. */
internal class ScriptedRepo(
    val base: InMemoryConversationRepository = InMemoryConversationRepository(),
) : ConversationRepository by base {
    var sendResult: SendResult = SendResult.Sent(null)
    val sends = mutableListOf<Triple<String, String, String>>() // id, text, source
    val answers = mutableListOf<Triple<String?, String, String>>() // questionId, text, source
    val starts = mutableListOf<Pair<String, String>>() // peerId, prompt

    override suspend fun send(id: String, text: String, source: String): SendResult {
        sends += Triple(id, text, source)
        return sendResult
    }

    override suspend fun answer(id: String, questionId: String?, text: String, source: String): SendResult {
        answers += Triple(questionId, text, source)
        return SendResult.Sent(null)
    }

    override suspend fun startChat(peerId: String, prompt: String, kind: String, spokenAt: String?, source: String): SendResult {
        starts += peerId to prompt
        return SendResult.Sent(null)
    }
}
