package com.peersflow.mobile.ui.main

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import kotlinx.coroutines.launch
import java.util.Locale
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.ui.draw.alpha
import androidx.compose.foundation.layout.size

@Composable
fun ChatScreen(vm: ChatViewModel, onBack: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    ChatContent(
        state = state,
        onBack = onBack,
        actions = ChatActions(
            composer = ComposerActions(
                onText = vm::setComposer,
                onSend = vm::send,
                onMicDown = vm::startListening,
                onMicUp = vm::stopListening,
                onMicCancel = vm::cancelListening,
                onCancelConfirm = vm::cancelConfirm,
                onEditConfirm = vm::editConfirm,
                onStop = vm::stop,
                onDone = vm::done,
                onReopen = vm::reopen,
            ),
            onAnswer = { vm.answer(it, null) },
            onQuickReply = vm::quickReply,
            onLoadOlder = vm::loadOlder,
            onToggleThinking = vm::toggleThinking,
            onToggleTool = vm::toggleTool,
            onToastAction = vm::onToastAction,
            onToastDismissed = vm::dismissToast,
            onRetryPending = vm::retryPending,
            onDeletePending = vm::deletePending,
        ),
    )
}

internal class ChatActions(
    val composer: ComposerActions,
    val onAnswer: (com.peersflow.mobile.wire.QuestionOption?) -> Unit,
    val onQuickReply: (String) -> Unit,
    val onLoadOlder: () -> Unit,
    val onToggleThinking: () -> Unit,
    val onToggleTool: (String) -> Unit,
    val onToastAction: () -> Unit,
    val onToastDismissed: () -> Unit,
    val onRetryPending: (String) -> Unit = {},
    val onDeletePending: (String) -> Unit = {},
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatContent(state: ChatUiState, onBack: () -> Unit, actions: ChatActions) {
    val snackbar = remember { SnackbarHostState() }
    val focus = remember { FocusRequester() }
    LaunchedEffect(state.toast?.id) {
        val t = state.toast ?: return@LaunchedEffect
        val r = snackbar.showSnackbar(
            t.message,
            actionLabel = t.actionLabel,
            duration = if (t.actionLabel != null) SnackbarDuration.Long else SnackbarDuration.Short,
        )
        if (r == SnackbarResult.ActionPerformed) actions.onToastAction() else actions.onToastDismissed()
    }

    Scaffold(
        containerColor = UiColors.bg,
        topBar = { ChatTopBar(state, onBack, actions) },
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Column {
                HorizontalDivider(color = UiColors.outline, thickness = 1.dp)
                if (state.showNeedsCard) {
                    NeedsYouCard(state.needsText, state.chips, enabled = !state.sending, onChip = { chip ->
                        when (chip.kind) {
                            NeedsChipKind.OPTION -> actions.onAnswer(chip.option)
                            NeedsChipKind.QUICK -> actions.onQuickReply(chip.label)
                            NeedsChipKind.OTHER -> runCatching { focus.requestFocus() }
                        }
                    })
                }
                Composer(state, actions.composer, focus)
            }
        },
    ) { padding ->
        MessageList(state, actions, Modifier.padding(padding))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatTopBar(state: ChatUiState, onBack: () -> Unit, actions: ChatActions) {
    var menu by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<String?>(null) }   // "done" | "reopen" | "stop" — every one asks first
    confirm?.let { what ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { confirm = null },
            containerColor = UiColors.surface,
            title = { Text(when (what) { "done" -> "Mark this chat done?"; "reopen" -> "Reopen this chat?"; else -> "Stop this chat?" }, color = UiColors.onBg) },
            text = { Text(when (what) { "done" -> "It moves to History on the Mac and the phone."; "reopen" -> "It goes back to the pinned list."; else -> "The agent stops working on it now." }, color = UiColors.muted) },
            confirmButton = {
                androidx.compose.material3.TextButton(onClick = {
                    when (what) { "done" -> actions.composer.onDone(); "reopen" -> actions.composer.onReopen(); else -> actions.composer.onStop() }
                    confirm = null
                }) { Text(when (what) { "done" -> "Mark done"; "reopen" -> "Reopen"; else -> "Stop" }, color = if (what == "stop") UiColors.err else UiColors.primary, fontWeight = FontWeight.Bold) }
            },
            dismissButton = { androidx.compose.material3.TextButton(onClick = { confirm = null }) { Text("Cancel", color = UiColors.onBg) } },
        )
    }
    val s = state.detail?.summary
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(containerColor = UiColors.bg, titleContentColor = UiColors.onBg),
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.chat_back), tint = UiColors.onBg)
            }
        },
        title = {
            Column {
                Text(
                    (s?.peerName ?: "").uppercase(Locale.getDefault()),
                    fontSize = 11.sp, color = UiColors.subtle, fontWeight = FontWeight.Bold, maxLines = 1,
                )
                Text(s?.title ?: "", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val dot = dotStyle(state.state, state.pinned)
                    StatusDot(dot.color, dot.pulse, size = 8.dp)
                    Spacer(Modifier.width(6.dp))
                    Text(
                        state.detail?.job?.detail?.takeIf { it.isNotBlank() } ?: s?.detail ?: state.state,
                        fontSize = 12.sp, color = UiColors.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        },
        actions = {
            if (state.isLive) {
                IconButton(onClick = { confirm = "stop" }, modifier = Modifier.testTag("chat_stop")) {
                    Icon(Icons.Filled.Stop, stringResource(R.string.chat_stop), tint = UiColors.err)
                }
            }
            if (state.pinned) {
                IconButton(onClick = { confirm = "done" }, modifier = Modifier.testTag("chat_done")) {
                    Icon(Icons.Filled.Check, stringResource(R.string.chat_mark_done), tint = UiColors.ok)
                }
            } else {
                IconButton(onClick = { confirm = "reopen" }, modifier = Modifier.testTag("chat_done")) {
                    Icon(Icons.Outlined.Replay, stringResource(R.string.chat_reopen), tint = UiColors.onBg)
                }
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, stringResource(R.string.chat_more), tint = UiColors.onBg) }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = UiColors.surface) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_show_thinking), color = UiColors.onBg) },
                        trailingIcon = {
                            Checkbox(state.showThinking, onCheckedChange = null,
                                colors = CheckboxDefaults.colors(checkedColor = UiColors.primary, uncheckedColor = UiColors.outline))
                        },
                        onClick = { actions.onToggleThinking(); menu = false },
                    )
                    if (state.pinned) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_mark_done), color = UiColors.onBg) },
                            onClick = { confirm = "done"; menu = false },
                        )
                    } else {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_reopen), color = UiColors.onBg) },
                            onClick = { confirm = "reopen"; menu = false },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.chat_stop), color = UiColors.err) },
                        onClick = { confirm = "stop"; menu = false },
                    )
                }
            }
        },
    )
}

@Composable
private fun MessageList(state: ChatUiState, actions: ChatActions, modifier: Modifier) {
    val visible = state.visibleMessages
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val hasHeader = state.hasOlder
    val total = visible.size + if (hasHeader) 1 else 0
    // follow = the user is parked at the bottom; only a finished user scroll changes it
    var follow by remember { mutableStateOf(true) }
    var unseen by remember { mutableStateOf(false) }
    var lastId by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(list.isScrollInProgress) {
        if (!list.isScrollInProgress) {
            val info = list.layoutInfo
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            follow = info.totalItemsCount == 0 || lastVisible >= info.totalItemsCount - 1
            if (follow) unseen = false
        }
    }
    LaunchedEffect(visible.lastOrNull()?.id) {
        val newest = visible.lastOrNull()?.id ?: return@LaunchedEffect
        if (newest == lastId) return@LaunchedEffect
        val first = lastId == null
        lastId = newest
        if (first || follow) list.scrollToItem(total) else unseen = true
    }
    LaunchedEffect(state.pending.size) { if (state.pending.isNotEmpty()) list.animateScrollToItem(total + state.pending.size) }

    Box(modifier.fillMaxSize()) {
        LazyColumn(state = list, modifier = Modifier.fillMaxSize().testTag("chat_messages")) {
            if (hasHeader) {
                item(key = "older") {
                    Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                        if (state.loadingOlder) {
                            CircularProgressIndicator(color = UiColors.primary, modifier = Modifier.padding(8.dp))
                        } else {
                            OutlinedButton(onClick = actions.onLoadOlder, modifier = Modifier.heightIn(min = 48.dp)) {
                                Text(stringResource(R.string.chat_load_earlier), color = UiColors.onBg)
                            }
                        }
                    }
                }
            }
            if (visible.isEmpty()) {
                item(key = "empty") {
                    Text(stringResource(R.string.chat_empty), color = UiColors.muted, textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(32.dp))
                }
            }
            items(visible, key = { it.id }) { e ->
                MessageRow(e, toolExpanded = e.id in state.expandedTools, onToggleTool = { actions.onToggleTool(e.id) })
            }
            items(state.pending, key = { "pending_" + it.id }) { p ->
                PendingBubble(p, onRetry = { actions.onRetryPending(p.id) }, onDelete = { actions.onDeletePending(p.id) })
            }
            item(key = "end") { Spacer(Modifier.height(8.dp)) }
        }
        if (unseen) {
            Button(
                onClick = {
                    unseen = false
                    follow = true
                    scope.launch { list.animateScrollToItem((total).coerceAtLeast(0)) }
                },
                colors = ButtonDefaults.buttonColors(containerColor = UiColors.info, contentColor = UiColors.bg),
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp).heightIn(min = 48.dp),
            ) { Text(stringResource(R.string.chat_new_messages), fontWeight = FontWeight.SemiBold) }
        }
    }
}

@Preview(widthDp = 360, heightDp = 760)
@Composable
private fun ChatPreview() = UiMainTheme {
    Box(Modifier.background(UiColors.bg)) {
        ChatContent(PreviewData.chatState, {}, PreviewData.noChatActions)
    }
}

@Preview(widthDp = 360, heightDp = 300)
@Composable
private fun ChatOfflinePreview() = UiMainTheme {
    Column(Modifier.background(UiColors.bg), verticalArrangement = Arrangement.Bottom) {
        Composer(
            PreviewData.chatState.copy(connection = com.peersflow.mobile.wire.ConnectionState.MAC_OFF,
                recording = RecordingState.Listening("check the bu")),
            PreviewData.noActions,
            FocusRequester(),
        )
    }
}


/** A message just sent from the phone: right-aligned like the user's bubbles, with its delivery status underneath. */
@Composable
private fun PendingBubble(p: PendingMsg, onRetry: () -> Unit, onDelete: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), horizontalAlignment = Alignment.End) {
        Text(
            p.text, color = UiColors.onBg, fontSize = 15.sp,
            modifier = Modifier.background(UiColors.surfaceVariant, androidx.compose.foundation.shape.RoundedCornerShape(14.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp).alpha(if (p.status == PendingMsg.Status.SENDING) 0.7f else 1f),
        )
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            when (p.status) {
                PendingMsg.Status.SENDING -> {
                    CircularProgressIndicator(color = UiColors.muted, strokeWidth = 2.dp, modifier = Modifier.size(12.dp))
                    Spacer(Modifier.width(6.dp)); Text("Sending…", color = UiColors.muted, fontSize = 12.sp)
                }
                PendingMsg.Status.SENT -> Text("✓ Sent — waiting for the reply", color = UiColors.ok, fontSize = 12.sp)
                PendingMsg.Status.QUEUED -> {
                    Text("⏳ Mac offline — sends when it is back", color = UiColors.warn, fontSize = 12.sp)
                }
                PendingMsg.Status.FAILED -> {
                    Text("✕ Not sent" + (p.error?.let { ": $it" } ?: ""), color = UiColors.err, fontSize = 12.sp, maxLines = 2, modifier = Modifier.weight(1f, fill = false))
                    androidx.compose.material3.TextButton(onClick = onRetry) { Text("Retry", color = UiColors.primary) }
                    androidx.compose.material3.TextButton(onClick = onDelete) { Text("Delete", color = UiColors.err) }
                }
            }
        }
    }
}
