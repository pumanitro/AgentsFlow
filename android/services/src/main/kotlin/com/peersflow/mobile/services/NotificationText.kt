package com.peersflow.mobile.services

import com.peersflow.mobile.wire.ConnectionState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Pure text builders for notifications and the Hi LISA connection line; no Context needed. */
object NotificationText {
    private val HHMM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    fun hhmm(ms: Long, zone: ZoneId = ZoneId.systemDefault()): String = HHMM.format(Instant.ofEpochMilli(ms).atZone(zone))

    fun connectionText(state: ConnectionState, since: Long?, serverName: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        when (state) {
            ConnectionState.ONLINE -> if (serverName.isNullOrBlank()) "Connected" else "Connected to $serverName"
            ConnectionState.APP_DOWN -> "Peers Flow is not running on the Mac"
            ConnectionState.MAC_OFF -> if (since == null) "Mac is off" else "Mac off since ${hhmm(since, zone)}"
            ConnectionState.PAUSED -> "Paused"
            ConnectionState.UNAUTHORIZED -> "Revoked — open the app"
            ConnectionState.UNPAIRED -> "Not paired"
        }

    fun tasks(n: Int): String = if (n == 1) "1 task" else "$n tasks"

    fun macBackText(n: Int): String = "Mac is back · ${tasks(n)} started"

    fun offlineText(n: Int, since: Long, zone: ZoneId = ZoneId.systemDefault()): String =
        "${tasks(n)} ${if (n == 1) "is" else "are"} waiting — the Mac has been off since ${hhmm(since, zone)}"
}
