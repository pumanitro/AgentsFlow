package com.peersflow.mobile.voice

import kotlin.math.max
import kotlin.math.sqrt

/**
 * Energy VAD. The first 300 ms calibrate the noise floor (mean frame RMS); a frame is speech when its RMS is
 * above max(noiseFloor × 3, 300). [VadEvent.SpeechStart] fires on the first speech frame; [VadEvent.SpeechEnd]
 * fires once [silenceMs] of non-speech follow at least [minSpeechMs] of speech. A shorter blip is dropped silently.
 */
class Vad(private val sampleRate: Int, private val silenceMs: Int = 1200, private val minSpeechMs: Int = 400) {
    private var calibMs = 0.0
    private var calibSum = 0.0
    private var calibFrames = 0
    var noiseFloor: Double? = null
        private set
    private var inSpeech = false
    private var speechMs = 0.0
    private var silenceRun = 0.0

    fun push(frame: ShortArray): VadEvent? {
        if (frame.isEmpty()) return null
        val ms = frame.size * 1000.0 / sampleRate
        val rms = rms(frame)
        val floor = noiseFloor
        if (floor == null) {
            calibSum += rms
            calibFrames++
            calibMs += ms
            if (calibMs >= CALIBRATION_MS - EPS) noiseFloor = calibSum / calibFrames
            return null
        }
        val speech = rms > max(floor * 3, MIN_THRESHOLD)
        if (!inSpeech) {
            if (!speech) return null
            inSpeech = true
            speechMs = ms
            silenceRun = 0.0
            return VadEvent.SpeechStart
        }
        if (speech) {
            speechMs += ms
            silenceRun = 0.0
            return null
        }
        silenceRun += ms
        if (silenceRun < silenceMs - EPS) return null
        val enough = speechMs >= minSpeechMs - EPS
        inSpeech = false
        speechMs = 0.0
        silenceRun = 0.0
        return if (enough) VadEvent.SpeechEnd else null
    }

    fun reset() {
        calibMs = 0.0
        calibSum = 0.0
        calibFrames = 0
        noiseFloor = null
        inSpeech = false
        speechMs = 0.0
        silenceRun = 0.0
    }

    companion object {
        const val CALIBRATION_MS = 300.0
        const val MIN_THRESHOLD = 300.0
        private const val EPS = 1e-6

        fun rms(frame: ShortArray): Double {
            var sum = 0.0
            for (s in frame) sum += s.toDouble() * s
            return sqrt(sum / frame.size)
        }
    }
}
