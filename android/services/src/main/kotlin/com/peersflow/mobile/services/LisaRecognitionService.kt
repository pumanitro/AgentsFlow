package com.peersflow.mobile.services

import android.content.Intent
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/** Required by the assistant role; Peers Flow does its own speech recognition, so this always answers "busy". */
class LisaRecognitionService : RecognitionService() {
    override fun onStartListening(recognizerIntent: Intent?, listener: Callback?) = busy(listener)

    override fun onCancel(listener: Callback?) = busy(listener)

    override fun onStopListening(listener: Callback?) = busy(listener)

    private fun busy(listener: Callback?) {
        runCatching { listener?.error(SpeechRecognizer.ERROR_RECOGNIZER_BUSY) }
    }
}
