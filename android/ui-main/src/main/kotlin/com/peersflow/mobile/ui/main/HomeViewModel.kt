package com.peersflow.mobile.ui.main

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.Outbox
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutcomesRepository
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.ServerStatusRepository
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class HomeUiState(
    val connection: ConnectionState = ConnectionState.UNPAIRED,
    val health: ServerHealth? = null,
    val lastSeenAt: Long? = null,
    val filter: HomeFilter = HomeFilter.ALL,
    val sections: List<PeerSection> = emptyList(),
    val outbox: List<OutboxItem> = emptyList(),
    val unseenOutcomes: Int = 0,
    val banner: String? = null,
    val refreshing: Boolean = false,
    val error: String? = null,
    val peers: List<PeerSummary> = emptyList(),
    val counts: Map<HomeFilter, Int> = HomeFilter.entries.associateWith { 0 },
    /** False until the repository delivered its first peers + summaries; the empty states wait for it. */
    val loaded: Boolean = false,
    /** Every known conversation, used to name REPLY/ANSWER outbox targets. */
    val allSummaries: List<ConversationSummary> = emptyList(),
    /** The desktop pinned list + History (null until the Mac answered once). Shown for the All filter. */
    val pinned: com.peersflow.mobile.wire.PinnedListResponse? = null,
) {
    /** The list is drawn dimmed with "Showing the last known state" whenever the Mac is not reachable. */
    val greyed: Boolean get() = connection != ConnectionState.ONLINE
}

class HomeViewModel(
    private val repo: ConversationRepository,
    private val status: ServerStatusRepository,
    private val outbox: Outbox,
    private val outcomes: OutcomesRepository,
    private val lastFlush: StateFlow<FlushReport?> = MutableStateFlow(null),
    /** How long the "Mac is back" banner stays; injectable for tests. */
    private val bannerMillis: Long = 6_000,
) : ViewModel() {

    private data class Local(val filter: HomeFilter = HomeFilter.ALL, val banner: String? = null, val refreshing: Boolean = false, val error: String? = null)

    private val local = MutableStateFlow(Local())
    private var bannerJob: Job? = null

    private val repoData = combine(repo.peers(), repo.summaries(), repo.pinnedList().onStart { emit(null) }) { p, s, pin -> Triple(p, s, pin) }
    private val statusData = combine(status.state, status.health, status.lastSeenAt) { c, h, l -> Triple(c, h, l) }

    val state: StateFlow<HomeUiState> = combine(
        repoData,
        statusData,
        outbox.items.onStart { emit(emptyList()) },
        outcomes.unseenCount().onStart { emit(0) },
        local,
    ) { (peers, summaries, pin), (conn, health, seen), items, unseen, loc ->
        HomeUiState(
            connection = conn,
            health = health,
            lastSeenAt = seen,
            filter = loc.filter,
            sections = HomeLogic.sections(peers, summaries, loc.filter),
            outbox = items.sortedBy { it.createdAt },
            unseenOutcomes = unseen,
            banner = loc.banner,
            refreshing = loc.refreshing,
            error = loc.error,
            peers = peers,
            counts = HomeLogic.counts(summaries),
            loaded = true,
            allSummaries = summaries,
            pinned = pin,
        )
    }.stateIn(
        viewModelScope,
        SharingStarted.Eagerly,
        HomeUiState(connection = status.state.value, health = status.health.value, lastSeenAt = status.lastSeenAt.value),
    )

    init {
        viewModelScope.launch {
            var lastShown: FlushReport? = null
            lastFlush.collect { report ->
                if (report == null || report === lastShown || report.sent <= 0) return@collect
                lastShown = report
                bannerJob?.cancel()
                local.update { it.copy(banner = HomeLogic.flushBanner(report.sent)) }
                bannerJob = viewModelScope.launch {
                    delay(bannerMillis)
                    local.update { it.copy(banner = null) }
                }
            }
        }
        refresh()
    }

    fun setFilter(filter: HomeFilter) = local.update { it.copy(filter = filter) }

    fun refresh() {
        if (local.value.refreshing) return
        local.update { it.copy(refreshing = true) }
        viewModelScope.launch {
            val ok = runCatching { repo.refresh() }.getOrDefault(false)
            local.update { it.copy(refreshing = false, error = if (ok) null else REFRESH_FAILED) }
        }
    }

    fun onTapStatus() = refresh()

    fun cancelOutbox(id: String) {
        viewModelScope.launch { outbox.remove(id) }
    }

    fun retargetOutbox(id: String, peerId: String) {
        viewModelScope.launch { outbox.retarget(id, peerId) }
    }

    fun dismissBanner() = local.update { it.copy(banner = null) }

    fun dismissError() = local.update { it.copy(error = null) }

    companion object {
        const val REFRESH_FAILED = "Could not reach the Mac — showing the last known state"
    }
}
