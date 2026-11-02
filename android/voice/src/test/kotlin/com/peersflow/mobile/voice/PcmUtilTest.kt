package com.peersflow.mobile.voice

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class PcmUtilTest {
    @Test
    fun littleEndianAndBase64OfKnownFrame() {
        val frame = shortArrayOf(1, -1, 0x1234, Short.MIN_VALUE)
        val bytes = PcmUtil.toLittleEndianBytes(frame)
        assertArrayEquals(byteArrayOf(0x01, 0x00, 0xFF.toByte(), 0xFF.toByte(), 0x34, 0x12, 0x00, 0x80.toByte()), bytes)
        assertEquals("AQD//zQSAIA=", PcmUtil.base64(frame))
        assertArrayEquals(frame, PcmUtil.fromLittleEndianBytes(PcmUtil.fromBase64("AQD//zQSAIA=")))
    }

    @Test
    fun concat() {
        assertArrayEquals(shortArrayOf(1, 2, 3), PcmUtil.concat(listOf(shortArrayOf(1), shortArrayOf(2, 3))))
    }
}
