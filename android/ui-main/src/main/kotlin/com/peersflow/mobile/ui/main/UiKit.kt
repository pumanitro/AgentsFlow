package com.peersflow.mobile.ui.main

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.peersflow.mobile.wire.ConvStates
import com.peersflow.mobile.wire.Palette
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Compose colours built from the shared [Palette]; the only colour source in this module. */
internal object UiColors {
    val ok = Color(Palette.OK)
    val warn = Color(Palette.WARN)
    val err = Color(Palette.ERR)
    val info = Color(Palette.INFO)
    val muted = Color(Palette.MUTED)
    val subtle = Color(Palette.SUBTLE)
    val bg = Color(Palette.BG)
    val surface = Color(Palette.SURFACE)
    val surfaceVariant = Color(Palette.SURFACE_VARIANT)
    val outline = Color(Palette.OUTLINE)
    val onBg = Color(Palette.ON_BG)
    val primary = Color(Palette.PRIMARY)
    val secondary = Color(Palette.SECONDARY)
}

/** Previews and Compose tests only; the app wraps screens in its own `PeersFlowTheme`. */
@Composable
internal fun UiMainTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = UiColors.primary,
            onPrimary = UiColors.bg,
            secondary = UiColors.secondary,
            onSecondary = UiColors.bg,
            tertiary = UiColors.info,
            background = UiColors.bg,
            onBackground = UiColors.onBg,
            surface = UiColors.surface,
            onSurface = UiColors.onBg,
            surfaceVariant = UiColors.surfaceVariant,
            onSurfaceVariant = UiColors.muted,
            outline = UiColors.outline,
            error = UiColors.err,
        ),
        content = content,
    )
}

/** Dot colour + pulse, mirroring `renderer/lib/status.ts`: unpinned (marked done) wins and never pulses. */
internal data class DotStyle(val color: Color, val pulse: Boolean)

internal fun dotStyle(state: String, pinned: Boolean): DotStyle {
    if (!pinned) return DotStyle(UiColors.subtle, false)
    return when (state.lowercase()) {
        ConvStates.WORKING -> DotStyle(UiColors.info, true)
        ConvStates.BLOCKED, "needs-input" -> DotStyle(UiColors.warn, true)
        ConvStates.DONE, "completed" -> DotStyle(UiColors.ok, false)
        ConvStates.FAILED, "error" -> DotStyle(UiColors.err, false)
        ConvStates.STARTING -> DotStyle(UiColors.muted, true)
        else -> DotStyle(UiColors.muted, false)
    }
}

@Composable
internal fun StatusDot(color: Color, pulse: Boolean, modifier: Modifier = Modifier, size: Dp = 10.dp) {
    val alpha = if (pulse) {
        val t = rememberInfiniteTransition(label = "dot")
        val a by t.animateFloat(
            initialValue = 1f,
            targetValue = 0.35f,
            animationSpec = infiniteRepeatable(tween(800), RepeatMode.Reverse),
            label = "dotAlpha",
        )
        a
    } else {
        1f
    }
    Box(modifier.size(size).alpha(alpha).background(color, CircleShape))
}

/** Small outlined label, e.g. "voice", "routine", "needs you". */
@Composable
internal fun Pill(text: String, color: Color, modifier: Modifier = Modifier, filled: Boolean = false, icon: ImageVector? = null) {
    Row(
        modifier
            .background(if (filled) color else Color.Transparent, RoundedCornerShape(50))
            .border(1.5.dp, color, RoundedCornerShape(50))
            .padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, null, tint = if (filled) UiColors.bg else color, modifier = Modifier.size(12.dp))
            Spacer(Modifier.width(3.dp))
        }
        Text(text, color = if (filled) UiColors.bg else color, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
    }
}

internal fun hhmm(ms: Long): String =
    DateTimeFormatter.ofPattern("HH:mm").format(Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()))
