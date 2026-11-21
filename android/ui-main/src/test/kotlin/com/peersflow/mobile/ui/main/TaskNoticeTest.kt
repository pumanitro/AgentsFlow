package com.peersflow.mobile.ui.main

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskNoticeTest {
    @Test fun collapsesTaskNotification() {
        val raw = "<task-notification>\n<task-id>a6</task-id>\n<status>completed</status>\n<summary>Agent \"Verify Nov 19 items\" finished</summary>\n<result>```json\n[]```</result>\n</task-notification>"
        assertEquals("Agent \"Verify Nov 19 items\" finished · completed", taskNoticeText(raw))
        assertNull(taskNoticeText("hello"))
    }
}
