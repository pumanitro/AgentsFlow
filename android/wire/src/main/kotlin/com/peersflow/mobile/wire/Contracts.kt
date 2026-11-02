// Contracts.kt
package com.peersflow.mobile.wire
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

sealed interface ApiResult<out T> {
  data class Ok<T>(val value: T) : ApiResult<T>
  data class Err(val code: String, val message: String, val status: Int = 0, val transport: Boolean = false) : ApiResult<Nothing>  // transport=true ⇒ no HTTP answer at all
}
enum class ConnectionState { UNPAIRED, ONLINE, APP_DOWN, MAC_OFF, PAUSED, UNAUTHORIZED }
data class Session(val baseUrl: String, val token: String, val deviceId: String, val scopes: List<String>, val serverName: String, val sttKey: String?, val pairedAt: Long)
data class VoicePrefs(val voicePeerId: String? = null, val stayConnected: Boolean = true, val biometric: Boolean = false, val speakAlways: Boolean = false,
  val quietFrom: Int? = null, val quietTo: Int? = null, val ttsVoice: String = "marin", val liveStt: Boolean = true)

interface ApiClient {
  /** Speech key from the Mac (null when none is set there). */
  suspend fun voiceKey(): ApiResult<String?> = ApiResult.Err("unsupported", "voice key not available")
  suspend fun pinned(): ApiResult<PinnedListResponse> = ApiResult.Err("unsupported", "pinned list not available")
  suspend fun pair(baseUrl: String, req: PairRequest): ApiResult<PairResponse>          // the only call made before a Session exists
  suspend fun ping(): ApiResult<Unit>
  suspend fun me(): ApiResult<MeResponse>
  suspend fun health(): ApiResult<ServerHealth>
  suspend fun peers(): ApiResult<List<PeerSummary>>
  suspend fun conversations(filter: String? = null, peerId: String? = null): ApiResult<List<ConversationSummary>>
  suspend fun conversation(id: String): ApiResult<ConversationDetail>
  suspend fun messages(id: String, before: Long? = null, limit: Int = 50): ApiResult<MessagesPage>
  suspend fun reply(id: String, req: ReplyRequest): ApiResult<ReplyResponse>
  suspend fun answer(id: String, req: AnswerRequest): ApiResult<ReplyResponse>
  suspend fun stop(id: String): ApiResult<Unit>
  suspend fun done(id: String): ApiResult<Unit>
  suspend fun reopen(id: String): ApiResult<Unit>
  suspend fun spawn(req: SpawnConversationRequest): ApiResult<SpawnConversationResponse>
  suspend fun outcomes(afterSeq: Long): ApiResult<List<FeedItem>>
  suspend fun vocabulary(): ApiResult<VocabularyResponse>
  suspend fun notifications(): ApiResult<List<MobileNotification>>
  suspend fun dismissNotification(id: String): ApiResult<Unit>
  suspend fun probe(): ConnectionState                 // TCP connect to host:port, then GET /ping → ONLINE | APP_DOWN | MAC_OFF | PAUSED | UNAUTHORIZED; no session ⇒ UNPAIRED
}
interface SessionStore {
  val session: StateFlow<Session?>
  val prefs: StateFlow<VoicePrefs>
  fun save(session: Session)
  fun clear()
  fun updatePrefs(f: (VoicePrefs) -> VoicePrefs)
  fun lastSeq(): Long
  fun setLastSeq(seq: Long)
  fun lastSeenAt(): Long?
  fun setLastSeenAt(ms: Long)
}
interface EventStream {
  val events: SharedFlow<ServerEvent>
  val state: StateFlow<ConnectionState>
  fun start()
  fun stop()
  fun kick(reason: String)    // kick = reconnect now (network change, app open, tap)
  fun subscribe(ids: Set<String>)
  fun unsubscribe(ids: Set<String>)
}
enum class OutboxKind { REPLY, ANSWER, SPAWN }
data class OutboxItem(val id: String /* = clientId */, val kind: OutboxKind, val conversationId: String?, val peerId: String?, val text: String,
  val source: String, val chatKind: String = "chat", val spokenAt: String? = null, val createdAt: Long, val attempts: Int = 0, val lastError: String? = null, val needsDecision: Boolean = false)
data class FlushReport(val sent: Int, val duplicates: Int, val failed: Int, val stoppedOnTransport: Boolean)
interface Outbox {
  val items: Flow<List<OutboxItem>>
  suspend fun enqueue(item: OutboxItem)
  suspend fun remove(id: String)
  suspend fun retarget(id: String, peerId: String)  // "start a fresh chat with this text"
  suspend fun flush(): FlushReport                     // single-flight; createdAt order; stops at the first transport error
}
sealed interface SendResult {
  data class Sent(val via: String?) : SendResult
  data class Queued(val outboxId: String) : SendResult
  object Duplicate : SendResult
  data class Failed(val message: String, val notRunning: Boolean = false) : SendResult
}
interface ConversationRepository {
  /** The desktop pinned list + History; null until first loaded. */
  fun pinnedList(): kotlinx.coroutines.flow.Flow<PinnedListResponse?> = kotlinx.coroutines.flow.flowOf(null)
  fun peers(): Flow<List<PeerSummary>>
  fun summaries(): Flow<List<ConversationSummary>>
  fun detail(id: String): Flow<ConversationDetail?>
  fun messages(id: String): Flow<List<MessageEntry>>
  suspend fun refresh(): Boolean
  suspend fun loadOlder(id: String): Boolean
  fun open(id: String)
  fun close(id: String)          // subscribe/unsubscribe live updates for a chat
  suspend fun send(id: String, text: String, source: String): SendResult
  suspend fun answer(id: String, questionId: String?, text: String, source: String): SendResult
  suspend fun stop(id: String): SendResult
  suspend fun done(id: String): SendResult
  suspend fun reopen(id: String): SendResult
  suspend fun startChat(peerId: String, prompt: String, kind: String, spokenAt: String?, source: String): SendResult
}
interface OutcomesRepository {
  fun feed(): Flow<List<FeedItem>>
  fun unseenCount(): Flow<Int>
  suspend fun markSeen(uptoSeq: Long)
  suspend fun replay(): Int
  fun latestSeq(): Long
}
interface ServerStatusRepository { val state: StateFlow<ConnectionState>; val health: StateFlow<ServerHealth?>; val lastSeenAt: StateFlow<Long?>; val outboxCount: StateFlow<Int> }
interface ActionGate { suspend fun confirm(reason: String): Boolean }   // biometric; always true when disabled

// voice
data class SttConfig(val languages: List<String> = listOf("pl", "en"), val keywords: List<String> = emptyList(), val sampleRate: Int = 24000, val prompt: String? = null)
data class SttResult(val text: String, val language: String?, val provider: String, val durationMs: Long)
interface SttSession {
  val partial: StateFlow<String>
  suspend fun feed(pcm16: ShortArray)
  suspend fun finish(): SttResult
  fun cancel()
}
interface SttProvider { val id: String; suspend fun start(config: SttConfig): SttSession }   // ids: "openai-live" | "openai-file" | "on-device"
interface AudioSource { val sampleRate: Int; fun frames(): Flow<ShortArray> }                 // 20 ms frames, mono PCM16
interface TtsHandle {
  suspend fun await()
  fun stop()
}
interface Tts { val id: String; suspend fun speak(text: String, voice: String?): TtsHandle }  // ids: "openai-realtime" | "on-device"
interface ListenHandle {
  val endOfSpeech: Flow<Unit>
  suspend fun finish(): SttResult
  fun cancel()
}   // endOfSpeech from VAD (1.2 s silence)
interface VoiceEngine {
  fun listen(config: SttConfig, source: AudioSource, onPartial: (String) -> Unit): ListenHandle   // live → file fallback (1.5 s connect timeout / mid-utterance drop) → on-device when offline
  suspend fun speak(text: String, cacheKey: String?): TtsHandle                                   // openai → on-device
  val vocabulary: StateFlow<List<String>>
}
