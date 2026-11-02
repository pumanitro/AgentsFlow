package com.peersflow.mobile.voice

sealed interface VadEvent {
    data object SpeechStart : VadEvent

    data object SpeechEnd : VadEvent
}
