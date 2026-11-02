package com.peersflow.mobile.net

/** Logging seam for `:net`. `:app` passes an `android.util.Log` adapter. Callers never pass the token or the sttKey. */
interface NetLogger {
    fun d(msg: String)
    fun w(msg: String, t: Throwable? = null)

    companion object {
        val NONE: NetLogger = object : NetLogger {
            override fun d(msg: String) = Unit
            override fun w(msg: String, t: Throwable?) = Unit
        }
    }
}
