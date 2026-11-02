package com.peersflow.mobile.wire

import kotlinx.serialization.json.Json

/** The one Json instance every module uses to read and write wire types. */
val WireJson = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
