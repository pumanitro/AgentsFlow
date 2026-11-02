package com.peersflow.mobile.ui.main

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Callbacks of the bottom bar, grouped so the screen passes one object. */
internal class ComposerActions(
    val onText: (String) -> Unit,
    val onSend: () -> Unit,
    val onMicDown: () -> Unit,
    val onMicUp: () -> Unit,
    val onMicCancel: () -> Unit,
    val onCancelConfirm: () -> Unit,
    val onEditConfirm: () -> Unit,
    val onStop: () -> Unit,
    val onDone: () -> Unit,
    val onReopen: () -> Unit,
)

@Composable
internal fun Composer(state: ChatUiState, actions: ComposerActions, focus: FocusRequester, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().background(UiColors.bg).navigationBarsPadding().imePadding()) {
        if (state.greyed) {
            Text(
                stringResource(R.string.chat_mac_off),
                color = UiColors.bg,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                modifier = Modifier.fillMaxWidth().background(UiColors.warn).padding(horizontal = 16.dp, vertical = 4.dp),
            )
        }
        RecordingLine(state.recording, actions)
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            // One field: the text gets the whole width; mic (empty) or send (text) sits inside it.
            val canSend = state.composer.isNotBlank()
            OutlinedTextField(
                value = state.composer,
                onValueChange = actions.onText,
                placeholder = { Text(stringResource(R.string.chat_placeholder), color = UiColors.subtle) },
                maxLines = 8,
                modifier = Modifier.weight(1f).focusRequester(focus).testTag("chat_composer"),
                shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
                trailingIcon = {
                    if (canSend) {
                        IconButton(
                            onClick = actions.onSend,
                            modifier = Modifier.size(48.dp).testTag("chat_send"),
                            colors = IconButtonDefaults.iconButtonColors(contentColor = UiColors.primary),
                        ) { Icon(Icons.AutoMirrored.Filled.Send, stringResource(R.string.chat_send)) }
                    } else {
                        MicButton(state.recording, actions)
                    }
                },
                colors = OutlinedTextFieldDefaults.colors(
                    focusedTextColor = UiColors.onBg,
                    unfocusedTextColor = UiColors.onBg,
                    focusedBorderColor = UiColors.primary,
                    unfocusedBorderColor = UiColors.outline,
                    cursorColor = UiColors.primary,
                    focusedContainerColor = UiColors.surface,
                    unfocusedContainerColor = UiColors.surface,
                ),
            )
        }
    }
}

@Composable
private fun RecordingLine(rec: RecordingState, actions: ComposerActions) {
    when (rec) {
        RecordingState.Idle -> Unit
        is RecordingState.Listening -> Text(
            rec.partial.ifBlank { stringResource(R.string.chat_listening) },
            color = UiColors.info,
            fontStyle = FontStyle.Italic,
            fontSize = 15.sp,
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        )
        is RecordingState.Confirm -> Column(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                .border(1.5.dp, UiColors.info, androidx.compose.foundation.shape.RoundedCornerShape(10.dp))
                .padding(10.dp),
        ) {
            Text(rec.text, color = UiColors.onBg, fontSize = 15.sp, maxLines = 4, overflow = TextOverflow.Ellipsis)
            Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(stringResource(R.string.chat_sending_in, rec.secondsLeft), color = UiColors.info, fontWeight = FontWeight.SemiBold,
                    fontSize = 13.sp, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = actions.onCancelConfirm, modifier = Modifier.heightIn(min = 48.dp), border = BorderStroke(1.5.dp, UiColors.err)) {
                    Text(stringResource(R.string.chat_cancel), color = UiColors.err)
                }
                OutlinedButton(onClick = actions.onEditConfirm, modifier = Modifier.heightIn(min = 48.dp), border = BorderStroke(1.5.dp, UiColors.outline)) {
                    Text(stringResource(R.string.chat_edit), color = UiColors.onBg)
                }
            }
        }
        is RecordingState.Error -> Text(
            rec.msg,
            color = UiColors.err,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        )
    }
}

/** Press-and-hold: down starts listening, release stops and transcribes, a cancelled gesture drops it. */
@Composable
private fun MicButton(rec: RecordingState, actions: ComposerActions) {
    val down by rememberUpdatedState(actions.onMicDown)
    val up by rememberUpdatedState(actions.onMicUp)
    val cancel by rememberUpdatedState(actions.onMicCancel)
    val listening = rec is RecordingState.Listening
    val scale = if (listening) {
        val t = rememberInfiniteTransition(label = "mic")
        val s by t.animateFloat(1f, 1.18f, infiniteRepeatable(tween(600), RepeatMode.Reverse), label = "micScale")
        s
    } else {
        1f
    }
    val label = stringResource(R.string.chat_mic)
    Box(
        Modifier
            .size(48.dp)
            .testTag("chat_mic")
            .semantics { contentDescription = label }
            .pointerInput(Unit) {
                detectTapGestures(onPress = {
                    down()
                    if (tryAwaitRelease()) up() else cancel()
                })
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(40.dp).scale(scale).background(if (listening) UiColors.info else UiColors.surfaceVariant, CircleShape)
                .border(1.5.dp, if (listening) UiColors.info else UiColors.outline, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Filled.Mic, null, tint = if (listening) UiColors.bg else UiColors.onBg, modifier = Modifier.size(22.dp))
        }
    }
}

@Preview(widthDp = 360)
@Composable
private fun ComposerConfirmPreview() = UiMainTheme {
    Composer(
        PreviewData.chatState.copy(recording = RecordingState.Confirm("check the build and push", 2)),
        PreviewData.noActions,
        FocusRequester(),
    )
}
