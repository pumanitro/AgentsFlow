package com.peersflow.mobile.data.logic

import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.FeedItem

/** Conversation-list bookkeeping. The DB applies the same rules through `ConversationDao.replaceAll`. */
object SummaryReducer {
    /**
     * A full `conversations.updated`: the incoming list IS the list, so every current row is replaced by id and
     * ids not in it are dropped. The last duplicate of an id wins.
     */
    @Suppress("UNUSED_PARAMETER")
    fun full(current: List<ConversationSummary>, incoming: List<ConversationSummary>): List<ConversationSummary> =
        sort(incoming.associateBy { it.id }.values.toList())

    /** A single `conversation.updated`: replace by id or add. */
    fun upsert(current: List<ConversationSummary>, s: ConversationSummary): List<ConversationSummary> =
        sort(current.filterNot { it.id == s.id } + s)

    /** Ids present now that a full update removes. */
    fun missingIds(currentIds: Collection<String>, incoming: List<ConversationSummary>): Set<String> =
        currentIds.toSet() - incoming.map { it.id }.toSet()

    /** Newest first (ISO-8601 timestamps sort lexicographically). */
    fun sort(list: List<ConversationSummary>): List<ConversationSummary> = list.sortedByDescending { it.updatedAt }
}

/** A feed item plus when the user saw it (null = unseen). */
data class FeedRow(val item: FeedItem, val seenAt: Long? = null)

object FeedReducer {
    /** Merges [incoming] into [current]: one row per seq (an existing row keeps its seenAt), newest first. */
    fun merge(current: List<FeedRow>, incoming: List<FeedItem>): List<FeedRow> {
        val bySeq = LinkedHashMap<Long, FeedRow>()
        current.forEach { bySeq.putIfAbsent(it.item.seq, it) }
        incoming.forEach { if (it.seq !in bySeq) bySeq[it.seq] = FeedRow(it) }
        return bySeq.values.sortedByDescending { it.item.seq }
    }

    fun unseenCount(rows: List<FeedRow>): Int = rows.count { it.seenAt == null }

    fun markSeen(rows: List<FeedRow>, uptoSeq: Long, now: Long): List<FeedRow> =
        rows.map { if (it.item.seq <= uptoSeq && it.seenAt == null) it.copy(seenAt = now) else it }

    fun maxSeq(items: List<FeedItem>): Long = items.maxOfOrNull { it.seq } ?: 0L
}

/** Message paging state for one chat, persisted in the kv table. */
data class PageState(val cursor: Long?, val hasMore: Boolean)

object Paging {
    fun cursorKey(convId: String) = "messagesCursor:$convId"
    fun hasMoreKey(convId: String) = "messagesHasMore:$convId"
    fun endKey(convId: String) = "messagesEnd:$convId"

    /** `before` for the next older page, or null when there is nothing older to load. */
    fun nextBefore(state: PageState): Long? = if (state.hasMore && state.cursor != null && state.cursor > 0) state.cursor else null

    /**
     * After a page arrived. Opening a chat (newest page) always resets the cursor, because the stored one may
     * be stale; an older page only ever moves the cursor backwards.
     */
    fun afterPage(previous: PageState?, pageCursor: Long, pageHasMore: Boolean, isNewest: Boolean): PageState =
        if (isNewest || previous?.cursor == null) PageState(pageCursor, pageHasMore)
        else PageState(minOf(previous.cursor, pageCursor), pageHasMore)

    /** Byte offset end only grows. */
    fun nextEnd(previous: Long?, incoming: Long): Long = maxOf(previous ?: 0L, incoming)
}
