package com.peersflow.mobile.ui.main

import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.JobSlice
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.MessageKinds
import com.peersflow.mobile.wire.NeedsYouQuestion
import com.peersflow.mobile.wire.QuestionOption
import com.peersflow.mobile.wire.SendResult
import com.peersflow.mobile.wire.Sources
import com.peersflow.mobile.wire.fakes.AlwaysAllowGate
import com.peersflow.mobile.wire.fakes.FakeServerStatus
import com.peersflow.mobile.wire.fakes.FakeVoiceEngine
import com.peersflow.mobile.wire.fakes.InMemoryConversationRepository
import com.peersflow.mobile.wire.fakes.SilentAudioSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatViewModelTest {
    private val dispatcher = StandardTestDispatcher()

    @Before fun setUp() = Dispatchers.setMain(dispatcher)

    @After fun tearDown() = Dispatchers.resetMain()

    private val question = NeedsYouQuestion(
        id = "q1", question = "Which database?",
        options = listOf(QuestionOption("Postgres"), QuestionOption("SQLite", "small")),
    )

    private fun repoWithQuestion(): ScriptedRepo {
        val base = InMemoryConversationRepository(listOf(peer("p1")), listOf(conv("c1", state = "blocked", needsYou = true)))
        base.details.value = mapOf(
            "c1" to ConversationDetail(
                conv("c1", state = "blocked", needsYou = true),
                JobSlice(state = "blocked", questions = listOf(question), suggestedReply = "Use Postgres"),
            ),
        )
        return ScriptedRepo(base)
    }

    private fun TestScope.chat(repo: ScriptedRepo, voice: FakeVoiceEngine = FakeVoiceEngine()): ChatViewModel =
        ChatViewModel("c1", repo, FakeServerStatus(), voice, AlwaysAllowGate, SilentAudioSource()).also { advanceUntilIdle() }

    @Test fun chipsComeFromFirstQuestionOptionsPlusSuggestedReply() = runTest(dispatcher) {
        val vm = chat(repoWithQuestion())
        val chips = vm.state.value.chips
        assertEquals(listOf("Postgres", "SQLite", "Use Postgres", "Other…"), chips.map { it.label })
        assertEquals(listOf(NeedsChipKind.OPTION, NeedsChipKind.OPTION, NeedsChipKind.QUICK, NeedsChipKind.OTHER), chips.map { it.kind })
        assertTrue(vm.state.value.showNeedsCard)
        assertEquals("Which database?", vm.state.value.needsText)
    }

    @Test fun answerWithOptionSendsTheOptionLabel() = runTest(dispatcher) {
        val repo = repoWithQuestion()
        val vm = chat(repo)
        vm.answer(question.options[1], null)
        advanceUntilIdle()
        assertEquals(listOf(Triple<String?, String, String>("q1", "SQLite", Sources.PHONE)), repo.answers)
        assertEquals("Answered", vm.state.value.toast?.message)
    }

    @Test fun holdToTalkConfirmsThenSendsAsVoiceAfterCountdown() = runTest(dispatcher) {
        val repo = repoWithQuestion()
        val vm = chat(repo)
        vm.startListening()
        assertTrue(vm.state.value.recording is RecordingState.Listening)
        vm.stopListening()
        runCurrent()
        assertEquals(RecordingState.Confirm("fake transcript", 3), vm.state.value.recording)
        advanceTimeBy(1_001)
        assertEquals(RecordingState.Confirm("fake transcript", 2), vm.state.value.recording)
        assertTrue(repo.sends.isEmpty())
        advanceTimeBy(2_100)
        advanceUntilIdle()
        assertEquals(listOf(Triple("c1", "fake transcript", Sources.VOICE)), repo.sends)
        assertEquals(RecordingState.Idle, vm.state.value.recording)
    }

    @Test fun cancelConfirmMovesTextIntoComposerAndSendsNothing() = runTest(dispatcher) {
        val repo = repoWithQuestion()
        val vm = chat(repo)
        vm.startListening()
        vm.stopListening()
        runCurrent()
        advanceTimeBy(500)
        vm.cancelConfirm()
        advanceUntilIdle()
        assertTrue(repo.sends.isEmpty())
        assertEquals("fake transcript", vm.state.value.composer)
        assertEquals(RecordingState.Idle, vm.state.value.recording)
    }

    @Test fun missingMicPermissionShowsErrorThenIdle() = runTest(dispatcher) {
        val vm = ChatViewModel("c1", repoWithQuestion(), FakeServerStatus(), FakeVoiceEngine(), AlwaysAllowGate, SilentAudioSource(),
            hasMicPermission = { false })
        advanceUntilIdle()
        vm.startListening()
        assertEquals(RecordingState.Error("Microphone permission needed"), vm.state.value.recording)
        advanceTimeBy(3_001)
        assertEquals(RecordingState.Idle, vm.state.value.recording)
    }

    @Test fun notRunningFailureOffersStartNewChatWithSameText() = runTest(dispatcher) {
        val repo = repoWithQuestion().apply { sendResult = SendResult.Failed("This chat is not running", notRunning = true) }
        val vm = chat(repo)
        vm.setComposer("please continue")
        vm.send()
        advanceUntilIdle()
        val toast = vm.state.value.toast!!
        assertEquals(ChatViewModel.START_NEW_CHAT, toast.actionLabel)
        assertEquals("please continue", vm.state.value.composer)
        vm.onToastAction()
        advanceUntilIdle()
        assertEquals(listOf("p1" to "please continue"), repo.starts)
        assertEquals("Started a new chat", vm.state.value.toast?.message)
        assertEquals("", vm.state.value.composer)
    }

    @Test fun sentViaOpenChatToastAndToolResultsFoldUntilExpanded() = runTest(dispatcher) {
        val repo = repoWithQuestion().apply { sendResult = SendResult.Sent("open-chat") }
        repo.base.messageMap.value = mapOf(
            "c1" to listOf(
                MessageEntry("m2", MessageKinds.TOOL_USE, "2026-10-28T10:00:02Z", "ls", toolUseId = "t1"),
                MessageEntry("m1", MessageKinds.USER, "2026-10-28T10:00:01Z", "hi", source = Sources.PHONE),
                MessageEntry("m3", MessageKinds.TOOL_RESULT, "2026-10-28T10:00:03Z", "a b c", toolUseId = "t1"),
                MessageEntry("m4", MessageKinds.THINKING, "2026-10-28T10:00:04Z", "hmm"),
            ),
        )
        val vm = chat(repo)
        assertEquals(listOf("m1", "m2", "m3", "m4"), vm.state.value.messages.map { it.id })
        assertEquals(listOf("m1", "m2"), vm.state.value.visibleMessages.map { it.id })
        vm.toggleTool("m2")
        vm.toggleThinking()
        assertEquals(listOf("m1", "m2", "m3", "m4"), vm.state.value.visibleMessages.map { it.id })
        vm.setComposer("go")
        vm.send()
        advanceUntilIdle()
        assertEquals(PendingMsg.Status.SENT, vm.state.value.pending.last().status)   // shown under the bubble, not as a pop-up
        assertFalse(vm.state.value.sending)
    }
}
