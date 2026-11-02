package com.peersflow.mobile.wire.fakes

import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.ListenHandle
import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttResult
import com.peersflow.mobile.wire.TtsHandle
import com.peersflow.mobile.wire.VoiceEngine
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow

/** `listen` yields "fake transcript" on finish; `speak` completes at once. Spoken texts land in [spoken]. */
class FakeVoiceEngine(var transcript: String = "fake transcript") : VoiceEngine {
    override val vocabulary = MutableStateFlow<List<String>>(emptyList())
    val spoken = mutableListOf<String>()
    var cancelled = 0
        private set

    override fun listen(config: SttConfig, source: AudioSource, onPartial: (String) -> Unit): ListenHandle {
        val text = transcript
        return object : ListenHandle {
            override val endOfSpeech: Flow<Unit> = emptyFlow()
            override suspend fun finish(): SttResult = SttResult(text, "pl", "fake", 0)
            override fun cancel() {
                cancelled++
            }
        }
    }

    override suspend fun speak(text: String, cacheKey: String?): TtsHandle {
        spoken += text
        return object : TtsHandle {
            override suspend fun await() {}
            override fun stop() {}
        }
    }
}
