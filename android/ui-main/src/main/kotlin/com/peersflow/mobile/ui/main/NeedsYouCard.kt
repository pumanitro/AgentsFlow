package com.peersflow.mobile.ui.main

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Pinned above the composer while the chat waits for the user: the question and one chip per answer. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NeedsYouCard(text: String?, chips: List<NeedsChip>, enabled: Boolean, onChip: (NeedsChip) -> Unit, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().height(IntrinsicSize.Min).background(UiColors.surface)) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(UiColors.warn))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 8.dp)) {
            Text(stringResource(R.string.needs_title).uppercase(), color = UiColors.warn, fontSize = 11.sp, fontWeight = FontWeight.Bold)
            if (text != null) {
                Text(text, color = UiColors.onBg, fontSize = 15.sp, maxLines = 4, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                chips.forEachIndexed { i, chip ->
                    val (label, border) = when (chip.kind) {
                        NeedsChipKind.OPTION -> chip.label to UiColors.warn
                        NeedsChipKind.QUICK -> stringResource(R.string.needs_quick, chip.label) to UiColors.primary
                        NeedsChipKind.OTHER -> chip.label to UiColors.outline
                    }
                    AssistChip(
                        onClick = { onChip(chip) },
                        enabled = enabled,
                        label = { Text(label, maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium) },
                        modifier = Modifier.heightIn(min = 48.dp).testTag("needs_chip_$i"),
                        colors = AssistChipDefaults.assistChipColors(containerColor = Color.Transparent, labelColor = UiColors.onBg),
                        border = AssistChipDefaults.assistChipBorder(enabled = enabled, borderColor = border, borderWidth = 1.5.dp),
                    )
                }
            }
        }
    }
}

@Preview(widthDp = 360)
@Composable
private fun NeedsYouCardPreview() = UiMainTheme {
    val s = PreviewData.chatState
    NeedsYouCard(s.needsText, s.chips, true, {})
}
