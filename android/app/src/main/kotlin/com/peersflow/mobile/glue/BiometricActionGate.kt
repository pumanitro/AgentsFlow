package com.peersflow.mobile.glue

import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.peersflow.mobile.wire.ActionGate
import com.peersflow.mobile.wire.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * Biometric (or device PIN) confirmation before an action. Passes straight through when the
 * "biometric" pref is off or a confirmation succeeded in the last [graceMs]. No activity on screen ⇒ refuse.
 */
class BiometricActionGate(
    private val session: SessionStore,
    private val clock: () -> Long = System::currentTimeMillis,
    private val graceMs: Long = 5 * 60 * 1000L,
    private val activity: () -> FragmentActivity?,
) : ActionGate {
    @Volatile private var lastSuccessAt: Long? = null

    override suspend fun confirm(reason: String): Boolean {
        if (!session.prefs.value.biometric) return true
        val last = lastSuccessAt
        if (last != null && clock() - last < graceMs) return true
        val ok = withContext(Dispatchers.Main) {
            val act = activity()?.takeIf { !it.isFinishing && !it.isDestroyed } ?: return@withContext false
            suspendCancellableCoroutine { cont ->
                val prompt = BiometricPrompt(act, ContextCompat.getMainExecutor(act), object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (cont.isActive) cont.resume(false)
                    }
                    // onAuthenticationFailed is not terminal: the prompt stays up for another try.
                })
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Confirm")
                    .setSubtitle(reason)
                    .setAllowedAuthenticators(BIOMETRIC_WEAK or DEVICE_CREDENTIAL)
                    .build()
                cont.invokeOnCancellation { runCatching { prompt.cancelAuthentication() } }
                try {
                    prompt.authenticate(info)
                } catch (e: RuntimeException) {
                    if (cont.isActive) cont.resume(false)
                }
            }
        }
        if (ok) lastSuccessAt = clock()
        return ok
    }
}
