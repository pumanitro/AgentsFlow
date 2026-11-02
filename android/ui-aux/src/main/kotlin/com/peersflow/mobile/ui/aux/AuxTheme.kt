package com.peersflow.mobile.ui.aux

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.peersflow.mobile.wire.Palette

/** The module's own dark scheme, built only from [Palette]; used by previews. */
@Composable
internal fun AuxTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = Color(Palette.PRIMARY),
            secondary = Color(Palette.SECONDARY),
            tertiary = Color(Palette.INFO),
            background = Color(Palette.BG),
            surface = Color(Palette.SURFACE),
            surfaceVariant = Color(Palette.SURFACE_VARIANT),
            outline = Color(Palette.OUTLINE),
            onBackground = Color(Palette.ON_BG),
            onSurface = Color(Palette.ON_BG),
            onSurfaceVariant = Color(Palette.MUTED),
            error = Color(Palette.ERR),
        ),
        content = content,
    )
}
