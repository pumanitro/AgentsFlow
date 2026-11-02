package com.peersflow.mobile.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ServerHealth
import java.util.Locale

/** Dot colour and sentence for each connection state (PLAN §5.1). */
@Composable
internal fun statusLine(connection: ConnectionState, health: ServerHealth?, lastSeenAt: Long?): Pair<Color, String> = when (connection) {
    ConnectionState.ONLINE -> UiColors.ok to when {
        health == null -> stringResource(R.string.status_online_nohost)
        health.load1 == null -> stringResource(R.string.status_online, health.hostname)
        else -> stringResource(R.string.status_online_load, health.hostname, String.format(Locale.US, "%.1f", health.load1))
    }
    ConnectionState.APP_DOWN -> UiColors.warn to
        (lastSeenAt?.let { stringResource(R.string.status_app_down_seen, hhmm(it)) } ?: stringResource(R.string.status_app_down))
    ConnectionState.MAC_OFF -> UiColors.err to
        (lastSeenAt?.let { stringResource(R.string.status_mac_off_since, hhmm(it)) } ?: stringResource(R.string.status_mac_off))
    ConnectionState.PAUSED -> UiColors.warn to stringResource(R.string.status_paused)
    ConnectionState.UNAUTHORIZED -> UiColors.err to stringResource(R.string.status_unauthorized)
    ConnectionState.UNPAIRED -> UiColors.muted to stringResource(R.string.status_unpaired)
}

/** Full-width band under the top bar; a tap re-checks the Mac. */
@Composable
fun StatusStrip(connection: ConnectionState, health: ServerHealth?, lastSeenAt: Long?, onTap: () -> Unit, modifier: Modifier = Modifier) {
    val (color, text) = statusLine(connection, health, lastSeenAt)
    Column(modifier.fillMaxWidth().testTag("status_strip").clickable(onClick = onTap)) {
        Row(
            Modifier.fillMaxWidth().background(UiColors.surface).heightIn(min = 48.dp).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            StatusDot(color, pulse = false)
            Text(
                text,
                color = UiColors.onBg,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        // coloured underline so the state reads at a glance even without the dot
        Box(Modifier.fillMaxWidth().height(2.dp).background(color))
    }
}

@Preview
@Composable
private fun StatusStripPreview() = UiMainTheme {
    Column {
        StatusStrip(ConnectionState.ONLINE, PreviewData.health, null, {})
        StatusStrip(ConnectionState.MAC_OFF, null, 1_761_640_000_000, {})
        StatusStrip(ConnectionState.APP_DOWN, null, 1_761_640_000_000, {})
        StatusStrip(ConnectionState.UNAUTHORIZED, null, null, {})
    }
}
