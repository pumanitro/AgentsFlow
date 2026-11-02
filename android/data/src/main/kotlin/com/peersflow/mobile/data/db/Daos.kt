package com.peersflow.mobile.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// Every DAO is an interface so JVM tests can implement it in memory (see the test source set).
// The `replaceAll` default methods run inside a Room transaction; in-memory fakes inherit them as-is.

@Dao
interface PeerDao {
    @Query("SELECT * FROM peers ORDER BY id")
    fun observeAll(): Flow<List<PeerEntity>>

    @Upsert
    suspend fun upsertAll(rows: List<PeerEntity>)

    @Query("DELETE FROM peers")
    suspend fun deleteAll()

    @Transaction
    suspend fun replaceAll(rows: List<PeerEntity>) {
        deleteAll()
        upsertAll(rows)
    }
}

@Dao
interface ConversationDao {
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    fun observeAll(): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE id = :id")
    suspend fun get(id: String): ConversationEntity?

    @Upsert
    suspend fun upsertAll(rows: List<ConversationEntity>)

    /** Deletes every row whose id is NOT in [ids]. Never call with an empty list; use [deleteAll]. */
    @Query("DELETE FROM conversations WHERE id NOT IN (:ids)")
    suspend fun deleteMissing(ids: List<String>)

    @Query("DELETE FROM conversations")
    suspend fun deleteAll()

    /** Full update: rows not in [rows] are deleted, the rest upserted, atomically. */
    @Transaction
    suspend fun replaceAll(rows: List<ConversationEntity>) {
        if (rows.isEmpty()) deleteAll() else deleteMissing(rows.map { it.id })
        upsertAll(rows)
    }
}

@Dao
interface DetailDao {
    @Query("SELECT * FROM details WHERE id = :id")
    fun observe(id: String): Flow<DetailEntity?>

    @Query("SELECT * FROM details WHERE id = :id")
    suspend fun get(id: String): DetailEntity?

    @Upsert
    suspend fun upsert(row: DetailEntity)
}

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE conversationId = :convId ORDER BY at ASC, rowid ASC")
    fun observe(convId: String): Flow<List<MessageEntity>>

    @Upsert
    suspend fun upsertAll(rows: List<MessageEntity>)

    @Query("DELETE FROM messages WHERE conversationId = :convId")
    suspend fun deleteFor(convId: String)
}

@Dao
interface FeedDao {
    @Query("SELECT * FROM feed ORDER BY seq DESC")
    fun observeAll(): Flow<List<FeedEntity>>

    @Upsert
    suspend fun upsert(rows: List<FeedEntity>)

    /** Inserts only seqs not stored yet (a seq never changes), so an already-seen item keeps its `seenAt`. */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertNew(rows: List<FeedEntity>)

    @Query("SELECT COALESCE(MAX(seq), 0) FROM feed")
    suspend fun maxSeq(): Long

    @Query("SELECT COUNT(*) FROM feed WHERE seenAt IS NULL")
    fun unseenCount(): Flow<Int>

    @Query("UPDATE feed SET seenAt = :now WHERE seq <= :seq AND seenAt IS NULL")
    suspend fun markSeenUpTo(seq: Long, now: Long)
}

@Dao
interface OutboxDao {
    @Query("SELECT * FROM outbox ORDER BY createdAt ASC, id ASC")
    fun observeAll(): Flow<List<OutboxEntity>>

    @Query("SELECT * FROM outbox ORDER BY createdAt ASC, id ASC")
    suspend fun all(): List<OutboxEntity>

    @Query("SELECT * FROM outbox WHERE id = :id")
    suspend fun get(id: String): OutboxEntity?

    @Upsert
    suspend fun upsert(row: OutboxEntity)

    @Query("DELETE FROM outbox WHERE id = :id")
    suspend fun delete(id: String)

    /** Records a failed attempt on an EXISTING row only, so a row the user removed mid-flush stays removed. */
    @Query("UPDATE outbox SET attempts = :attempts, lastError = :lastError, needsDecision = :needsDecision WHERE id = :id")
    suspend fun markFailure(id: String, attempts: Int, lastError: String?, needsDecision: Boolean)
}

@Dao
interface KvDao {
    @Query("SELECT value FROM kv WHERE `key` = :key")
    suspend fun get(key: String): String?

    @Upsert
    suspend fun put(row: KvEntity)

    @Query("DELETE FROM kv WHERE `key` = :key")
    suspend fun delete(key: String)
}
