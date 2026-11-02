package com.peersflow.mobile.data.db

import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.WireJson
import kotlinx.serialization.json.Json

/** Wire type <-> row conversions. Rows that fail to decode (older app version) are dropped, never thrown. */
object Mappers {
    fun peer(p: PeerSummary, json: Json = WireJson) = PeerEntity(p.id, json.encodeToString(PeerSummary.serializer(), p))
    fun peer(e: PeerEntity, json: Json = WireJson): PeerSummary? =
        runCatching { json.decodeFromString(PeerSummary.serializer(), e.json) }.getOrNull()

    fun conversation(s: ConversationSummary, json: Json = WireJson) = ConversationEntity(
        id = s.id, peerId = s.peerId, state = s.state, pinned = s.pinned, updatedAt = s.updatedAt,
        json = json.encodeToString(ConversationSummary.serializer(), s),
    )
    fun conversation(e: ConversationEntity, json: Json = WireJson): ConversationSummary? =
        runCatching { json.decodeFromString(ConversationSummary.serializer(), e.json) }.getOrNull()

    fun detail(d: ConversationDetail, json: Json = WireJson) =
        DetailEntity(d.summary.id, json.encodeToString(ConversationDetail.serializer(), d))
    fun detail(e: DetailEntity, json: Json = WireJson): ConversationDetail? =
        runCatching { json.decodeFromString(ConversationDetail.serializer(), e.json) }.getOrNull()

    fun message(convId: String, m: MessageEntry, json: Json = WireJson) =
        MessageEntity(convId, m.id, m.at, m.kind, json.encodeToString(MessageEntry.serializer(), m))
    fun message(e: MessageEntity, json: Json = WireJson): MessageEntry? =
        runCatching { json.decodeFromString(MessageEntry.serializer(), e.json) }.getOrNull()

    fun feed(f: FeedItem, json: Json = WireJson, seenAt: Long? = null) =
        FeedEntity(f.seq, f.kind, f.at, json.encodeToString(FeedItem.serializer(), f), seenAt)
    fun feed(e: FeedEntity, json: Json = WireJson): FeedItem? =
        runCatching { json.decodeFromString(FeedItem.serializer(), e.json) }.getOrNull()

    fun outbox(i: OutboxItem) = OutboxEntity(
        id = i.id, kind = i.kind.name, conversationId = i.conversationId, peerId = i.peerId, text = i.text,
        source = i.source, chatKind = i.chatKind, spokenAt = i.spokenAt, createdAt = i.createdAt,
        attempts = i.attempts, lastError = i.lastError, needsDecision = i.needsDecision,
    )
    fun outbox(e: OutboxEntity): OutboxItem? {
        val kind = runCatching { OutboxKind.valueOf(e.kind) }.getOrNull() ?: return null
        return OutboxItem(
            id = e.id, kind = kind, conversationId = e.conversationId, peerId = e.peerId, text = e.text,
            source = e.source, chatKind = e.chatKind, spokenAt = e.spokenAt, createdAt = e.createdAt,
            attempts = e.attempts, lastError = e.lastError, needsDecision = e.needsDecision,
        )
    }
}
