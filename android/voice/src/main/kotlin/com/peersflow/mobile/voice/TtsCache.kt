package com.peersflow.mobile.voice

import java.io.File
import java.security.MessageDigest

/** Disk cache of synthesized PCM: `<sha256(text + "|" + voice)>.pcm`, LRU eviction by mtime above [maxBytes]. */
class TtsCache(private val dir: File, private val maxBytes: Long = 50L * 1024 * 1024) {
    fun key(text: String, voice: String?): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$text|${voice ?: ""}".toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun file(key: String): File = File(dir, "$key.pcm")

    @Synchronized
    fun get(key: String): ByteArray? {
        val f = file(key)
        if (!f.isFile) return null
        f.setLastModified(System.currentTimeMillis())
        return runCatching { f.readBytes() }.getOrNull()
    }

    @Synchronized
    fun put(key: String, pcm: ByteArray) {
        if (pcm.isEmpty() || pcm.size > maxBytes) return
        dir.mkdirs()
        val tmp = File(dir, "$key.pcm.tmp")
        tmp.writeBytes(pcm)
        if (!tmp.renameTo(file(key))) {
            file(key).writeBytes(pcm)
            tmp.delete()
        }
        evict()
    }

    private fun evict() {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".pcm") }?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (f in files) {
            if (total <= maxBytes) break
            total -= f.length()
            f.delete()
        }
    }
}
