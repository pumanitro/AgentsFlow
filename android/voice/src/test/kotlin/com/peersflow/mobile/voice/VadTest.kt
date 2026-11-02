package com.peersflow.mobile.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class VadTest {
    @Test
    fun speechStartThenSpeechEndAtTheRightFrame() {
        // 300 ms silence (frames 0-14), 800 ms tone (15-54), 1500 ms silence (55-129); 20 ms frames.
        val pcm = TestAudio.silence(300) + TestAudio.tone(800) + TestAudio.silence(1500)
        val frames = TestAudio.frames(pcm)
        assertEquals(130, frames.size)
        val vad = Vad(24000)
        val events = frames.mapIndexedNotNull { i, f -> vad.push(f)?.let { i to it } }
        assertEquals(listOf(15 to VadEvent.SpeechStart, 114 to VadEvent.SpeechEnd), events)
    }

    @Test
    fun shortBlipDoesNotEndSpeech() {
        val pcm = TestAudio.silence(300) + TestAudio.tone(200) + TestAudio.silence(1500)
        val vad = Vad(24000)
        val events = TestAudio.frames(pcm).mapNotNull { vad.push(it) }
        assertEquals(listOf<VadEvent>(VadEvent.SpeechStart), events)
    }

    @Test
    fun resetRecalibrates() {
        val vad = Vad(24000)
        TestAudio.frames(TestAudio.silence(300)).forEach { vad.push(it) }
        assertEquals(0.0, vad.noiseFloor!!, 0.0)
        vad.reset()
        assertEquals(null, vad.noiseFloor)
    }
}
