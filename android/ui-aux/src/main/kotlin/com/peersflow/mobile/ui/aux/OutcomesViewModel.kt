package com.peersflow.mobile.ui.aux

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.OutcomesRepository
import com.peersflow.mobile.wire.TtsHandle
import com.peersflow.mobile.wire.VoiceEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

data class DayGroup(val label: String, val items: List<FeedItem>)

data class OutcomesUiState(
    val groups: List<DayGroup> = emptyList(),
    val unseen: Int = 0,
    val speakingSeq: Long? = null,
    val awayHeader: String? = null,
)

class OutcomesViewModel(
    private val outcomes: OutcomesRepository,
    private val voice: VoiceEngine,
    @Suppress("unused") private val repo: ConversationRepository,
    private val clock: Clock = Clock.systemDefaultZone(),
) : ViewModel() {

    private val speaking = MutableStateFlow<Long?>(null)
    private val away = MutableStateFlow<String?>(null)
    private var awayItems: List<FeedItem> = emptyList()
    private var speakJob: Job? = null
    private var handle: TtsHandle? = null

    val state: StateFlow<OutcomesUiState>
    private val computeAway: Job

    init {
        val live = MutableStateFlow(OutcomesUiState())
        state = live.asStateFlow()
        viewModelScope.launch {
            combine(outcomes.feed(), outcomes.unseenCount(), speaking, away) { feed, unseen, sp, aw ->
                OutcomesUiState(groupByDay(feed), unseen, sp, aw)
            }.collect { s -> live.update { s } }
        }
        // computed once on entry: the first feed + unseen pair we see
        computeAway = viewModelScope.launch {
            val feed = outcomes.feed().first()
            val unseen = outcomes.unseenCount().first()
            awayItems = feed.sortedBy { it.seq }.takeLast(unseen)
            away.value = if (unseen > 1) "$unseen conclusions while you were away" else null
        }
    }

    private fun groupByDay(feed: List<FeedItem>): List<DayGroup> {
        val zone = clock.zone
        val today = LocalDate.now(clock)
        val fmt = DateTimeFormatter.ofPattern("dd MMM", Locale.ENGLISH)
        return feed.sortedByDescending { it.seq }
            .groupBy { item ->
                try { Instant.parse(item.at).atZone(zone).toLocalDate() } catch (_: Exception) { today }
            }
            .entries.sortedByDescending { it.key }
            .map { (day, items) ->
                val label = when (day) {
                    today -> "Today"
                    today.minusDays(1) -> "Yesterday"
                    else -> day.format(fmt)
                }
                DayGroup(label, items)
            }
    }

    fun replay(item: FeedItem) {
        stopSpeaking()
        speakJob = viewModelScope.launch { speakOne(item) }
    }

    /** Replays every item that was unseen on entry, oldest first. */
    fun readAll() {
        stopSpeaking()
        val items = awayItems
        speakJob = viewModelScope.launch { for (i in items) speakOne(i) }
    }

    private suspend fun speakOne(item: FeedItem) {
        speaking.value = item.seq
        try {
            val text = item.spoken ?: item.questions.firstOrNull()?.question ?: item.title
            val h = voice.speak(text, cacheKey = "feed:${item.seq}")
            handle = h
            h.await()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // speaking is best effort
        } finally {
            handle = null
            speaking.value = null
        }
    }

    fun stopSpeaking() {
        handle?.stop()
        speakJob?.cancel()
        speakJob = null
        speaking.value = null
    }

    fun markAllSeen() {
        viewModelScope.launch {
            computeAway.join()
            outcomes.markSeen(outcomes.latestSeq())
        }
    }

    fun refresh() {
        viewModelScope.launch { outcomes.replay() }
    }

    override fun onCleared() {
        handle?.stop()
    }
}
