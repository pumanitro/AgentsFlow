package com.peersflow.mobile

import android.content.Intent

/** Reads `peersflow://pair?url=<base>&code=<code>&fp=<hex>` into (url, code); anything else gives (null, null). */
fun parsePairDeepLink(intent: Intent?): Pair<String?, String?> {
    val uri = intent?.data ?: return null to null
    if (uri.scheme != "peersflow" || uri.host != "pair") return null to null
    val url = uri.getQueryParameter("url")?.takeIf { it.isNotBlank() }
    val code = uri.getQueryParameter("code")?.takeIf { it.isNotBlank() }
    return url to code
}
