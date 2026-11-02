package com.peersflow.mobile.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import kotlinx.coroutines.delay
import java.util.concurrent.LinkedBlockingQueue

/** Streams PCM16 24 kHz mono to an AudioTrack (USAGE_ASSISTANT) from its own writer thread. */
class AudioTrackSink(private val sampleRate: Int = 24000) : PcmSink {
    private val queue = LinkedBlockingQueue<ByteArray>()
    private val lock = Any()
    private var track: AudioTrack? = null
    private var writer: Thread? = null
    @Volatile private var framesWritten = 0L
    @Volatile private var generation = 0

    private fun ensureTrack(): AudioTrack = synchronized(lock) {
        track ?: run {
            val min = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val t = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(maxOf(min * 4, sampleRate))
                .build()
            t.play()
            track = t
            framesWritten = 0
            val gen = generation
            writer = Thread({
                while (generation == gen) {
                    val chunk = try { queue.take() } catch (_: InterruptedException) { break }
                    if (generation != gen) break
                    val n = t.write(chunk, 0, chunk.size, AudioTrack.WRITE_BLOCKING)
                    if (n > 0) framesWritten += n / 2
                }
            }, "AudioTrackSink").apply { isDaemon = true; start() }
            t
        }
    }

    override fun write(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        ensureTrack()
        queue.put(bytes)
    }

    override fun stop() {
        synchronized(lock) {
            generation++
            queue.clear()
            writer?.interrupt()
            writer = null
            track?.let {
                runCatching { it.pause(); it.flush(); it.stop() }
                it.release()
            }
            track = null
        }
    }

    override suspend fun drain() {
        val t = synchronized(lock) { track } ?: return
        while (true) {
            val queued = queue.isNotEmpty()
            val head = runCatching { t.playbackHeadPosition.toLong() and 0xffffffffL }.getOrDefault(Long.MAX_VALUE)
            if (!queued && head >= framesWritten) break
            if (synchronized(lock) { track } !== t) break
            delay(20)
        }
    }
}
