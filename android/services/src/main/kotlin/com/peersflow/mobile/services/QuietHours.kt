package com.peersflow.mobile.services

import com.peersflow.mobile.wire.VoicePrefs
import java.time.Instant
import java.time.OffsetDateTime

/** Pure timing rules for the connection service: quiet hours, the 6-hour outage reminder, stale feed replays. */
object QuietHours {
    const val OUTAGE_REMINDER_MS: Long = 6L * 60 * 60 * 1000
    const val STALE_FEED_MS: Long = 2L * 60 * 1000   // older than 2 min = replayed, never spoken

    /**
     * True when [nowMinutes] (minutes since local midnight) falls inside `[quietFrom, quietTo)`.
     * A range whose end is before its start crosses midnight (22:00–07:00). Either bound null, or equal bounds, ⇒ never quiet.
     */
    fun isQuiet(prefs: VoicePrefs, nowMinutes: Int): Boolean {
        val from = prefs.quietFrom ?: return false
        val to = prefs.quietTo ?: return false
        if (from == to) return false
        val now = ((nowMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
        return if (from < to) now in from until to else now >= from || now < to
    }

    /** One reminder per outage, once it has lasted 6 hours. */
    fun nextOutageReminderDue(offlineSince: Long, now: Long, alreadySent: Boolean): Boolean =
        !alreadySent && now - offlineSince >= OUTAGE_REMINDER_MS

    /** A feed item whose `at` is older than 10 minutes is a replay: notify, but do not read it aloud. Unparsable ⇒ fresh. */
    fun isStaleFeed(atIso: String, now: Long): Boolean {
        val at = parseIso(atIso) ?: return false
        return now - at > STALE_FEED_MS
    }

    fun parseIso(iso: String): Long? =
        runCatching { Instant.parse(iso).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(iso).toInstant().toEpochMilli() }.getOrNull()

    private const val MINUTES_PER_DAY = 24 * 60
}
