package com.peersflow.mobile.voice

/** Shared request shaping for the OpenAI providers. */
internal object SttText {
    /** Keywords go one per line; OpenAI rejects the whole request if one holds `<`, `>`, CR or LF. */
    fun keywords(raw: List<String>): List<String> =
        raw.map { it.replace(Regex("[<>\\r\\n]"), " ").trim() }.filter { it.isNotEmpty() }.distinct()

    /** OpenAI wants ISO 639-1 codes: "pl-PL" ⇒ "pl". */
    fun languages(raw: List<String>): List<String> =
        raw.map { it.substringBefore('-').substringBefore('_').lowercase() }.filter { it.isNotEmpty() }.distinct()
}
