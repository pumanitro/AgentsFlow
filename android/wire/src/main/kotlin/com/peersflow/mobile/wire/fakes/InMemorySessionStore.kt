package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.Session
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.VoicePrefs
import kotlinx.coroutines.flow.MutableStateFlow

class InMemorySessionStore(initial: Session? = null, initialPrefs: VoicePrefs = VoicePrefs()) : SessionStore {
    override val session = MutableStateFlow(initial)
    override val prefs = MutableStateFlow(initialPrefs)
    private var seq = 0L
    private var seenAt: Long? = null

    override fun save(session: Session) {
        this.session.value = session
    }

    override fun clear() {
        session.value = null
        seq = 0L
        seenAt = null
    }

    override fun updatePrefs(f: (VoicePrefs) -> VoicePrefs) {
        prefs.value = f(prefs.value)
    }

    override fun lastSeq(): Long = seq

    override fun setLastSeq(seq: Long) {
        this.seq = seq
    }

    override fun lastSeenAt(): Long? = seenAt

    override fun setLastSeenAt(ms: Long) {
        seenAt = ms
    }
}
