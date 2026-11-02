package com.peersflow.mobile

import android.app.Activity
import android.app.Application
import androidx.fragment.app.FragmentActivity
import com.peersflow.mobile.data.OutboxImpl
import com.peersflow.mobile.data.SessionStoreImpl
import com.peersflow.mobile.data.db.buildDb
import com.peersflow.mobile.data.repos.ConversationRepositoryImpl
import com.peersflow.mobile.data.repos.OutcomesRepositoryImpl
import com.peersflow.mobile.data.repos.ServerStatusRepositoryImpl
import com.peersflow.mobile.glue.AndroidNetLogger
import com.peersflow.mobile.glue.AndroidVoiceLog
import com.peersflow.mobile.glue.BiometricActionGate
import com.peersflow.mobile.glue.internetReachable
import com.peersflow.mobile.net.OkHttpApiClient
import com.peersflow.mobile.net.OkHttpEventStream
import com.peersflow.mobile.services.ServicesDeps
import com.peersflow.mobile.services.ServicesHost
import com.peersflow.mobile.voice.AudioCaptureSource
import com.peersflow.mobile.voice.AudioTrackSink
import com.peersflow.mobile.voice.OnDeviceStt
import com.peersflow.mobile.voice.OnDeviceTts
import com.peersflow.mobile.voice.OpenAiFileStt
import com.peersflow.mobile.voice.OpenAiLiveStt
import com.peersflow.mobile.voice.OpenAiRealtimeTts
import com.peersflow.mobile.voice.TtsCache
import com.peersflow.mobile.voice.VoiceEngineImpl
import com.peersflow.mobile.wire.ActionGate
import com.peersflow.mobile.wire.ApiClient
import com.peersflow.mobile.wire.ApiResult
import com.peersflow.mobile.wire.AudioSource
import com.peersflow.mobile.wire.ConversationRepository
import com.peersflow.mobile.wire.EventStream
import com.peersflow.mobile.wire.FlushReport
import com.peersflow.mobile.wire.OutcomesRepository
import com.peersflow.mobile.wire.Outbox
import com.peersflow.mobile.wire.ServerStatusRepository
import com.peersflow.mobile.wire.SessionStore
import com.peersflow.mobile.wire.VoiceEngine
import com.peersflow.mobile.wire.WireJson
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** Process-wide object graph: construction only, no business logic. */
object AppGraph {
    lateinit var api: ApiClient
    lateinit var session: SessionStore
    lateinit var events: EventStream
    lateinit var outbox: Outbox
    lateinit var repo: ConversationRepository
    lateinit var outcomes: OutcomesRepository
    lateinit var status: ServerStatusRepository
    lateinit var voice: VoiceEngine
    lateinit var gate: ActionGate
    lateinit var audio: AudioSource

    /** Extras beyond C5 that the host needs. */
    lateinit var scope: CoroutineScope
    lateinit var statusImpl: ServerStatusRepositoryImpl
    lateinit var voiceImpl: VoiceEngineImpl
    lateinit var lastSpawnedId: StateFlow<String?>
    val lastFlush: StateFlow<FlushReport?> get() = statusImpl.lastFlush

    /** The resumed (or most recently resumed, still alive) activity; used by the biometric gate. */
    @Volatile var currentActivity: Activity? = null

    val isPaired: Boolean get() = ::session.isInitialized && session.session.value != null

    private var initialized = false

    @Synchronized
    fun init(app: Application) {
        if (initialized) return
        val json = WireJson
        // No pingInterval: the event stream pings itself. 60 s read timeout for file-mode transcription.
        val okhttp = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
        val sessionImpl = SessionStoreImpl(app)
        session = sessionImpl
        api = OkHttpApiClient(sessionImpl, okhttp, json, logger = AndroidNetLogger)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        events = OkHttpEventStream(sessionImpl, api, okhttp, scope, logger = AndroidNetLogger)
        val db = buildDb(app)
        outbox = OutboxImpl(db.outboxDao(), api)
        statusImpl = ServerStatusRepositoryImpl(events, sessionImpl, outbox, scope)
        status = statusImpl
        val repoImpl = ConversationRepositoryImpl(db, api, events, sessionImpl, outbox, statusImpl, scope, json)
        repo = repoImpl
        lastSpawnedId = repoImpl.lastSpawnedId
        val outcomesImpl = OutcomesRepositoryImpl(db, api, events, sessionImpl, scope)
        outcomes = outcomesImpl
        statusImpl.start()
        repoImpl.start()
        outcomesImpl.start()

        audio = AudioCaptureSource()
        val key: () -> String? = { session.session.value?.sttKey?.takeIf { it.isNotBlank() } }
        voiceImpl = VoiceEngineImpl(
            live = OpenAiLiveStt(key, okhttp, json, log = AndroidVoiceLog),
            file = OpenAiFileStt(key, okhttp, json, log = AndroidVoiceLog),
            onDevice = OnDeviceStt(app),
            cloudTts = OpenAiRealtimeTts(
                key, okhttp, json,
                player = AudioTrackSink(),
                cache = TtsCache(File(app.cacheDir, "tts")),
                log = AndroidVoiceLog,
            ),
            deviceTts = OnDeviceTts(app),
            vocabularyFetcher = {
                if (session.session.value == null) null else (api.vocabulary() as? ApiResult.Ok)?.value?.words
            },
            // "Cloud speech usable" = the phone has internet AND a speech key was paired. Without a key the
            // OpenAI providers would throw on every call, so the engine goes straight to on-device instead.
            online = { key() != null && internetReachable(app) },
            scope = scope,
            liveEnabled = { session.prefs.value.liveStt },
            voice = { session.prefs.value.ttsVoice },
            log = AndroidVoiceLog,
        )
        voice = voiceImpl
        gate = BiometricActionGate(sessionImpl) { currentActivity as? FragmentActivity }

        ServicesHost.deps = object : ServicesDeps {
            override val repo get() = AppGraph.repo
            override val events get() = AppGraph.events
            override val outbox get() = AppGraph.outbox
            override val outcomes get() = AppGraph.outcomes
            override val status get() = AppGraph.status
            override val session get() = AppGraph.session
            override val voice get() = AppGraph.voice
            override val audio get() = AppGraph.audio
            override val lastFlush get() = AppGraph.statusImpl.lastFlush
        }
        initialized = true
    }

    /** An activity came to the foreground: keep the stream up even when the service is off, and reconnect now. */
    fun onForeground(reason: String) {
        if (!isPaired) return
        events.start()
        events.kick(reason)
    }

    /** Freshly paired: pull the lists and the vocabulary right away instead of waiting for the next tick. */
    fun onPaired() {
        scope.launch { runCatching { repo.refresh() } }
        scope.launch { runCatching { voiceImpl.refreshVocabulary() } }
    }
}
