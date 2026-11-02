package com.peersflow.mobile.voice

/** 16-bit mono PCM WAV writer/reader. [read] skips unknown chunks (afconvert writes `FLLR`) until `data`. */
object WavCodec {
    fun write(pcm16: ShortArray, sampleRate: Int): ByteArray {
        val dataLen = pcm16.size * 2
        val out = ByteArray(44 + dataLen)
        fun ascii(at: Int, s: String) = s.forEachIndexed { i, c -> out[at + i] = c.code.toByte() }
        fun int32(at: Int, v: Int) {
            for (i in 0 until 4) out[at + i] = ((v shr (8 * i)) and 0xff).toByte()
        }
        fun int16(at: Int, v: Int) {
            out[at] = (v and 0xff).toByte()
            out[at + 1] = ((v shr 8) and 0xff).toByte()
        }
        ascii(0, "RIFF"); int32(4, 36 + dataLen); ascii(8, "WAVE")
        ascii(12, "fmt "); int32(16, 16); int16(20, 1); int16(22, 1)
        int32(24, sampleRate); int32(28, sampleRate * 2); int16(32, 2); int16(34, 16)
        ascii(36, "data"); int32(40, dataLen)
        PcmUtil.toLittleEndianBytes(pcm16).copyInto(out, 44)
        return out
    }

    /** Returns (sampleRate, samples). Throws [IllegalArgumentException] for anything but 16-bit mono PCM. */
    fun read(bytes: ByteArray): Pair<Int, ShortArray> {
        require(bytes.size >= 12 && tag(bytes, 0) == "RIFF" && tag(bytes, 8) == "WAVE") { "not a RIFF/WAVE file" }
        var pos = 12
        var sampleRate = -1
        while (pos + 8 <= bytes.size) {
            val id = tag(bytes, pos)
            val size = int32(bytes, pos + 4)
            val body = pos + 8
            when (id) {
                "fmt " -> {
                    val format = int16(bytes, body)
                    val channels = int16(bytes, body + 2)
                    val bits = int16(bytes, body + 14)
                    require(format == 1 || format == 0xFFFE) { "WAV format $format is not PCM" }
                    require(channels == 1) { "WAV has $channels channels, need mono" }
                    require(bits == 16) { "WAV has $bits-bit samples, need 16-bit" }
                    sampleRate = int32(bytes, body + 4)
                }
                "data" -> {
                    require(sampleRate > 0) { "WAV data chunk before fmt chunk" }
                    val len = minOf(size.toLong() and 0xffffffffL, (bytes.size - body).toLong()).toInt()
                    return sampleRate to PcmUtil.fromLittleEndianBytes(bytes, body, len)
                }
            }
            pos = body + size + (size and 1)
        }
        throw IllegalArgumentException("WAV has no data chunk")
    }

    private fun tag(b: ByteArray, at: Int) = String(b, at, 4, Charsets.US_ASCII)

    private fun int16(b: ByteArray, at: Int) = (b[at].toInt() and 0xff) or ((b[at + 1].toInt() and 0xff) shl 8)

    private fun int32(b: ByteArray, at: Int) = int16(b, at) or (int16(b, at + 2) shl 16)
}
