package com.peersflow.mobile.ui.aux

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.PairRequest
import com.peersflow.mobile.wire.Session
import com.peersflow.mobile.wire.SessionStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.net.URI
import java.net.URLDecoder

data class PairingUiState(
    val url: String = "",
    val code: String = "",
    val name: String = "",
    val busy: Boolean = false,
    val error: String? = null,
    val warning: String? = null,
    val paired: Boolean = false,
)

class PairingViewModel(
    private val api: ApiClient,
    private val session: SessionStore,
    deviceNameDefault: String = android.os.Build.MODEL ?: "phone",
    private val now: () -> Long = System::currentTimeMillis,
) : ViewModel() {

    private val _state = MutableStateFlow(PairingUiState(name = deviceNameDefault))
    val state: StateFlow<PairingUiState> = _state.asStateFlow()

    fun setUrl(value: String) = _state.update { it.copy(url = value.trim(), error = null) }

    fun setCode(raw: String) = _state.update { it.copy(code = normaliseCode(raw), error = null) }

    fun setName(value: String) = _state.update { it.copy(name = value) }

    fun applyDeepLink(url: String?, code: String?) {
        if (!url.isNullOrBlank()) setUrl(url)
        if (!code.isNullOrBlank()) setCode(code)
    }

    /** Parses `peersflow://pair?url=&code=&fp=` from a scanned QR. */
    fun applyScan(text: String) {
        val parsed = parsePairingLink(text)
        if (parsed == null) {
            _state.update { it.copy(error = "Not a Peers Flow pairing code") }
            return
        }
        applyDeepLink(parsed.first, parsed.second)
    }

    fun submit() {
        val s = _state.value
        if (s.busy) return
        val url = s.url.trim()
        if (!(url.startsWith("http://") || url.startsWith("https://"))) {
            _state.update { it.copy(error = "Server address must start with http:// or https://") }
            return
        }
        if (s.code.length != CODE_LEN) {
            _state.update { it.copy(error = "Enter the 8-letter pairing code (ABCD-EFGH)") }
            return
        }
        val baseUrl = url.trimEnd('/')
        _state.update { it.copy(busy = true, error = null, warning = null) }
        viewModelScope.launch {
            val name = s.name.ifBlank { "phone" }
            when (val r = api.pair(baseUrl, PairRequest(s.code, name))) {
                is ApiResult.Ok -> {
                    val p = r.value
                    session.save(Session(baseUrl, p.token, p.deviceId, p.scopes, p.serverName, p.sttKey, now()))
                    _state.update {
                        it.copy(
                            busy = false,
                            paired = true,
                            warning = if (p.sttKey == null) NO_STT_WARNING else null,
                        )
                    }
                }
                is ApiResult.Err -> _state.update { it.copy(busy = false, error = describe(r, baseUrl)) }
            }
        }
    }

    private fun describe(e: ApiResult.Err, baseUrl: String): String = when {
        e.transport || e.code == "transport" -> "Cannot reach ${hostOf(baseUrl)} — same network? Peers Flow running?"
        e.code == "not_found" || e.code == "unauthorized" ->
            "Code is wrong or expired — make a new one in Peers Flow → Mobile"
        e.code == "rate_limited" -> "Too many attempts, wait a minute"
        e.code == "forbidden" -> "The Mac refused: not your tailnet identity"
        else -> e.message
    }

    companion object {
        const val CODE_LEN = 9
        const val NO_STT_WARNING = "No speech key from the Mac — voice will use the phone's own recognizer"

        fun normaliseCode(raw: String): String {
            val letters = raw.uppercase().filter { it in 'A'..'Z' || it in '2'..'9' }.take(8)
            return if (letters.length > 4) letters.substring(0, 4) + "-" + letters.substring(4) else letters
        }

        fun hostOf(url: String): String = try {
            URI(url).host ?: url
        } catch (_: Exception) {
            url
        }

        /** Returns (url, code) or null when the text is not a pairing link. Pure JVM, no android.net.Uri. */
        fun parsePairingLink(text: String): Pair<String?, String?>? {
            return try {
                val uri = URI(text.trim())
                if (uri.scheme != "peersflow") return null
                val q = uri.rawQuery ?: return null
                val map = q.split('&').filter { it.isNotEmpty() }.associate { part ->
                    val i = part.indexOf('=')
                    val k = if (i < 0) part else part.substring(0, i)
                    val v = if (i < 0) "" else part.substring(i + 1)
                    URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
                }
                val url = map["url"]
                val code = map["code"]
                if (url == null && code == null) null else url to code
            } catch (_: Exception) {
                null
            }
        }
    }
}
