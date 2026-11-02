package com.peersflow.mobile.ui.aux

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.ServerStatusRepository
import com.peersflow.mobile.wire.Session
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.VoiceEngine
import com.peersflow.mobile.wire.VoicePrefs
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class SettingsUiState(
    val session: Session? = null,
    val prefs: VoicePrefs = VoicePrefs(),
    val peers: List<PeerSummary> = emptyList(),
    val connection: ConnectionState = ConnectionState.UNPAIRED,
    val health: ServerHealth? = null,
    val assistantHeld: Boolean = false,
    val vocabularyCount: Int = 0,
    val effectiveVoicePeer: PeerSummary? = null,
)

class SettingsViewModel(
    private val session: SessionStore,
    repo: ConversationRepository,
    status: ServerStatusRepository,
    voice: VoiceEngine,
    private val roleRequester: (Context) -> Unit,
    private val roleHeld: (Context) -> Boolean = { false },
) : ViewModel() {

    private val held = MutableStateFlow(false)
    private val _unpaired = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val unpaired: SharedFlow<Unit> = _unpaired.asSharedFlow()

    private val core = combine(
        session.session, session.prefs, repo.peers(), status.state, status.health,
    ) { s, p, peers, conn, health ->
        SettingsUiState(
            session = s, prefs = p, peers = peers, connection = conn, health = health,
            effectiveVoicePeer = resolveVoicePeer(p, peers),
        )
    }

    val state: StateFlow<SettingsUiState> = combine(core, voice.vocabulary, held) { c, vocab, h ->
        c.copy(vocabularyCount = vocab.size, assistantHeld = h)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, SettingsUiState())

    fun setVoicePeer(id: String?) = session.updatePrefs { it.copy(voicePeerId = id) }
    fun setStayConnected(on: Boolean) = session.updatePrefs { it.copy(stayConnected = on) }
    fun setBiometric(on: Boolean) = session.updatePrefs { it.copy(biometric = on) }
    fun setSpeakAlways(on: Boolean) = session.updatePrefs { it.copy(speakAlways = on) }
    fun setQuietHours(from: Int?, to: Int?) = session.updatePrefs { it.copy(quietFrom = from, quietTo = to) }
    fun setTtsVoice(name: String) = session.updatePrefs { it.copy(ttsVoice = name.trim().ifEmpty { "marin" }) }
    fun setLiveStt(on: Boolean) = session.updatePrefs { it.copy(liveStt = on) }

    fun unpair() {
        session.clear()
        viewModelScope.launch { _unpaired.emit(Unit) }
    }

    fun requestAssistantRole(ctx: Context) = roleRequester(ctx)
    fun refreshRole(ctx: Context) {
        held.value = roleHeld(ctx)
    }

    companion object {
        fun resolveVoicePeer(prefs: VoicePrefs, peers: List<PeerSummary>): PeerSummary? {
            val chosen = prefs.voicePeerId
            return if (chosen != null) peers.firstOrNull { it.id == chosen }
            else peers.firstOrNull { it.name.equals("LISA", ignoreCase = true) }
        }
    }
}
