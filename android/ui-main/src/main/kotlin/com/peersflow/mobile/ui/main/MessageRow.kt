package com.peersflow.mobile.ui.main

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.TypedValue
import android.widget.TextView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.MessageKinds
import com.peersflow.mobile.wire.Palette
import com.peersflow.mobile.wire.Sources
import io.noties.markwon.Markwon
import io.noties.markwon.ext.tables.TablePlugin

/**
 * One transcript entry. Visibility (thinking switch, folded tool results) is decided by
 * [ChatUiState.visibleMessages]; this only draws.
 */
@Composable
fun MessageRow(entry: MessageEntry, toolExpanded: Boolean = false, onToggleTool: () -> Unit = {}) {
    val tag = Modifier.testTag("chat_msg_${entry.id}")
    when (entry.kind) {
        MessageKinds.USER -> UserBubble(entry, tag)
        MessageKinds.ASSISTANT -> AssistantBubble(entry, tag)
        MessageKinds.TOOL_USE -> ToolUseLine(entry, toolExpanded, onToggleTool, tag)
        MessageKinds.TOOL_RESULT -> ToolResultBlock(entry, tag)
        MessageKinds.THINKING -> Text(
            entry.text,
            color = UiColors.subtle,
            fontStyle = FontStyle.Italic,
            fontSize = 13.sp,
            modifier = tag.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        )
        MessageKinds.SUBAGENT -> SubagentCard(entry, tag)
        else -> Text(entry.text, color = UiColors.muted, fontSize = 13.sp, modifier = tag.padding(horizontal = 16.dp, vertical = 4.dp))
    }
}

@Composable
private fun UserBubble(entry: MessageEntry, tag: Modifier) {
    val maxW = (LocalConfiguration.current.screenWidthDp * 0.85f).dp
    Row(tag.fillMaxWidth().padding(start = 48.dp, end = 16.dp, top = 4.dp, bottom = 4.dp), horizontalArrangement = Arrangement.End) {
        Row(
            Modifier
                .widthIn(max = maxW)
                .background(UiColors.surfaceVariant, RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp))
                .border(1.dp, UiColors.outline, RoundedCornerShape(16.dp, 16.dp, 4.dp, 16.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            val icon = when (entry.source) {
                Sources.VOICE -> Icons.Outlined.Mic
                Sources.PHONE -> Icons.Outlined.PhoneAndroid
                else -> null
            }
            if (icon != null) {
                Icon(icon, entry.source, tint = UiColors.secondary, modifier = Modifier.size(16.dp).padding(top = 2.dp))
                Spacer(Modifier.width(6.dp))
            }
            Text(entry.text, color = UiColors.onBg, fontSize = 15.sp)
        }
    }
}

@Composable
private fun AssistantBubble(entry: MessageEntry, tag: Modifier) {
    Box(
        tag
            .fillMaxWidth()
            .padding(start = 16.dp, end = 32.dp, top = 4.dp, bottom = 4.dp)
            .background(UiColors.surface, RoundedCornerShape(16.dp, 16.dp, 16.dp, 4.dp))
            .border(1.dp, UiColors.outline, RoundedCornerShape(16.dp, 16.dp, 16.dp, 4.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        if (LocalInspectionMode.current) {
            Text(entry.text, color = UiColors.onBg, fontSize = 15.sp)
        } else {
            MarkdownText(entry.text)
        }
    }
}

/** Markdown through Markwon in a TextView; long-press copies the raw text. */
@Composable
private fun MarkdownText(markdown: String) {
    val ctx = LocalContext.current
    val markwon = remember(ctx) { Markwon.builder(ctx).usePlugin(TablePlugin.create(ctx)).build() }
    val copied = stringResource(R.string.chat_copied)
    AndroidView(
        factory = { c ->
            TextView(c).apply {
                setTextColor(Palette.ON_BG.toInt())
                setLinkTextColor(Palette.SECONDARY.toInt())
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            }
        },
        update = { tv ->
            markwon.setMarkdown(tv, markdown)
            tv.setOnLongClickListener {
                val cm = tv.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("message", markdown))
                android.widget.Toast.makeText(tv.context, copied, android.widget.Toast.LENGTH_SHORT).show()
                true
            }
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun ToolUseLine(entry: MessageEntry, expanded: Boolean, onToggle: () -> Unit, tag: Modifier) {
    Row(
        tag
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 2.dp)
            .border(BorderStroke(1.dp, UiColors.outline), RoundedCornerShape(8.dp))
            .clickable(onClick = onToggle)
            .heightIn(min = 48.dp)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Terminal, null, tint = UiColors.muted, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            listOfNotNull(entry.toolName, entry.text.takeIf { it.isNotBlank() }).joinToString(" · "),
            color = UiColors.muted,
            fontSize = 12.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, tint = UiColors.muted, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun ToolResultBlock(entry: MessageEntry, tag: Modifier) {
    Column(
        tag
            .fillMaxWidth()
            .padding(start = 32.dp, end = 16.dp, top = 2.dp, bottom = 4.dp)
            .background(UiColors.surfaceVariant, RoundedCornerShape(6.dp))
            .padding(8.dp),
    ) {
        Text(entry.text, color = UiColors.onBg, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        if (entry.truncated) {
            Text(stringResource(R.string.chat_more_on_desktop), color = UiColors.muted, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
    }
}

@Composable
private fun SubagentCard(entry: MessageEntry, tag: Modifier) {
    Row(
        tag
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 2.dp)
            .background(UiColors.surface, RoundedCornerShape(8.dp))
            .border(1.dp, UiColors.info, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.Hub, null, tint = UiColors.info, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(8.dp))
        Text(stringResource(R.string.chat_subagent, entry.text), color = UiColors.onBg, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
