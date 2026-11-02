package com.peersflow.mobile.services

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/** Starts/stops [ConnectionService]. Every call is a safe no-op before `ServicesHost.deps` is wired. */
object ConnectionServiceControl {
    private const val TAG = "PeersFlowConn"

    /** Starts the foreground service when paired and "stay connected" is on; falls back to a plain stream start. */
    fun start(ctx: Context) {
        if (!ServicesHost.isReady) return
        val deps = ServicesHost.deps
        if (deps.session.session.value == null || !deps.session.prefs.value.stayConnected) return
        try {
            ContextCompat.startForegroundService(
                ctx,
                Intent(ctx, ConnectionService::class.java).setAction(ConnectionService.ACTION_START),
            )
        } catch (e: IllegalStateException) { // ForegroundServiceStartNotAllowedException (API 31+) extends it
            Log.w(TAG, "foreground start not allowed; keeping the stream without the service", e)
            deps.events.start()
        } catch (e: SecurityException) {
            Log.w(TAG, "foreground start refused", e)
            deps.events.start()
        }
    }

    fun stop(ctx: Context) {
        runCatching { ctx.stopService(Intent(ctx, ConnectionService::class.java)) }
    }

    /** Reconnect now. Goes straight to the shared event stream, so it works whether or not the service runs. */
    fun kick(ctx: Context, reason: String) {
        if (!ServicesHost.isReady) return
        ServicesHost.deps.events.kick(reason)
    }
}
