package com.peersflow.mobile.net

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Shared HTTP helpers for the API client and the event stream. */
internal object Http {
    const val USER_AGENT = "PeersFlowMobile/0.1 (Android)"
    private const val JSON_CT = "application/json; charset=utf-8"
    private val JSON_TYPE = JSON_CT.toMediaType()

    class RawResponse(val status: Int, val body: String)

    /** `<baseUrl without trailing slash>/api/v1/<path…>?<query>`, segments encoded, null query values skipped; null when [baseUrl] does not parse. */
    fun apiUrl(baseUrl: String, path: List<String>, query: List<Pair<String, String?>> = emptyList()): HttpUrl? {
        val base = baseUrl.trim().trimEnd('/').toHttpUrlOrNull() ?: return null
        val b = base.newBuilder().addPathSegments("api/v1")
        path.forEach { b.addPathSegment(it) }
        query.forEach { (k, v) -> if (v != null) b.addQueryParameter(k, v) }
        return b.build()
    }

    /** The WebSocket URL for [baseUrl]: http→ws, https→wss, plus `/api/v1/events`. */
    fun eventsUrl(baseUrl: String): String {
        val trimmed = baseUrl.trim().trimEnd('/')
        val ws = when {
            trimmed.startsWith("https://", ignoreCase = true) -> "wss://" + trimmed.substring(8)
            trimmed.startsWith("http://", ignoreCase = true) -> "ws://" + trimmed.substring(7)
            else -> trimmed
        }
        return "$ws/api/v1/events"
    }

    fun get(url: HttpUrl, token: String?): Request = builder(token).url(url).get().build()

    fun post(url: HttpUrl, body: String, token: String?): Request =
        builder(token).url(url).post(body.toRequestBody(JSON_TYPE)).header("Content-Type", JSON_CT).build()

    /** Common headers; the URL is set by the caller. */
    fun builder(token: String?): Request.Builder {
        val b = Request.Builder().header("Accept", "application/json").header("User-Agent", USER_AGENT)
        if (token != null) b.header("Authorization", "Bearer $token")
        return b
    }

    /** Runs [call] asynchronously, reads the whole body, cancels the call when the coroutine is cancelled. */
    suspend fun await(call: Call): RawResponse = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (cont.isActive) cont.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                val raw = try {
                    response.use { RawResponse(it.code, it.body?.string().orEmpty()) }
                } catch (e: IOException) {
                    if (cont.isActive) cont.resumeWithException(e)
                    return
                }
                if (cont.isActive) cont.resume(raw)
            }
        })
    }
}
