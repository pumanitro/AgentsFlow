@file:OptIn(ExperimentalMaterial3Api::class)

package com.peersflow.mobile.ui.aux

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.Palette
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val TIME_FMT: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

private fun timeOf(at: String): String = try {
    TIME_FMT.format(Instant.parse(at).atZone(ZoneId.systemDefault()))
} catch (_: Exception) { "" }

@Composable
fun OutcomesScreen(vm: OutcomesViewModel, onOpenChat: (String) -> Unit, onBack: () -> Unit) {
    val state by vm.state.collectAsState()
    LaunchedEffect(Unit) { vm.markAllSeen() }

    Scaffold(
        containerColor = Color(Palette.BG),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.outcomes_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back))
                    }
                },
                actions = {
                    IconButton(onClick = vm::refresh, modifier = Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.Outlined.Refresh, stringResource(R.string.refresh))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color(Palette.BG),
                    titleContentColor = Color(Palette.ON_BG),
                    navigationIconContentColor = Color(Palette.ON_BG),
                    actionIconContentColor = Color(Palette.ON_BG),
                ),
            )
        },
    ) { pad ->
        LazyColumn(
            Modifier.fillMaxSize().padding(pad).padding(horizontal = 16.dp).testTag("outcomes_list"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            state.awayHeader?.let { header ->
                item(key = "away") {
                    RailCard(Palette.INFO) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Text(header, color = Color(Palette.ON_BG), fontSize = 15.sp, modifier = Modifier.weight(1f))
                            Button(onClick = vm::readAll, modifier = Modifier.heightIn(min = 48.dp).testTag("outcomes_read_all")) {
                                Text(stringResource(R.string.read_all))
                            }
                        }
                    }
                }
            }
            if (state.groups.isEmpty()) {
                item(key = "empty") {
                    Text(
                        stringResource(R.string.outcomes_empty),
                        color = Color(Palette.MUTED), fontSize = 15.sp,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
                    )
                }
            }
            state.groups.forEach { group ->
                item(key = "h-${group.label}") {
                    Text(
                        group.label, color = Color(Palette.SUBTLE), fontSize = 12.sp,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                items(group.items, key = { it.seq }) { item ->
                    if (item.kind == "needs-you") NeedsYouRow(item, onOpenChat)
                    else OutcomeRow(item, speaking = state.speakingSeq == item.seq, vm = vm, onOpenChat = onOpenChat)
                }
            }
            item(key = "end") { Box(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun RailCard(rail: Long, content: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .background(Color(Palette.SURFACE), RoundedCornerShape(12.dp)),
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(Color(rail), RoundedCornerShape(topStart = 12.dp, bottomStart = 12.dp)))
        Column(Modifier.weight(1f).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { content() }
    }
}

@Composable
private fun OutcomeRow(item: FeedItem, speaking: Boolean, vm: OutcomesViewModel, onOpenChat: (String) -> Unit) {
    RailCard(Palette.OK) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(Icons.Outlined.RecordVoiceOver, null, tint = Color(Palette.MUTED), modifier = Modifier.size(16.dp))
            Text("${item.peerName} · ${item.title}", color = Color(Palette.MUTED), fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 2)
            Text(timeOf(item.at), color = Color(Palette.SUBTLE), fontSize = 12.sp)
        }
        item.spoken?.let { Text(it, color = Color(Palette.ON_BG), fontSize = 15.sp) }
        val needsPrefix = stringResource(R.string.needs_prefix) + " "
        item.needs?.let {
            Text(
                buildAnnotatedString {
                    withStyle(SpanStyle(color = Color(Palette.WARN))) { append(needsPrefix) }
                    append(it)
                },
                color = Color(Palette.ON_BG), fontSize = 14.sp,
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(
                onClick = { if (speaking) vm.stopSpeaking() else vm.replay(item) },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    if (speaking) Icons.Outlined.Stop else Icons.Outlined.PlayArrow,
                    stringResource(if (speaking) R.string.stop else R.string.play),
                    tint = Color(Palette.ON_BG),
                )
            }
            TextButton(onClick = { onOpenChat(item.conversationId) }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.open_chat))
            }
        }
    }
}

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun NeedsYouRow(item: FeedItem, onOpenChat: (String) -> Unit) {
    val q = item.questions.firstOrNull()
    RailCard(Palette.WARN) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${item.peerName} · ${item.title}", color = Color(Palette.MUTED), fontSize = 12.sp, modifier = Modifier.weight(1f), maxLines = 2)
            Text(timeOf(item.at), color = Color(Palette.SUBTLE), fontSize = 12.sp)
        }
        Text(q?.question ?: item.title, color = Color(Palette.ON_BG), fontSize = 15.sp)
        if (q != null && q.options.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                q.options.forEach { o ->
                    Text(
                        o.label, color = Color(Palette.ON_BG), fontSize = 13.sp,
                        modifier = Modifier
                            .background(Color(Palette.SURFACE_VARIANT), RoundedCornerShape(16.dp))
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }
        }
        TextButton(onClick = { onOpenChat(item.conversationId) }, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.answer_in_chat))
        }
    }
}
