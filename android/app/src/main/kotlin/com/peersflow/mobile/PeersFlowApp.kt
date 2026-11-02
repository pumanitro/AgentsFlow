package com.peersflow.mobile

import android.app.Activity
import android.app.Application
import android.os.Bundle
import com.peersflow.mobile.services.ConnectionServiceControl
import com.peersflow.mobile.services.Notifier
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

class PeersFlowApp : Application() {
    private var started = 0

    override fun onCreate() {
        super.onCreate()
        AppGraph.init(this)
        Notifier.createChannels(this)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityCreated(a: Activity, b: Bundle?) = Unit
            override fun onActivityStarted(a: Activity) {
                started++
            }

            override fun onActivityResumed(a: Activity) {
                AppGraph.currentActivity = a
                // ConnectionService.onDestroy stops the stream; a foreground app must still get live updates.
                AppGraph.onForeground("app-open")
            }

            override fun onActivityPaused(a: Activity) = Unit
            override fun onActivityStopped(a: Activity) {
                started = (started - 1).coerceAtLeast(0)
                // Nothing on screen and the user chose not to stay connected: let the stream go.
                if (started == 0 && AppGraph.isPaired && !AppGraph.session.prefs.value.stayConnected) {
                    AppGraph.events.stop()
                }
            }

            override fun onActivitySaveInstanceState(a: Activity, b: Bundle) = Unit
            override fun onActivityDestroyed(a: Activity) {
                if (AppGraph.currentActivity === a) AppGraph.currentActivity = null
            }
        })
        if (AppGraph.isPaired && AppGraph.session.prefs.value.stayConnected) {
            ConnectionServiceControl.start(this) // guarded; falls back to a plain stream start in the background
        }
        // The service stops itself when "stay connected" goes off; switching it back on must start it again.
        AppGraph.scope.launch {
            AppGraph.session.prefs.map { it.stayConnected }.distinctUntilChanged().drop(1).collect { on ->
                if (on) ConnectionServiceControl.start(this@PeersFlowApp)
            }
        }
    }
}
