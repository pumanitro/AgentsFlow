@file:OptIn(ExperimentalMaterial3Api::class)

package com.peersflow.mobile.ui.aux

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import com.peersflow.mobile.wire.Palette
import java.net.URI
import java.util.Locale

@Composable
fun SettingsScreen(vm: SettingsViewModel, onBack: () -> Unit, onUnpaired: () -> Unit) {
    val state by vm.state.collectAsState()
    val ctx = LocalContext.current
    val owner = LocalLifecycleOwner.current

    LaunchedEffect(Unit) { vm.unpaired.collect { onUnpaired() } }
    DisposableEffect(owner) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_RESUME) vm.refreshRole(ctx) }
        owner.lifecycle.addObserver(obs)
        onDispose { owner.lifecycle.removeObserver(obs) }
    }

    Scaffold(
        containerColor = Color(Palette.BG),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color(Palette.BG),
                    titleContentColor = Color(Palette.ON_BG),
                    navigationIconContentColor = Color(Palette.ON_BG),
                ),
            )
        },
    ) { pad ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(pad)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            ServerSection(state, vm)
            VoiceSection(state, vm)
            ConnectionSection(state, vm)
            AssistantSection(state, vm, ctx)
            SamsungChecklist(ctx)
            AboutSection(state, ctx)
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .background(Color(Palette.SURFACE), RoundedCornerShape(12.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(title.uppercase(Locale.ROOT), fontSize = 11.sp, color = Color(Palette.SUBTLE), letterSpacing = 1.sp)
        content()
    }
}

@Composable
private fun KeyValue(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, color = Color(Palette.MUTED), fontSize = 14.sp)
        Text(value, color = Color(Palette.ON_BG), fontSize = 14.sp)
    }
}

@Composable
private fun SwitchRow(label: String, helper: String?, checked: Boolean, modifier: Modifier, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, color = Color(Palette.ON_BG), fontSize = 15.sp)
            if (helper != null) Text(helper, color = Color(Palette.MUTED), fontSize = 12.sp)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            modifier = modifier,
        )
    }
}

@Composable
private fun ServerSection(state: SettingsUiState, vm: SettingsViewModel) {
    var confirming by remember { mutableStateOf(false) }
    SectionCard(stringResource(R.string.section_server)) {
        val s = state.session
        if (s == null) {
            Text(stringResource(R.string.not_paired), color = Color(Palette.MUTED))
        } else {
            KeyValue(stringResource(R.string.server_name), s.serverName)
            KeyValue(stringResource(R.string.server_address), hostOf(s.baseUrl))
            KeyValue(stringResource(R.string.server_device), s.deviceId.take(8))
            KeyValue(stringResource(R.string.server_connection), state.connection.name.lowercase(Locale.ROOT).replace('_', ' '))
            if (!confirming) {
                OutlinedButton(
                    onClick = { confirming = true },
                    border = BorderStroke(1.dp, Color(Palette.ERR)),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = Color(Palette.ERR)),
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("settings_unpair"),
                ) { Text(stringResource(R.string.unpair)) }
            } else {
                Text(stringResource(R.string.unpair_confirm), color = Color(Palette.ON_BG))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { confirming = false; vm.unpair() },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(Palette.ERR), contentColor = Color.White),
                        modifier = Modifier.heightIn(min = 48.dp),
                    ) { Text(stringResource(R.string.unpair_yes)) }
                    TextButton(onClick = { confirming = false }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.cancel))
                    }
                }
            }
        }
    }
}

private fun hostOf(url: String): String = try { URI(url).host ?: url } catch (_: Exception) { url }

@Composable
private fun VoiceSection(state: SettingsUiState, vm: SettingsViewModel) {
    val prefs = state.prefs
    SectionCard(stringResource(R.string.section_voice)) {
        PeerDropdown(state, vm)
        SwitchRow(stringResource(R.string.live_stt), null, prefs.liveStt, Modifier.testTag("settings_live_stt"), vm::setLiveStt)
        SwitchRow(stringResource(R.string.speak_always), null, prefs.speakAlways, Modifier.testTag("settings_speak_always"), vm::setSpeakAlways)
        QuietHoursRow(prefs.quietFrom, prefs.quietTo, vm::setQuietHours)
        var voiceName by remember(prefs.ttsVoice) { mutableStateOf(prefs.ttsVoice) }
        OutlinedTextField(
            value = voiceName,
            onValueChange = { voiceName = it; vm.setTtsVoice(it) },
            label = { Text(stringResource(R.string.tts_voice_label)) },
            supportingText = { Text(stringResource(R.string.tts_voice_helper)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(stringResource(R.string.ai_disclosure), color = Color(Palette.MUTED), fontSize = 12.sp)
    }
}

@Composable
private fun PeerDropdown(state: SettingsUiState, vm: SettingsViewModel) {
    var open by remember { mutableStateOf(false) }
    val chosen = state.effectiveVoicePeer
    val isDefault = state.prefs.voicePeerId == null
    val text = when {
        chosen == null -> stringResource(R.string.voice_peer_none)
        isDefault -> "${chosen.name} ${stringResource(R.string.voice_peer_default)}"
        else -> chosen.name
    }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = text,
            onValueChange = {},
            readOnly = true,
            label = { Text(stringResource(R.string.voice_peer_label)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor().testTag("settings_voice_peer"),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            state.peers.forEach { p ->
                DropdownMenuItem(
                    text = { Text(p.name) },
                    onClick = { vm.setVoicePeer(p.id); open = false },
                    modifier = Modifier.heightIn(min = 48.dp),
                )
            }
        }
    }
}

private fun fmtMinutes(m: Int): String = String.format(Locale.ROOT, "%02d:%02d", m / 60, m % 60)

@Composable
private fun QuietHoursRow(from: Int?, to: Int?, onSet: (Int?, Int?) -> Unit) {
    var step by remember { mutableStateOf(0) }   // 0 closed, 1 picking "from", 2 picking "to"
    var pendingFrom by remember { mutableStateOf(from ?: 22 * 60) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.quiet_hours), color = Color(Palette.ON_BG), fontSize = 15.sp)
            Text(
                if (from == null || to == null) stringResource(R.string.quiet_off) else "${fmtMinutes(from)} – ${fmtMinutes(to)}",
                color = Color(Palette.MUTED), fontSize = 13.sp,
            )
        }
        TextButton(onClick = { step = 1 }, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.quiet_set)) }
        if (from != null) {
            TextButton(onClick = { onSet(null, null) }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(stringResource(R.string.quiet_clear))
            }
        }
    }
    if (step != 0) {
        val initial = if (step == 1) (from ?: 22 * 60) else (to ?: 7 * 60)
        val picker = rememberTimePickerState(initial / 60, initial % 60, true)
        AlertDialog(
            onDismissRequest = { step = 0 },
            title = { Text(stringResource(if (step == 1) R.string.quiet_from else R.string.quiet_to)) },
            text = { TimePicker(state = picker) },
            confirmButton = {
                TextButton(onClick = {
                    val minutes = picker.hour * 60 + picker.minute
                    if (step == 1) { pendingFrom = minutes; step = 2 } else { onSet(pendingFrom, minutes); step = 0 }
                }) { Text(stringResource(R.string.ok)) }
            },
            dismissButton = { TextButton(onClick = { step = 0 }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun ConnectionSection(state: SettingsUiState, vm: SettingsViewModel) {
    SectionCard(stringResource(R.string.section_connection)) {
        SwitchRow(
            stringResource(R.string.stay_connected), stringResource(R.string.stay_connected_helper),
            state.prefs.stayConnected, Modifier.testTag("settings_stay_connected"), vm::setStayConnected,
        )
        SwitchRow(
            stringResource(R.string.biometric), stringResource(R.string.biometric_helper),
            state.prefs.biometric, Modifier.testTag("settings_biometric"), vm::setBiometric,
        )
    }
}

@Composable
private fun AssistantSection(state: SettingsUiState, vm: SettingsViewModel, ctx: Context) {
    SectionCard(stringResource(R.string.section_assistant)) {
        Button(
            onClick = { vm.requestAssistantRole(ctx) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("settings_assistant_role"),
        ) { Text(stringResource(R.string.assistant_button)) }
        Text(
            stringResource(if (state.assistantHeld) R.string.assistant_held else R.string.assistant_not_held),
            color = Color(if (state.assistantHeld) Palette.OK else Palette.WARN),
            fontSize = 13.sp,
        )
    }
}

/** Opens the nearest Settings screen; every step is wrapped so a missing activity never crashes. */
private fun launchSettings(ctx: Context, vararg intents: Intent) {
    for (i in intents) {
        try {
            ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        } catch (_: Exception) {
            // try the next one
        }
    }
}

private fun appDetails(ctx: Context): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null))

@Composable
fun SamsungChecklist(ctx: Context = LocalContext.current) {
    SectionCard(stringResource(R.string.section_samsung)) {
        ChecklistRow(stringResource(R.string.sam_sleep_title), stringResource(R.string.sam_sleep_why)) {
            launchSettings(
                ctx,
                Intent("com.samsung.android.sm.ACTION_BATTERY"),
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                appDetails(ctx),
            )
        }
        ChecklistRow(stringResource(R.string.sam_battery_title), stringResource(R.string.sam_battery_why)) {
            launchSettings(ctx, appDetails(ctx))
        }
        ChecklistRow(stringResource(R.string.sam_assistant_title), stringResource(R.string.sam_assistant_why)) {
            launchSettings(ctx, Intent(Settings.ACTION_VOICE_INPUT_SETTINGS), appDetails(ctx))
        }
        ChecklistRow(stringResource(R.string.sam_side_title), stringResource(R.string.sam_side_why)) {
            launchSettings(ctx, Intent(Settings.ACTION_SETTINGS), appDetails(ctx))
        }
    }
}

@Composable
private fun ChecklistRow(title: String, why: String, onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Color(Palette.ON_BG), fontSize = 15.sp)
            Text(why, color = Color(Palette.MUTED), fontSize = 12.sp)
        }
        OutlinedButton(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp)) { Text(stringResource(R.string.open)) }
    }
}

@Composable
private fun AboutSection(state: SettingsUiState, ctx: Context) {
    val version = remember {
        try { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?" } catch (_: Exception) { "?" }
    }
    SectionCard(stringResource(R.string.section_about)) {
        KeyValue(stringResource(R.string.about_version), version)
        val h = state.health
        if (h != null) {
            val cli = if (h.cliVersion.isNotEmpty()) " · Claude ${h.cliVersion}" else ""
            KeyValue(stringResource(R.string.about_mac), "${h.appVersion}$cli")
        }
    }
}
