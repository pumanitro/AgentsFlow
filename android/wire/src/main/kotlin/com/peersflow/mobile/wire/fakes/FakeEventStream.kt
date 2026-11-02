package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.EventStream
import com.peersflow.mobile.wire.ServerEvent
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow

/** Tests push events with [emit] (or `events.tryEmit`) and drive [state] directly. */
class FakeEventStream : EventStream {
    override val events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 64)
    override val state = MutableStateFlow(ConnectionState.ONLINE)

    val subscribed = mutableSetOf<String>()
    val kicks = mutableListOf<String>()
    var started = false
        private set

    suspend fun emit(event: ServerEvent) = events.emit(event)

    override fun start() {
        started = true
    }

    override fun stop() {
        started = false
    }

    override fun kick(reason: String) {
        kicks += reason
    }

    override fun subscribe(ids: Set<String>) {
        subscribed += ids
    }

    override fun unsubscribe(ids: Set<String>) {
        subscribed -= ids
    }
}
