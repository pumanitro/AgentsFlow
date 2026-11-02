package com.peersflow.mobile.net

import com.peersflow.mobile.wire.Session
import okhttp3.OkHttpClient
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

internal object TestData {
    const val TOKEN = "t-test"

    fun session(baseUrl: String) = Session(
        baseUrl = baseUrl, token = TOKEN, deviceId = "d1", scopes = listOf("view", "talk"),
        serverName = "mac", sttKey = "sk-secret", pairedAt = 1L,
    )

    fun client(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    /** A localhost port with nothing listening on it. */
    fun closedPort(): Int = ServerSocket(0).use { it.localPort }

    const val HEALTH = """{"hostname":"mac","appVersion":"12.0.0","now":"2026-10-28T10:00:00Z"}"""
    const val WELCOME = """{"type":"welcome","seq":7,"health":$HEALTH,"serverTime":"2026-10-28T10:00:00Z"}"""
    const val FEED_7 = """{"type":"feed","item":{"seq":7,"kind":"outcome","conversationId":"c1","title":"Build","peerName":"LISA","at":"2026-10-28T10:00:00Z","spoken":"done","messageId":"m1"}}"""
    const val SUMMARY = """{"id":"c1","peerId":"p1","peerName":"LISA","title":"Build","state":"working","createdAt":"2026-10-28T09:00:00Z","updatedAt":"2026-10-28T10:00:00Z"}"""
    const val CONVS_UPDATED = """{"type":"conversations.updated","summaries":[$SUMMARY]}"""
}
