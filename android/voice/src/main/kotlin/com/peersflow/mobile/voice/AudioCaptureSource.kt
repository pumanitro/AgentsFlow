package com.peersflow.mobile.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import com.peersflow.mobile.wire.AudioSource
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive

/** Microphone capture: mono PCM16 in 20 ms frames on Dispatchers.IO. Stops when the collector is cancelled. Needs RECORD_AUDIO. */
class AudioCaptureSource(override val sampleRate: Int = 24000) : AudioSource {
    @SuppressLint("MissingPermission")
    override fun frames(): Flow<ShortArray> = flow {
        val minBuffer = AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(minBuffer > 0) { "AudioRecord does not support $sampleRate Hz mono PCM16" }
        val record = AudioRecord(
            MediaRecorder.AudioSource.MIC, sampleRate, AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT, minBuffer * 4,
        )
        check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord failed to initialise" }
        val frameSize = sampleRate / 50
        try {
            record.startRecording()
            while (currentCoroutineContext().isActive) {
                val frame = ShortArray(frameSize)
                var got = 0
                while (got < frameSize) {
                    val n = record.read(frame, got, frameSize - got)
                    if (n < 0) error("AudioRecord.read failed: $n")
                    got += n
                }
                emit(frame)
            }
        } finally {
            runCatching { record.stop() }
            record.release()
        }
    }.flowOn(Dispatchers.IO)
}
