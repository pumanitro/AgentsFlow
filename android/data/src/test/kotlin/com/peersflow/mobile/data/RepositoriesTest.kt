package com.peersflow.mobile.data

import com.peersflow.mobile.data.repos.ConversationRepositoryImpl
import com.peersflow.mobile.data.repos.OutcomesRepositoryImpl
import com.peersflow.mobile.data.repos.ServerStatusRepositoryImpl
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.ReplyResponse
import com.peersflow.mobile.wire.SendResult
import com.peersflow.mobile.wire.ServerEvent
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.fakes.FakeEventStream
import com.peersflow.mobile.wire.fakes.FakeServerStatus
import com.peersflow.mobile.wire.fakes.InMemorySessionStore
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RepositoriesTest {
    private val outboxDao = MemOutboxDao()
    private val daos = memDaos(outboxDao)
    private val api = ScriptedApiClient()
    private val events = FakeEventStream()
    private val session = InMemorySessionStore()
    private val outbox = OutboxImpl(outboxDao, api)

    private fun conv(id: String, updatedAt: String = "2026-10-28T01:00:00Z") =
        ConversationSummary(id = id, peerId = "p", peerName = "P", title = id, state = "working", createdAt = "2026-10-01T00:00:00Z", updatedAt = updatedAt)

    @Test fun sendWhileMacOffIsQueuedInOutbox() = runTest(UnconfinedTestDispatcher()) {
        val repo = ConversationRepositoryImpl(daos, api, events, session, outbox, FakeServerStatus(ConnectionState.MAC_OFF), backgroundScope)

        val result = repo.send("c1", "ship it", "phone")

        assertTrue(result is SendResult.Queued)
        val item = outbox.items.first().single()
        assertEquals((result as SendResult.Queued).outboxId, item.id)
        assertEquals(OutboxKind.REPLY, item.kind)
        assertEquals("c1", item.conversationId)
        assertEquals("ship it", item.text)
        assertTrue(api.calls.isEmpty())
    }

    @Test fun sendOnlineMapsServerAnswers() = runTest(UnconfinedTestDispatcher()) {
        val repo = ConversationRepositoryImpl(daos, api, events, session, outbox, FakeServerStatus(ConnectionState.ONLINE), backgroundScope)
        api.replyScript += ApiResult.Ok(ReplyResponse(ok = true, via = "open-chat"))
        api.replyScript += ApiResult.Ok(ReplyResponse(ok = true, duplicate = true))
        api.replyScript += ApiResult.Err("conflict", "not running", status = 409)
        api.replyScript += ApiResult.Err("transport", "reset", transport = true)

        assertEquals(SendResult.Sent("open-chat"), repo.send("c1", "1", "phone"))
        assertEquals(SendResult.Duplicate, repo.send("c1", "2", "phone"))
        assertEquals(SendResult.Failed("not running", notRunning = true), repo.send("c1", "3", "phone"))
        assertTrue(repo.send("c1", "4", "phone") is SendResult.Queued)
        assertEquals(listOf("4"), outbox.items.first().map { it.text })
    }

    @Test fun liveEventsLandInDb() = runTest(UnconfinedTestDispatcher()) {
        val repo = ConversationRepositoryImpl(daos, api, events, session, outbox, FakeServerStatus(), backgroundScope)
        repo.start()

        events.emit(ServerEvent.ConversationsUpdated(listOf(conv("a"), conv("b"))))
        events.emit(ServerEvent.ConversationsUpdated(listOf(conv("b", "2026-10-28T02:00:00Z"))))
        events.emit(ServerEvent.MessagesAppended("b", listOf(MessageEntry("m1", "user.text", "2026-10-28T02:00:00Z", "hi")), end = 1234))

        assertEquals(listOf("b"), repo.summaries().first().map { it.id })
        assertEquals(listOf("m1"), repo.messages("b").first().map { it.id })
        assertEquals("1234", (daos.kv as MemKvDao).rows["messagesEnd:b"])
    }

    @Test fun reconnectFlushesOutboxAndReportsIt() = runTest(UnconfinedTestDispatcher()) {
        events.state.value = ConnectionState.MAC_OFF
        val status = ServerStatusRepositoryImpl(events, session, outbox, backgroundScope, clock = { 1_000L })
        val repo = ConversationRepositoryImpl(daos, api, events, session, outbox, status, backgroundScope)
        status.start()

        repo.startChat("p1", "task one", "voice", null, "voice")
        repo.startChat("p1", "task two", "voice", null, "voice")
        assertEquals(2, status.outboxCount.value)

        events.state.value = ConnectionState.ONLINE

        assertEquals(2, status.lastFlush.value?.sent)
        assertEquals(0, status.outboxCount.value)
        assertEquals(listOf("task one", "task two"), api.calls.map { it.third })

        events.emit(ServerEvent.Health(ServerHealth(hostname = "mac", appVersion = "12", now = "x")))
        assertEquals("mac", status.health.value?.hostname)
        assertEquals(1_000L, status.lastSeenAt.value)
    }

    @Test fun outcomesDedupeLiveAndReplay() = runTest(UnconfinedTestDispatcher()) {
        val repo = OutcomesRepositoryImpl(daos, api, events, session, backgroundScope)
        repo.start()
        val item = { seq: Long -> FeedItem(seq, "outcome", "c", "t", "P", "2026-10-28T00:00:00Z") }

        events.emit(ServerEvent.Feed(item(1)))
        api.base.feed += listOf(item(1), item(2), item(3))
        val replayed = repo.replay()

        assertEquals(2, replayed)                     // asked only for seq > 1
        assertEquals(listOf(3L, 2L, 1L), repo.feed().first().map { it.seq })
        assertEquals(3, repo.unseenCount().first())
        assertEquals(3L, repo.latestSeq())
        assertEquals(3L, session.lastSeq())
        repo.markSeen(2)
        assertEquals(1, repo.unseenCount().first())
    }
}
