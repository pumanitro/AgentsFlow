package com.peersflow.mobile.ui.aux

import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.FeedItem
import com.peersflow.mobile.wire.ListenHandle
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.Session
import com.peersflow.mobile.wire.SttConfig
import com.peersflow.mobile.wire.TtsHandle
import com.peersflow.mobile.wire.VoiceEngine
import com.peersflow.mobile.wire.VoicePrefs
import com.peersflow.mobile.wire.fakes.FakeApiClient
import com.peersflow.mobile.wire.fakes.FakeServerStatus
import com.peersflow.mobile.wire.fakes.InMemoryConversationRepository
import com.peersflow.mobile.wire.fakes.InMemoryOutcomesRepository
import com.peersflow.mobile.wire.fakes.InMemorySessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

@OptIn(ExperimentalCoroutinesApi::class)
class AuxViewModelsTest {

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun pairing(api: FakeApiClient = FakeApiClient(), store: InMemorySessionStore = InMemorySessionStore()) =
        PairingViewModel(api, store, deviceNameDefault = "Test phone", now = { 42L })

    @Test fun applyScan_parsesDeepLink_andRejectsWrongScheme() {
        val vm = pairing()
        vm.applyScan("peersflow://pair?url=http%3A%2F%2F10.0.2.2%3A47821&code=ABCD-EFGH&fp=")
        assertEquals("http://10.0.2.2:47821", vm.state.value.url)
        assertEquals("ABCD-EFGH", vm.state.value.code)
        assertNull(vm.state.value.error)

        vm.applyScan("https://example.com/pair?code=ABCD-EFGH")
        assertEquals("Not a Peers Flow pairing code", vm.state.value.error)
    }

    @Test fun setCode_normalises() {
        val vm = pairing()
        vm.setCode("abcd efgh")
        assertEquals("ABCD-EFGH", vm.state.value.code)
        vm.setCode("ABCDEFGHJ")
        assertEquals("ABCD-EFGH", vm.state.value.code)
        vm.setCode("ab1c")
        assertEquals("AB", vm.state.value.code.take(2))
        assertFalse(vm.state.value.code.contains('1'))
    }

    @Test fun submit_savesSession_andWrongCodeShowsNotFoundMessage() = runTest {
        val api = FakeApiClient()
        val store = InMemorySessionStore()
        val vm = pairing(api, store)
        vm.setUrl("http://10.0.2.2:47821/")
        vm.setCode(FakeApiClient.TEST_CODE)
        vm.submit()
        assertTrue(vm.state.value.paired)
        val saved = store.session.value
        assertNotNull(saved)
        assertEquals("http://10.0.2.2:47821", saved!!.baseUrl)
        assertEquals(FakeApiClient.TEST_TOKEN, saved.token)
        assertEquals(42L, saved.pairedAt)
        assertEquals(PairingViewModel.NO_STT_WARNING, vm.state.value.warning)

        val bad = pairing(api, InMemorySessionStore())
        bad.setUrl("http://10.0.2.2:47821")
        bad.setCode("WRONGCODE")
        bad.submit()
        assertFalse(bad.state.value.paired)
        assertEquals("Code is wrong or expired — make a new one in Peers Flow → Mobile", bad.state.value.error)

        val off = pairing(api, InMemorySessionStore())
        off.setUrl("http://mac.local:1")
        off.setCode(FakeApiClient.TEST_CODE)
        api.nextError = ApiResult.Err("transport", "x", transport = true)
        off.submit()
        assertTrue(off.state.value.error!!.startsWith("Cannot reach mac.local"))
    }

    private fun session() = Session("http://h:1", "t", "dev", listOf("view"), "Mac", null, 0)

    @Test fun settings_effectiveVoicePeer_andUnpair() = runTest {
        val lisa = PeerSummary("p1", "Lisa", "/a")
        val other = PeerSummary("p2", "Other", "/b")
        val store = InMemorySessionStore(session())
        val repo = InMemoryConversationRepository(initialPeers = listOf(other, lisa))
        val vm = SettingsViewModel(store, repo, FakeServerStatus(), com.peersflow.mobile.wire.fakes.FakeVoiceEngine(), {})
        assertEquals("p1", vm.state.value.effectiveVoicePeer?.id)

        vm.setVoicePeer("p2")
        assertEquals("p2", vm.state.value.effectiveVoicePeer?.id)
        assertEquals("p2", store.prefs.value.voicePeerId)

        var unpaired = 0
        val job = launch(UnconfinedTestDispatcher(testScheduler)) { vm.unpaired.collect { unpaired++ } }
        vm.unpair()
        assertNull(store.session.value)
        assertEquals(1, unpaired)
        job.cancel()
    }

    private class RecordingVoice : VoiceEngine {
        val calls = mutableListOf<Pair<String, String?>>()
        override val vocabulary = MutableStateFlow<List<String>>(emptyList())
        override fun listen(config: SttConfig, source: AudioSource, onPartial: (String) -> Unit): ListenHandle =
            throw UnsupportedOperationException()
        override suspend fun speak(text: String, cacheKey: String?): TtsHandle {
            calls += text to cacheKey
            return object : TtsHandle {
                override suspend fun await() {}
                override fun stop() {}
            }
        }
    }

    private fun item(seq: Long, at: String, spoken: String? = "done $seq") =
        FeedItem(seq, "outcome", "c$seq", "Title $seq", "Lisa", at, spoken = spoken)

    @Test fun outcomes_groupsByDay_awayHeader_andReplayCacheKey() = runTest {
        val clock = Clock.fixed(Instant.parse("2026-10-28T12:00:00Z"), ZoneOffset.UTC)
        val repo = InMemoryOutcomesRepository(
            listOf(
                item(1, "2026-10-26T09:00:00Z"),
                item(2, "2026-10-27T09:00:00Z"),
                item(3, "2026-10-28T08:00:00Z"),
            ),
        )
        val voice = RecordingVoice()
        val vm = OutcomesViewModel(repo, voice, InMemoryConversationRepository(), clock)
        val s = vm.state.value
        assertEquals(listOf("Today", "Yesterday", "26 Oct"), s.groups.map { it.label })
        assertEquals(3, s.unseen)
        assertEquals("3 conclusions while you were away", s.awayHeader)

        vm.replay(repo.items.value.first { it.seq == 2L })
        assertEquals(listOf("done 2" to "feed:2"), voice.calls)

        vm.markAllSeen()
        assertEquals(3L, repo.seenUpTo.value)
        assertEquals(0, vm.state.value.unseen)
    }

    @Test fun outcomes_noAwayHeaderForSingleUnseen() = runTest {
        val clock = Clock.fixed(Instant.parse("2026-10-28T12:00:00Z"), ZoneOffset.UTC)
        val repo = InMemoryOutcomesRepository(listOf(item(1, "2026-10-28T08:00:00Z")))
        val vm = OutcomesViewModel(repo, RecordingVoice(), InMemoryConversationRepository(), clock)
        assertEquals(1, vm.state.value.unseen)
        assertNull(vm.state.value.awayHeader)
    }
}
