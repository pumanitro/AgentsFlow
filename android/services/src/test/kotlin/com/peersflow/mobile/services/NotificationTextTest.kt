package com.peersflow.mobile.services

import com.peersflow.mobile.wire.ConnectionState
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneOffset

class NotificationTextTest {
    private val utc = ZoneOffset.UTC
    private val at0930 = QuietHours.parseIso("2026-10-28T09:30:00Z")!!

    @Test fun connectionTexts() {
        assertEquals("Connected to iMac", NotificationText.connectionText(ConnectionState.ONLINE, null, "iMac", utc))
        assertEquals("Peers Flow is not running on the Mac", NotificationText.connectionText(ConnectionState.APP_DOWN, null, "iMac", utc))
        assertEquals("Mac off since 09:30", NotificationText.connectionText(ConnectionState.MAC_OFF, at0930, "iMac", utc))
        assertEquals("Mac is off", NotificationText.connectionText(ConnectionState.MAC_OFF, null, "iMac", utc))
        assertEquals("Paused", NotificationText.connectionText(ConnectionState.PAUSED, null, null, utc))
        assertEquals("Revoked — open the app", NotificationText.connectionText(ConnectionState.UNAUTHORIZED, null, null, utc))
    }

    @Test fun macBackAndOfflineTexts() {
        assertEquals("Mac is back · 1 task started", NotificationText.macBackText(1))
        assertEquals("Mac is back · 3 tasks started", NotificationText.macBackText(3))
        assertEquals("2 tasks are waiting — the Mac has been off since 09:30", NotificationText.offlineText(2, at0930, utc))
        assertEquals("1 task is waiting — the Mac has been off since 09:30", NotificationText.offlineText(1, at0930, utc))
    }

    @Test fun headsetLongPressReleaseOnly() {
        val hook = android.view.KeyEvent.KEYCODE_HEADSETHOOK
        val up = android.view.KeyEvent.ACTION_UP
        val down = android.view.KeyEvent.ACTION_DOWN
        assertEquals(true, MediaButtonReceiver.isLongPressRelease(hook, up, 0, false, 800))
        assertEquals(true, MediaButtonReceiver.isLongPressRelease(hook, up, 2, false, 100))
        assertEquals(false, MediaButtonReceiver.isLongPressRelease(hook, up, 0, false, 120))
        assertEquals(false, MediaButtonReceiver.isLongPressRelease(hook, down, 3, true, 900))
        assertEquals(false, MediaButtonReceiver.isLongPressRelease(android.view.KeyEvent.KEYCODE_VOLUME_UP, up, 3, true, 900))
    }
}
