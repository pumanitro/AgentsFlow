package com.peersflow.mobile.services

import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.SendResult
import com.peersflow.mobile.wire.Session
import com.peersflow.mobile.wire.fakes.FakeServerStatus
import com.peersflow.mobile.wire.fakes.FakeVoiceEngine
import com.peersflow.mobile.wire.fakes.InMemoryConversationRepository
import com.peersflow.mobile.wire.fakes.InMemorySessionStore
import com.peersflow.mobile.wire.fakes.SilentAudioSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Records the arguments the in-memory fake drops (kind, spokenAt, source); answers [result]. */
private class RecordingRepository(
    val inner: InMemoryConversationRepository,
    var result: SendResult = SendResult.Sent("fake"),
) : ConversationRepository by inner {
    data class StartChat(val peerId: String, val prompt: String, val kind: String, val spokenAt: String?, val source: String)
    data class Send(val id: String, val text: String, val source: String)

    val starts = mutableListOf<StartChat>()
    val sends = mutableListOf<Send>()

    override suspend fun startChat(peerId: String, prompt: String, kind: String, spokenAt: String?, source: String): SendResult {
        starts += StartChat(peerId, prompt, kind, spokenAt, source)
        return result
    }

    override suspend fun send(id: String, text: String, source: String): SendResult {
        sends += Send(id, text, source)
        return result
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class HiLisaViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val lisa = PeerSummary("peer-lisa", "LISA", "/Users/x/lisa")
    private val other = PeerSummary("peer-other", "Atlas", "/Users/x/atlas")
    private val paired = Session("http://10.0.2.2:47821", "tok", "dev1", listOf("all"), "iMac", null, 0L)

    private lateinit var inner: InMemoryConversationRepository
    private lateinit var repo: RecordingRepository

    @Before fun setUp() {
        Dispatchers.setMain(dispatcher)
        inner = InMemoryConversationRepository(initialPeers = listOf(other, lisa))
        repo = RecordingRepository(inner)
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm(session: InMemorySessionStore = InMemorySessionStore(paired)) =
        HiLisaViewModel(repo, session, FakeVoiceEngine(), FakeServerStatus(ConnectionState.ONLINE), SilentAudioSource(), clock = { 1_761_652_800_000L })

    private fun summary(id: String, kind: String, state: String) = ConversationSummary(
        id = id, peerId = lisa.id, peerName = "LISA", title = "Voice chat $id", state = state, chatKind = kind,
        createdAt = "2026-10-28T08:00:00Z", updatedAt = "2026-10-28T08:0${id.length % 10}:00Z",
    )

    @Test fun listensConfirmsAndStartsAVoiceChatAfterTheCountdown() = runTest(dispatcher) {
        val vm = vm()
        vm.start("tile")
        runCurrent()
        assertTrue(vm.state.value.phase is Phase.Listening)
        vm.tapToStop()
        runCurrent()
        assertEquals(Phase.Confirm("fake transcript", 3, Target.NewChat(lisa.id, "LISA")), vm.state.value.phase)
        advanceTimeBy(1_000); runCurrent()
        assertEquals(2, (vm.state.value.phase as Phase.Confirm).secondsLeft)
        assertTrue(repo.starts.isEmpty())
        advanceTimeBy(2_100); runCurrent()
        val call = repo.starts.single()
        assertEquals(lisa.id, call.peerId)
        assertEquals("fake transcript", call.prompt)
        assertEquals("voice", call.kind)
        assertEquals("voice", call.source)
        assertNotNull(call.spokenAt)
        assertEquals("LISA is on it · new chat", (vm.state.value.phase as Phase.Done).message)
        advanceTimeBy(1_600); runCurrent()
        assertTrue(vm.state.value.closeRequested)
    }

    @Test fun cancelDuringConfirmGoesToTypingAndSendsNothing() = runTest(dispatcher) {
        val vm = vm()
        vm.start()
        runCurrent()
        vm.tapToStop()
        runCurrent()
        assertTrue(vm.state.value.phase is Phase.Confirm)
        vm.cancel()
        advanceTimeBy(10_000); runCurrent()
        assertEquals(Phase.Typing("fake transcript"), vm.state.value.phase)
        assertTrue(repo.starts.isEmpty())
        assertTrue(repo.sends.isEmpty())
    }

    @Test fun continueRoutesToTheLiveVoiceChat() = runTest(dispatcher) {
        inner.summaryList.value = listOf(
            summary("c-chat", "chat", "working"),
            summary("c-done", "voice", "done"),
            summary("c-voice", "voice", "working"),
        )
        val vm = vm()
        vm.start()
        runCurrent()
        assertTrue(vm.state.value.canContinue)
        vm.setTarget(Target.Continue("c-voice", "Voice chat c-voice"))
        vm.tapToStop()
        runCurrent()
        vm.send()
        runCurrent()
        assertEquals(listOf(RecordingRepository.Send("c-voice", "fake transcript", "voice")), repo.sends)
        assertTrue(repo.starts.isEmpty())
    }

    @Test fun noLiveVoiceChatMeansNoContinue() = runTest(dispatcher) {
        inner.summaryList.value = listOf(summary("c-done", "voice", "done"), summary("c-chat", "chat", "working"))
        val vm = vm()
        vm.start()
        runCurrent()
        assertEquals(false, vm.state.value.canContinue)
    }

    @Test fun queuedSendSaysSaved() = runTest(dispatcher) {
        repo.result = SendResult.Queued("ob-1")
        val vm = vm()
        vm.start(typed = "remind me at five")
        runCurrent()
        assertEquals(Phase.Typing("remind me at five"), vm.state.value.phase)
        vm.send("remind me at five")
        runCurrent()
        val done = vm.state.value.phase as Phase.Done
        assertEquals("Saved — it will start when the Mac is back", done.message)
        assertEquals("remind me at five", repo.starts.single().prompt)
    }

    @Test fun failedSendStaysOpen() = runTest(dispatcher) {
        repo.result = SendResult.Failed("boom")
        val vm = vm()
        vm.start(typed = "x")
        runCurrent()
        vm.send("x")
        advanceTimeBy(5_000); runCurrent()
        assertTrue(vm.state.value.phase is Phase.Done)
        assertEquals(false, vm.state.value.closeRequested)
        vm.retry()
        assertEquals(Phase.Typing("x"), vm.state.value.phase)
    }

    @Test fun unpairedPhoneShowsAnError() = runTest(dispatcher) {
        val vm = vm(InMemorySessionStore(null))
        vm.start()
        runCurrent()
        assertEquals(Phase.Error("Pair the phone first"), vm.state.value.phase)
    }

    @Test fun noPeersShowsAnError() = runTest(dispatcher) {
        inner.peerList.value = emptyList()
        val vm = vm()
        vm.start()
        runCurrent()
        assertEquals(Phase.Error("No peers yet"), vm.state.value.phase)
    }

    @Test fun micDeniedOpensTypedMode() = runTest(dispatcher) {
        val vm = vm()
        vm.start(micAllowed = false)
        runCurrent()
        assertEquals(Phase.Typing(""), vm.state.value.phase)
        assertNotNull(vm.state.value.notice)
    }
}
