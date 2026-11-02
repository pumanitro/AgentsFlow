package com.peersflow.mobile.data

import com.peersflow.mobile.data.db.ConversationDao
import com.peersflow.mobile.data.db.ConversationEntity
import com.peersflow.mobile.data.db.DataDaos
import com.peersflow.mobile.data.db.DetailDao
import com.peersflow.mobile.data.db.DetailEntity
import com.peersflow.mobile.data.db.FeedDao
import com.peersflow.mobile.data.db.FeedEntity
import com.peersflow.mobile.data.db.KvDao
import com.peersflow.mobile.data.db.KvEntity
import com.peersflow.mobile.data.db.MessageDao
import com.peersflow.mobile.data.db.MessageEntity
import com.peersflow.mobile.data.db.OutboxDao
import com.peersflow.mobile.data.db.OutboxEntity
import com.peersflow.mobile.data.db.PeerDao
import com.peersflow.mobile.data.db.PeerEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.map

// MutableList/Map-backed DAO implementations; Room itself is not exercised on the JVM.

class MemPeerDao : PeerDao {
    val rows = MutableStateFlow<Map<String, PeerEntity>>(emptyMap())
    override fun observeAll(): Flow<List<PeerEntity>> = rows.map { it.values.sortedBy { r -> r.id } }
    override suspend fun upsertAll(rows: List<PeerEntity>) { this.rows.value = this.rows.value + rows.associateBy { it.id } }
    override suspend fun deleteAll() { rows.value = emptyMap() }
}

class MemConversationDao : ConversationDao {
    val rows = MutableStateFlow<Map<String, ConversationEntity>>(emptyMap())
    override fun observeAll(): Flow<List<ConversationEntity>> = rows.map { it.values.sortedByDescending { r -> r.updatedAt } }
    override suspend fun get(id: String) = rows.value[id]
    override suspend fun upsertAll(rows: List<ConversationEntity>) { this.rows.value = this.rows.value + rows.associateBy { it.id } }
    override suspend fun deleteMissing(ids: List<String>) { rows.value = rows.value.filterKeys { it in ids } }
    override suspend fun deleteAll() { rows.value = emptyMap() }
}

class MemDetailDao : DetailDao {
    val rows = MutableStateFlow<Map<String, DetailEntity>>(emptyMap())
    override fun observe(id: String): Flow<DetailEntity?> = rows.map { it[id] }
    override suspend fun get(id: String) = rows.value[id]
    override suspend fun upsert(row: DetailEntity) { rows.value = rows.value + (row.id to row) }
}

class MemMessageDao : MessageDao {
    /** Insertion order stands in for rowid. */
    val rows = MutableStateFlow<List<MessageEntity>>(emptyList())
    override fun observe(convId: String): Flow<List<MessageEntity>> =
        rows.map { list -> list.withIndex().filter { it.value.conversationId == convId }.sortedWith(compareBy({ it.value.at }, { it.index })).map { it.value } }
    override suspend fun upsertAll(rows: List<MessageEntity>) {
        val cur = this.rows.value.toMutableList()
        for (r in rows) {
            val i = cur.indexOfFirst { it.conversationId == r.conversationId && it.id == r.id }
            if (i >= 0) cur[i] = r else cur += r
        }
        this.rows.value = cur
    }
    override suspend fun deleteFor(convId: String) { rows.value = rows.value.filterNot { it.conversationId == convId } }
}

class MemFeedDao : FeedDao {
    val rows = MutableStateFlow<Map<Long, FeedEntity>>(emptyMap())
    override fun observeAll(): Flow<List<FeedEntity>> = rows.map { it.values.sortedByDescending { r -> r.seq } }
    override suspend fun upsert(rows: List<FeedEntity>) { this.rows.value = this.rows.value + rows.associateBy { it.seq } }
    override suspend fun insertNew(rows: List<FeedEntity>) {
        this.rows.value = this.rows.value + rows.filter { it.seq !in this.rows.value }.associateBy { it.seq }
    }
    override suspend fun maxSeq(): Long = rows.value.keys.maxOrNull() ?: 0L
    override fun unseenCount(): Flow<Int> = rows.map { m -> m.values.count { it.seenAt == null } }
    override suspend fun markSeenUpTo(seq: Long, now: Long) {
        rows.value = rows.value.mapValues { (k, v) -> if (k <= seq && v.seenAt == null) v.copy(seenAt = now) else v }
    }
}

class MemOutboxDao : OutboxDao {
    val rows = MutableStateFlow<List<OutboxEntity>>(emptyList())
    private fun sorted(l: List<OutboxEntity>) = l.sortedWith(compareBy({ it.createdAt }, { it.id }))
    override fun observeAll(): Flow<List<OutboxEntity>> = rows.map(::sorted)
    override suspend fun all(): List<OutboxEntity> = sorted(rows.value)
    override suspend fun get(id: String) = rows.value.firstOrNull { it.id == id }
    override suspend fun upsert(row: OutboxEntity) { rows.value = rows.value.filterNot { it.id == row.id } + row }
    override suspend fun delete(id: String) { rows.value = rows.value.filterNot { it.id == id } }
    override suspend fun markFailure(id: String, attempts: Int, lastError: String?, needsDecision: Boolean) {
        rows.value = rows.value.map { if (it.id == id) it.copy(attempts = attempts, lastError = lastError, needsDecision = needsDecision) else it }
    }
}

class MemKvDao : KvDao {
    val rows = mutableMapOf<String, String>()
    override suspend fun get(key: String) = rows[key]
    override suspend fun put(row: KvEntity) { rows[row.key] = row.value }
    override suspend fun delete(key: String) { rows.remove(key) }
}

fun memDaos(outbox: MemOutboxDao = MemOutboxDao()) = DataDaos(
    peers = MemPeerDao(), conversations = MemConversationDao(), details = MemDetailDao(), messages = MemMessageDao(),
    feed = MemFeedDao(), outbox = outbox, kv = MemKvDao(),
)
