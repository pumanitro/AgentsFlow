package com.peersflow.mobile.ui.main

import app.cash.turbine.test
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.fakes.FakeServerStatus
import com.peersflow.mobile.wire.fakes.InMemoryConversationRepository
import com.peersflow.mobile.wire.fakes.InMemoryOutbox
import com.peersflow.mobile.wire.fakes.InMemoryOutcomesRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    private fun TestScope.vm(
        repo: InMemoryConversationRepository,
        status: FakeServerStatus = FakeServerStatus(),
        flush: MutableStateFlow<FlushReport?> = MutableStateFlow(null),
    ): HomeViewModel = HomeViewModel(repo, status, InMemoryOutbox(), InMemoryOutcomesRepository(), flush).also { advanceUntilIdle() }

    @Test fun needsFilterShowsOnlyNeedsYouRowsAndCountsMatch() = runTest(dispatcher) {
        val repo = InMemoryConversationRepository(
            listOf(peer("p1"), peer("p2")),
            listOf(
                conv("a", needsYou = true, state = "blocked"),
                conv("b", state = "working"),
                conv("c", peerId = "p2", needsYou = true),
                conv("d", state = "done"),
                conv("e", pinned = false),
                conv("f", state = "starting"),
            ),
        )
        val vm = vm(repo)
        vm.setFilter(HomeFilter.NEEDS)
        advanceUntilIdle()
        val s = vm.state.value
        assertEquals(HomeFilter.NEEDS, s.filter)
        val ids = s.sections.flatMap { sec -> sec.rows.map { it.summary.id } }
        assertEquals(listOf("a", "c"), ids)
        assertTrue(s.sections.flatMap { it.rows }.all { it.summary.needsYou })
        assertEquals(listOf("p1", "p2"), s.sections.map { it.peer.id })
        assertEquals(mapOf(HomeFilter.ALL to 6, HomeFilter.NEEDS to 2, HomeFilter.WORKING to 2, HomeFilter.DONE to 2), s.counts)
    }

    @Test fun delegatedRowsNestUnderTheirParentAndUnknownPeersGoToOther() = runTest(dispatcher) {
        val repo = InMemoryConversationRepository(
            listOf(peer("p1"), peer("p2")),
            listOf(
                conv("parent"),
                conv("child", peerId = "p2", delegatedBy = "parent"),
                conv("grandchild", delegatedBy = "child"),
                conv("orphan", delegatedBy = "missing"),
                conv("stray", peerId = "ghost"),
            ),
        )
        val s = vm(repo).state.value
        val p1 = s.sections.first { it.peer.id == "p1" }
        val parentRow = p1.rows.first { it.summary.id == "parent" }
        assertEquals(listOf("child", "grandchild"), parentRow.children.map { it.id })
        assertEquals(listOf("parent", "orphan"), p1.rows.map { it.summary.id })
        // p2's only conversation is nested, so p2 has no section of its own
        assertFalse(s.sections.any { it.peer.id == "p2" })
        assertEquals("Other", s.sections.last().peer.name)
        assertEquals(listOf("stray"), s.sections.last().rows.map { it.summary.id })
    }

    @Test fun macOffGreysTheListAndChatQueuesWithTheQueueToast() = runTest(dispatcher) {
        val status = FakeServerStatus(ConnectionState.MAC_OFF)
        status.lastSeenAt.value = 1_000L
        val base = InMemoryConversationRepository(listOf(peer("p1")), listOf(conv("a")))
        val home = vm(base, status)
        assertTrue(home.state.value.greyed)
        assertEquals(ConnectionState.MAC_OFF, home.state.value.connection)
        assertEquals(1_000L, home.state.value.lastSeenAt)

        val repo = ScriptedRepo(base).apply { sendResult = com.peersflow.mobile.wire.SendResult.Queued("ob1") }
        val chat = ChatViewModel("a", repo, status, com.peersflow.mobile.wire.fakes.FakeVoiceEngine(),
            com.peersflow.mobile.wire.fakes.AlwaysAllowGate, com.peersflow.mobile.wire.fakes.SilentAudioSource())
        advanceUntilIdle()
        assertTrue(chat.state.value.greyed)
        chat.setComposer("hello")
        chat.send()
        advanceUntilIdle()
        assertEquals(PendingMsg.Status.QUEUED, chat.state.value.pending.last().status)
        assertEquals("", chat.state.value.composer)
    }

    @Test fun flushReportShowsMacIsBackBannerOnceThenClears() = runTest(dispatcher) {
        val flush = MutableStateFlow<FlushReport?>(null)
        val vm = vm(InMemoryConversationRepository(listOf(peer("p1")), listOf(conv("a"))), flush = flush)
        vm.state.test {
            assertNull(awaitItem().banner)
            flush.value = FlushReport(sent = 2, duplicates = 0, failed = 0, stoppedOnTransport = false)
            runCurrent()
            assertEquals("Mac is back · 2 tasks started", awaitItem().banner)
            advanceTimeBy(6_001)
            assertNull(awaitItem().banner)
            // a report with nothing sent shows nothing
            flush.value = FlushReport(sent = 0, duplicates = 1, failed = 0, stoppedOnTransport = false)
            advanceUntilIdle()
            expectNoEvents()
            cancelAndIgnoreRemainingEvents()
        }
    }

    @Test fun refreshFailureSetsErrorText() = runTest(dispatcher) {
        val base = InMemoryConversationRepository()
        val repo = object : com.peersflow.mobile.wire.ConversationRepository by base {
            override suspend fun refresh(): Boolean = false
        }
        val vm = HomeViewModel(repo, FakeServerStatus(), InMemoryOutbox(), InMemoryOutcomesRepository())
        advanceUntilIdle()
        assertEquals(HomeViewModel.REFRESH_FAILED, vm.state.value.error)
        assertFalse(vm.state.value.refreshing)
    }
}
