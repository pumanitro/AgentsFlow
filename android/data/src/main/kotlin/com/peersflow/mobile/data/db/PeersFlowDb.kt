package com.peersflow.mobile.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [
        PeerEntity::class, ConversationEntity::class, DetailEntity::class, MessageEntity::class,
        FeedEntity::class, OutboxEntity::class, KvEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class PeersFlowDb : RoomDatabase() {
    abstract fun peerDao(): PeerDao
    abstract fun conversationDao(): ConversationDao
    abstract fun detailDao(): DetailDao
    abstract fun messageDao(): MessageDao
    abstract fun feedDao(): FeedDao
    abstract fun outboxDao(): OutboxDao
    abstract fun kvDao(): KvDao

    fun daos(): DataDaos = DataDaos(
        peers = peerDao(), conversations = conversationDao(), details = detailDao(), messages = messageDao(),
        feed = feedDao(), outbox = outboxDao(), kv = kvDao(),
    )
}

/** The local cache. Version 1, destructive fallback: the server is the source of truth, the cache can be rebuilt. */
fun buildDb(ctx: Context): PeersFlowDb =
    Room.databaseBuilder(ctx, PeersFlowDb::class.java, "peersflow.db")
        .fallbackToDestructiveMigration()
        .build()

/**
 * Every DAO in one holder. Repositories depend on this instead of the Room database so JVM tests can
 * pass in-memory DAO implementations; the `PeersFlowDb` constructor overloads call [PeersFlowDb.daos].
 */
class DataDaos(
    val peers: PeerDao,
    val conversations: ConversationDao,
    val details: DetailDao,
    val messages: MessageDao,
    val feed: FeedDao,
    val outbox: OutboxDao,
    val kv: KvDao,
)
