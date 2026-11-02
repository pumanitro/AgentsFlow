package com.peersflow.mobile.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.peersflow.mobile.wire.ActionGate
import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConvStates
import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.ListenHandle
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.MessageKinds
import com.peersflow.mobile.wire.NeedsYouQuestion
import com.peersflow.mobile.wire.QuestionOption
import com.peersflow.mobile.wire.SendResult
import com.peersflow.mobile.wire.ServerStatusRepository
import com.peersflow.mobile.wire.Sources
import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.VoiceEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

sealed interface RecordingState {
    data object Idle : RecordingState
    data class Listening(val partial: String) : RecordingState
    data class Confirm(val text: String, val secondsLeft: Int) : RecordingState
    data class Error(val msg: String) : RecordingState
}

/** A short message under the chat; [actionLabel] set ⇒ the screen shows a button that calls `onToastAction()`. */
data class Toast(val message: String, val actionLabel: String? = null, val id: Long = 0)

enum class NeedsChipKind { OPTION, QUICK, OTHER }

data class NeedsChip(val label: String, val kind: NeedsChipKind, val option: QuestionOption? = null)

/** A message the user just sent from the phone, shown until the chat transcript contains it. */
data class PendingMsg(val id: String, val text: String, val status: Status, val error: String? = null, val source: String = "phone") {
    enum class Status { SENDING, SENT, QUEUED, FAILED }
}

data class ChatUiState(
    val pending: List<PendingMsg> = emptyList(),
    val detail: ConversationDetail? = null,
    val messages: List<MessageEntry> = emptyList(),
    val connection: ConnectionState = ConnectionState.ONLINE,
    val hasOlder: Boolean = false,
    val loadingOlder: Boolean = false,
    val composer: String = "",
    val recording: RecordingState = RecordingState.Idle,
    val sending: Boolean = false,
    val toast: Toast? = null,
    val showThinking: Boolean = false,
    /** Ids of `tool_use` entries whose `tool_result` is unfolded. */
    val expandedTools: Set<String> = emptySet(),
) {
    val greyed: Boolean get() = connection != ConnectionState.ONLINE

    val state: String get() = detail?.job?.state ?: detail?.summary?.state ?: ""

    /** working | blocked | starting ⇒ the composer shows Stop; otherwise Done / Reopen. */
    val isLive: Boolean get() = state == ConvStates.WORKING || state == ConvStates.BLOCKED || state == ConvStates.STARTING

    val pinned: Boolean get() = detail?.summary?.pinned ?: true

    val question: NeedsYouQuestion? get() = detail?.job?.questions?.firstOrNull()

    val suggestedReply: String? get() = detail?.job?.suggestedReply?.takeIf { it.isNotBlank() }

    val needsText: String? get() = question?.question ?: detail?.job?.needs?.takeIf { it.isNotBlank() }

    val showNeedsCard: Boolean get() = question != null || suggestedReply != null || needsText != null

    /** Options of the first open question, then the suggested reply, then "Other…" (focuses the composer). */
    val chips: List<NeedsChip>
        get() {
            if (!showNeedsCard) return emptyList()
            val out = mutableListOf<NeedsChip>()
            question?.options?.forEach { out += NeedsChip(it.label, NeedsChipKind.OPTION, it) }
            suggestedReply?.let { out += NeedsChip(it, NeedsChipKind.QUICK) }
            out += NeedsChip("Other…", NeedsChipKind.OTHER)
            return out
        }

    /** What the list draws: thinking only when switched on, a tool result only when its tool call is unfolded. */
    val visibleMessages: List<MessageEntry>
        get() {
            val toolEntryByUseId = messages.filter { it.kind == MessageKinds.TOOL_USE && it.toolUseId != null }
                .associate { it.toolUseId!! to it.id }
            return messages.filter { m ->
                when (m.kind) {
                    MessageKinds.THINKING -> showThinking
                    MessageKinds.TOOL_RESULT -> toolEntryByUseId[m.toolUseId]?.let { it in expandedTools } ?: false
                    else -> true
                }
            }
        }
}

class ChatViewModel(
    private val id: String,
    private val repo: ConversationRepository,
    private val status: ServerStatusRepository,
    private val voice: VoiceEngine,
    private val gate: ActionGate,
    private val source: AudioSource,
    private val hasMicPermission: () -> Boolean = { true },
    /** Seconds of the "sending in 3…2…1" window after a voice message. */
    private val confirmSeconds: Int = 3,
) : ViewModel() {

    private val _state = MutableStateFlow(ChatUiState(connection = status.state.value))
    val state: StateFlow<ChatUiState> = _state.asStateFlow()

    private var listenHandle: ListenHandle? = null
    private var endOfSpeechJob: Job? = null
    private var countdownJob: Job? = null
    private var errorJob: Job? = null
    private var toastSeq = 0L
    private var olderPossible = true

    /** Text waiting for the "Start a new chat" toast action. */
    private var pendingNewChatText: String? = null

    init {
        repo.open(id)
        viewModelScope.launch { repo.detail(id).collect { d -> _state.update { it.copy(detail = d) } } }
        viewModelScope.launch {
            repo.messages(id).collect { list ->
                val sorted = list.sortedBy { it.at }
                // A pending bubble disappears once the real message is in the transcript.
                val userTexts = sorted.filter { m -> m.kind == "user.text" }.map { m -> m.text.trim().replace(Regex("\\s+"), " ") }.toSet()
                _state.update { st ->
                    st.copy(
                        messages = sorted, hasOlder = olderPossible && sorted.isNotEmpty(),
                        pending = st.pending.filterNot { p -> p.status != PendingMsg.Status.FAILED && p.text.trim().replace(Regex("\\s+"), " ") in userTexts },
                    )
                }
            }
        }
        viewModelScope.launch { status.state.collect { c -> _state.update { it.copy(connection = c) } } }
    }

    override fun onCleared() {
        listenHandle?.cancel()
        repo.close(id)
    }

    // ---- composer ----

    fun setComposer(text: String) = _state.update { it.copy(composer = text) }

    fun send() {
        val text = _state.value.composer.trim()
        if (text.isEmpty()) return
        viewModelScope.launch {
            if (!gate.confirm("Send to the chat")) return@launch
            sendPending(text, Sources.PHONE)
        }
    }

    // The message appears in the chat at once with a status (sending → sent / waiting for Mac / failed),
    // and the composer clears straight away.
    private suspend fun sendPending(text: String, source: String, reuseId: String? = null) {
        val pid = reuseId ?: java.util.UUID.randomUUID().toString()
        _state.update { s ->
            val others = s.pending.filterNot { it.id == pid }
            s.copy(pending = others + PendingMsg(pid, text, PendingMsg.Status.SENDING, source = source),
                composer = if (s.composer.trim() == text) "" else s.composer)
        }
        val r = safe { repo.send(id, text, source) }
        val status = when (r) {
            is SendResult.Sent, SendResult.Duplicate -> PendingMsg.Status.SENT
            is SendResult.Queued -> PendingMsg.Status.QUEUED
            is SendResult.Failed -> PendingMsg.Status.FAILED
        }
        val err = (r as? SendResult.Failed)?.message
        _state.update { s -> s.copy(pending = s.pending.map { if (it.id == pid) it.copy(status = status, error = err) else it }) }
        if (r is SendResult.Failed && r.notRunning) handleSend(r, text)
    }

    fun retryPending(pid: String) {
        val p = _state.value.pending.firstOrNull { it.id == pid } ?: return
        viewModelScope.launch { sendPending(p.text, p.source, reuseId = pid) }
    }

    fun deletePending(pid: String) = _state.update { s -> s.copy(pending = s.pending.filterNot { it.id == pid }) }

    private fun sendVoice(text: String) {
        viewModelScope.launch { sendPending(text, Sources.VOICE) }
    }

    private fun handleSend(r: SendResult, text: String) {
        _state.update { s ->
            val clear = r is SendResult.Sent || r is SendResult.Queued || r is SendResult.Duplicate
            s.copy(sending = false, composer = if (clear && s.composer.trim() == text) "" else s.composer)
        }
        when (r) {
            is SendResult.Sent -> toast(if (r.via == "open-chat") "Sent (through the open chat)" else "Sent")
            is SendResult.Queued -> toast(QUEUED)
            SendResult.Duplicate -> toast("Already sent")
            is SendResult.Failed -> if (r.notRunning) {
                pendingNewChatText = text
                // keep the text so the user can still edit it
                _state.update { if (it.composer.isBlank()) it.copy(composer = text) else it }
                toast(r.message.ifBlank { "This chat is not running on the Mac" }, START_NEW_CHAT)
            } else {
                _state.update { if (it.composer.isBlank()) it.copy(composer = text) else it }
                toast(r.message.ifBlank { "Could not send" })
            }
        }
    }

    /** The toast's button: today only "Start a new chat" with the text that could not be delivered. */
    fun onToastAction() {
        val text = pendingNewChatText ?: return
        pendingNewChatText = null
        val peerId = _state.value.detail?.summary?.peerId
        _state.update { it.copy(toast = null) }
        if (peerId == null) {
            toast("Unknown peer — cannot start a new chat")
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(sending = true) }
            val r = safe { repo.startChat(peerId, text, "chat", null, Sources.PHONE) }
            _state.update { s -> s.copy(sending = false, composer = if (r is SendResult.Failed) s.composer else "") }
            when (r) {
                is SendResult.Sent, SendResult.Duplicate -> toast("Started a new chat")
                is SendResult.Queued -> toast(QUEUED)
                is SendResult.Failed -> toast(r.message.ifBlank { "Could not start a new chat" })
            }
        }
    }

    fun dismissToast() = _state.update { it.copy(toast = null) }

    // ---- needs-you ----

    /** Answers the first open question with the option label, or with free [text]. */
    fun answer(option: QuestionOption?, text: String?) {
        val reply = option?.label ?: text?.trim()?.takeIf { it.isNotEmpty() } ?: return
        val questionId = _state.value.question?.id
        viewModelScope.launch {
            if (!gate.confirm("Answer the chat")) return@launch
            _state.update { it.copy(sending = true) }
            val r = safe { repo.answer(id, questionId, reply, Sources.PHONE) }
            _state.update { it.copy(sending = false) }
            commandToast(r, "Answered")
        }
    }

    /** The "quick:" chip: answers the open question when there is one, else sends it as a reply. */
    fun quickReply(text: String) {
        if (_state.value.question != null) {
            answer(null, text)
            return
        }
        viewModelScope.launch {
            if (!gate.confirm("Send to the chat")) return@launch
            _state.update { it.copy(sending = true) }
            val r = safe { repo.send(id, text, Sources.PHONE) }
            handleSend(r, text)
        }
    }

    fun stop() = command("Stop the chat", "Stopped") { repo.stop(id) }

    fun done() = command("Mark the chat done", "Marked done") { repo.done(id) }

    fun reopen() = command("Reopen the chat", "Reopened") { repo.reopen(id) }

    private fun command(reason: String, okText: String, call: suspend () -> SendResult) {
        viewModelScope.launch {
            if (!gate.confirm(reason)) return@launch
            commandToast(safe { call() }, okText)
        }
    }

    private fun commandToast(r: SendResult, okText: String) = when (r) {
        is SendResult.Sent, SendResult.Duplicate -> toast(okText)
        is SendResult.Queued -> toast(QUEUED)
        is SendResult.Failed -> toast(r.message.ifBlank { "That did not work" })
    }

    // ---- history / view toggles ----

    fun loadOlder() {
        if (_state.value.loadingOlder) return
        viewModelScope.launch {
            _state.update { it.copy(loadingOlder = true) }
            val more = runCatching { repo.loadOlder(id) }.getOrDefault(false)
            olderPossible = more
            _state.update { it.copy(loadingOlder = false, hasOlder = more && it.messages.isNotEmpty()) }
        }
    }

    fun toggleThinking() = _state.update { it.copy(showThinking = !it.showThinking) }

    fun toggleTool(entryId: String) = _state.update {
        it.copy(expandedTools = if (entryId in it.expandedTools) it.expandedTools - entryId else it.expandedTools + entryId)
    }

    // ---- hold-to-talk ----

    fun startListening() {
        if (listenHandle != null || _state.value.recording is RecordingState.Confirm) return
        if (!hasMicPermission()) {
            showRecordingError("Microphone permission needed")
            return
        }
        errorJob?.cancel()
        _state.update { it.copy(recording = RecordingState.Listening("")) }
        val handle = try {
            voice.listen(SttConfig(keywords = voice.vocabulary.value), source) { partial ->
                _state.update { s -> if (s.recording is RecordingState.Listening) s.copy(recording = RecordingState.Listening(partial)) else s }
            }
        } catch (e: Exception) {
            showRecordingError(e.message ?: "Could not start the microphone")
            return
        }
        listenHandle = handle
        endOfSpeechJob = viewModelScope.launch {
            runCatching { handle.endOfSpeech.first() }.onSuccess { stopListening() }
        }
    }

    /** Mic released (or the VAD heard the end of speech): transcribe and open the cancel window. */
    fun stopListening() {
        val handle = listenHandle ?: return
        listenHandle = null
        endOfSpeechJob?.cancel()
        endOfSpeechJob = null
        viewModelScope.launch {
            val result = try {
                handle.finish()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                showRecordingError(e.message ?: "Could not understand the recording")
                return@launch
            }
            val text = result.text.trim()
            if (text.isEmpty()) {
                showRecordingError("Did not catch that — try again")
                return@launch
            }
            startCountdown(text)
        }
    }

    /** The gesture was abandoned (finger slid away, screen left): drop the recording without sending. */
    fun cancelListening() {
        val handle = listenHandle ?: return
        listenHandle = null
        endOfSpeechJob?.cancel()
        handle.cancel()
        _state.update { it.copy(recording = RecordingState.Idle) }
    }

    private fun startCountdown(text: String) {
        countdownJob?.cancel()
        countdownJob = viewModelScope.launch {
            for (s in confirmSeconds downTo 1) {
                _state.update { it.copy(recording = RecordingState.Confirm(text, s)) }
                delay(1_000)
            }
            _state.update { it.copy(recording = RecordingState.Idle) }
            sendVoice(text)
        }
    }

    /** Cancel inside the 3 s window: nothing is sent, the words move into the composer. */
    fun cancelConfirm() = moveConfirmToComposer()

    fun editConfirm() = moveConfirmToComposer()

    private fun moveConfirmToComposer() {
        val confirm = _state.value.recording as? RecordingState.Confirm ?: return
        countdownJob?.cancel()
        countdownJob = null
        _state.update { s ->
            val merged = if (s.composer.isBlank()) confirm.text else s.composer.trimEnd() + " " + confirm.text
            s.copy(recording = RecordingState.Idle, composer = merged)
        }
    }

    private fun showRecordingError(msg: String) {
        errorJob?.cancel()
        _state.update { it.copy(recording = RecordingState.Error(msg)) }
        errorJob = viewModelScope.launch {
            delay(3_000)
            _state.update { if (it.recording is RecordingState.Error) it.copy(recording = RecordingState.Idle) else it }
        }
    }

    // ---- helpers ----

    private fun toast(message: String, actionLabel: String? = null) {
        if (actionLabel == null) pendingNewChatText = null
        _state.update { it.copy(toast = Toast(message, actionLabel, ++toastSeq)) }
    }

    private suspend fun safe(call: suspend () -> SendResult): SendResult = try {
        call()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        SendResult.Failed(e.message ?: "Something went wrong")
    }

    companion object {
        const val QUEUED = "Queued — the Mac is off, it will be sent when it is back"
        const val START_NEW_CHAT = "Start a new chat"
    }
}
