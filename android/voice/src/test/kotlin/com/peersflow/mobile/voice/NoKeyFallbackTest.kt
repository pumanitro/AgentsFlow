package com.peersflow.mobile.voice

import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.SttProvider
import com.peersflow.mobile.wire.SttResult
import com.peersflow.mobile.wire.SttSession
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Regression (2026-11-02): with no OpenAI key, a failing phone recognizer was masked by "no OpenAI key". */
class NoKeyFallbackTest {
    private fun failingOnDevice() = object : SttProvider {
        override val id = "on-device"
        // What the phone did: Android reported no speech service, so start() failed.
        override suspend fun start(config: SttConfig): SttSession = throw SttUnavailable("no speech recognizer on this device")
    }
    private val keylessFile = object : SttProvider {
        override val id = "openai-file"
        override suspend fun start(config: SttConfig): SttSession = throw SttUnavailable("no OpenAI key")
    }

    @Test fun withoutAKeyThePhoneRecognizersRealErrorIsShown() = runTest {
        val engine = VoiceEngineImpl(null, keylessFile, failingOnDevice(), null, null, { null }, { false }, backgroundScope)
        val h = engine.listen(SttConfig(), TestAudio.ListSource(emptyList())) {}
        try { h.finish(); fail("expected a failure") } catch (e: Exception) {
            assertTrue("got: ${e.message}", e.message.orEmpty().contains("no speech recognizer"))
        }
    }
}
