// Wire.kt
package com.peersflow.mobile.wire
import kotlinx.serialization.Serializable

object ConvStates { const val STARTING = "starting"; const val WORKING = "working"; const val BLOCKED = "blocked"; const val DONE = "done"; const val FAILED = "failed"; const val IDLE = "idle" }
object Scopes { const val VIEW = "view"; const val TALK = "talk"; const val ADMIN = "admin" }
object Sources { const val DESKTOP = "desktop"; const val PHONE = "phone"; const val VOICE = "voice" }
object MessageKinds { const val USER = "user.text"; const val ASSISTANT = "assistant.text"; const val TOOL_USE = "tool_use"; const val TOOL_RESULT = "tool_result"; const val THINKING = "thinking"; const val SUBAGENT = "subagent"; const val NOTICE = "notice" }

@Serializable data class PeerSummary(val id: String, val name: String, val path: String, val remote: Boolean = false)
@Serializable data class ConversationSummary(
  val id: String, val peerId: String, val peerName: String, val title: String, val detail: String = "",
  val state: String, val rawState: String = "", val needsYou: Boolean = false, val pinned: Boolean = true,
  val provider: String = "claude", val chatKind: String = "chat", val createdAt: String, val unpinnedAt: String? = null,
  val updatedAt: String, val delegatedBy: String? = null, val hasSession: Boolean = false, val host: String? = null)
@Serializable data class QuestionOption(val label: String, val description: String? = null)
@Serializable data class NeedsYouQuestion(val id: String, val question: String, val options: List<QuestionOption> = emptyList())
@Serializable data class InFlight(val tasks: Int = 0, val queued: Int = 0, val kinds: List<String> = emptyList())
@Serializable data class TimelineRow(val at: String, val state: String, val detail: String)
@Serializable data class JobSlice(val state: String, val rawState: String = "", val detail: String = "", val tempo: String? = null,
  val needs: String? = null, val suggestedReply: String? = null, val questions: List<NeedsYouQuestion> = emptyList(),
  val inFlight: InFlight = InFlight(), val updatedAt: String? = null, val timeline: List<TimelineRow> = emptyList())
@Serializable data class ConversationDetail(val summary: ConversationSummary, val job: JobSlice? = null)
@Serializable data class MessageEntry(val id: String, val kind: String, val at: String, val text: String,
  val toolName: String? = null, val toolUseId: String? = null, val truncated: Boolean = false, val source: String? = null, val sidechain: Boolean = false)
@Serializable data class MessagesPage(val entries: List<MessageEntry>, val hasMore: Boolean, val cursor: Long, val end: Long)
@Serializable data class FeedItem(val seq: Long, val kind: String, val conversationId: String, val title: String, val peerName: String, val at: String,
  val spoken: String? = null, val needs: String? = null, val messageId: String? = null,
  val questions: List<NeedsYouQuestion> = emptyList(), val suggestedReply: String? = null)   // kind: "outcome" | "needs-you"
@Serializable data class Outage(val from: String, val to: String, val clean: Boolean)
@Serializable data class ServerHealth(val ok: Boolean = true, val hostname: String, val appVersion: String, val cliVersion: String = "", val uptimeSec: Long = 0,
  val now: String, val devMode: Boolean = false, val paused: Boolean = false, val load1: Double? = null, val lastOutage: Outage? = null)
@Serializable data class DeviceInfo(val id: String, val name: String, val scopes: List<String>, val createdAt: String, val lastSeenAt: String)
@Serializable data class MeResponse(val device: DeviceInfo, val server: ServerHealth, val voicePeerId: String? = null)
@Serializable data class PairRequest(val code: String, val deviceName: String)
@Serializable data class PairResponse(val token: String, val deviceId: String, val scopes: List<String>, val sttProvider: String? = null, val sttKey: String? = null, val serverName: String)
@Serializable data class ReplyRequest(val text: String, val source: String, val clientId: String)
@Serializable data class AnswerRequest(val questionId: String? = null, val text: String, val source: String? = null, val clientId: String)
@Serializable data class ReplyResponse(val ok: Boolean, val via: String? = null, val error: String? = null, val duplicate: Boolean = false)
@Serializable data class SpawnConversationRequest(val peerId: String, val prompt: String, val kind: String, val model: String? = null, val contract: String? = null,
  val clientId: String, val spokenAt: String? = null, val source: String? = null)
@Serializable data class SpawnConversationResponse(val conversationId: String, val duplicate: Boolean = false)
@Serializable data class VocabularyResponse(val words: List<String>, val updatedAt: String)
@Serializable data class MobileNotification(val id: String, val level: String, val title: String, val body: String? = null, val createdAt: String, val conversationId: String? = null, val peerName: String? = null)
@Serializable data class ApiErrorBody(val error: String, val code: String)
@Serializable data class PeersResponse(val peers: List<PeerSummary>)
@Serializable data class SummariesResponse(val summaries: List<ConversationSummary>)
@Serializable data class FeedResponse(val items: List<FeedItem>)
@Serializable data class NotificationsResponse(val notifications: List<MobileNotification>)
@Serializable data class OkResponse(val ok: Boolean = true)
@Serializable data class PingResponse(val ok: Boolean = true, val name: String = "", val v: Int = 1)
