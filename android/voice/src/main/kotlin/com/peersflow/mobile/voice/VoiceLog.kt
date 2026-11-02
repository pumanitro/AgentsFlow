package com.peersflow.mobile.voice

/** Tiny logging seam for the voice module. Never pass an API key into a log line. */
fun interface VoiceLog {
    fun log(message: String)

    companion object {
        val NONE: VoiceLog = VoiceLog { }
    }
}
