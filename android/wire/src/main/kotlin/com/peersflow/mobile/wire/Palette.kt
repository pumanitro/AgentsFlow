package com.peersflow.mobile.wire

/** App colours as ARGB longs, shared by every UI module without a Compose dependency here. Build `Color(Palette.OK)`. */
object Palette {
    // status
    const val OK: Long = 0xFF4ADE80
    const val WARN: Long = 0xFFFBBF24
    const val ERR: Long = 0xFFEF4444
    const val INFO: Long = 0xFF3B82F6
    const val MUTED: Long = 0xFFB2B8CC
    const val SUBTLE: Long = 0xFF8C93A8

    // theme
    const val BG: Long = 0xFF0F1115
    const val SURFACE: Long = 0xFF181B25
    const val SURFACE_VARIANT: Long = 0xFF222636
    const val OUTLINE: Long = 0xFF3A4159
    const val ON_BG: Long = 0xFFF1F3F8
    const val PRIMARY: Long = 0xFFFF7847
    const val SECONDARY: Long = 0xFFFFA274
}
