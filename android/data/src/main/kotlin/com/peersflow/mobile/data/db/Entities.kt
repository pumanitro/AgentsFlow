package com.peersflow.mobile.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** `json` is the `PeerSummary` encoded with `WireJson`. */
@Entity(tableName = "peers")
data class PeerEntity(@PrimaryKey val id: String, val json: String)

/** `json` is the full `ConversationSummary`; the other columns are copies for ordering and filtering. */
@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val id: String,
    val peerId: String,
    val state: String,
    val pinned: Boolean,
    val updatedAt: String,
    val json: String,
)

/** `json` is the `ConversationDetail`. */
@Entity(tableName = "details")
data class DetailEntity(@PrimaryKey val id: String, val json: String)

/** One transcript entry; `json` is the `MessageEntry`. */
@Entity(
    tableName = "messages",
    primaryKeys = ["conversationId", "id"],
    indices = [Index("conversationId")],
)
data class MessageEntity(
    val conversationId: String,
    val id: String,
    val at: String,
    val kind: String,
    val json: String,
)

/** One outcome / needs-you feed item; `json` is the `FeedItem`. `seenAt` is null until the user saw it. */
@Entity(tableName = "feed")
data class FeedEntity(
    @PrimaryKey val seq: Long,
    val kind: String,
    val at: String,
    val json: String,
    val seenAt: Long? = null,
)

/** Mirror of `OutboxItem`; `kind` is the `OutboxKind` name. `id` is the clientId sent to the server. */
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val conversationId: String?,
    val peerId: String?,
    val text: String,
    val source: String,
    val chatKind: String,
    val spokenAt: String?,
    val createdAt: Long,
    val attempts: Int,
    val lastError: String?,
    val needsDecision: Boolean,
)

/** Small key/value table: `messagesEnd:<convId>`, `messagesCursor:<convId>`, `messagesHasMore:<convId>`. */
@Entity(tableName = "kv")
data class KvEntity(@PrimaryKey val key: String, val value: String)
