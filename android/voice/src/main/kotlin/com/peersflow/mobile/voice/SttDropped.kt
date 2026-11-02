package com.peersflow.mobile.voice

import java.io.IOException

/** A live session died mid-utterance. [buffered] holds every frame that was fed, so another provider can redo it. */
class SttDropped(val buffered: List<ShortArray>, message: String = "live transcription dropped") : IOException(message)
