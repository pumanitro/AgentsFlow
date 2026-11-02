package com.peersflow.mobile

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.fragment.app.FragmentActivity
import com.peersflow.mobile.services.Notifier

/** One navigation request parsed from a launch intent; [nonce] makes a repeat of the same intent fire again. */
data class LaunchRequest(
    val deepLink: Pair<String?, String?> = null to null,
    val route: String? = null,
    val conversationId: String? = null,
    val nonce: Int = 0,
)

class MainActivity : FragmentActivity() {
    private val request = mutableStateOf(LaunchRequest())
    private var nonce = 0

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A recreated activity (rotation) must not replay the launch intent's navigation.
        if (savedInstanceState == null) request.value = parse(intent)
        setContent {
            PeersFlowTheme {
                Box(Modifier.semantics { testTagsAsResourceId = true }) {
                    val r = request.value
                    NavGraph(
                        startDestination = if (AppGraph.isPaired) "home" else "pairing",
                        deepLink = r.deepLink,
                        initialRoute = r.route,
                        conversationId = r.conversationId,
                        requestNonce = r.nonce,
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        request.value = parse(intent)
    }

    private fun parse(intent: Intent?): LaunchRequest = LaunchRequest(
        deepLink = parsePairDeepLink(intent),
        route = intent?.getStringExtra(EXTRA_ROUTE)?.takeIf { it in ROUTES },
        conversationId = intent?.getStringExtra(Notifier.EXTRA_CONVERSATION_ID)?.takeIf { it.isNotBlank() },
        nonce = ++nonce,
    )

    companion object {
        const val EXTRA_ROUTE = "route"
        private val ROUTES = setOf("outcomes", "settings", "home")
    }
}
