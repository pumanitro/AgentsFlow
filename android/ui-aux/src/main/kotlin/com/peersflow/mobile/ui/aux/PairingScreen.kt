package com.peersflow.mobile.ui.aux

import android.content.pm.ApplicationInfo
import android.content.Context
import android.content.ContextWrapper
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.peersflow.mobile.wire.Palette

private const val DEBUG_URL = "http://10.0.2.2:47822"

@Composable
fun PairingScreen(vm: PairingViewModel, initialUrl: String?, initialCode: String?, onPaired: () -> Unit) {
    val state by vm.state.collectAsState()
    val ctx = LocalContext.current
    val debuggable = 0 != (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE)
    val scanPrompt = stringResource(R.string.pair_scan_prompt)

    LaunchedEffect(initialUrl, initialCode) { vm.applyDeepLink(initialUrl, initialCode) }
    LaunchedEffect(debuggable) {
        if (debuggable && vm.state.value.url.isEmpty() && initialUrl.isNullOrBlank()) vm.setUrl(DEBUG_URL)
    }
    LaunchedEffect(state.paired) { if (state.paired) onPaired() }

    val scanner = rememberScanLauncher(ctx) { vm.applyScan(it) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            stringResource(R.string.pair_title),
            style = MaterialTheme.typography.headlineLarge,
            color = Color(Palette.ON_BG),
        )
        Text(
            stringResource(R.string.pair_explain),
            style = MaterialTheme.typography.bodyMedium,
            color = Color(Palette.MUTED),
        )
        Spacer(Modifier.height(4.dp))
        OutlinedTextField(
            value = state.url,
            onValueChange = vm::setUrl,
            label = { Text(stringResource(R.string.pair_url_label)) },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            modifier = Modifier.fillMaxWidth().testTag("pair_url"),
        )
        OutlinedTextField(
            value = state.code,
            onValueChange = vm::setCode,
            label = { Text(stringResource(R.string.pair_code_label)) },
            singleLine = true,
            textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 20.sp),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            modifier = Modifier.fillMaxWidth().testTag("pair_code"),
        )
        OutlinedTextField(
            value = state.name,
            onValueChange = vm::setName,
            label = { Text(stringResource(R.string.pair_name_label)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("pair_name"),
        )
        OutlinedButton(
            onClick = {
                scanner?.launch(
                    ScanOptions()
                        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setBeepEnabled(false)
                        .setOrientationLocked(false)
                        .setPrompt(scanPrompt),
                )
            },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("pair_scan"),
        ) { Text(stringResource(R.string.pair_scan)) }
        Button(
            onClick = vm::submit,
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("pair_submit"),
        ) { Text(stringResource(R.string.pair_submit)) }
        state.error?.let {
            Text(it, color = Color(Palette.ERR), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth())
        }
        state.warning?.let {
            Text(it, color = Color(Palette.WARN), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.fillMaxWidth())
        }
    }
}

private tailrec fun Context.findActivity(): ComponentActivity? = when (this) {
    is ComponentActivity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/**
 * Registers the zxing scan contract on the host activity's registry (the module has no activity-compose
 * dependency, so this does by hand what rememberLauncherForActivityResult does). Null when there is no activity.
 */
@Composable
private fun rememberScanLauncher(ctx: Context, onText: (String) -> Unit): ActivityResultLauncher<ScanOptions>? {
    val activity = remember(ctx) { ctx.findActivity() } ?: return null
    val key = remember { "pair_scan_" + java.util.UUID.randomUUID() }
    val latest = androidx.compose.runtime.rememberUpdatedState(onText)
    val launcher = remember(activity) {
        activity.activityResultRegistry.register(key, ScanContract()) { r -> r.contents?.let { latest.value(it) } }
    }
    DisposableEffect(launcher) { onDispose { launcher.unregister() } }
    return launcher
}
