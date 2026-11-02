// Events.kt — decoded by the JSON "type" field; unknown types → ServerEvent.Unknown
package com.peersflow.mobile.wire
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import kotlinx.serialization.json.contentOrNull
sealed interface ServerEvent {
  data class Welcome(val seq: Long, val health: ServerHealth, val serverTime: String) : ServerEvent
  data class ConversationsUpdated(val summaries: List<ConversationSummary>) : ServerEvent
  data class ConversationUpdated(val summary: ConversationSummary) : ServerEvent
  data class ConversationDetailEvent(val detail: ConversationDetail) : ServerEvent
  data class MessagesAppended(val conversationId: String, val entries: List<MessageEntry>, val end: Long) : ServerEvent
  data class Feed(val item: FeedItem) : ServerEvent
  data class NotificationAdded(val notification: MobileNotification) : ServerEvent
  data class Health(val health: ServerHealth) : ServerEvent
  data class Pong(val serverTime: String) : ServerEvent
  data class Error(val message: String) : ServerEvent
  data class Unknown(val type: String, val raw: JsonObject) : ServerEvent
}
object EventCodec {   // implemented in :wire by wave 0
  /** Decodes one WebSocket text frame. Throws on text that is not a JSON object or on a known type with a malformed body. */
  fun decode(text: String): ServerEvent {
    val obj = WireJson.parseToJsonElement(text).jsonObject
    val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: ""
    return when (type) {
      "welcome" -> ServerEvent.Welcome(
        seq = obj.req("seq").jsonPrimitive.long,
        health = WireJson.decodeFromJsonElement(ServerHealth.serializer(), obj.req("health")),
        serverTime = obj.req("serverTime").jsonPrimitive.content,
      )
      "conversations.updated" -> ServerEvent.ConversationsUpdated(
        WireJson.decodeFromJsonElement(SummariesResponse.serializer(), obj).summaries,
      )
      "conversation.updated" -> ServerEvent.ConversationUpdated(
        WireJson.decodeFromJsonElement(ConversationSummary.serializer(), obj.req("summary")),
      )
      "conversation.detail" -> ServerEvent.ConversationDetailEvent(
        WireJson.decodeFromJsonElement(ConversationDetail.serializer(), obj.req("detail")),
      )
      "messages.appended" -> ServerEvent.MessagesAppended(
        conversationId = obj.req("conversationId").jsonPrimitive.content,
        entries = (obj["entries"] as? JsonArray ?: JsonArray(emptyList())).map {
          WireJson.decodeFromJsonElement(MessageEntry.serializer(), it)
        },
        end = obj.req("end").jsonPrimitive.long,
      )
      "feed" -> ServerEvent.Feed(WireJson.decodeFromJsonElement(FeedItem.serializer(), obj.req("item")))
      "notification.added" -> ServerEvent.NotificationAdded(
        WireJson.decodeFromJsonElement(MobileNotification.serializer(), obj.req("notification")),
      )
      "server.health" -> ServerEvent.Health(WireJson.decodeFromJsonElement(ServerHealth.serializer(), obj.req("health")))
      "pong" -> ServerEvent.Pong(obj["serverTime"]?.jsonPrimitive?.contentOrNull ?: "")
      "error" -> ServerEvent.Error(obj["message"]?.jsonPrimitive?.contentOrNull ?: "")
      else -> ServerEvent.Unknown(type, obj)
    }
  }

  fun hello(lastSeq: Long, subscribe: Set<String>): String = buildJsonObject {
    put("type", "hello")
    put("lastSeq", lastSeq)
    put("subscribe", ids(subscribe))
  }.toString()

  fun subscribe(ids: Set<String>): String = buildJsonObject {
    put("type", "subscribe")
    put("ids", ids(ids))
  }.toString()

  fun unsubscribe(ids: Set<String>): String = buildJsonObject {
    put("type", "unsubscribe")
    put("ids", ids(ids))
  }.toString()

  fun ping(): String = buildJsonObject { put("type", "ping") }.toString()

  private fun ids(ids: Set<String>): JsonArray = JsonArray(ids.map { JsonPrimitive(it) })

  private fun JsonObject.req(key: String): JsonElement =
    this[key] ?: throw IllegalArgumentException("server event missing \"$key\"")
}
