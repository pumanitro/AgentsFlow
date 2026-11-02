# Peers Flow on your phone — design plan (Android, v2)

Status: plan only, nothing built. v1 written 2026-10-28 after reading the app, probing the Mac, the tailnet and the Claude CLI. v2 same day, after three decisions from you; v2.1 same day again: **OpenAI's newest speech models in both directions** (`gpt-live-transcribe` for listening, `gpt-realtime-2.1-mini` for LISA's voice), on-device engines only as the offline fallback. Earlier decisions: a **personal second tailnet**, **cloud speech providers** (nothing runs on the Mac for voice), and a server that is **24/7 in intent but sometimes off** — the design must survive that. Phone: **Samsung Galaxy S25+** (SM-S936B/DS). Phone identifiers from the screenshot are deliberately not recorded here.

## TL;DR

Run Peers Flow on the Mac, add a small **gateway** inside the app that speaks HTTPS + WebSocket on `127.0.0.1` only, and publish it on a **free personal tailnet** (Tailscale Personal: $0, up to 6 users, unlimited devices) with `tailscale serve` — verified working on this Mac today, with valid TLS and identity headers. A native **Android app** pairs by QR, mirrors every peer and chat live, and lets you reply or start chats by **voice**. Speech runs on **OpenAI's newest models, called from the phone**: `gpt-live-transcribe` streams your words as you speak ($0.017/min), `gpt-transcribe` handles recorded clips ($0.0045/min), and LISA's conclusions are voiced by `gpt-realtime-2.1-mini`, with the phone's own engines as the offline fallback. The Mac does no voice work and voice keeps working while the Mac is off. The phone keeps an **outbox**: tasks spoken while the Mac is down are queued and sent the moment it is back; conclusions that landed while the phone was unreachable are replayed. **LISA** is the voice front door: side-button long press → new LISA chat that works as long as it needs → one spoken conclusion. No cloud hosting, no relay, no port forwarding; the only third parties are Tailscale's coordination and the speech API you already pay for.

---

## 1. What you asked for, as four capabilities

| # | Capability | One-line shape |
|---|---|---|
| A | See and open any chat from the phone, live, while the home server is online; sane behaviour when it is not | Read-only mirror of the desktop + a cached last-known state, an outbox, and replay on reconnect |
| B | Voice chat through LISA as orchestrator; "Hi LISA" starts a new chat | Voice task → new LISA chat (kind `voice`) → LISA plans, delegates to peers, works until done |
| C | Long thinking, then just the outcome | No instant replies: the chat runs as a full agent session; the phone gets one spoken conclusion when it ends, or one question when it is stuck |
| D | A voice button inside any chat, and voice to start a new chat anywhere | Mic → cloud transcript (from the phone) → the same reply path the desktop uses |

---

## 2. Facts this plan is built on (verified 2026-10-28)

### 2.1 The machine, the network, the phone

| Fact | Value | How verified |
|---|---|---|
| Host | MacBook Pro, Apple M3 Max, 128 GB, macOS 26.5.2, Node 24, Claude Code 2.1.312 | `sysctl`, `sw_vers`, `claude --version` |
| Power today | on battery, `pmset -c sleep 1` (sleeps after 1 idle minute on mains), Peers Flow is not a login item | `pmset -g custom`, login items |
| Tailscale on the Mac today | userspace `tailscaled` (launch agent `com.iij.tailscaled-user`, socket `~/.tailscale-user/tailscaled.sock`) on the **company tailnet `abilitie.com`**. Not used for this project. | `tailscale status --json` |
| Inbound to a localhost port over a userspace tailscaled | **works**: a server bound to `127.0.0.1:47911` answered `HTTP 200` to a request from another tailnet node | live test |
| `tailscale serve --https=8443` on a userspace tailscaled | **works**: valid Let's Encrypt cert (`ssl_verify_result=0`), backend saw `Tailscale-User-Login`, `Tailscale-User-Name`, `X-Forwarded-For`. The first HTTPS request right after enabling failed while the cert was being issued; the next one succeeded. | live test, config removed afterwards |
| Several `tailscaled` on one host | documented pattern: own `--statedir`, `--socket`, `--port`, `--tun=userspace-networking` | Tailscale FAQ, community configs |
| Tailscale Personal plan | **$0, "Free forever", up to 6 users, unlimited user devices**, MagicDNS and ACLs included (up to 3 ACL groups); next tier Standard $8/user/month | tailscale.com/pricing, kb/1154 |
| HTTPS certificates | one-time toggle in the admin console (DNS page → Enable HTTPS); machine + tailnet names land in public Certificate Transparency logs; no plan restriction stated | kb/1153 |
| Fast user switching on the phone | one active account at a time; switching needs no re-login once both are added | Tailscale docs |
| Phone | Samsung Galaxy S25+ (SM-S936B/DS, dual SIM, 5G on T-Mobile PL). One UI 8.5 / Android 16 has been rolling out to the S25 series in Poland since May 2026 — check Settings → Software update | screenshot; Polish press (Spider's Web, android.com.pl) |
| Speech tooling on the Mac | none needed any more; `OPENAI_API_KEY` exists in `~/Desktop/LISA/.env.local`. LISA's `transcribe` skill still calls `gpt-4o-transcribe`, which OpenAI has deprecated (shutdown 2027-02-26) — move it to `gpt-transcribe` | `grep`, OpenAI speech-to-text guide |
| Android toolchain on the Mac | SDK present (`~/Library/Android/sdk`), Gradle present, no `adb` on PATH | `ls`, `which` |

### 2.2 Cloud speech prices (verified on the providers' pages today)

| Provider / model | Price | Notes |
|---|---|---|
| OpenAI **`gpt-transcribe`** (current) | $0.0045 / min | OpenAI's recommended model for recorded speech: `prompt`, `keywords` (name hints), `languages: ["pl","en"]`, partial text while a file is processed, returns detected languages, 25 MB max |
| OpenAI **`gpt-live-transcribe`** (current) | $0.017 / min | **streaming** words as you speak over WebSocket; `languages`, `keywords`; client-side end-of-speech; no timestamps or speaker labels |
| OpenAI `gpt-realtime-whisper` (current) | $0.017 / min | streaming Whisper-family model; the guide does not mention it, listed on the models page |
| OpenAI `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1` | $0.006 / $0.003 / $0.006 per min | **deprecated, shut down 2027-02-26** (notice dated 2026-08-26). Not used in this plan |
| Groq `whisper-large-v3-turbo` | **$0.04 / hour** (≈ $0.0007 / min) | "216× speed factor", 99+ languages, 100 MB max file. Price reference only; an older Whisper generation, not used |
| OpenAI `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd` | $0.60 / 1M input + $12 / 1M audio output tokens (mini-tts) | **deprecated, shut down 2027-01-06**; OpenAI's migration target for speech output is `gpt-realtime-2.1-mini` through the Realtime API. On-device TTS stays the plan's default |
| OpenAI speech-to-speech: `gpt-live-1`, `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` | see §2.2a | `gpt-realtime-2.1-mini` is **LISA's voice** in this plan (text in → audio out); the conversation models stay out, since a voice task is minutes of agent work, not a chat |

At 30 minutes of speech a day: `gpt-live-transcribe` ≈ $15 / month, `gpt-transcribe` ≈ $4 / month if everything went through file mode, Groq ≈ $0.60 / month (reference only, not used). LISA's voice on `gpt-realtime-2.1-mini` is billed per audio token; a 3-sentence conclusion is seconds of audio, and phase 4 measures the real monthly figure. All negligible next to the subscriptions already in play.

#### 2.2a Speech-to-speech (live conversation) prices, for the record

| Model | Price (verified today) | Fit for this project |
|---|---|---|
| `gpt-live-1` | $0.05 / min, billed per second | OpenAI's premier live-conversation model; would make a spoken back-and-forth with LISA possible later, but a voice task here is minutes of agent work, not a chat, so it is not in any phase |
| `gpt-realtime-2.1` | $32 / 1M audio input tokens, $64 / 1M audio output, $4 / 1M text input, $24 / 1M text output | reasoning realtime model with tool use; same verdict |
| `gpt-realtime-2.1-mini` | $10 / 1M audio input, $20 / 1M audio output, $0.60 / 1M text input, $2.40 / 1M text output | OpenAI's migration target for text-to-speech once the Speech API voices shut down (2027-01-06); the only candidate if you ever want a cloud voice for conclusions |

### 2.3 What the app already gives us (reuse, do not rebuild)

| Need on the phone | Existing piece | Where |
|---|---|---|
| List of peers / chats / dividers / todos | `store.getDirectories()`, `store.getConversations()`, `getPinnedOrder()` | `electron/store.ts` |
| Live status (working / blocked / done) | poller tick reconciles `claude agents --json` with `state.json`; emits `conversations:updated` / `conversations:patched` | `electron/poller.ts`, `electron/derive-state.ts` |
| "What is it doing right now" line | `state.json.detail`, plus a per-job `timeline.jsonl` of detail changes | `~/.claude/jobs/<short>/` |
| "Needs you" signals | `state.json.needs`, `suggestedReply` (e.g. `"commit and push it"`), `block.questions` (AskUserQuestion), `tempo: blocked` | `electron/derive-state.ts` `isBlocked()` |
| Message history | transcript JSONL (`findTranscript`), tail parser with mtime+size cache, `lastAssistantText()` | `electron/transcript-path.ts`, `electron/keeper/transcript-signals.ts`, `electron/main-remote.ts` |
| Send a message into a running chat without a window | `sendToSession()` — types into an open PTY or a headless `claude attach`, with a `verify` callback and retries | `electron/pty-manager.ts:920` |
| Start a chat in a peer | `spawnConversation({ dir, prompt, chatKind, model, contract })` | `electron/main.ts:1932` |
| Stop / done / reopen / fork | `stopAgent`, `convs:setPinned`, `convs:fork` | `electron/claude-cli.ts`, `electron/main.ts` |
| Agent → user notices | `notify` MCP tool, gated by `chatKind` (`mayNotify`), `notificationsStore` | `electron/registry.ts`, `electron/main.ts:2429` |
| Routines | `routinesStore`, scheduler with catch-up after downtime, `run`/`pause` ops | `electron/routines-*.ts` |
| Usage meters / accounts | `getUsage()`, accounts pool, rotation | `electron/usage.ts`, `electron/accounts.ts` |
| Keeper ("is it being babysat") | `keeper.snapshot` | `electron/keeper/` |
| Raw terminal | `attach()` PTY channels, `write`, `resize` | `electron/pty-manager.ts:377` |
| Codex chats as structured messages | `CodexSnapshot { entries, requests, state }`, `codexReply` | `shared/codex.ts`, `renderer/components/CodexChat.tsx` |
| Remote (SSH) peers | transparent: every CLI/PTY call routes on `conv.host` | `electron/remote/` |
| Local server patterns inside main | wake proxy (`net.createServer`), delegation bridge (unix socket) | `electron/services/wake-proxy.ts`, `electron/delegation-bridge.ts` |

Gaps the gateway fills itself: a **transcript tailer** (JSONL → phone-sized message events), **outcome extraction**, **device pairing**, and the **offline bookkeeping** (heartbeat, replay cursors). Voice runs entirely on the phone + cloud.

### 2.4 Android and Samsung rules that shape the design

| Rule | Source | Consequence |
|---|---|---|
| A foreground service of type `microphone` must be started while the app has a visible activity; from the background Android 14+ throws `SecurityException`. Exempt: the app that provides the **VoiceInteractionService**, a notification action, a widget. | developer.android.com, restrictions-bg-start | Make the app the **default digital assistant**: hardware trigger + mic exemption in one |
| The 6-hour cap for background foreground services (Android 15+) applies only to `dataSync` and `mediaProcessing`. | developer.android.com, fg-service-timeout | Server connection lives in a `specialUse` service |
| `ROLE_ASSISTANT` needs a `VoiceInteractionService` or `ACTION_ASSIST`; one holder at a time. | developer.android.com RoleManager | Replaces Gemini/Bixby on the button while held |
| Samsung: Settings → Apps → Choose default apps → **Digital assistant app** accepts third-party apps; Settings → Advanced features → **Side button → Press and hold → Digital assistant** routes the long press to it (One UI 7 on the S25; Gemini sits there by default). | Samsung support ANS10001575, SamMobile Feb 2025 | "Hi LISA" = hold the side button, from phase 4 |
| Samsung sleeping-app lists can restrict foreground services; Samsung states that since One UI 6 foreground services of apps following the Android 14 policy work as intended. | developer.samsung.com, dontkillmyapp | Still: add the app to **Never sleeping apps**, battery **Unrestricted**; test a week with screen off |
| On-device recognition: `SpeechRecognizer.createOnDeviceSpeechRecognizer` (API 31+), downloadable languages (API 33+). | developer.android.com | Offline fallback only |
| Picovoice Porcupine's free tier ended 2026-06-30. | Home Assistant community posts quoting Picovoice | **No Porcupine**; wake word = open source, phase 5, optional |

### 2.5 Why not Anthropic's Remote Control

Claude Code 2.1.312 ships `claude --remote-control`. Per the official page: the local session polls the Anthropic API, **all traffic goes through Anthropic's servers**, the **transcript is stored on Anthropic servers while connected**, one Claude session per process (or a server mode in one directory), used from the Claude app. It sees nothing of Peers Flow: no peers, routines, Keeper, account pool, LISA front door, outcome-only delivery, no offline queue. Keep it as the zero-build fallback for a single chat.

---

## 3. Architecture

```
PHONE (Galaxy S25+, Kotlin)                   CLOUD                 HOME MAC (24/7 intent, sometimes off)
┌──────────────────────────────┐      ┌─────────────────┐     ┌──────────────────────────────────────────┐
│ Peers Flow app               │      │ speech-to-text  │     │ tailscaled #2 (userspace, PERSONAL tailnet)│
│  · home: peers → chats       │ ───► │ OpenAI (newest) │     │   tailscale serve https://<node>.ts.net:8443│
│  · chat: message stream      │audio │ (key on phone)  │     │   TLS + identity → 127.0.0.1:47xxx         │
│  · mic / Hi LISA (side key)  │ ◄─── └─────────────────┘     │                   │                        │
│  · outbox (Mac off? queue)   │ text                         │ ┌─────────────────▼──────────────────────┐ │
│  · outcomes inbox + TTS      │   WireGuard (personal tailnet)│ │ Peers Flow main process                │ │
│  · bg service: 1 WebSocket   │◄────────────────────────────►│ │  electron/mobile/  (NEW gateway)       │ │
│  · cached last-known state   │   direct or DERP relay       │ │   auth · api · events · tailer         │ │
│  · Keystore token, biometric │                              │ │   outcomes · heartbeat · devices       │ │
└──────────────────────────────┘                              │ │        │ in-process calls               │ │
  Tailscale app signed into the                               │ │  store · poller · pty · spawn          │ │
  personal tailnet (one active                                │ │  notifications · routines · usage      │ │
  account at a time)                                          │ └────────────────────────────────────────┘ │
                                                              │ tailscaled #1 (company) keeps the Mac Studio│
                                                              │ peer link, untouched                        │
                                                              └──────────────────────────────────────────┘
```

### 3.1 Decisions

| # | Decision | Chosen | Rejected and why |
|---|---|---|---|
| D1 | Transport | Personal tailnet + `tailscale serve` (TLS, identity headers, WebSocket through Tailscale's reverse proxy) | Port forwarding (exposes the Mac), tunnels (third-party relay), Remote Control (hosted, single chat), hand-rolled WireGuard |
| D2 | Which tailnet | **A second, personal tailnet — free.** Second userspace `tailscaled` on the Mac; the phone's Tailscale app signed into the personal account | Company tailnet (colleagues' devices reach served ports; policy questions) |
| D3 | Where the gateway lives | Inside the Electron main process as `electron/mobile/` | A sidecar would need its own copy of store/poller/PTY state |
| D4 | Phone app | Native Kotlin + Jetpack Compose, minSdk 35 (Android 15), targetSdk 36; WebView only for the raw-terminal fallback page | PWA (no assistant role, no background service, no SpeechRecognition in WebView); hybrid shell + served UI (every voice path crosses a JS bridge) |
| D5 | Speech → text | **OpenAI's newest, called from the phone**: `gpt-live-transcribe` for every live mic (words appear as you speak; `languages: ["pl","en"]`, `keywords` from the vocabulary; client-side end-of-speech), `gpt-transcribe` for recorded clips (a mic session that could not hold its WebSocket on poor 5G, re-transcribing an outbox item), on-device recognizer only with no internet. One `SttProvider` interface so a model swap is one class | Groq (older Whisper generation, kept as a price reference), the deprecated `gpt-4o-*-transcribe` / `whisper-1` family (shut down 2027-02-26) |
| D6 | Text → speech | **OpenAI `gpt-realtime-2.1-mini`** through the Realtime API (text in, streamed audio out) voices LISA's conclusions and questions; audio cached per outcome so replay costs nothing; Samsung/Google on-device `TextToSpeech` when offline or in quiet hours | The Speech API voices (`gpt-4o-mini-tts`, `tts-1`), which shut down 2027-01-06; `gpt-live-1` / `gpt-realtime-2.1` (conversation models, overkill for reading three sentences) |
| D7 | "Hi LISA" trigger | v1: side-button long press (assistant role), Quick Settings tile, lock-screen notification action, headset button. v2: open-source wake word | Picovoice (free tier gone); always-on wake word in v1 |
| D8 | Finished-work delivery | One WebSocket in a `specialUse` foreground service while "stay connected" is on; local notifications + TTS; replay cursor for anything missed | FCM (Google in the path), ntfy (second app) |
| D9 | Mac sometimes off | **Phone-side outbox + server-side replay cursor + heartbeat**, §4.4. The phone never pretends; it shows "Mac off since 22:10", queues, and flushes on reconnect | "Wake the Mac from the phone" (no device awake on the LAN to send a magic packet; userspace tailscaled is down when the Mac sleeps) |
| D10 | Orchestrator | `ChatKind` gains `'voice'`; spawned in the LISA peer with a `/voice-task` skill; voice chats may `notify`; Keeper contract `until-done` by default | Reusing `routine` kind (would pollute routine boards) |
| D11 | Outcome contract | Final message ends with `<spoken>…</spoken>` (≤ 3 sentences, your language) and optionally `<needs>…</needs>`; gateway extracts; fallback = first two sentences | A second model call per outcome |

### 3.2 The personal tailnet — exact shape, cost $0

1. **Account**: a personal Tailscale account (Google/GitHub/Apple/Microsoft/passkey — a personal identity, not the company one). Personal plan: $0, up to 6 users, unlimited devices. Nothing to pay unless you later want paid features (none are needed here).
2. **Admin console, once**: DNS → MagicDNS on (default) → **Enable HTTPS** (certificate names are public in CT logs, so give the Mac a bland node name such as `home-hub`). Machines → the Mac → **Disable key expiry** (otherwise the node must re-authenticate every 180 days and would silently drop off one morning). Same for the phone if you want zero maintenance. ACL: default allows your own devices to talk; nothing else is in the tailnet.
3. **Mac**: a second launch agent `com.iij.tailscaled-home` running `tailscaled --tun=userspace-networking --statedir=~/.tailscale-home --socket=~/.tailscale-home/tailscaled.sock --port=0` (no SOCKS proxy needed), `tailscale --socket=~/.tailscale-home/tailscaled.sock up --hostname=home-hub`. The company instance keeps running untouched; the Mac Studio peer link stays on it.
4. **Gateway**: `tailscale --socket=~/.tailscale-home/tailscaled.sock serve --bg --https=8443 http://127.0.0.1:<port>`, written by the app once; `tailscale cert <node>.<tailnet>.ts.net` pre-warm at start.
5. **Phone**: Tailscale app → add the personal account. If you ever need the company tailnet on the phone, fast user switching flips between them (one active at a time).
6. **Defence in depth stays**: even with only you in the tailnet, the gateway pins `Tailscale-User-Login` to your personal login and requires the paired device token.

### 3.3 Security model

```
request ──► tailnet reachability (WireGuard, device keys; only your devices exist in it)
        ──► tailscale serve: TLS, strips spoofed headers, injects Tailscale-User-Login
        ──► gateway: Tailscale-User-Login == owner login  (else 403, logged)
        ──► gateway: Bearer device token (paired by QR, stored hashed)  (else 401)
        ──► scope check: view | talk | admin
        ──► phone: biometric before any talk/admin action (5-minute grace)
```

- Gateway binds **`127.0.0.1` only**, reachable solely through serve.
- **Pairing**: desktop sidebar shows a QR `{url, code, certFingerprint}`; the code lives 2 minutes; the phone receives a 32-byte token; the Mac stores `sha256(token)`, device name, scopes, created / last-seen in `<userData>/mobile-devices.json`; the phone keeps the token in `EncryptedSharedPreferences` (Keystore-backed).
- **Speech key on the phone**: pairing also hands the phone its speech-provider key, encrypted in transit by TLS and kept in the Keystore. Make it a **dedicated, restricted OpenAI project key** (audio and realtime only) so it can be revoked without touching LISA's. OpenAI's client-side guidance is ephemeral tokens; our phone is a single trusted client holding a revocable restricted key in the Keystore, which is the same posture as the device token.
- **Scopes**: `view` (read-only), `talk` (reply, answer, start, stop, done, queue), `admin` (switch account, raw terminal, routines run/pause, revoke devices). Default `view+talk`; `admin` is a per-device toggle on the desktop.
- **Kill switches**: "Pause mobile access", per-device Revoke, Revoke all; every write logged `[agentsflow][mobile]`; "Stop everything" on the phone (admin).
- A `talk` token types into chats that run with `bypassPermissions`. Treat the phone like a root shell.
- Dev mode: `PEERSFLOW_MOBILE_DEV=1` lets the emulator reach `10.0.2.2:<port>` over plain HTTP with a dev token. Never in a normal launch.

---

## 4. Gateway design (`electron/mobile/`)

| File | Responsibility |
|---|---|
| `server.ts` | `http.createServer` on `127.0.0.1:<port>` + `ws` for `/api/v1/events`; starts after `app.whenReady`, stops in `before-quit`; writes the serve config once; cert pre-warm |
| `tailscale.ts` | Talks to the **home** socket (`~/.tailscale-home/tailscaled.sock`): node DNS name, owner login, cert domains, "serve is on" for the sidebar; never touches the company socket |
| `auth.ts` | Owner-login check, pairing codes, token hashing, scopes, rate limit |
| `devices.ts` | `mobile-devices.json`, revoke, last-seen, per-device replay cursor |
| `api.ts` | REST routes below; thin adapters over existing functions |
| `events.ts` | Fan-out of `conversations:updated/patched`, notifications, keeper, usage to subscribed sockets |
| `transcript-tailer.ts` | Per subscribed conversation: byte-offset tail of the JSONL, 1 s poll while subscribed, parse into `MessageEntry[]`, initial page from the tail backwards |
| `job-state.ts` | `state.json` + `timeline.jsonl` slices: `detail`, `tempo`, `needs`, `suggestedReply`, `block.questions`, `inFlight` |
| `outcomes.ts` | Watches voice-kind chats; on working → idle/done reads `lastAssistantText`, extracts `<spoken>` / `<needs>`, dedupes by message uuid, appends to `outcomes.json` with a monotonic sequence number |
| `heartbeat.ts` | Writes `<userData>/mobile-heartbeat.json` every 30 s and a clean-shutdown marker; on start computes "was off from … to …, clean/unclean" for `/health` and the phone's status card |
| `web/` | Static `/m/terminal?id=` (xterm.js over the PTY WebSocket) and `/m/status` (debug list) |

Sidebar: `renderer/components/MobilePanel.tsx` — tailnet node + serve state, QR pairing, device list with scopes and Revoke, "Pause mobile access", last connection and queued-task count per device. Same visual language as the Accounts/Usage sections.

### 4.1 API (all under `/api/v1`, Bearer token, owner identity header required)

| Method + path | Scope | Backed by |
|---|---|---|
| `POST /pair` `{code, deviceName}` → `{token, scopes, sttProvider?, sttKey?}` | none (code) | `devices.ts` |
| `GET /me` → device, scopes, server `{hostname, version, uptime, offlineSince?, lastOutageClean?}` | view | `heartbeat.ts` |
| `GET /peers` | view | `store.getDirectories()` |
| `GET /conversations?filter=&peer=` → summaries | view | store + poller rows |
| `GET /conversations/:id` → summary + job-state slice + timeline tail | view | `job-state.ts` |
| `GET /conversations/:id/messages?before=&limit=` | view | `transcript-tailer.ts`; Codex: `CodexSnapshot` |
| `POST /conversations/:id/reply` `{text, source, clientId}` → `{ok, via}` | talk | `sendToSession` with transcript `verify`; `clientId` makes retries idempotent |
| `POST /conversations/:id/answer` `{questionId, option|text, clientId}` | talk | same path; Codex: `codexReply` |
| `POST /conversations/:id/stop` · `/done` · `/reopen` | talk | `stopAgent`, `setPinned` |
| `POST /conversations` `{peerId, prompt, kind, provider?, model?, contract?, clientId, spokenAt}` → `{conversationId}` | talk | `spawnConversation`; `clientId` dedupes an outbox flush that was retried |
| `GET /outcomes?after=<seq>` → outcomes + needs-you items in order | view | `outcomes.ts` |
| `GET /notifications` · `POST /notifications/:id/dismiss` | view / talk | `notificationsStore` |
| `GET /routines/today` · `POST /routines/:id/run` · `/pause` · `/resume` | view / admin | `routinesStore` |
| `GET /usage` · `POST /accounts/switch` | view / admin | `getUsage`, accounts |
| `GET /keeper` · `GET /health` | view | keeper snapshot, sysmon, heartbeat |
| `WS /conversations/:id/terminal` | admin | `attach()` PTY channel |
| `WS /events` | view | below |

**Events** (server → phone): `conversations.updated`, `conversation.patched {id, patch}`, `progress {id, detail, at}`, `messages.appended {id, entries}`, `needs-you {id, questions?, needs?, suggestedReply?, seq}`, `outcome {id, title, spoken, at, seq}`, `notification.added`, `usage.updated`, `server.health`. Phone → server: `hello {lastSeq}` on connect (server replays anything newer), `subscribe {ids}` / `unsubscribe`.

### 4.2 Message model from the transcript

| Entry kind | From | Shown as |
|---|---|---|
| `user.text` | `type: user`, text parts, not `isMeta` | your bubble (voice ones carry a 🎤 mark via `source`) |
| `assistant.text` | `type: assistant`, text parts | markdown bubble |
| `tool_use` | assistant `tool_use` part | one-line card "Bash: npm test" |
| `tool_result` | user `tool_result` part | collapsed under its tool card, first 2 KB, "more" fetches the rest |
| `thinking` | assistant `thinking` part | hidden by default |
| sidechain rows | `isSidechain: true` | folded into one "subagent working" card |

Granularity is message level (the transcript has no token stream); the live feel comes from `progress` events and the status dot. Token streaming exists only in the raw terminal fallback.

### 4.3 Reply reliability

The gateway always passes a `verify` to `sendToSession`: the transcript tail gained a `user` entry containing the sent text. Phone states: sent · sent after retry · "the chat is not running, start a new one?" · "no PTY capacity, try again". Every write carries a `clientId`; the gateway remembers the last 1 000 so an outbox flush that is retried after a dropped connection never double-posts.

### 4.4 When the Mac is off (or Peers Flow is down)

```
phone sees:  Mac reachable + gateway ok   → ONLINE  (live)
             Mac reachable, gateway down  → APP DOWN ("Peers Flow is not running on the Mac")
             Mac unreachable              → MAC OFF ("Mac off since 22:10", last-known state shown greyed)
```

| Concern | Handling |
|---|---|
| Telling the states apart | gateway `/health` fails but the tailnet node answers a TCP connect on the serve port → APP DOWN; nothing answers → MAC OFF. Shown with the time it was last seen |
| Reading while off | the app keeps the last snapshot (list, each opened chat's last page, outcomes) in a local Room database; everything greyed with a banner; no action pretends to succeed |
| Speaking while off | voice capture and cloud transcription work regardless (phone → provider). The result goes to the **outbox** as a card: "waiting for the Mac · to LISA · cancel / edit". Tasks are flushed in order on reconnect; each with `clientId` so a flaky reconnect cannot duplicate them. The app tells you "Mac is back, 2 tasks started" |
| Replies while off | same outbox, pinned to the chat; if the chat is no longer running when the Mac returns, the app asks whether to start a fresh chat with that text |
| Conclusions while the phone was unreachable | per-device replay cursor: on `hello {lastSeq}` the gateway replays newer `outcome` / `needs-you` items; the app shows them grouped ("3 conclusions while you were away") and speaks only the newest unless you tap "read all" |
| Reconnect policy | immediate retry on network change, app open, or tap; otherwise backoff 15 s → 2 min while APP DOWN, 2 → 10 min while MAC OFF (the phone is on 5G most of the day; do not burn battery hammering a dead host) |
| Mac side after an outage | routines already catch up their newest missed slot; the Keeper resumes its chats; the gateway's heartbeat reports the outage window; voice tasks arrive from the phone's outbox, nothing is lost on the Mac side because nothing was ever accepted that was not persisted |
| Making outages rarer | `pmset -c sleep 0 disablesleep 1 autorestart 1`, optional `pmset repeat wakeorpoweron MTWRFSU 07:00` for a scheduled morning power-on, Peers Flow as a launch agent with `KeepAlive`, tailscaled home agent with `KeepAlive` (same as the company one) |
| Long outage | after 6 h offline with queued tasks the app reminds you once ("3 tasks waiting; the Mac has been off since 22:10") |

---

## 5. Android app design

### 5.1 Screens

```
┌ Home ─────────────────────────┐  ┌ Chat ──────────────────────────┐  ┌ Hi LISA ───────────────────┐
│ ● Mac online · load 3.2 · 71% │  │ ← abi · "release notes draft"  │  │  ◉ listening…              │
│ [Needs you 2] [Working 5] [Done]│ │ ● working · Reading diff…     │  │  "sprawdź czy faktury za    │
│ ─ LISA ──────────────────────  │  │ ┌────────────────────────────┐ │  │   wrzesień poszły do księg…"│
│ ● voice: "faktury wrzesień"   │  │ │ You 🎤: …                   │ │  │  sends to: LISA (new chat) │
│   working 12 min · delegating │  │ │ Bash: git diff --stat  ▸    │ │  │  [cancel 3s] [edit] [send] │
│ ─ abi ───────────────────────  │  │ │ Claude: …markdown…         │ │  └────────────────────────────┘
│ ◐ needs you: 2 questions      │  │ └────────────────────────────┘ │
│ ● release notes draft         │  │ ◐ Needs you: Which option?     │  ┌ Mac off ──────────────────┐
│ ─ nutrable ──────────────────  │  │   [A: keep] [B: drop] [other]  │  │ ⏻ Mac off since 22:10     │
│ ○ done · dev-to-staging       │  │ quick: [commit and push it]    │  │ Outbox (2)                │
│                               │  │ ┌──────────────────┐ 🎤  ■    │  │  · to LISA: "faktury…"    │
│ (🎤)  Hi LISA                 │  │ │ type or hold mic │          │  │  · reply → abi: "yes, B"   │
└───────────────────────────────┘  └────────────────────────────────┘  │ last known state below ▾   │
                                                                       └────────────────────────────┘
```

| Screen | Content | Desktop feature it mirrors |
|---|---|---|
| Home | server strip (online / app down / Mac off since…); filters; peers as sections with chats, same dot colours as `statusDotClass`; delegated children nested; dividers as labels; outbox card when non-empty; FAB = Hi LISA | sidebar + pinned list + usage pill |
| Chat | header (peer, title, dot, live `detail`); message stream; Needs-you card with chips from `block.questions` and `suggestedReply`; composer: text, hold-to-talk, Stop, Done; overflow: Fork, raw terminal, open on desktop | session view |
| Hi LISA overlay | side-button long press / tile / FAB / headset; records with end-of-speech detection; cloud transcript (streaming words when using `gpt-live-transcribe`); 3-second cancel window; target = new LISA voice chat, or "continue last voice chat" when one is working; if the Mac is off, "will start when the Mac is back" | SpawnBar, voice-first |
| Outcomes | chronological spoken conclusions and questions, grouped per outage; replay; open chat | notifications bell |
| Routines (later) | today's runs with marks, Run now / Pause | Routines board |
| Settings | pairing/QR, biometric lock, stay-connected, speech provider + key status, TTS voice, quiet hours, wake word (v2), assistant-role status with a deep link to the Samsung setting | Settings modal |

### 5.2 Stack

- Kotlin, Jetpack Compose, minSdk 35, targetSdk 36. Modules: `core-api` (Ktor client, OkHttp WebSocket, kotlinx.serialization types generated from `shared/mobile.ts` so the wire contract is typed once), `voice` (`SttProvider` interface: `OpenAiLiveStt`, `OpenAiFileStt`, `OnDeviceStt`; `Tts` interface: `OpenAiRealtimeTts`, `OnDeviceTts`), `app`.
- Local persistence: Room for snapshot cache, outbox, outcomes; `EncryptedSharedPreferences` for tokens and the speech key.
- Markdown: Markwon; code blocks monospaced, tables scroll horizontally.
- Background: `ConnectionService` (`foregroundServiceType="specialUse"`) holds the WebSocket and runs the outbox flush; quiet persistent notification; backoff per §4.4.
- Notifications: channels `outcomes` (high, own sound), `needs-you` (high), `connection` (min). Your own DND write-up (`~/Desktop/LISA/android-notifications/index.html`) covers letting `needs-you` through at night.
- Samsung setup checklist shown once in the app: Never sleeping apps, battery Unrestricted, default Digital assistant app, side button → Digital assistant.
- Distribution: sideload. CI builds a signed APK next to the DMG in the GitHub release; the gateway also serves `/m/app.apk` + version; the app offers "update from your Mac".

### 5.3 Voice pipeline (no Mac involvement, OpenAI's newest models)

```
hold mic / side button ─► AudioRecord 24 kHz mono PCM chunks
   ─► LIVE (default)   wss://api.openai.com/v1/realtime?intent=transcription
                       session.update { type: "transcription", model: "gpt-live-transcribe",
                         languages: ["pl","en"], keywords: [vocabulary], audio.input.transcription.delay: "low" }
                       delta events ─► words appear on screen as you speak
                       client VAD (silence 1.2 s or release) ─► input_audio_buffer.commit ─► completed event = final text
   ─► FILE (fallback)  POST /v1/audio/transcriptions model=gpt-transcribe, prompt + keywords + languages   ($0.0045/min)
                       used when the WebSocket is not up within ~1.5 s, after a mid-utterance drop, and for outbox items
   ─► OFFLINE          on-device recognizer (Samsung/Google): lower quality, keeps the outbox usable with no internet
   ─► text on screen, 3 s cancel window ─► POST reply | POST conversations  (or outbox if the Mac is off)

   ◄─ outcome event / replay ◄─ gateway extracted <spoken>
   ─► LISA's VOICE     Realtime API session, model gpt-realtime-2.1-mini, text input → streamed PCM audio out,
                       voice fixed per user setting, audio cached per outcome (replay is free)
   ─► OFFLINE / quiet  on-device TTS, or silent notification in quiet hours
```

- Vocabulary: the gateway publishes `GET /vocabulary` (peer names, people, products: "Peers Flow", "LISA", "Vast", "nutrable", "Abilitie", "KSeF", …); the phone caches it and sends it as `keywords` (live) or `prompt` (file). Keywords are hints, one per line, no `<`/`>`.
- Live mode is the default because it is OpenAI's recommended path for live audio and because seeing words land while you speak is the fastest way to catch a mis-transcription before a task starts. It costs about 4× file mode; at 30 minutes a day that is ≈ $15 / month.
- Expected latency: live mode shows partial words within about a second; the final text follows the commit. File mode on a 20-second clip returns in roughly 1–3 s. Phase 3 measures both on Polish/English clips and tunes `audio.input.transcription.delay` (lower = earlier words, higher = better accuracy).
- LISA's voice: one Realtime session per conclusion (seconds of audio), played through the phone and cached; "always speak" or headset/car audio decides whether it plays automatically. The usage policy requires disclosing that the voice is AI-generated: the app says so once in Settings.
- Headset and car: media-button press = Hi LISA; audio routed to the connected device.

### 5.4 "Hi LISA" triggers

| Trigger | Phase | Notes |
|---|---|---|
| Hold the mic in a chat | 2–3 | plain reply |
| FAB on Home | 3 | new voice chat |
| **Side-button long press** (default digital assistant) | 4 | `VoiceInteractionService` + `ROLE_ASSISTANT`; Samsung: Side button → Press and hold → Digital assistant; also unlocks mic-from-background |
| Quick Settings tile, lock-screen notification action, headset button | 4 | cheap, reliable |
| Spoken wake word "Hi LISA" | 5 | openWakeWord / microWakeWord custom model from synthetic samples; only while charging / headset / car unless you decide otherwise; measure false accepts for a week |

---

## 6. LISA as the voice orchestrator

- **Chat kind**: `ChatKind` gains `'voice'`; `mayNotify(kind)` is true for `routine` and `voice`; `spawnConversation({ chatKind: 'voice' })` is reachable from the gateway (desktop composer later if wanted).
- **Skill** (LISA peer, `~/Desktop/LISA/.claude/skills/voice-task/SKILL.md`, invoked as `/voice-task <transcript>` with `spokenAt` so a task queued overnight knows it is stale):
  1. Restate the request in one line (a mis-transcription shows up early).
  2. Plan; delegate to the peer that owns the capability; verify; never ask what the chat can find out.
  3. A decision only you can make: write the question in the chat, `notify` (level `action`), end the turn → `needs-you` with chips on the phone; your spoken/typed answer is the next user message.
  4. Finish with the full write-up, then `<spoken>` (≤ 3 sentences, your language, rounded numbers, no paths) and, if anything is left for you, `<needs>` (one line).
  5. Default contract `until-done` so the Keeper nudges a stalled task instead of leaving it half done.
- **No instant chat**: no typing indicator for a voice task; "LISA is on it · started 09:14 · now: delegating to abi" with the live `detail` line. The conclusion arrives as a notification + speech. "Quick question: …" asks for a one-turn answer, same pipeline.
- **Follow-ups**: speaking from the Outcomes card or the chat sends into the same session; "Hi LISA" from Home always starts a new chat unless you choose "continue".
- Probe in phase 4: Claude Code 2.1.312 lists `--brief` ("Enable SendUserMessage tool for agent-to-user communication"), absent from the published CLI reference. If it is a first-class "message the user" tool, `<spoken>` can move onto it.

---

## 7. Server readiness (phase 0, no app code)

The server is **whatever Mac runs Peers Flow**; the app is macOS-only (node-pty, keychain accounts, `claude --bg`). The M3 Max laptop is fine; a Mac mini later is a drop-in (pair the phone again).

| Item | Action | Why |
|---|---|---|
| Personal tailnet | account, HTTPS toggle, key expiry off, second `tailscaled` launch agent, phone signed in (§3.2) | the transport; $0 |
| Sleep | `sudo pmset -c sleep 0 disablesleep 1 autorestart 1`; stay on mains; optional `pmset repeat wakeorpoweron` | today `sleep 1` on mains |
| Thermals | lid open or on a stand (thermal-throttle incident is in memory) | sustained agent load |
| Login | auto-login + Peers Flow launch agent with `KeepAlive`. FileVault forces a decision: with it on, a power cut parks the Mac at the pre-boot screen until someone types the password | survive reboots |
| Monitoring | gateway `/health` + heartbeat; the phone's status strip; optional daily LISA routine that reports uptime | know when it was down and why |

Acceptance: Mac on mains, lid closed 12 h, Peers Flow still up, `https://home-hub.<tailnet>.ts.net:8443/api/v1/health` answers from the phone's browser; then power the Mac off for an hour and confirm the phone shows "Mac off since …" and recovers by itself.

---

## 8. Phases (walking skeleton first)

| Phase | Deliverable | Mainly touches | Done when | Size |
|---|---|---|---|---|
| **0 Readiness** | personal tailnet live on Mac + phone, serve on, Mac never sleeps, launch agents, outage drill | config, docs | §7 acceptance | S |
| **1 See it** | Gateway read-only: pairing, `/peers`, `/conversations`, `/messages`, `/events`, heartbeat; `MobilePanel` with QR; transcript tailer with tests on real JSONL; Android: pair, Home, Chat read-only, offline states with cached snapshot | `electron/mobile/*`, `shared/mobile.ts`, `MobilePanel.tsx`, `android/` | From the couch, a chat started on the desktop updates live on the phone; switch the Mac off → phone shows "Mac off since", greyed state, recovers alone | L |
| **2 Talk back** | `reply`, `answer` (chips), `stop/done/reopen`, `POST /conversations` (text), `clientId` idempotency, outbox, biometric gate, audit log, revoke | gateway `api.ts`, Android composer + outbox | A reply typed with the Mac off is delivered when it returns, exactly once; a chat started from the phone appears pinned on the desktop | M |
| **3 Voice** | `SttProvider` with `gpt-live-transcribe` (live), `gpt-transcribe` (file) and on-device (offline); hold-to-talk in Chat and Home with words appearing live; vocabulary endpoint; outcomes extraction for any chat; Outcomes screen; `ConnectionService`; replay cursor; notifications; on-device TTS as the first voice; LISA's `transcribe` skill moved to `gpt-transcribe` | Android `voice`, `outcomes.ts`, `heartbeat.ts`, LISA skill | Speak a message and watch it land in the chat as you talk; a chat finishing while the phone is in your pocket vibrates and reads its conclusion; Polish/English clips measured in live and file mode | L |
| **4 LISA front door** | `ChatKind 'voice'`, `/voice-task` skill, `<spoken>`/`<needs>` contract, needs-you round trip, assistant role + Samsung side button, tile, headset button, **LISA's voice on `gpt-realtime-2.1-mini`** with per-outcome audio cache and measured monthly cost | `registry.ts`, `main.ts` spawn, LISA skill, Android assistant service + `voice` | Hold the side button, speak a multi-step task, pocket the phone, hear one conclusion in LISA's voice 10+ minutes later; answer a question by voice and the task continues | M |
| **5 Hands-free** | custom wake word, mic policy (charging/headset/car), quiet hours, digest | Android `voice` | "Hi LISA" across the room while charging; false-accept rate measured for a week | M (R&D) |
| **6 Breadth** | Routines today view, usage + account switch, Keeper status, raw terminal page, Codex chats, multiple devices, APK self-update | gateway + Android | §5.1 parity list all green | M |

### 8.1 Testing

- Unit: transcript tailer on copies of real transcripts; auth/pairing/scopes; outcome extraction; `clientId` dedupe; heartbeat outage math; outbox ordering.
- Gateway integration: `node --test` with a fake store/poller, real HTTP + WS on an ephemeral port.
- Desktop manual: the isolated-instance recipe (userData wrapper, offscreen window), never the live app.
- Android: Compose UI tests with a fake server; emulator ↔ Mac in dev mode; acceptance only on the S25+ over the personal tailnet, on 5G, including the outage drill (Mac off → speak two tasks → Mac on → both start once).
- Safety: unpaired client, revoked token, wrong tailnet identity, replayed `clientId` — all refused and logged, no chat touched.

---

## 9. Decisions still open

1. **Voice when offline or in quiet hours**: fall back to the phone's own voice, or stay silent and only vibrate? Plan default: on-device voice when headphones/car are connected, silent otherwise.
2. **Scheduled power-on** for the Mac (e.g. 07:00 daily) or purely manual. Plan default: `autorestart` only.
3. **Node name** for the Mac on the personal tailnet (public in CT logs). Plan default: `home-hub`.
4. **FileVault** on the server Mac: keep (manual unlock after power cuts) or off. Plan default: keep, documented.

## 10. Risks and how the plan handles them

| Risk | Handling |
|---|---|
| Typing into a TUI drops a keystroke | `sendToSession` + transcript `verify` + `clientId` idempotency + explicit failure states |
| Duplicate tasks after a flaky reconnect | every write carries a `clientId`; gateway remembers the last 1 000 |
| Transcripts of tens of MB | byte-offset tailing, backwards paging |
| First HTTPS request after enabling serve fails | cert pre-warm with `tailscale cert`; phone retries |
| WebSocket through `tailscale serve` | expected (Go reverse proxy); phase 1 day 1 test; fallback = SSE, or our own TLS on the tailnet IP with the cert files serve issued (inbound verified) |
| Two `tailscaled` on one Mac | separate statedir/socket/port; home one has no SOCKS; gateway only ever talks to the home socket; tested in phase 0 before anything else |
| Tailnet key expiry silently dropping the server | key expiry disabled on the Mac node in the admin console |
| Speech key on the phone | dedicated restricted key, Keystore, revocable from the provider console; rotate at pairing |
| OpenAI audio model shutdowns (transcribe family 2027-02-26, Speech API TTS 2027-01-06) | the plan uses only current models (`gpt-live-transcribe`, `gpt-transcribe`, `gpt-realtime-2.1-mini`); the `SttProvider` / `Tts` interfaces isolate a swap; LISA's `transcribe` skill is migrated in phase 3 |
| Live transcription on flaky 5G | the live session falls back to file mode after a 1.5 s connect timeout or a mid-utterance drop; the audio buffer is kept locally until a final text exists |
| Realtime API cost drift for LISA's voice | per-outcome audio cache, conclusions capped at 3 sentences, monthly figure measured in phase 4 and shown in Settings |
| Samsung battery management | Never sleeping apps + Unrestricted + Android 14-policy foreground service; a one-week screen-off test |
| Wake-word quality without Picovoice | phase 5, optional; every earlier trigger is a button |
| Polish/English mixed speech | `languages: ["pl","en"]` / `prompt` vocabulary; confirm window; LISA restates the request first |
| `state.json` / transcript formats are undocumented CLI internals | tolerant parsers, tests on real files, CLI version shown in `/health` |
| The Mac is off for days | outbox persists, one reminder after 6 h, nothing expires silently; tasks carry `spokenAt` so LISA knows they are stale |
