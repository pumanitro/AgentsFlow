package com.peersflow.mobile.voice

/** Strips anything that looks like an OpenAI key from text that may end up in an exception or a log. */
internal object Redact {
    private val KEY = Regex("sk-[A-Za-z0-9_\\-]+")

    fun text(s: String?): String = s?.let { KEY.replace(it, "[redacted]") } ?: ""
}
