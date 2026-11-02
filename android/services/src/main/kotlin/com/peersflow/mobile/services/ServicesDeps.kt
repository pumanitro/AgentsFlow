package com.peersflow.mobile.services

import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.EventStream
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.OutcomesRepository
import com.peersflow.mobile.wire.Outbox
import com.peersflow.mobile.wire.ServerStatusRepository
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.VoiceEngine
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Everything the `:services` components need, supplied by `:app` (AppGraph) through [ServicesHost]. */
interface ServicesDeps {
    val repo: ConversationRepository
    val events: EventStream
    val outbox: Outbox
    val outcomes: OutcomesRepository
    val status: ServerStatusRepository
    val session: SessionStore
    val voice: VoiceEngine
    val audio: AudioSource

    /**
     * Report of the flush the status repository runs when the Mac comes back (`ServerStatusRepositoryImpl.lastFlush`).
     * Defaults to a flow that never reports, so an AppGraph that has not wired it yet still compiles.
     */
    val lastFlush: StateFlow<FlushReport?> get() = NO_FLUSH
}

private val NO_FLUSH: StateFlow<FlushReport?> = MutableStateFlow(null)
