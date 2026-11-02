package com.peersflow.mobile.wire

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EventCodecTest {
    private val health = """{"ok":true,"hostname":"mac","appVersion":"12.0.0","cliVersion":"2.1.0","uptimeSec":5,"now":"2026-10-28T10:00:00Z","devMode":true,"paused":false,"load1":1.5,"lastOutage":null}"""
    private val summary = """{"id":"c1","peerId":"p1","peerName":"AgentsFlow","title":"Fix it","detail":"working","state":"working","rawState":"running","needsYou":false,"pinned":true,"provider":"claude","chatKind":"chat","createdAt":"2026-10-28T09:00:00Z","updatedAt":"2026-10-28T10:00:00Z","hasSession":true}"""
    private val question = """{"id":"q1","question":"Which?","options":[{"label":"A","description":"first"},{"label":"B"}]}"""
    private val entry = """{"id":"u1:0","kind":"assistant.text","at":"2026-10-28T10:00:00Z","text":"hello","source":"phone"}"""

    @Test
    fun everyC1ServerEventDecodesToItsClass() {
        val samples = mapOf(
            """{"type":"welcome","seq":7,"health":$health,"serverTime":"2026-10-28T10:00:00Z"}""" to ServerEvent.Welcome::class,
            """{"type":"conversations.updated","summaries":[$summary]}""" to ServerEvent.ConversationsUpdated::class,
            """{"type":"conversation.updated","summary":$summary}""" to ServerEvent.ConversationUpdated::class,
            """{"type":"conversation.detail","detail":{"summary":$summary,"job":{"state":"blocked","rawState":"waiting","detail":"q","questions":[$question],"inFlight":{"tasks":1,"queued":0,"kinds":["Bash"]},"timeline":[{"at":"x","state":"working","detail":"d"}]}}}""" to ServerEvent.ConversationDetailEvent::class,
            """{"type":"messages.appended","conversationId":"c1","entries":[$entry],"end":1234}""" to ServerEvent.MessagesAppended::class,
            """{"type":"feed","item":{"seq":3,"kind":"outcome","conversationId":"c1","title":"Fix it","peerName":"AgentsFlow","at":"x","spoken":"Done.","messageId":"u1:0"}}""" to ServerEvent.Feed::class,
            """{"type":"feed","item":{"seq":4,"kind":"needs-you","conversationId":"c1","title":"Fix it","peerName":"AgentsFlow","at":"x","questions":[$question],"suggestedReply":"A"}}""" to ServerEvent.Feed::class,
            """{"type":"notification.added","notification":{"id":"n1","level":"warn","title":"Low disk","createdAt":"x"}}""" to ServerEvent.NotificationAdded::class,
            """{"type":"server.health","health":$health}""" to ServerEvent.Health::class,
            """{"type":"pong","serverTime":"2026-10-28T10:00:00Z"}""" to ServerEvent.Pong::class,
            """{"type":"error","message":"bad hello"}""" to ServerEvent.Error::class,
        )
        for ((json, cls) in samples) {
            val ev = EventCodec.decode(json)
            assertTrue("$json decoded to $ev", cls.isInstance(ev))
        }
        val welcome = EventCodec.decode(samples.keys.first()) as ServerEvent.Welcome
        assertEquals(7L, welcome.seq)
        assertEquals("mac", welcome.health.hostname)
        val appended = EventCodec.decode("""{"type":"messages.appended","conversationId":"c1","entries":[$entry],"end":1234}""") as ServerEvent.MessagesAppended
        assertEquals("hello", appended.entries.single().text)
        assertEquals(1234L, appended.end)
    }

    @Test
    fun helloEncodesExactlyTheC1Shape() {
        assertEquals("""{"type":"hello","lastSeq":5,"subscribe":["a"]}""", EventCodec.hello(5, setOf("a")))
        assertEquals("""{"type":"subscribe","ids":["a","b"]}""", EventCodec.subscribe(linkedSetOf("a", "b")))
        assertEquals("""{"type":"unsubscribe","ids":["a"]}""", EventCodec.unsubscribe(setOf("a")))
        assertEquals("""{"type":"ping"}""", EventCodec.ping())
    }

    @Test
    fun unknownTypeDecodesToUnknown() {
        val ev = EventCodec.decode("""{"type":"future.thing","x":1}""")
        assertTrue(ev is ServerEvent.Unknown)
        assertEquals("future.thing", (ev as ServerEvent.Unknown).type)
        assertEquals("1", ev.raw["x"].toString())
    }
}
