package com.peersflow.mobile.services

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Re-opens the connection after a reboot (guarded: paired + "stay connected"; no-op before the graph exists). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!ServicesHost.isReady) return
        ConnectionServiceControl.start(context)
    }
}
