package com.peersflow.mobile.net

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.InetSocketAddress
import java.net.Socket

/**
 * Plain TCP reachability, used by `probe()` to tell "the Mac is off / unreachable" from "the Mac is up but the app is down".
 *
 * Dev-mode caveat: the emulator reaches the Mac as 10.0.2.2. When the Peers Flow app is down nothing listens on the
 * port, so the TCP connect fails and `probe()` reports MAC_OFF instead of APP_DOWN. On a real tailnet the HTTPS port is
 * served by Tailscale, so TCP succeeds while the app is down and the two states separate properly.
 */
object Reachability {
    /** True when a TCP connection to [host]:[port] opens within [timeoutMs]. Blocking; call it off the main thread. */
    fun tcpOpen(host: String, port: Int, timeoutMs: Int): Boolean = try {
        Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs) }
        true
    } catch (_: Exception) {
        false
    }

    /** Host and port of [baseUrl]; the port defaults to 80 for http and 443 for https. Throws on an unparseable URL. */
    fun hostPort(baseUrl: String): Pair<String, Int> {
        val url = baseUrl.trim().toHttpUrlOrNull() ?: throw IllegalArgumentException("not an http(s) url")
        return url.host to url.port
    }
}
