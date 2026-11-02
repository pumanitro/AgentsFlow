package com.peersflow.mobile

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.peersflow.mobile.wire.Palette

private val PeersFlowDark = darkColorScheme(
    background = Color(Palette.BG),
    surface = Color(Palette.SURFACE),
    surfaceVariant = Color(Palette.SURFACE_VARIANT),
    outline = Color(Palette.OUTLINE),
    onBackground = Color(Palette.ON_BG),
    onSurface = Color(Palette.ON_BG),
    primary = Color(Palette.PRIMARY),
    secondary = Color(Palette.SECONDARY),
    tertiary = Color(Palette.INFO),
    error = Color(Palette.ERR),
)

/** App theme, built from `com.peersflow.mobile.wire.Palette` so every UI module shares the same colours. */
@Composable
fun PeersFlowTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = PeersFlowDark, content = content)
}
