package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.ActionGate

object AlwaysAllowGate : ActionGate {
    override suspend fun confirm(reason: String): Boolean = true
}
