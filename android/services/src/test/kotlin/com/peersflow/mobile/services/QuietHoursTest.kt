package com.peersflow.mobile.services

import com.peersflow.mobile.wire.VoicePrefs
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuietHoursTest {
    private fun m(h: Int, min: Int = 0) = h * 60 + min

    @Test fun rangeInsideOneDay() {
        val p = VoicePrefs(quietFrom = m(13), quietTo = m(15))
        assertFalse(QuietHours.isQuiet(p, m(12, 59)))
        assertTrue(QuietHours.isQuiet(p, m(13)))
        assertTrue(QuietHours.isQuiet(p, m(14, 59)))
        assertFalse(QuietHours.isQuiet(p, m(15)))
    }

    @Test fun rangeCrossingMidnight() {
        val p = VoicePrefs(quietFrom = m(22), quietTo = m(7))
        assertTrue(QuietHours.isQuiet(p, m(23, 30)))
        assertTrue(QuietHours.isQuiet(p, m(0)))
        assertTrue(QuietHours.isQuiet(p, m(6, 59)))
        assertFalse(QuietHours.isQuiet(p, m(7)))
        assertFalse(QuietHours.isQuiet(p, m(12)))
        assertFalse(QuietHours.isQuiet(p, m(21, 59)))
    }

    @Test fun nullOrEmptyRangeIsNeverQuiet() {
        assertFalse(QuietHours.isQuiet(VoicePrefs(), m(3)))
        assertFalse(QuietHours.isQuiet(VoicePrefs(quietFrom = m(22)), m(23)))
        assertFalse(QuietHours.isQuiet(VoicePrefs(quietTo = m(7)), m(3)))
        assertFalse(QuietHours.isQuiet(VoicePrefs(quietFrom = m(5), quietTo = m(5)), m(5)))
    }

    @Test fun outageReminderAtSixHoursOnce() {
        val since = 1_000_000L
        val six = 6L * 60 * 60 * 1000
        assertFalse(QuietHours.nextOutageReminderDue(since, since + six - 1, alreadySent = false))
        assertTrue(QuietHours.nextOutageReminderDue(since, since + six, alreadySent = false))
        assertTrue(QuietHours.nextOutageReminderDue(since, since + 2 * six, alreadySent = false))
        assertFalse(QuietHours.nextOutageReminderDue(since, since + six, alreadySent = true))
    }

    @Test fun staleFeedOlderThanTenMinutes() {
        val now = QuietHours.parseIso("2026-10-28T12:00:00Z")!!
        assertFalse(QuietHours.isStaleFeed("2026-10-28T11:59:00Z", now))   // 1 min old: live
        assertTrue(QuietHours.isStaleFeed("2026-10-28T11:55:00Z", now))    // 5 min old: replayed, silent
        assertTrue(QuietHours.isStaleFeed("2026-10-28T11:49:00Z", now))
        assertTrue(QuietHours.isStaleFeed("2026-10-28T13:49:00+02:00", now))
        assertFalse(QuietHours.isStaleFeed("not a date", now))
    }
}
