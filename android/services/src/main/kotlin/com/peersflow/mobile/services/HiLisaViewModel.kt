package com.peersflow.mobile.services

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.ListenHandle
import com.peersflow.mobile.wire.SendResult
import com.peersflow.mobile.wire.ServerStatusRepository
import com.peersflow.mobile.wire.SessionStore
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
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

/** Where the dictated text goes. */
sealed interface Target {
    data class NewChat(val peerId: String, val peerName: String) : Target
    data class Continue(val conversationId: String, val title: String) : Target
}

sealed interface Phase {
    data class Listening(val partial: String) : Phase
    data class Confirm(val text: String, val secondsLeft: Int, val target: Target) : Phase
    object Sending : Phase
    data class Done(val result: SendResult, val message: String) : Phase
    data class Typing(val text: String) : Phase
    data class Error(val msg: String) : Phase
}

data class HiLisaUiState(
    val phase: Phase = Phase.Listening(""),
    val target: Target? = null,
    /** A voice chat is still working/blocked/starting, so "continue last voice chat" is offered. */
    val canContinue: Boolean = false,
    val connection: ConnectionState = ConnectionState.UNPAIRED,
    val source: String = "assist",
    /** Hint shown above the typed-input field (mic denied, nothing heard, …). */
    val notice: String? = null,
    /** Set after a successful send; the overlay closes itself. */
    val closeRequested: Boolean = false,
)

/**
 * Hi LISA: listen → confirm with a 3-second countdown → send to the voice peer (new chat) or the last live voice chat.
 * [clock] and the Main dispatcher (viewModelScope) are swappable in tests.
 */
class HiLisaViewModel(
    private val repo: ConversationRepository,
    private val session: SessionStore,
    private val voice: VoiceEngine,
    private val status: ServerStatusRepository,
    private val source: AudioSource,
    private val clock: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val _state = MutableStateFlow(HiLisaUiState(connection = status.state.value))
    val state: StateFlow<HiLisaUiState> = _state.asStateFlow()

    private var handle: ListenHandle? = null
    private var listenJob: Job? = null
    private var countdownJob: Job? = null
    private var newChatTarget: Target.NewChat? = null
    private var continueTarget: Target.Continue? = null
    private var finishing = false

    init {
        viewModelScope.launch { status.state.collect { s -> _state.update { it.copy(connection = s) } } }
        viewModelScope.launch {
            repo.summaries().collect { list ->
                val live = latestLiveVoiceChat(list)
                continueTarget = live?.let { Target.Continue(it.id, it.title) }
                _state.update { st ->
                    // If the continued chat ended, fall back to a new chat.
                    val tgt = if (st.target is Target.Continue && live == null) newChatTarget ?: st.target else st.target
                    st.copy(canContinue = live != null, target = tgt)
                }
            }
        }
    }

    /**
     * Begin a show. [typed] skips the microphone (E2E harness, no mic on the emulator);
     * [micAllowed] false (RECORD_AUDIO denied) opens the typed-input mode.
     */
    fun start(sourceLabel: String = _state.value.source, typed: String? = null, micAllowed: Boolean = true) {
        stopListening()
        countdownJob?.cancel()
        finishing = false
        _state.update { it.copy(source = sourceLabel, closeRequested = false, notice = null, phase = Phase.Listening("")) }
        listenJob = viewModelScope.launch {
            if (session.session.value == null) {
                setPhase(Phase.Error("Pair the phone first"))
                return@launch
            }
            val target = resolvePeer() ?: run {
                setPhase(Phase.Error("No peers yet"))
                return@launch
            }
            newChatTarget = target
            _state.update { it.copy(target = target) }
            when {
                typed != null -> setPhase(Phase.Typing(typed))
                !micAllowed -> {
                    _state.update { it.copy(notice = "Microphone is off — type instead") }
                    setPhase(Phase.Typing(""))
                }
                else -> listen()
            }
        }
    }

    private suspend fun resolvePeer(): Target.NewChat? {
        val peers = repo.peers().first()
        val prefId = session.prefs.value.voicePeerId
        val peer = prefId?.let { id -> peers.firstOrNull { it.id == id } }
            ?: peers.firstOrNull { it.name.equals("LISA", ignoreCase = true) }
            ?: peers.firstOrNull()
        return when {
            peer != null -> Target.NewChat(peer.id, peer.name)
            prefId != null -> Target.NewChat(prefId, "LISA")
            else -> null
        }
    }

    private suspend fun listen() {
        val h = try {
            voice.listen(SttConfig(keywords = voice.vocabulary.value), source) { partial ->
                _state.update { st -> if (st.phase is Phase.Listening) st.copy(phase = Phase.Listening(partial)) else st }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _state.update { it.copy(notice = "Voice is unavailable — type instead") }
            setPhase(Phase.Typing(""))
            return
        }
        handle = h
        if (h.endOfSpeech.firstOrNull() != null) finish()
    }

    /** End of speech (VAD) or a tap on the mic: transcribe, then confirm. */
    fun finish() {
        val h = handle ?: return
        if (finishing || _state.value.phase !is Phase.Listening) return
        finishing = true
        val heard = (_state.value.phase as? Phase.Listening)?.partial.orEmpty()
        viewModelScope.launch {
            var reason: String? = null
            val text = try {
                h.finish().text.trim()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                reason = e.message?.take(120)   // shown, so a failure says why instead of a generic line
                null
            } finally {
                handle = null
            }
            finishing = false
            when {
                text == null -> {
                    _state.update { it.copy(notice = "Could not transcribe" + (reason?.let { r -> " ($r)" } ?: "") + " — edit or type") }
                    setPhase(Phase.Typing(heard))
                }
                text.isEmpty() -> {
                    _state.update { it.copy(notice = "Didn't catch that — type instead") }
                    setPhase(Phase.Typing(""))
                }
                else -> confirm(text)
            }
        }
    }

    fun tapToStop() = finish()

    private fun confirm(text: String) {
        val target = _state.value.target ?: return
        countdownJob?.cancel()
        countdownJob = viewModelScope.launch {
            for (s in COUNTDOWN downTo 1) {
                setPhase(Phase.Confirm(text, s, _state.value.target ?: target))
                delay(1_000)
            }
            countdownJob = null
            send(text)
        }
    }

    /** Cancel: stop listening/countdown and drop to the editable text. */
    fun cancel() {
        val text = currentText()
        countdownJob?.cancel()
        stopListening()
        setPhase(Phase.Typing(text))
    }

    /** Cancel from the typed-input card: give up and close the overlay without sending. */
    fun cancelAndClose() {
        countdownJob?.cancel()
        stopListening()
        _state.update { it.copy(closeRequested = true) }
    }

    /** "Edit" from the confirm card. */
    fun edit() = cancel()

    fun startTyping(text: String) {
        countdownJob?.cancel()
        stopListening()
        setPhase(Phase.Typing(text))
    }

    /** Text field changes while typing. */
    fun updateTyping(text: String) {
        if (_state.value.phase is Phase.Typing) setPhase(Phase.Typing(text))
    }

    fun setTarget(target: Target) {
        _state.update { st ->
            val phase = st.phase
            st.copy(target = target, phase = if (phase is Phase.Confirm) phase.copy(target = target) else phase)
        }
    }

    /** ⇄ between a new chat and the last live voice chat. */
    fun toggleContinue() {
        val cur = _state.value.target
        val next = if (cur is Target.Continue) newChatTarget else continueTarget
        if (next != null) setTarget(next)
    }

    /** Send now (from Confirm or Typing). */
    fun send(text: String = currentText()) {
        val body = text.trim()
        if (body.isEmpty()) return
        val target = _state.value.target ?: return
        countdownJob?.cancel()
        countdownJob = null
        stopListening()
        setPhase(Phase.Sending)
        lastSentText = body
        viewModelScope.launch {
            val result = try {
                when (target) {
                    is Target.NewChat -> repo.startChat(target.peerId, body, "voice", Instant.ofEpochMilli(clock()).toString(), Sources.VOICE)
                    is Target.Continue -> repo.send(target.conversationId, body, Sources.VOICE)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                SendResult.Failed(e.message ?: "Could not send")
            }
            setPhase(Phase.Done(result, doneMessage(result, target)))
            if (result !is SendResult.Failed) {
                delay(AUTO_CLOSE_MS)
                _state.update { it.copy(closeRequested = true) }
            }
        }
    }

    /** After a failed send: back to the text. */
    fun retry() = setPhase(Phase.Typing(lastSentText))

    /** The activity went to the background: release the microphone. */
    fun onHidden() {
        if (_state.value.phase is Phase.Listening) cancel()
    }

    override fun onCleared() {
        stopListening()
        super.onCleared()
    }

    // ---- internals ---------------------------------------------------------------------------------------------

    private var lastSentText: String = ""

    private fun currentText(): String = when (val p = _state.value.phase) {
        is Phase.Listening -> p.partial
        is Phase.Confirm -> p.text
        is Phase.Typing -> p.text
        else -> lastSentText
    }

    private fun stopListening() {
        listenJob?.cancel()
        listenJob = null
        handle?.cancel()
        handle = null
        finishing = false
    }

    private fun setPhase(p: Phase) = _state.update { it.copy(phase = p) }

    companion object {
        const val COUNTDOWN = 3
        const val AUTO_CLOSE_MS = 1_500L
        private val LIVE_STATES = setOf("working", "blocked", "starting")

        fun latestLiveVoiceChat(list: List<ConversationSummary>): ConversationSummary? =
            list.filter { it.chatKind == "voice" && it.state in LIVE_STATES }.maxByOrNull { it.updatedAt }

        fun doneMessage(result: SendResult, target: Target): String = when (result) {
            is SendResult.Sent -> when (target) {
                is Target.NewChat -> "${target.peerName} is on it · new chat"
                is Target.Continue -> "Sent · ${target.title}"
            }
            is SendResult.Queued -> "Saved — it will start when the Mac is back"
            SendResult.Duplicate -> "Already sent"
            is SendResult.Failed -> "Not sent: ${result.message}"
        }
    }
}
