package com.peersflow.mobile.services

import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.ServerEvent
import com.peersflow.mobile.wire.Sources
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import java.time.LocalTime

/**
 * Foreground service (type specialUse) that keeps the event stream to the Mac open while the phone is idle,
 * turns feed events into notifications, reads conclusions aloud, flushes the outbox, and reminds about long outages.
 */
class ConnectionService : LifecycleService() {

    companion object {
        private const val TAG = "PeersFlowConn"
        private const val P = "com.peersflow.mobile.services."
        const val ACTION_START = P + "START"
        const val ACTION_STOP = P + "STOP"
        const val ACTION_KICK = P + "KICK"
        const val ACTION_ANSWER = P + "ANSWER"
        const val ACTION_REPLAY = P + "REPLAY"

        const val EXTRA_REASON = "reason"
        const val EXTRA_CONVERSATION_ID = "conversationId"
        const val EXTRA_QUESTION_ID = "questionId"
        const val EXTRA_TEXT = "text"
        const val EXTRA_SEQ = "seq"
        const val EXTRA_NOTIFICATION_ID = "notificationId"

        const val NOTIF_ID_CONNECTION = Notifier.NOTIF_ID_CONNECTION

        private const val FLUSH_TICK_MS = 60_000L
        private const val REMINDER_TICK_MS = 60_000L
        private const val MAC_BACK_WAIT_MS = 30_000L
        private const val STALE_BURST_SETTLE_MS = 2_000L

        @Volatile
        var running: Boolean = false
            private set
    }

    private val deps: ServicesDeps? get() = if (ServicesHost.isReady) ServicesHost.deps else null

    private var state: ConnectionState = ConnectionState.UNPAIRED
    private var offlineSince: Long? = null
    private var reminderSent = false
    private var flushAtOutageStart: FlushReport? = null

    /** At most 3 waiting conclusions; beyond that the oldest is dropped so the newest wins. */
    private val speakQueue = Channel<FeedItem>(capacity = 3, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    private var staleCandidate: FeedItem? = null
    private var staleJob: Job? = null

    /** One-shot work from notification actions; a stop waits for these so an answer is not cut off. */
    private val oneShots = mutableListOf<Job>()

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        val d = deps
        // startForeground first, always: startForegroundService() demands it within seconds, even if we stop right after.
        if (!goForeground(d)) {
            stopSelf()
            return
        }
        if (d == null) {
            Log.w(TAG, "ServicesHost not ready; stopping")
            stopSelf()
            return
        }
        d.events.start()
        watchState(d)
        watchEvents(d)
        speaker(d)
        flushTicker(d)
        outageReminder(d)
        watchPrefsAndSession(d)
        registerNetwork(d)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        val d = deps ?: return START_NOT_STICKY
        when (intent?.action) {
            ACTION_STOP -> {
                ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_KICK -> d.events.kick(intent.getStringExtra(EXTRA_REASON) ?: "service")
            ACTION_ANSWER -> {
                val cid = intent.getStringExtra(EXTRA_CONVERSATION_ID)
                val text = intent.getStringExtra(EXTRA_TEXT)
                val qid = intent.getStringExtra(EXTRA_QUESTION_ID)
                val nid = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)
                if (cid != null && text != null) {
                    oneShot {
                        val r = runCatching { d.repo.answer(cid, qid, text, Sources.PHONE) }
                        Log.i(TAG, "answer from notification: ${r.getOrNull() ?: r.exceptionOrNull()}")
                        if (nid >= 0) Notifier.cancel(this, nid)
                    }
                }
            }
            ACTION_REPLAY -> {
                val seq = intent.getLongExtra(EXTRA_SEQ, -1L)
                if (seq >= 0) {
                    oneShot {
                        val item = d.outcomes.feed().first().firstOrNull { it.seq == seq }
                        if (item?.spoken != null) speakQueue.trySend(item)
                    }
                }
            }
            else -> Unit // ACTION_START / null (sticky restart): onCreate already did the work
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        deps?.events?.stop()
        networkCallback?.let { cb ->
            runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
        }
        networkCallback = null
        super.onDestroy()
    }

    // ---- foreground --------------------------------------------------------------------------------------------

    private fun goForeground(d: ServicesDeps?): Boolean {
        val s = d?.status?.state?.value ?: ConnectionState.UNPAIRED
        val n = Notifier.connectionNotification(this, s, null, d?.session?.session?.value?.serverName)
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID_CONNECTION, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIF_ID_CONNECTION, n)
            }
            true
        } catch (e: IllegalStateException) { // ForegroundServiceStartNotAllowedException extends it
            Log.w(TAG, "startForeground refused", e)
            false
        }
    }

    // ---- (a) connection state ----------------------------------------------------------------------------------

    private fun watchState(d: ServicesDeps) = lifecycleScope.launch {
        var prev: ConnectionState? = null
        d.status.state.collect { s ->
            val now = System.currentTimeMillis()
            if (s != ConnectionState.ONLINE) {
                if (offlineSince == null) {
                    offlineSince = now
                    reminderSent = false
                    flushAtOutageStart = d.lastFlush.value
                }
            } else {
                if (prev != null && prev != ConnectionState.ONLINE) awaitMacBack(d, flushAtOutageStart)
                offlineSince = null
                reminderSent = false
            }
            state = s
            updateConnection(d)
            prev = s
        }
    }

    private fun since(d: ServicesDeps): Long? = d.status.lastSeenAt.value ?: offlineSince

    private fun updateConnection(d: ServicesDeps) {
        Notifier.updateConnection(this, state, since(d), d.session.session.value?.serverName)
    }

    /** The status repo flushes the outbox when the Mac returns; wait for that report (not the one from before the outage). */
    private fun awaitMacBack(d: ServicesDeps, before: FlushReport?) {
        lifecycleScope.launch {
            val report = withTimeoutOrNull(MAC_BACK_WAIT_MS) {
                d.lastFlush.first { it != null && it !== before }
            }
            if (report != null && report.sent > 0) Notifier.macBack(this@ConnectionService, report.sent)
        }
    }

    // ---- (b) events --------------------------------------------------------------------------------------------

    private fun watchEvents(d: ServicesDeps) = lifecycleScope.launch {
        d.events.events.collect { e ->
            when (e) {
                is ServerEvent.Feed -> onFeed(d, e.item)
                is ServerEvent.NotificationAdded -> Notifier.appNotice(this@ConnectionService, e.notification)
                else -> Unit
            }
        }
    }

    private fun onFeed(d: ServicesDeps, item: FeedItem) {
        when (item.kind) {
            "outcome" -> {
                Notifier.outcome(this, item)
                if (item.spoken.isNullOrBlank()) return
                val prefs = d.session.prefs.value
                if (!prefs.speakAlways || QuietHours.isQuiet(prefs, nowMinutes())) return
                // Never read out anything old: a reconnect or app start replays past conclusions,
                // and those stay silent (they are in the Outcomes list). Only a conclusion that
                // arrives live, while connected, is spoken — and only when the user turned it on.
                if (QuietHours.isStaleFeed(item.at, System.currentTimeMillis())) return
                speakQueue.trySend(item)
            }
            "needs-you" -> Notifier.needsYou(this, item)
            else -> Unit
        }
    }

    /** One utterance at a time. */
    private fun speaker(d: ServicesDeps) = lifecycleScope.launch {
        for (item in speakQueue) {
            val text = item.spoken ?: continue
            try {
                d.voice.speak(text, "feed:${item.seq}").await()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "speak failed for feed ${item.seq}", e)
            }
        }
    }

    // ---- (c) outbox ticker -------------------------------------------------------------------------------------

    private fun flushTicker(d: ServicesDeps) = lifecycleScope.launch {
        while (isActive) {
            delay(FLUSH_TICK_MS)
            if (d.status.state.value == ConnectionState.ONLINE) {
                try {
                    d.outbox.flush()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "outbox flush failed", e)
                }
            }
        }
    }

    // ---- (d) network -------------------------------------------------------------------------------------------

    private fun registerNetwork(d: ServicesDeps) {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = d.events.kick("network")

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) d.events.kick("network")
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: RuntimeException) {
            Log.w(TAG, "network callback not registered", e)
        }
    }

    // ---- (e) offline reminder ----------------------------------------------------------------------------------

    private fun outageReminder(d: ServicesDeps) = lifecycleScope.launch {
        while (isActive) {
            delay(REMINDER_TICK_MS)
            val start = offlineSince ?: continue
            if (!QuietHours.nextOutageReminderDue(start, System.currentTimeMillis(), reminderSent)) continue
            val waiting = d.outbox.items.first().size
            if (waiting > 0) {
                reminderSent = true
                Notifier.offlineReminder(this@ConnectionService, waiting, since(d) ?: start)
            }
        }
    }

    // ---- (f) prefs / session -----------------------------------------------------------------------------------

    private fun watchPrefsAndSession(d: ServicesDeps) {
        lifecycleScope.launch {
            d.session.prefs.collect { if (!it.stayConnected) stopWhenIdle() }
        }
        lifecycleScope.launch {
            d.session.session.collect { if (it == null) stopWhenIdle() else updateConnection(d) }
        }
    }

    private fun oneShot(block: suspend () -> Unit) {
        val job = lifecycleScope.launch { block() }
        synchronized(oneShots) { oneShots += job }
        job.invokeOnCompletion { synchronized(oneShots) { oneShots -= job } }
    }

    private fun stopWhenIdle() {
        lifecycleScope.launch {
            synchronized(oneShots) { oneShots.toList() }.joinAll()
            stopSelf()
        }
    }

    private fun nowMinutes(): Int = LocalTime.now().let { it.hour * 60 + it.minute }
}
