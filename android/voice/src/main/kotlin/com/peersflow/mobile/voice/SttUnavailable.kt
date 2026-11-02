package com.peersflow.mobile.voice

import java.io.IOException

/** The provider could not be used at all (no key, no connection in time, recognizer error). The engine falls back. */
class SttUnavailable(message: String) : IOException(message)
