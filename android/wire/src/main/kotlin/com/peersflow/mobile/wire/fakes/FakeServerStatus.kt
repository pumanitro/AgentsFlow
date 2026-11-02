package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.ServerStatusRepository
import kotlinx.coroutines.flow.MutableStateFlow

class FakeServerStatus(initial: ConnectionState = ConnectionState.ONLINE) : ServerStatusRepository {
    override val state = MutableStateFlow(initial)
    override val health = MutableStateFlow<ServerHealth?>(null)
    override val lastSeenAt = MutableStateFlow<Long?>(null)
    override val outboxCount = MutableStateFlow(0)
}
