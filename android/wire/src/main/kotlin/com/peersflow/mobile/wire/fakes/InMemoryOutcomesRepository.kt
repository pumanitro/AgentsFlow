package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.OutcomesRepository
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.combine

class InMemoryOutcomesRepository(initial: List<FeedItem> = emptyList()) : OutcomesRepository {
    val items = MutableStateFlow(initial)
    val seenUpTo = MutableStateFlow(0L)

    override fun feed(): Flow<List<FeedItem>> = items

    override fun unseenCount(): Flow<Int> = combine(items, seenUpTo) { list, seen -> list.count { it.seq > seen } }

    override suspend fun markSeen(uptoSeq: Long) {
        if (uptoSeq > seenUpTo.value) seenUpTo.value = uptoSeq
    }

    override suspend fun replay(): Int = 0

    override fun latestSeq(): Long = items.value.maxOfOrNull { it.seq } ?: 0L
}
