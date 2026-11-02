package com.peersflow.mobile.services

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.peersflow.mobile.wire.ConnectionState
import com.peersflow.mobile.wire.Palette
import com.peersflow.mobile.wire.SendResult

private val Bg = Color(Palette.BG)
private val SurfaceC = Color(Palette.SURFACE)
private val SurfaceVar = Color(Palette.SURFACE_VARIANT)
private val Outline = Color(Palette.OUTLINE)
private val OnBg = Color(Palette.ON_BG)
private val Muted = Color(Palette.MUTED)
private val Primary = Color(Palette.PRIMARY)
private val Info = Color(Palette.INFO)
private val Ok = Color(Palette.OK)
private val Warn = Color(Palette.WARN)
private val Err = Color(Palette.ERR)

@Composable
fun HiLisaOverlay(vm: HiLisaViewModel, onClose: () -> Unit) {
    val st by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(st.closeRequested) { if (st.closeRequested) onClose() }

    Box(
        Modifier
            .fillMaxSize()
            .background(Bg.copy(alpha = 0.85f))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                if (st.phase is Phase.Error || st.phase is Phase.Done) onClose()
            },
        contentAlignment = Alignment.BottomCenter,
    ) {
        Surface(
            color = SurfaceC,
            shape = RoundedCornerShape(24.dp),
            border = BorderStroke(1.dp, Outline),
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp)
                .navigationBarsPadding()
                .imePadding()
                // swallow taps so they do not reach the dim background
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
        ) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Header(st.source)
                when (val p = st.phase) {
                    is Phase.Listening -> ListeningBody(p.partial, onTap = vm::tapToStop)
                    is Phase.Confirm -> ConfirmBody(p, st.canContinue, vm)
                    is Phase.Typing -> TypingBody(p.text, st.notice, vm)
                    Phase.Sending -> SendingBody()
                    is Phase.Done -> DoneBody(p, vm, onClose)
                    is Phase.Error -> ErrorBody(p.msg, onClose)
                }
                ConnectionLine(st.connection)
            }
        }
    }
}

@Composable
private fun Header(source: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Hi LISA", color = OnBg, fontSize = 22.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
        Text(
            sourceLabel(source),
            color = OnBg,
            fontSize = 13.sp,
            modifier = Modifier
                .border(1.dp, Outline, RoundedCornerShape(50))
                .background(SurfaceVar, RoundedCornerShape(50))
                .padding(horizontal = 10.dp, vertical = 4.dp),
        )
    }
}

private fun sourceLabel(source: String): String = when (source) {
    "tile" -> "Quick tile"
    "side-button" -> "Side button"
    "headset" -> "Headset"
    "assist" -> "Assistant"
    else -> source
}

@Composable
private fun SpokenText(text: String, placeholder: String = "") {
    Text(
        text.ifEmpty { placeholder },
        color = if (text.isEmpty()) Muted else OnBg,
        fontSize = 20.sp,
        minLines = 3,
        modifier = Modifier.fillMaxWidth().testTag("hilisa_partial"),
    )
}

@Composable
private fun ListeningBody(partial: String, onTap: () -> Unit) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        PulsingMic(onTap)
        SpokenText(partial, "Listening…")
        Text("tap to finish", color = Muted, fontSize = 14.sp)
    }
}

@Composable
private fun PulsingMic(onTap: () -> Unit) {
    val t = rememberInfiniteTransition(label = "mic")
    val pulse by t.animateFloat(0.85f, 1.15f, infiniteRepeatable(tween(700), RepeatMode.Reverse), label = "pulse")
    Box(
        Modifier
            .size(96.dp)
            .semantics { contentDescription = "Microphone — tap to finish" }
            .clickable(onClick = onTap),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(96.dp)) {
            val r = size.minDimension / 2
            drawCircle(Info.copy(alpha = 0.25f), radius = r * pulse.coerceAtMost(1f))
            drawCircle(Info, radius = r * 0.62f)
            // the microphone glyph
            val w = r * 0.30f
            val h = r * 0.55f
            val cx = center.x
            val top = center.y - h * 0.75f
            drawRoundRect(OnBg, Offset(cx - w / 2, top), Size(w, h), CornerRadius(w / 2))
            val arcW = w * 1.8f
            drawArc(
                OnBg, 0f, 180f, false,
                topLeft = Offset(cx - arcW / 2, top + h * 0.35f),
                size = Size(arcW, h * 0.95f),
                style = Stroke(width = r * 0.06f),
            )
            drawLine(OnBg, Offset(cx, top + h * 0.35f + h * 0.95f), Offset(cx, top + h * 1.55f), strokeWidth = r * 0.06f)
        }
    }
}

@Composable
private fun ConfirmBody(p: Phase.Confirm, canContinue: Boolean, vm: HiLisaViewModel) {
    SpokenText(p.text)
    val targetLine = when (val t = p.target) {
        is Target.NewChat -> "sends to: ${t.peerName} (new chat)"
        is Target.Continue -> "sends to: ${t.title} (continue)"
    }
    Text(targetLine, color = Muted, fontSize = 15.sp)
    if (canContinue) {
        OutlinedButton(onClick = vm::toggleContinue, border = BorderStroke(1.dp, Outline)) {
            Text(if (p.target is Target.Continue) "New chat instead ⇄" else "Continue last voice chat ⇄", color = OnBg)
        }
    }
    Text(
        "sending in ${p.secondsLeft}…",
        color = Primary,
        fontSize = 28.sp,
        fontWeight = FontWeight.Bold,
        modifier = Modifier.fillMaxWidth(),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = vm::cancel, border = BorderStroke(1.dp, Outline), modifier = Modifier.weight(1f).testTag("hilisa_cancel")) {
            Text("Cancel", color = OnBg)
        }
        OutlinedButton(onClick = vm::edit, border = BorderStroke(1.dp, Outline), modifier = Modifier.weight(1f).testTag("hilisa_edit")) {
            Text("Edit", color = OnBg)
        }
        Button(
            onClick = { vm.send() },
            colors = ButtonDefaults.buttonColors(containerColor = Primary, contentColor = Bg),
            modifier = Modifier.weight(1.3f).testTag("hilisa_send"),
        ) { Text("Send now", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun TypingBody(text: String, notice: String?, vm: HiLisaViewModel) {
    if (notice != null) Text(notice, color = Warn, fontSize = 14.sp)
    OutlinedTextField(
        value = text,
        onValueChange = vm::updateTyping,
        minLines = 3,
        textStyle = androidx.compose.ui.text.TextStyle(fontSize = 18.sp, color = OnBg),
        placeholder = { Text("Type what LISA should do", color = Muted) },
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = Primary,
            unfocusedBorderColor = Outline,
            cursorColor = Primary,
            focusedTextColor = OnBg,
            unfocusedTextColor = OnBg,
        ),
        modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).testTag("hilisa_edit"),
    )
    // Mirror of the current text for automation (uiautomator reads hilisa_partial in every phase).
    Text(
        text,
        color = Color.Transparent,
        fontSize = 1.sp,
        maxLines = 1,
        modifier = Modifier.height(1.dp).testTag("hilisa_partial"),
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        OutlinedButton(onClick = { vm.cancelAndClose() }, border = BorderStroke(1.dp, Outline), modifier = Modifier.weight(1f).testTag("hilisa_cancel")) {
            Text("Cancel", color = OnBg)
        }
        Button(
            onClick = { vm.send(text) },
            enabled = text.isNotBlank(),
            colors = ButtonDefaults.buttonColors(containerColor = Primary, contentColor = Bg, disabledContainerColor = SurfaceVar, disabledContentColor = Muted),
            modifier = Modifier.weight(1.3f).testTag("hilisa_send"),
        ) { Text("Send", fontWeight = FontWeight.Bold) }
    }
}

@Composable
private fun SendingBody() {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(color = Primary, modifier = Modifier.size(28.dp))
        Text("Sending…", color = OnBg, fontSize = 18.sp)
    }
}

@Composable
private fun DoneBody(p: Phase.Done, vm: HiLisaViewModel, onClose: () -> Unit) {
    val failed = p.result is SendResult.Failed
    val color = when (p.result) {
        is SendResult.Sent, SendResult.Duplicate -> Ok
        is SendResult.Queued -> Warn
        is SendResult.Failed -> Err
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(14.dp).background(color, CircleShape))
        Text(p.message, color = OnBg, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
    }
    if (failed) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onClose, border = BorderStroke(1.dp, Outline)) { Text("Close", color = OnBg) }
            Button(onClick = vm::retry, colors = ButtonDefaults.buttonColors(containerColor = Primary, contentColor = Bg)) { Text("Edit and retry") }
        }
    }
}

@Composable
private fun ErrorBody(msg: String, onClose: () -> Unit) {
    Text(msg, color = Err, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
    Button(onClick = onClose, colors = ButtonDefaults.buttonColors(containerColor = SurfaceVar, contentColor = OnBg)) { Text("Close") }
}

@Composable
private fun ConnectionLine(state: ConnectionState) {
    val color = when (state) {
        ConnectionState.ONLINE -> Ok
        ConnectionState.APP_DOWN, ConnectionState.MAC_OFF, ConnectionState.PAUSED -> Warn
        ConnectionState.UNAUTHORIZED, ConnectionState.UNPAIRED -> Err
    }
    Spacer(Modifier.height(2.dp))
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Text(NotificationText.connectionText(state, null, null), color = Muted, fontSize = 13.sp)
    }
}
