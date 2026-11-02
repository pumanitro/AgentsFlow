package com.peersflow.mobile.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.peersflow.mobile.wire.Session
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.VoicePrefs
import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable

/**
 * Pairing session + voice prefs + replay cursor on EncryptedSharedPreferences (file `peersflow-session`).
 * If the keystore-backed file cannot be opened it is deleted once and reopened; if that fails too, plain
 * SharedPreferences (`peersflow-session-plain`) are used with a logged warning, so the app still works.
 */
class SessionStoreImpl(ctx: Context) : SessionStore {

    private val sp: SharedPreferences = open(ctx.applicationContext)

    private val _session = MutableStateFlow(readSession())
    private val _prefs = MutableStateFlow(readPrefs())

    override val session: StateFlow<Session?> = _session.asStateFlow()
    override val prefs: StateFlow<VoicePrefs> = _prefs.asStateFlow()

    @Synchronized
    override fun save(session: Session) {
        sp.edit().putString(K_SESSION, WireJson.encodeToString(StoredSession.serializer(), StoredSession.of(session))).apply()
        _session.value = session
    }

    @Synchronized
    override fun clear() {
        sp.edit().remove(K_SESSION).remove(K_LAST_SEQ).remove(K_LAST_SEEN).apply()
        _session.value = null
    }

    @Synchronized
    override fun updatePrefs(f: (VoicePrefs) -> VoicePrefs) {
        val next = f(_prefs.value)
        sp.edit().putString(K_PREFS, WireJson.encodeToString(StoredPrefs.serializer(), StoredPrefs.of(next))).apply()
        _prefs.value = next
    }

    override fun lastSeq(): Long = sp.getLong(K_LAST_SEQ, 0L)

    override fun setLastSeq(seq: Long) {
        sp.edit().putLong(K_LAST_SEQ, seq).apply()
    }

    override fun lastSeenAt(): Long? = if (sp.contains(K_LAST_SEEN)) sp.getLong(K_LAST_SEEN, 0L) else null

    override fun setLastSeenAt(ms: Long) {
        sp.edit().putLong(K_LAST_SEEN, ms).apply()
    }

    private fun readSession(): Session? = sp.getString(K_SESSION, null)?.let { raw ->
        runCatching { WireJson.decodeFromString(StoredSession.serializer(), raw).toSession() }.getOrNull()
    }

    private fun readPrefs(): VoicePrefs = sp.getString(K_PREFS, null)?.let { raw ->
        runCatching { WireJson.decodeFromString(StoredPrefs.serializer(), raw).toPrefs() }.getOrNull()
    } ?: VoicePrefs()

    @Serializable
    internal data class StoredSession(
        val baseUrl: String, val token: String, val deviceId: String, val scopes: List<String>,
        val serverName: String, val sttKey: String? = null, val pairedAt: Long,
    ) {
        fun toSession() = Session(baseUrl, token, deviceId, scopes, serverName, sttKey, pairedAt)
        companion object {
            fun of(s: Session) = StoredSession(s.baseUrl, s.token, s.deviceId, s.scopes, s.serverName, s.sttKey, s.pairedAt)
        }
    }

    @Serializable
    internal data class StoredPrefs(
        val voicePeerId: String? = null, val stayConnected: Boolean = true, val biometric: Boolean = false,
        val speakAlways: Boolean = true, val quietFrom: Int? = null, val quietTo: Int? = null,
        val ttsVoice: String = "marin", val liveStt: Boolean = true,
    ) {
        fun toPrefs() = VoicePrefs(voicePeerId, stayConnected, biometric, speakAlways, quietFrom, quietTo, ttsVoice, liveStt)
        companion object {
            fun of(p: VoicePrefs) = StoredPrefs(p.voicePeerId, p.stayConnected, p.biometric, p.speakAlways, p.quietFrom, p.quietTo, p.ttsVoice, p.liveStt)
        }
    }

    companion object {
        const val FILE = "peersflow-session"
        private const val PLAIN_FILE = "peersflow-session-plain"
        private const val TAG = "PeersFlowSession"
        private const val K_SESSION = "session"
        private const val K_PREFS = "prefs"
        private const val K_LAST_SEQ = "lastSeq"
        private const val K_LAST_SEEN = "lastSeenAt"

        private fun encrypted(ctx: Context): SharedPreferences {
            val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            return EncryptedSharedPreferences.create(
                ctx, FILE, key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        private fun open(ctx: Context): SharedPreferences {
            try {
                return encrypted(ctx)
            } catch (first: Exception) {
                Log.w(TAG, "encrypted session store unreadable, recreating it", first)
                ctx.deleteSharedPreferences(FILE)
            }
            return try {
                encrypted(ctx)
            } catch (second: Exception) {
                Log.w(TAG, "encrypted session store still failing; falling back to plain SharedPreferences", second)
                ctx.getSharedPreferences(PLAIN_FILE, Context.MODE_PRIVATE)
            }
        }
    }
}
