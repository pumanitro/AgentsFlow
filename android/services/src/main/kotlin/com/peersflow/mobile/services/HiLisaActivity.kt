package com.peersflow.mobile.services

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.peersflow.mobile.wire.Palette

/** The Hi LISA voice overlay, opened by the assistant gesture, the Quick Settings tile or a headset long press. */
class HiLisaActivity : ComponentActivity() {

    companion object {
        const val EXTRA_SOURCE = "source"

        /** Skip the microphone and open the typed-input mode with this text (E2E harness: the emulator has no mic). */
        const val EXTRA_TYPED = "typed"

        fun intent(ctx: Context, source: String): Intent =
            Intent(ctx, HiLisaActivity::class.java).putExtra(EXTRA_SOURCE, source)
    }

    private val vm: HiLisaViewModel by viewModels {
        viewModelFactory {
            initializer {
                val d = ServicesHost.deps
                HiLisaViewModel(d.repo, d.session, d.voice, d.status, d.audio)
            }
        }
    }

    private var shown = false
    private var askingPermission = false

    private val micPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        askingPermission = false
        vm.start(sourceOf(intent), micAllowed = granted)
    }

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!ServicesHost.isReady) {
            finish()
            return
        }
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableEdgeToEdge()
        // A recreated activity (rotation) keeps its ViewModel and its current phase; do not restart listening.
        shown = savedInstanceState != null
        setContent {
            MaterialTheme(colorScheme = lisaColors()) {
                Box(Modifier.semantics { testTagsAsResourceId = true }) {
                    HiLisaOverlay(vm, onClose = { finish() })
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        if (!ServicesHost.isReady) return
        if (!shown) {
            shown = true
            begin(intent)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!ServicesHost.isReady) return
        shown = true
        begin(intent)
    }

    override fun onStop() {
        super.onStop()
        if (ServicesHost.isReady && !isChangingConfigurations && !askingPermission) vm.onHidden()
    }

    private fun begin(i: Intent) {
        val source = sourceOf(i)
        val typed = i.getStringExtra(EXTRA_TYPED)
        when {
            typed != null -> vm.start(source, typed = typed)
            ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED ->
                vm.start(source)
            else -> {
                askingPermission = true
                micPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }

    private fun sourceOf(i: Intent?): String = i?.getStringExtra(EXTRA_SOURCE) ?: "assist"
}

internal fun lisaColors() = darkColorScheme(
    primary = Color(Palette.PRIMARY),
    onPrimary = Color(Palette.BG),
    secondary = Color(Palette.SECONDARY),
    onSecondary = Color(Palette.BG),
    background = Color(Palette.BG),
    onBackground = Color(Palette.ON_BG),
    surface = Color(Palette.SURFACE),
    onSurface = Color(Palette.ON_BG),
    surfaceVariant = Color(Palette.SURFACE_VARIANT),
    onSurfaceVariant = Color(Palette.MUTED),
    outline = Color(Palette.OUTLINE),
    error = Color(Palette.ERR),
    onError = Color(Palette.ON_BG),
)
