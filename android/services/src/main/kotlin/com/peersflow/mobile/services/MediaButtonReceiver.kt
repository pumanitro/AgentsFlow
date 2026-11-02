package com.peersflow.mobile.services

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import android.view.KeyEvent
import androidx.core.content.IntentCompat

/** Headset button long press ⇒ Hi LISA. Short presses are left to the media player. */
class MediaButtonReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MEDIA_BUTTON) return
        val ev = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_KEY_EVENT, KeyEvent::class.java) ?: return
        val longPress = (ev.flags and KeyEvent.FLAG_LONG_PRESS) != 0
        if (!isLongPressRelease(ev.keyCode, ev.action, ev.repeatCount, longPress, ev.eventTime - ev.downTime)) return
        try {
            context.startActivity(HiLisaActivity.intent(context, "headset").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: RuntimeException) { // background activity start may be refused
            Log.w("PeersFlowAssist", "headset start refused", e)
        }
    }

    companion object {
        const val LONG_PRESS_MS = 600L

        /** Pure: the release (ACTION_UP) of a held HEADSETHOOK / PLAY_PAUSE key. */
        fun isLongPressRelease(keyCode: Int, action: Int, repeatCount: Int, longPressFlag: Boolean, heldMs: Long): Boolean {
            if (keyCode != KeyEvent.KEYCODE_HEADSETHOOK && keyCode != KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE) return false
            if (action != KeyEvent.ACTION_UP) return false
            return longPressFlag || repeatCount > 0 || heldMs >= LONG_PRESS_MS
        }
    }
}
