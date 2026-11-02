package com.peersflow.mobile.services

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import android.util.Log

/** The assistant session only hands off to [HiLisaActivity]; it draws no UI of its own. */
class LisaVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        try {
            startAssistantActivity(HiLisaActivity.intent(context, "side-button").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: RuntimeException) {
            Log.w("PeersFlowAssist", "could not start Hi LISA", e)
        }
        hide()
    }


    // onHandleAssist is left at its default (ignored): the overlay does not use screen context.
}
