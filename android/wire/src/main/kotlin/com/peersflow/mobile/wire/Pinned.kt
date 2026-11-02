package com.peersflow.mobile.wire

import kotlinx.serialization.Serializable

// GET /api/v1/pinned — the desktop "PINNED CONVERSATIONS" list in its exact order, plus History.
@Serializable data class PinnedTodoItem(val id: String, val text: String, val done: Boolean = false)

/** kind: "divider" (id, title) | "conversation" (summary, todos, children) | "todo" (id, text, done, peerName). */
@Serializable data class PinnedListItem(
  val kind: String,
  val id: String? = null,
  val title: String? = null,
  val summary: ConversationSummary? = null,
  val todos: List<PinnedTodoItem> = emptyList(),
  val children: List<ConversationSummary> = emptyList(),
  val text: String? = null,
  val done: Boolean = false,
  val peerName: String? = null,
)

@Serializable data class VoiceKeyResponse(val sttKey: String? = null)

@Serializable data class PinnedListResponse(val items: List<PinnedListItem> = emptyList(), val history: List<ConversationSummary> = emptyList())
