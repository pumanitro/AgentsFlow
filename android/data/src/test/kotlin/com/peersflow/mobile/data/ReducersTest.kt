package com.peersflow.mobile.data

import com.peersflow.mobile.data.logic.FeedReducer
import com.peersflow.mobile.data.logic.FeedRow
import com.peersflow.mobile.data.logic.PageState
import com.peersflow.mobile.data.logic.Paging
import com.peersflow.mobile.data.logic.SummaryReducer
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.FeedItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReducersTest {
    private fun conv(id: String, updatedAt: String, title: String = id) =
        ConversationSummary(id = id, peerId = "p", peerName = "P", title = title, state = "working", createdAt = "2026-10-01T00:00:00Z", updatedAt = updatedAt)

    private fun feed(seq: Long) = FeedItem(seq, "outcome", "c$seq", "t$seq", "P", "2026-10-28T00:00:0${seq % 10}Z")

    @Test fun summaryFullUpdateReplacesByIdAndDropsMissing() {
        val current = listOf(conv("a", "2026-10-28T01:00:00Z", "old a"), conv("b", "2026-10-28T02:00:00Z"))
        val incoming = listOf(conv("a", "2026-10-28T03:00:00Z", "new a"), conv("c", "2026-10-28T00:30:00Z"))

        val next = SummaryReducer.full(current, incoming)

        assertEquals(listOf("a", "c"), next.map { it.id })
        assertEquals("new a", next.first().title)
        assertEquals(setOf("b"), SummaryReducer.missingIds(current.map { it.id }, incoming))
    }

    @Test fun summaryUpsertReplacesOrAdds() {
        val current = listOf(conv("a", "2026-10-28T01:00:00Z"))
        val next = SummaryReducer.upsert(SummaryReducer.upsert(current, conv("a", "2026-10-28T05:00:00Z", "A2")), conv("b", "2026-10-28T02:00:00Z"))
        assertEquals(listOf("a", "b"), next.map { it.id })
        assertEquals("A2", next.first().title)
    }

    @Test fun feedDedupesBySeqNewestFirstAndCountsUnseen() {
        val seen = FeedRow(feed(2), seenAt = 100)
        val merged = FeedReducer.merge(listOf(seen), listOf(feed(1), feed(2), feed(3), feed(3)))

        assertEquals(listOf(3L, 2L, 1L), merged.map { it.item.seq })
        assertEquals(100L, merged.first { it.item.seq == 2L }.seenAt)   // replayed item stays seen
        assertEquals(2, FeedReducer.unseenCount(merged))

        val marked = FeedReducer.markSeen(merged, uptoSeq = 3, now = 200)
        assertEquals(0, FeedReducer.unseenCount(marked))
        assertEquals(100L, marked.first { it.item.seq == 2L }.seenAt)
    }

    @Test fun pagingCursorBookkeeping() {
        val opened = Paging.afterPage(null, pageCursor = 50, pageHasMore = true, isNewest = true)
        assertEquals(50L, Paging.nextBefore(opened))
        val older = Paging.afterPage(opened, pageCursor = 0, pageHasMore = false, isNewest = false)
        assertNull(Paging.nextBefore(older))
        assertEquals(PageState(80, true), Paging.afterPage(older, 80, true, isNewest = true))  // re-open resets
        assertEquals(500L, Paging.nextEnd(500, 400))
    }
}
