package com.peersflow.mobile.ui.main

import com.peersflow.mobile.wire.ConvStates
import com.peersflow.mobile.wire.ConversationSummary
import com.peersflow.mobile.wire.PeerSummary

enum class HomeFilter { ALL, NEEDS, WORKING, DONE }

/** One list row: a conversation plus the delegated conversations nested under it. */
data class ConvRow(val summary: ConversationSummary, val children: List<ConversationSummary> = emptyList())

/** One block of the Home list: a peer header and its rows. */
data class PeerSection(val peer: PeerSummary, val rows: List<ConvRow>)

/** Pure Home list rules, kept apart from the view model so they test without coroutines. */
object HomeLogic {
    /** Section used for conversations whose peer is not in `peers()`. */
    val OTHER_PEER = PeerSummary(id = "", name = "Other", path = "")

    fun matches(c: ConversationSummary, filter: HomeFilter): Boolean = when (filter) {
        HomeFilter.ALL -> true
        HomeFilter.NEEDS -> c.needsYou
        HomeFilter.WORKING -> c.state == ConvStates.WORKING || c.state == ConvStates.STARTING
        HomeFilter.DONE -> c.state == ConvStates.DONE || c.state == ConvStates.FAILED || !c.pinned
    }

    fun counts(all: List<ConversationSummary>): Map<HomeFilter, Int> =
        HomeFilter.entries.associateWith { f -> all.count { matches(it, f) } }

    /**
     * Groups the visible conversations by peer in `peers` order, nesting each delegated conversation under the
     * top-most ancestor that is also visible. Unknown peers land in a trailing "Other" section; empty sections drop.
     */
    fun sections(peers: List<PeerSummary>, summaries: List<ConversationSummary>, filter: HomeFilter): List<PeerSection> {
        val visible = summaries.filter { matches(it, filter) }
        val byId = visible.associateBy { it.id }

        fun rootOf(c: ConversationSummary): ConversationSummary {
            var cur = c
            val seen = mutableSetOf(c.id)
            while (true) {
                val parent = cur.delegatedBy?.let { byId[it] } ?: return cur
                if (!seen.add(parent.id)) return cur // cycle guard
                cur = parent
            }
        }

        val children = linkedMapOf<String, MutableList<ConversationSummary>>()
        val roots = mutableListOf<ConversationSummary>()
        for (c in visible) {
            val root = rootOf(c)
            if (root.id == c.id) roots += c else children.getOrPut(root.id) { mutableListOf() } += c
        }
        val rows = roots.map { ConvRow(it, children[it.id].orEmpty()) }

        val peerIds = peers.map { it.id }.toSet()
        val out = peers.mapNotNull { p ->
            val r = rows.filter { it.summary.peerId == p.id }
            if (r.isEmpty()) null else PeerSection(p, r)
        }
        val other = rows.filter { it.summary.peerId !in peerIds }
        return if (other.isEmpty()) out else out + PeerSection(OTHER_PEER, other)
    }

    fun flushBanner(sent: Int): String = if (sent == 1) "Mac is back · 1 task started" else "Mac is back · $sent tasks started"
}
