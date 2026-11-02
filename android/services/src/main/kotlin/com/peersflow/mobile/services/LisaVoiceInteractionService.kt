package com.peersflow.mobile.services

import android.service.voice.VoiceInteractionService
import android.util.Log

/** Registers Peers Flow as a digital-assistant app (Samsung side-button long press, ASSIST gesture). */
class LisaVoiceInteractionService : VoiceInteractionService() {
    override fun onReady() {
        super.onReady()
        Log.i("PeersFlowAssist", "voice interaction service ready")
    }
}
