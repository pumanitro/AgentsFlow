package com.peersflow.mobile.ui.main

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Reply
import androidx.compose.material.icons.outlined.AddComment
import androidx.compose.material.icons.outlined.QuestionAnswer
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.PeerSummary

/** Messages written while the Mac was away; each can be cancelled or turned into a fresh chat. */
@Composable
fun OutboxCard(
    items: List<OutboxItem>,
    peers: List<PeerSummary>,
    summaries: List<ConversationSummary>,
    onCancel: (String) -> Unit,
    onRetarget: (id: String, peerId: String) -> Unit,
    modifier: Modifier = Modifier,
    now: Long = System.currentTimeMillis(),
) {
    var picking by remember { mutableStateOf<String?>(null) }
    Card(
        modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("outbox_card"),
        colors = CardDefaults.cardColors(containerColor = UiColors.surface, contentColor = UiColors.onBg),
        border = BorderStroke(1.5.dp, UiColors.warn),
    ) {
        Column(Modifier.padding(vertical = 8.dp)) {
            Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Schedule, null, tint = UiColors.warn, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(stringResource(R.string.outbox_title, items.size), fontWeight = FontWeight.SemiBold, fontSize = 15.sp, color = UiColors.onBg)
            }
            items.forEachIndexed { i, item ->
                if (i > 0) HorizontalDivider(color = UiColors.outline, modifier = Modifier.padding(horizontal = 12.dp))
                OutboxRow(item, peers, summaries, now, onCancel = { onCancel(item.id) }, onFresh = { picking = item.id })
            }
        }
    }
    val pickId = picking
    if (pickId != null) {
        AlertDialog(
            onDismissRequest = { picking = null },
            title = { Text(stringResource(R.string.outbox_pick_peer)) },
            text = {
                Column {
                    peers.forEach { p ->
                        TextButton(
                            onClick = { onRetarget(pickId, p.id); picking = null },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) { Text(p.name, color = UiColors.onBg, modifier = Modifier.fillMaxWidth()) }
                    }
                }
            },
            confirmButton = {},
            dismissButton = { TextButton(onClick = { picking = null }) { Text(stringResource(R.string.outbox_cancel)) } },
            containerColor = UiColors.surface,
        )
    }
}

@Composable
private fun OutboxRow(
    item: OutboxItem,
    peers: List<PeerSummary>,
    summaries: List<ConversationSummary>,
    now: Long,
    onCancel: () -> Unit,
    onFresh: () -> Unit,
) {
    val icon = when (item.kind) {
        OutboxKind.SPAWN -> Icons.Outlined.AddComment
        OutboxKind.REPLY -> Icons.AutoMirrored.Outlined.Reply
        OutboxKind.ANSWER -> Icons.Outlined.QuestionAnswer
    }
    val target = when (item.kind) {
        OutboxKind.SPAWN -> stringResource(R.string.outbox_to_new, peers.firstOrNull { it.id == item.peerId }?.name ?: item.peerId ?: "?")
        else -> stringResource(
            R.string.outbox_reply_to,
            summaries.firstOrNull { it.id == item.conversationId }?.title ?: item.conversationId ?: "?",
        )
    }
    Column(Modifier.fillMaxWidth().testTag("outbox_item_${item.id}").padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, tint = UiColors.onBg, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(target, color = UiColors.onBg, fontSize = 13.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(age(now - item.createdAt), color = UiColors.muted, fontSize = 12.sp)
        }
        Text(item.text.take(80) + if (item.text.length > 80) "…" else "", color = UiColors.muted, fontSize = 13.sp,
            maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 26.dp, top = 2.dp))
        if (item.lastError != null) {
            Text(stringResource(R.string.outbox_attempts, item.attempts, item.lastError ?: ""), color = UiColors.warn, fontSize = 12.sp,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 26.dp, top = 2.dp))
        }
        Row(Modifier.padding(start = 26.dp, top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onCancel, modifier = Modifier.heightIn(min = 48.dp), border = BorderStroke(1.5.dp, UiColors.outline)) {
                Text(stringResource(R.string.outbox_cancel), color = UiColors.onBg)
            }
            if (item.needsDecision) {
                OutlinedButton(onClick = onFresh, modifier = Modifier.heightIn(min = 48.dp), border = BorderStroke(1.5.dp, UiColors.primary)) {
                    Text(stringResource(R.string.outbox_fresh), color = UiColors.primary)
                }
            }
        }
    }
}

@Composable
internal fun age(deltaMs: Long): String {
    val min = (deltaMs / 60_000).coerceAtLeast(0)
    return when {
        min < 1 -> stringResource(R.string.age_now)
        min < 60 -> stringResource(R.string.age_min, min.toInt())
        min < 60 * 24 -> stringResource(R.string.age_hour, (min / 60).toInt())
        else -> stringResource(R.string.age_day, (min / (60 * 24)).toInt())
    }
}

@Preview
@Composable
private fun OutboxCardPreview() = UiMainTheme {
    OutboxCard(PreviewData.outbox, PreviewData.peers, PreviewData.summaries, {}, { _, _ -> }, now = PreviewData.NOW)
}
