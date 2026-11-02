package com.peersflow.mobile.ui.main

import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.ConversationDetail
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.JobSlice
import com.peersflow.mobile.wire.MessageEntry
import com.peersflow.mobile.wire.MessageKinds
import com.peersflow.mobile.wire.NeedsYouQuestion
import com.peersflow.mobile.wire.OutboxItem
import com.peersflow.mobile.wire.OutboxKind
import com.peersflow.mobile.wire.PeerSummary
import com.peersflow.mobile.wire.QuestionOption
import com.peersflow.mobile.wire.ServerHealth
import com.peersflow.mobile.wire.Sources

/** Sample data for @Preview only. */
internal object PreviewData {
    const val NOW = 1_761_650_000_000L

    val health = ServerHealth(hostname = "kebe-mbp", appVersion = "12.0.0", now = "2026-10-28T10:00:00Z", load1 = 3.42)
    val peers = listOf(PeerSummary("p1", "AgentsFlow", "~/Desktop/AgentsFlow"), PeerSummary("p2", "atlas", "~/code/atlas"))

    private fun s(id: String, peer: String, title: String, state: String, detail: String = "", needsYou: Boolean = false,
                  pinned: Boolean = true, kind: String = "chat", by: String? = null) = ConversationSummary(
        id = id, peerId = peer, peerName = peers.first { it.id == peer }.name, title = title, detail = detail, state = state,
        needsYou = needsYou, pinned = pinned, chatKind = kind, createdAt = "2026-10-28T09:00:00Z", updatedAt = "2026-10-28T09:30:00Z", delegatedBy = by,
    )

    val summaries = listOf(
        s("c1", "p1", "Android home screen", "working", "Writing HomeScreen.kt"),
        s("c2", "p2", "Tests for the council", "blocked", "Which database should I use?", needsYou = true),
        s("c3", "p1", "Morning summary", "done", "3 tasks finished", kind = "routine"),
        s("c4", "p1", "Fix the login bug", "working", "Delegated sub-task", by = "c1"),
        s("c5", "p2", "Voice note: buy milk", "idle", kind = "voice"),
        s("c6", "p2", "Old experiment", "done", pinned = false),
    )

    val outbox = listOf(
        OutboxItem("o1", OutboxKind.REPLY, "c2", null, "Use Postgres, and add a migration for the user table please", Sources.PHONE,
            createdAt = NOW - 5 * 60_000),
        OutboxItem("o2", OutboxKind.SPAWN, null, "p1", "Check why the nightly build failed", Sources.VOICE, createdAt = NOW - 2 * 3_600_000,
            attempts = 1, lastError = "chat is no longer running", needsDecision = true),
    )

    val homeState = HomeUiState(
        connection = ConnectionState.ONLINE,
        health = health,
        sections = HomeLogic.sections(peers, summaries, HomeFilter.ALL),
        outbox = outbox,
        unseenOutcomes = 3,
        peers = peers,
        counts = HomeLogic.counts(summaries),
        loaded = true,
        allSummaries = summaries,
    )

    val chatState = ChatUiState(
        detail = ConversationDetail(
            summaries[1],
            JobSlice(
                state = "blocked",
                detail = "Waiting for an answer",
                questions = listOf(NeedsYouQuestion("q1", "Which database should I use?", listOf(QuestionOption("Postgres"), QuestionOption("SQLite")))),
                suggestedReply = "Postgres, like production",
            ),
        ),
        messages = listOf(
            MessageEntry("m1", MessageKinds.USER, "2026-10-28T09:00:00Z", "Write tests for the council module", source = Sources.VOICE),
            MessageEntry("m2", MessageKinds.ASSISTANT, "2026-10-28T09:00:05Z", "Sure — first I will look at **the schema**."),
            MessageEntry("m3", MessageKinds.TOOL_USE, "2026-10-28T09:00:06Z", "ls src/council", toolName = "Bash", toolUseId = "t1"),
            MessageEntry("m4", MessageKinds.TOOL_RESULT, "2026-10-28T09:00:07Z", "index.ts\nvote.ts\nrules.ts", toolUseId = "t1", truncated = true),
            MessageEntry("m5", MessageKinds.SUBAGENT, "2026-10-28T09:00:08Z", "reading vote.ts"),
            MessageEntry("m6", MessageKinds.USER, "2026-10-28T09:01:00Z", "ok", source = Sources.PHONE),
        ),
        expandedTools = setOf("m3"),
        hasOlder = true,
    )

    val noActions = ComposerActions({}, {}, {}, {}, {}, {}, {}, {}, {}, {})
    val noChatActions = ChatActions(noActions, {}, {}, {}, {}, {}, {}, {})
}
