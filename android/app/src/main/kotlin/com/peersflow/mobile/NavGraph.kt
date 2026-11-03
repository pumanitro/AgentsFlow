package com.peersflow.mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.peersflow.mobile.glue.isAssistantRoleHeld
import com.peersflow.mobile.glue.requestAssistantRole
import com.peersflow.mobile.services.Notifier
import com.peersflow.mobile.services.ConnectionServiceControl
import com.peersflow.mobile.services.HiLisaActivity
import com.peersflow.mobile.ui.aux.OutcomesScreen
import com.peersflow.mobile.ui.aux.OutcomesViewModel
import com.peersflow.mobile.ui.aux.PairingScreen
import com.peersflow.mobile.ui.aux.PairingViewModel
import com.peersflow.mobile.ui.aux.SettingsScreen
import com.peersflow.mobile.ui.aux.SettingsViewModel
import com.peersflow.mobile.ui.main.ChatScreen
import com.peersflow.mobile.ui.main.ChatViewModel
import com.peersflow.mobile.ui.main.HomeScreen
import com.peersflow.mobile.ui.main.HomeViewModel

private fun granted(ctx: Context, permission: String) =
    ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED

/** Asked at most once per process each, so a "no" is not nagged on every chat open. */
private object PermissionAsks {
    var mic = false
    var notifications = false
}

private fun NavHostController.toPairing() = navigate("pairing") {
    popUpTo(graph.id) { inclusive = true }
    launchSingleTop = true
}

@Composable
fun NavGraph(
    startDestination: String,
    deepLink: Pair<String?, String?>,
    initialRoute: String? = null,
    conversationId: String? = null,
    requestNonce: Int = 0,
) {
    val nav = rememberNavController()
    val ctx = LocalContext.current
    var pairUrl by remember { mutableStateOf(deepLink.first) }
    var pairCode by remember { mutableStateOf(deepLink.second) }

    val notificationLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val micLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }

    // Launch-intent navigation: pairing deep link (even when paired), notification "open chat", or a named route.
    LaunchedEffect(requestNonce) {
        val (url, code) = deepLink
        when {
            url != null || code != null -> {
                pairUrl = url
                pairCode = code
                if (nav.currentDestination?.route != "pairing") nav.navigate("pairing") { launchSingleTop = true }
            }
            !AppGraph.isPaired -> Unit
            conversationId != null -> nav.navigate("chat/$conversationId") {
                popUpTo("home") // home stays underneath, so Back lands there
                launchSingleTop = true
            }
            initialRoute == "home" -> nav.popBackStack("home", inclusive = false)
            initialRoute != null -> nav.navigate(initialRoute) {
                popUpTo("home")
                launchSingleTop = true
            }
        }
    }

    // Session cleared (unpaired here, or revoked and then unpaired): back to pairing.
    LaunchedEffect(Unit) {
        AppGraph.session.session.collect { s ->
            if (s == null && nav.currentDestination?.route.let { it != null && it != "pairing" }) nav.toPairing()
        }
    }

    NavHost(navController = nav, startDestination = startDestination) {
        composable("pairing") {
            PairingScreen(
                vm = viewModel { PairingViewModel(AppGraph.api, AppGraph.session) },
                initialUrl = pairUrl,
                initialCode = pairCode,
                onPaired = {
                    pairUrl = null
                    pairCode = null
                    nav.navigate("home") {
                        popUpTo(nav.graph.id) { inclusive = true }
                        launchSingleTop = true
                    }
                    ConnectionServiceControl.start(ctx)
                    AppGraph.onForeground("paired")
                    AppGraph.onPaired()
                    if (Notifier.NOTIFICATIONS_ENABLED && !PermissionAsks.notifications && !granted(ctx, Manifest.permission.POST_NOTIFICATIONS)) {
                        PermissionAsks.notifications = true
                        notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                },
            )
        }
        composable("home") {
            HomeScreen(
                vm = viewModel {
                    HomeViewModel(AppGraph.repo, AppGraph.status, AppGraph.outbox, AppGraph.outcomes, lastFlush = AppGraph.lastFlush)
                },
                onOpenChat = { nav.navigate("chat/$it") },
                onHiLisa = { ctx.startActivity(HiLisaActivity.intent(ctx, "home")) },
                onOutcomes = { nav.navigate("outcomes") },
                onSettings = { nav.navigate("settings") },
            )
        }
        composable("chat/{id}") { entry ->
            val id = entry.arguments?.getString("id").orEmpty()
            // Mic permission is asked when a chat opens (the hold-to-talk button lives inside :ui-main).
            LaunchedEffect(Unit) {
                if (!PermissionAsks.mic && !granted(ctx, Manifest.permission.RECORD_AUDIO)) {
                    PermissionAsks.mic = true
                    micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
            ChatScreen(
                vm = viewModel(key = "chat:$id") {
                    ChatViewModel(
                        id, AppGraph.repo, AppGraph.status, AppGraph.voice, AppGraph.gate, AppGraph.audio,
                        hasMicPermission = { granted(ctx.applicationContext, Manifest.permission.RECORD_AUDIO) },
                    )
                },
                onBack = { nav.popBackStack() },
            )
        }
        composable("outcomes") {
            OutcomesScreen(
                vm = viewModel { OutcomesViewModel(AppGraph.outcomes, AppGraph.voice, AppGraph.repo) },
                onOpenChat = { nav.navigate("chat/$it") },
                onBack = { nav.popBackStack() },
            )
        }
        composable("settings") {
            SettingsScreen(
                vm = viewModel {
                    SettingsViewModel(
                        AppGraph.session, AppGraph.repo, AppGraph.status, AppGraph.voice,
                        roleRequester = ::requestAssistantRole,
                        roleHeld = ::isAssistantRoleHeld,
                    )
                },
                onBack = { nav.popBackStack() },
                onUnpaired = {
                    ConnectionServiceControl.stop(ctx)
                    nav.toPairing()
                },
            )
        }
    }
}
