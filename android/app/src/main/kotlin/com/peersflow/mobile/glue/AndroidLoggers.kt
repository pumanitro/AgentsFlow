package com.peersflow.mobile.glue

import android.util.Log
import com.peersflow.mobile.net.NetLogger
import com.peersflow.mobile.voice.VoiceLog

private const val TAG = "PeersFlow"

/** `:net` logging into logcat. `:net` only passes method, path, status and timing; no headers, token or key. */
object AndroidNetLogger : NetLogger {
    override fun d(msg: String) {
        Log.d(TAG, "net: $msg")
    }

    override fun w(msg: String, t: Throwable?) {
        // The throwable's class only: an exception message could echo a URL with a query string.
        Log.w(TAG, "net: $msg" + (t?.let { " (${it.javaClass.simpleName})" } ?: ""))
    }
}

/** `:voice` logging into logcat. `:voice` redacts keys itself (`Redact`). */
object AndroidVoiceLog : VoiceLog {
    override fun log(message: String) {
        Log.d(TAG, "voice: $message")
    }
}
