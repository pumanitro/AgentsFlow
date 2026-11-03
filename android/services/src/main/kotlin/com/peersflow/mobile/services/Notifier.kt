package com.peersflow.mobile.services

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.MobileNotification

/** Notification channels and every notification the app posts. Posting is skipped silently without POST_NOTIFICATIONS. */
object Notifier {
    const val CHANNEL_OUTCOMES = "outcomes"
    const val CHANNEL_NEEDS_YOU = "needs-you"
    const val CHANNEL_CONNECTION = "connection"

    const val GROUP_OUTCOMES = "outcomes"
    const val GROUP_NEEDS_YOU = "needs-you"

    /** Extra on the "Open" launch intent; MainActivity navigates to `chat/<id>`. */
    const val EXTRA_CONVERSATION_ID = "conversationId"

    const val NOTIF_ID_CONNECTION = 1
    const val NOTIF_ID_MAC_BACK = 2
    const val NOTIF_ID_OFFLINE = 3

    val NEEDS_YOU_VIBRATION = longArrayOf(0, 200, 100, 200)

    fun outcomeId(seq: Long): Int = 1000 + (seq % 100_000).toInt()

    fun needsYouId(seq: Long): Int = 200_000 + (seq % 100_000).toInt()

    fun appNoticeId(id: String): Int = 400_000 + (id.hashCode() and 0x7FFFFFFF) % 100_000

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_OUTCOMES, "Finished work", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A chat finished and has a conclusion for you"
                    setSound(sound, attrs)
                    enableVibration(true)
                },
                NotificationChannel(CHANNEL_NEEDS_YOU, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply {
                    description = "A chat is waiting for your answer"
                    setSound(sound, attrs)
                    enableVibration(true)
                    vibrationPattern = NEEDS_YOU_VIBRATION
                },
                NotificationChannel(CHANNEL_CONNECTION, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
                    description = "Keeps the link to your Mac open"
                    setSound(null, null)
                    enableVibration(false)
                    setShowBadge(false)
                },
            ),
        )
    }

    /** Owner rule 2026-11-03: the app is silent — no notification is posted anywhere. Flip to true to bring them back. */
    const val NOTIFICATIONS_ENABLED = false

    fun canPost(ctx: Context): Boolean {
        if (!NOTIFICATIONS_ENABLED) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(ctx).areNotificationsEnabled()
    }

    // ---- builders --------------------------------------------------------------------------------------------

    fun connectionNotification(ctx: Context, state: ConnectionState, since: Long?, serverName: String? = null): Notification =
        NotificationCompat.Builder(ctx, CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_peersflow)
            .setContentTitle("Peers Flow")
            .setContentText(NotificationText.connectionText(state, since, serverName))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(openApp(ctx, null, NOTIF_ID_CONNECTION))
            .build()

    fun outcome(ctx: Context, item: FeedItem) {
        val id = outcomeId(item.seq)
        // A short alert, not the conclusion itself: the details are one tap away in the chat.
        val body = item.needs?.takeIf { it.isNotBlank() }?.let { "Needs you: $it" } ?: "Done — nothing more needed from you."
        val n = NotificationCompat.Builder(ctx, CHANNEL_OUTCOMES)
            .setSmallIcon(R.drawable.ic_stat_peersflow)
            .setContentTitle("${item.peerName} · ${item.title}")
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setGroup(GROUP_OUTCOMES)
            .setWhen(QuietHours.parseIso(item.at) ?: System.currentTimeMillis())
            .setContentIntent(openApp(ctx, item.conversationId, id))
            .build()
        post(ctx, id, n)
    }

    fun needsYou(ctx: Context, item: FeedItem) {
        val id = needsYouId(item.seq)
        val question = item.questions.firstOrNull()
        val text = question?.question ?: item.needs ?: item.title
        val b = NotificationCompat.Builder(ctx, CHANNEL_NEEDS_YOU)
            .setSmallIcon(R.drawable.ic_stat_peersflow)
            .setContentTitle("${item.peerName} needs you")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVibrate(NEEDS_YOU_VIBRATION)
            .setAutoCancel(true)
            .setGroup(GROUP_NEEDS_YOU)
            .setContentIntent(openApp(ctx, item.conversationId, id))
        question?.options.orEmpty().take(MAX_ANSWER_CHIPS).forEachIndexed { i, opt ->
            val answer = Intent(ctx, ConnectionService::class.java)
                .setAction(ConnectionService.ACTION_ANSWER)
                .putExtra(ConnectionService.EXTRA_CONVERSATION_ID, item.conversationId)
                .putExtra(ConnectionService.EXTRA_QUESTION_ID, question?.id)
                .putExtra(ConnectionService.EXTRA_TEXT, opt.label)
                .putExtra(ConnectionService.EXTRA_NOTIFICATION_ID, id)
            // Distinct request code per chip, or FLAG_UPDATE_CURRENT would fold them into one PendingIntent.
            b.addAction(0, opt.label, serviceIntent(ctx, id * 4 + i + 1, answer))
        }
        b.addAction(0, "Open", openApp(ctx, item.conversationId, id))
        post(ctx, id, b.build())
    }

    fun appNotice(ctx: Context, n: MobileNotification) {
        val id = appNoticeId(n.id)
        val channel = if (n.level == "error" || n.level == "warn" || n.level == "warning") CHANNEL_NEEDS_YOU else CHANNEL_OUTCOMES
        val title = n.peerName?.let { "$it · ${n.title}" } ?: n.title
        val b = NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_stat_peersflow)
            .setContentTitle(title)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openApp(ctx, n.conversationId, id))
        n.body?.let { b.setContentText(it).setStyle(NotificationCompat.BigTextStyle().bigText(it)) }
        post(ctx, id, b.build())
    }

    fun macBack(ctx: Context, count: Int) {
        val n = NotificationCompat.Builder(ctx, CHANNEL_OUTCOMES)
            .setSmallIcon(R.drawable.ic_stat_peersflow)
            .setContentTitle(NotificationText.macBackText(count))
            .setContentText("Your saved messages were delivered")
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openApp(ctx, null, NOTIF_ID_MAC_BACK))
            .build()
        post(ctx, NOTIF_ID_MAC_BACK, n)
    }

    fun offlineReminder(ctx: Context, count: Int, since: Long) {
        val text = NotificationText.offlineText(count, since)
        val n = NotificationCompat.Builder(ctx, CHANNEL_NEEDS_YOU)
            .setSmallIcon(R.drawable.ic_stat_peersflow)
            .setContentTitle("Mac is still off")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openApp(ctx, null, NOTIF_ID_OFFLINE))
            .build()
        post(ctx, NOTIF_ID_OFFLINE, n)
    }

    fun updateConnection(ctx: Context, state: ConnectionState, since: Long?, serverName: String?) =
        post(ctx, NOTIF_ID_CONNECTION, connectionNotification(ctx, state, since, serverName))

    fun cancel(ctx: Context, id: Int) {
        NotificationManagerCompat.from(ctx).cancel(id)
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    @SuppressLint("MissingPermission") // checked in canPost
    private fun post(ctx: Context, id: Int, n: Notification) {
        if (!canPost(ctx)) return
        runCatching { NotificationManagerCompat.from(ctx).notify(id, n) }
    }

    private const val FLAGS = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    private const val MAX_ANSWER_CHIPS = 3

    private fun openApp(ctx: Context, conversationId: String?, requestCode: Int): PendingIntent? {
        val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: return null
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (conversationId != null) launch.putExtra(EXTRA_CONVERSATION_ID, conversationId)
        return PendingIntent.getActivity(ctx, requestCode, launch, FLAGS)
    }

    private fun serviceIntent(ctx: Context, requestCode: Int, intent: Intent): PendingIntent =
        PendingIntent.getForegroundService(ctx, requestCode, intent, FLAGS)
}
