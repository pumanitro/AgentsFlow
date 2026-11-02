package com.peersflow.mobile.voice

import java.util.Base64

/** PCM16 helpers. Pure JVM so tests can use them. */
object PcmUtil {
    fun toLittleEndianBytes(pcm16: ShortArray): ByteArray {
        val out = ByteArray(pcm16.size * 2)
        for (i in pcm16.indices) {
            val s = pcm16[i].toInt()
            out[2 * i] = (s and 0xff).toByte()
            out[2 * i + 1] = ((s shr 8) and 0xff).toByte()
        }
        return out
    }

    fun fromLittleEndianBytes(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset): ShortArray {
        val n = length / 2
        val out = ShortArray(n)
        for (i in 0 until n) {
            val lo = bytes[offset + 2 * i].toInt() and 0xff
            val hi = bytes[offset + 2 * i + 1].toInt()
            out[i] = ((hi shl 8) or lo).toShort()
        }
        return out
    }

    fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)

    fun base64(pcm16: ShortArray): String = base64(toLittleEndianBytes(pcm16))

    fun fromBase64(b64: String): ByteArray = Base64.getDecoder().decode(b64)

    fun concat(frames: List<ShortArray>): ShortArray {
        val out = ShortArray(frames.sumOf { it.size })
        var pos = 0
        for (f in frames) {
            f.copyInto(out, pos)
            pos += f.size
        }
        return out
    }
}
