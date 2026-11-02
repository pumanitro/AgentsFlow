package com.peersflow.mobile.ui.main

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.peersflow.mobile.wire.ConversationSummary
import java.util.Locale

@Composable
fun HomeScreen(vm: HomeViewModel, onOpenChat: (String) -> Unit, onHiLisa: () -> Unit, onOutcomes: () -> Unit, onSettings: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    HomeContent(
        state = state,
        onOpenChat = onOpenChat,
        onHiLisa = onHiLisa,
        onOutcomes = onOutcomes,
        onSettings = onSettings,
        onTapStatus = vm::onTapStatus,
        onRefresh = vm::refresh,
        onFilter = vm::setFilter,
        onCancelOutbox = vm::cancelOutbox,
        onRetargetOutbox = vm::retargetOutbox,
        onBannerShown = vm::dismissBanner,
        onErrorShown = vm::dismissError,
    )
}

/** Stateless Home; [HomeScreen] binds it to the view model, previews feed it directly. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun HomeContent(
    state: HomeUiState,
    onOpenChat: (String) -> Unit,
    onHiLisa: () -> Unit,
    onOutcomes: () -> Unit,
    onSettings: () -> Unit,
    onTapStatus: () -> Unit,
    onRefresh: () -> Unit,
    onFilter: (HomeFilter) -> Unit,
    onCancelOutbox: (String) -> Unit,
    onRetargetOutbox: (String, String) -> Unit,
    onBannerShown: () -> Unit = {},
    onErrorShown: () -> Unit = {},
) {
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(state.banner) {
        state.banner?.let {
            snackbar.showSnackbar(it)
            onBannerShown()
        }
    }
    LaunchedEffect(state.error) {
        state.error?.let {
            snackbar.showSnackbar(it)
            onErrorShown()
        }
    }

    Scaffold(
        containerColor = UiColors.bg,
        topBar = {
            Column {
                TopAppBar(
                    // Connection = one dot before the title (green online, amber app down / paused, red Mac off / revoked).
                    title = {
                        Row(
                            Modifier.testTag("status_strip").clickable(onClick = onTapStatus),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            val dotColor = when (state.connection) {
                                com.peersflow.mobile.wire.ConnectionState.ONLINE -> UiColors.ok
                                com.peersflow.mobile.wire.ConnectionState.APP_DOWN, com.peersflow.mobile.wire.ConnectionState.PAUSED -> UiColors.warn
                                com.peersflow.mobile.wire.ConnectionState.UNPAIRED -> UiColors.muted
                                else -> UiColors.err
                            }
                            Box(Modifier.size(10.dp).background(dotColor, androidx.compose.foundation.shape.CircleShape))
                            Spacer(Modifier.width(10.dp))
                            Text(stringResource(R.string.home_title), fontWeight = FontWeight.SemiBold)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = UiColors.bg, titleContentColor = UiColors.onBg),
                    actions = {
                        IconButton(onClick = onSettings, modifier = Modifier.testTag("home_settings")) {
                            Icon(Icons.Outlined.Settings, stringResource(R.string.home_settings), tint = UiColors.onBg)
                        }
                    },
                )
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onHiLisa,
                icon = { Icon(Icons.Filled.Mic, null) },
                text = { Text(stringResource(R.string.home_hi_lisa), fontWeight = FontWeight.SemiBold) },
                containerColor = UiColors.primary,
                contentColor = UiColors.bg,
                modifier = Modifier.testTag("home_fab"),
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            if (state.greyed) {
                Text(
                    stringResource(R.string.home_last_known),
                    color = UiColors.muted,
                    fontSize = 12.sp,
                    maxLines = 1,
                    modifier = Modifier.fillMaxWidth().background(UiColors.surfaceVariant).padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            PullToRefreshBox(isRefreshing = state.refreshing, onRefresh = onRefresh, modifier = Modifier.weight(1f).fillMaxWidth()) {
                HomeList(state, onOpenChat, onCancelOutbox, onRetargetOutbox)
            }
        }
    }
}

@Composable
private fun FilterRow(selected: HomeFilter, counts: Map<HomeFilter, Int>, onFilter: (HomeFilter) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        HomeFilter.entries.forEach { f ->
            val (label, tag) = when (f) {
                HomeFilter.ALL -> R.string.filter_all to "home_filter_all"
                HomeFilter.NEEDS -> R.string.filter_needs to "home_filter_needs"
                HomeFilter.WORKING -> R.string.filter_working to "home_filter_working"
                HomeFilter.DONE -> R.string.filter_done to "home_filter_done"
            }
            val isSel = f == selected
            FilterChip(
                selected = isSel,
                onClick = { onFilter(f) },
                label = { Text(stringResource(label, counts[f] ?: 0), fontWeight = if (isSel) FontWeight.Bold else FontWeight.Medium) },
                modifier = Modifier.heightIn(min = 48.dp).testTag(tag),
                colors = FilterChipDefaults.filterChipColors(
                    containerColor = UiColors.bg,
                    labelColor = UiColors.onBg,
                    selectedContainerColor = UiColors.primary,
                    selectedLabelColor = UiColors.bg,
                ),
                border = FilterChipDefaults.filterChipBorder(
                    enabled = true,
                    selected = isSel,
                    borderColor = UiColors.outline,
                    selectedBorderColor = UiColors.primary,
                    borderWidth = 1.5.dp,
                    selectedBorderWidth = 1.5.dp,
                ),
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeList(
    state: HomeUiState,
    onOpenChat: (String) -> Unit,
    onCancelOutbox: (String) -> Unit,
    onRetargetOutbox: (String, String) -> Unit,
) {
    val dim = Modifier.alpha(if (state.greyed) 0.55f else 1f)
    val historyOpen = androidx.compose.runtime.saveable.rememberSaveable { androidx.compose.runtime.mutableStateOf(false) }   // History hidden by default
    LazyColumn(Modifier.fillMaxSize().testTag("home_list")) {
        if (state.outbox.isNotEmpty()) {
            item(key = "outbox") {
                OutboxCard(state.outbox, state.peers, state.allSummaries, onCancelOutbox, onRetargetOutbox)
            }
        }
        if (state.loaded && state.sections.isEmpty()) {
            item(key = "empty") {
                val msg = if (state.peers.isEmpty()) R.string.home_no_peers else R.string.home_nothing_here
                Text(
                    stringResource(msg),
                    color = UiColors.muted,
                    fontSize = 15.sp,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 48.dp),
                )
            }
        }
        val pin = state.pinned
        if (state.filter == HomeFilter.ALL && pin != null) {
            pinnedListItems(pin, dim, onOpenChat, historyOpen)
            item(key = "fab_space") { Spacer(Modifier.height(96.dp)) }
            return@LazyColumn
        }
        state.sections.forEach { section ->
            stickyHeader(key = "h_${section.peer.id}") {
                Text(
                    section.peer.name.uppercase(Locale.getDefault()),
                    color = UiColors.subtle,
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = 1.sp,
                    modifier = Modifier.fillMaxWidth().background(UiColors.bg).padding(horizontal = 16.dp, vertical = 8.dp).then(dim),
                )
            }
            items(section.rows, key = { "r_${it.summary.id}" }) { row ->
                Column(dim) {
                    ConversationRow(row.summary, child = false, onClick = { onOpenChat(row.summary.id) })
                    row.children.forEach { c -> ConversationRow(c, child = true, onClick = { onOpenChat(c.id) }) }
                    HorizontalDivider(color = UiColors.outline, thickness = 1.dp)
                }
            }
        }
        item(key = "fab_space") { Spacer(Modifier.height(96.dp)) }
    }
}

@Composable
internal fun ConversationRow(c: ConversationSummary, child: Boolean, onClick: () -> Unit) {
    val dot = dotStyle(c.state, c.pinned)
    val railColor = UiColors.outline
    Row(
        Modifier
            .fillMaxWidth()
            .testTag("conv_row_${c.id}")
            .clickable(onClick = onClick)
            .heightIn(min = 56.dp)
            .padding(start = if (child) 40.dp else 16.dp, end = 16.dp)
            .then(
                if (child) {
                    Modifier.drawBehind {
                        val x = -12.dp.toPx()
                        drawLine(railColor, Offset(x, 0f), Offset(x, size.height), strokeWidth = 2.dp.toPx())
                    }
                } else {
                    Modifier
                },
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StatusDot(dot.color, dot.pulse)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    c.title.ifBlank { c.id },
                    color = UiColors.onBg,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (c.chatKind != "chat") {
                    Spacer(Modifier.width(6.dp))
                    when (c.chatKind) {
                        "voice" -> Pill(stringResource(R.string.pill_voice), UiColors.secondary, icon = Icons.Outlined.Mic)
                        "routine" -> Pill(stringResource(R.string.pill_routine), UiColors.secondary, icon = Icons.Outlined.Repeat)
                        else -> Pill(c.chatKind, UiColors.secondary)
                    }
                }
            }
            if (c.detail.isNotBlank()) {
                Text(c.detail, color = UiColors.muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (c.needsYou) {
            Spacer(Modifier.width(8.dp))
            Pill(stringResource(R.string.home_needs_you), UiColors.warn, filled = true)
        }
    }
}

@Preview(widthDp = 360, heightDp = 760)
@Composable
private fun HomePreview() = UiMainTheme {
    HomeContent(PreviewData.homeState, {}, {}, {}, {}, {}, {}, {}, {}, { _, _ -> })
}

@Preview(widthDp = 360, heightDp = 760)
@Composable
private fun HomeMacOffPreview() = UiMainTheme {
    HomeContent(
        PreviewData.homeState.copy(connection = com.peersflow.mobile.wire.ConnectionState.MAC_OFF, lastSeenAt = PreviewData.NOW - 3_600_000),
        {}, {}, {}, {}, {}, {}, {}, {}, { _, _ -> },
    )
}

@Preview(widthDp = 360, heightDp = 400)
@Composable
private fun HomeEmptyPreview() = UiMainTheme {
    Box(Modifier.background(UiColors.bg)) {
        HomeContent(HomeUiState(connection = com.peersflow.mobile.wire.ConnectionState.ONLINE, loaded = true), {}, {}, {}, {}, {}, {}, {}, {}, { _, _ -> })
    }
}


// ---- the desktop "PINNED CONVERSATIONS" list, mirrored (order, separators, to-dos, sub-chats) + History ----

private fun androidx.compose.foundation.lazy.LazyListScope.pinnedListItems(
    pin: com.peersflow.mobile.wire.PinnedListResponse, dim: Modifier, onOpenChat: (String) -> Unit,
    historyOpen: androidx.compose.runtime.MutableState<Boolean>,
) {
    pin.items.forEachIndexed { i, it ->
        when (it.kind) {
            "divider" -> item(key = "pd_${it.id ?: i}") { DividerPillRow(it.title.orEmpty(), dim) }
            "todo" -> item(key = "pt_${it.id ?: i}") {
                Column(dim) {
                    TodoLine(it.text.orEmpty(), it.done, nested = false, peer = it.peerName)
                    HorizontalDivider(color = UiColors.outline, thickness = 1.dp)
                }
            }
            else -> it.summary?.let { s ->
                item(key = "pc_${s.id}") {
                    Column(dim) {
                        PinnedConvRow(s, todoCount = it.todos.size, child = false) { onOpenChat(s.id) }
                        it.todos.forEach { t -> TodoLine(t.text, t.done, nested = true, peer = null) }
                        it.children.forEach { c -> PinnedConvRow(c, todoCount = 0, child = true) { onOpenChat(c.id) } }
                        HorizontalDivider(color = UiColors.outline, thickness = 1.dp)
                    }
                }
            }
        }
    }
    if (pin.history.isNotEmpty()) {
        item(key = "ph_header") {
            Box(Modifier.clickable { historyOpen.value = !historyOpen.value }.testTag("home_history_toggle")) {
                DividerPillRow(if (historyOpen.value) "HISTORY ▴" else "HISTORY (${pin.history.size}) ▾", dim)
            }
        }
        if (historyOpen.value) items(pin.history, key = { "phi_${it.id}" }) { s ->
            Column(dim) {
                PinnedConvRow(s, todoCount = 0, child = false) { onOpenChat(s.id) }
                HorizontalDivider(color = UiColors.outline, thickness = 1.dp)
            }
        }
    }
}

/** Full-width line with a centred uppercase pill, like the desktop separators (IMPORTANT, WORK, …). */
@Composable
private fun DividerPillRow(title: String, mod: Modifier) {
    Row(mod.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = UiColors.outline, thickness = 1.dp)
        Text(
            title.uppercase(Locale.getDefault()),
            color = UiColors.onBg, fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.sp,
            modifier = Modifier.padding(horizontal = 8.dp)
                .background(UiColors.surface, androidx.compose.foundation.shape.RoundedCornerShape(50))
                .border(1.dp, UiColors.outline, androidx.compose.foundation.shape.RoundedCornerShape(50))
                .padding(horizontal = 10.dp, vertical = 3.dp),
        )
        HorizontalDivider(Modifier.weight(1f), color = UiColors.outline, thickness = 1.dp)
    }
}

/** A conversation row in the desktop's shape: dot · provider glyph · bold peer, title below, needs-you chip, +N to-dos. */
@Composable
private fun PinnedConvRow(c: ConversationSummary, todoCount: Int, child: Boolean, onClick: () -> Unit) {
    val dot = dotStyle(c.state, c.pinned || child)
    Row(
        Modifier.fillMaxWidth().testTag("conv_row_${c.id}").clickable(onClick = onClick).heightIn(min = 56.dp)
            .padding(start = if (child) 40.dp else 16.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (child) { Text("↳", color = UiColors.subtle, fontSize = 13.sp); Spacer(Modifier.width(6.dp)) }
        StatusDot(dot.color, dot.pulse)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (c.provider == "codex") "✱" else "A", color = UiColors.muted, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(6.dp))
                Text(c.peerName, color = UiColors.onBg, fontSize = 14.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (c.chatKind == "voice") { Spacer(Modifier.width(6.dp)); Pill(stringResource(R.string.pill_voice), UiColors.secondary, icon = Icons.Outlined.Mic) }
                if (c.chatKind == "routine") { Spacer(Modifier.width(6.dp)); Pill(stringResource(R.string.pill_routine), UiColors.secondary, icon = Icons.Outlined.Repeat) }
            }
            Text(c.title.ifBlank { c.id }, color = UiColors.onBg, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (c.needsYou) { Spacer(Modifier.width(8.dp)); Pill(stringResource(R.string.home_needs_you), UiColors.warn, filled = false) }
        if (todoCount > 0) { Spacer(Modifier.width(8.dp)); Text("+ $todoCount", color = UiColors.muted, fontSize = 13.sp) }
    }
}

/** A to-do: nested ones sit under their conversation with ↳ and a checkbox, like desktop. */
@Composable
private fun TodoLine(text: String, done: Boolean, nested: Boolean, peer: String?) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 40.dp).padding(start = if (nested) 40.dp else 16.dp, end = 16.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (nested) { Text("↳", color = UiColors.subtle, fontSize = 13.sp); Spacer(Modifier.width(6.dp)) }
        Box(Modifier.size(16.dp).border(1.5.dp, UiColors.muted, androidx.compose.foundation.shape.RoundedCornerShape(3.dp)))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            if (!peer.isNullOrBlank()) Text(peer, color = UiColors.onBg, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text(
                text, color = if (done) UiColors.subtle else UiColors.onBg, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textDecoration = if (done) androidx.compose.ui.text.style.TextDecoration.LineThrough else null,
            )
        }
    }
}
