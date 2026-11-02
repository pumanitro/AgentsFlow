# Peers Flow mobile (Android)

Companion app for the Peers Flow desktop app. Kotlin, Jetpack Compose, minSdk 31, target/compile SDK 36.

## Build

```sh
cd /Users/iij/Desktop/AgentsFlow/android
./gw assembleDebug          # APK: app/build/outputs/apk/debug/app-debug.apk
./gw testDebugUnitTest      # JVM unit tests in every module
```

JDK 17 is required. `gradle.properties` pins `org.gradle.java.home` to the Homebrew openjdk@17, and `gw` exports the same `JAVA_HOME`, so the system default JDK does not matter. Gradle wrapper is 8.11.1, AGP 8.9.1, Kotlin 2.0.21. Versions live in `gradle/libs.versions.toml`.

## The `gw` rule

Run Gradle ONLY through `./gw`, never `./gradlew` or a global `gradle`. `gw` takes an exclusive lock at `/Users/iij/.claude/jobs/106e55f3/tmp/gradle.lock`, waits up to 30 minutes (printing `waiting for gradle lock held by <pid>` every 15 s), and releases it on exit. A lock left by a dead process is removed automatically. Never kill another agent's Gradle daemon.

Allowed tasks per package:

| Who | Tasks |
|-----|-------|
| Module owners (wave 1/2) | `:<module>:compileDebugKotlin`, `:<module>:testDebugUnitTest` (with `--tests` filters) |
| WP-01, WP-30, WP-31, integrator | also `assembleDebug`, `installDebug`, `connectedAndroidTest` |

Module owners never edit Gradle files: every module's `build.gradle.kts` already declares the dependencies its owner needs.

## Modules

| Module | Package | Depends on | Holds |
|--------|---------|-----------|-------|
| `app` | `com.peersflow.mobile` | all | MainActivity, PeersFlowApp, AppGraph, NavGraph, Theme, manifest, res |
| `wire` | `com.peersflow.mobile.wire` | serialization, coroutines | wire data classes, `ServerEvent` + `EventCodec`, interfaces, `Palette`, `fakes/` (frozen after wave 0) |
| `net` | `com.peersflow.mobile.net` | wire | OkHttp API client, WebSocket event stream, reachability, backoff |
| `data` | `com.peersflow.mobile.data` | wire | Room db, session store, outbox, repositories |
| `voice` | `com.peersflow.mobile.voice` | wire | audio capture, VAD, speech-to-text, text-to-speech, voice engine |
| `ui-main` | `com.peersflow.mobile.ui.main` | wire, voice | Home, Chat and their view models |
| `ui-aux` | `com.peersflow.mobile.ui.aux` | wire | Pairing, Settings, Outcomes and their view models |
| `services` | `com.peersflow.mobile.services` | wire, voice | connection service, notifications, tile, assistant, Hi LISA |

Status colours are `com.peersflow.mobile.wire.Palette` ARGB longs; UI modules write `Color(Palette.OK)`. `PeersFlowTheme` lives in `:app`.

## Test tags

Compose `Modifier.testTag("...")` values double as uiautomator resource-ids, because `MainActivity` and `HiLisaActivity` set `Modifier.semantics { testTagsAsResourceId = true }` on their root. Tags are snake_case and fixed by the plan, for example `pair_url`, `pair_code`, `pair_submit`, `home_list`, `home_fab`, `status_strip`, `chat_messages`, `chat_composer`, `chat_send`, `outcomes_list`, `settings_voice_peer`, `hilisa_partial`. Per-item tags append an id: `conv_row_<conversationId>`, `chat_msg_<entryId>`, `needs_chip_<i>`.

## Run on the emulator

```sh
/Users/iij/Library/Android/sdk/platform-tools/adb install -r app/build/outputs/apk/debug/app-debug.apk
```

In dev mode the desktop gateway is reached at `http://10.0.2.2:47821` (the emulator's alias for the Mac). Cleartext HTTP is allowed for `10.0.2.2` only (`res/xml/network_security_config.xml`).

Pairing deep link, the same string the desktop QR encodes:

```sh
adb shell am start -a android.intent.action.VIEW \
  -d 'peersflow://pair?url=http%3A%2F%2F10.0.2.2%3A47821&code=ABCD-EFGH&fp='
```
