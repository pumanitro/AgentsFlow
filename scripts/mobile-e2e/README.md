# Mobile E2E harness

Drives the Peers Flow phone app on a headless Android emulator against an **isolated** Peers Flow
instance (own userData, offscreen window, dev-mode gateway). The live app is never touched.

## Ports and paths

| What | Value |
|---|---|
| Gateway (dev mode, plain HTTP) | `127.0.0.1:47822`, emulator sees it as `http://10.0.2.2:47822` |
| Side channel (`/info`, `/shot`, `/js`) | `127.0.0.1:47832` |
| Isolated userData | `/Users/iij/.claude/jobs/106e55f3/tmp/pf-mobile-userdata` |
| Scratch peer (named LISA) | `/Users/iij/.claude/jobs/106e55f3/tmp/pf-scratch-peer` |
| Emulator | AVD `peersflow_api34`, serial `emulator-5600` |
| Evidence | `/Users/iij/.claude/plan-and-execute/AgentsFlow-mobile-app/evidence` |

47821 (the plan's example port) is taken on this Mac by `ai-factory/rent-model-5090/refresh_server.py`.
Override with `PF_PORT` / `PF_SIDE` if 47822/47832 are ever busy. All settings live in `env.sh`
(shell) and `config.js` (node); keep them in sync.

## Run order

```bash
cd /Users/iij/Desktop/AgentsFlow/scripts/mobile-e2e
./build-desktop.sh                 # dist/electron always; renderer/out only when stale
node seed-store.js --reset         # fresh userData + scratch peer (keeps nothing)
node launch-isolated.js            # starts the instance, waits for /info and /dev/pair-code
./pair.sh --curl-only              # pairs over HTTP, saves the token, checks /peers and /me
node ws-hello.js                   # WebSocket hello: expects welcome + conversations.updated
./avd.sh create                    # once; never touches the other AVDs
./avd.sh start                     # boots headless (~25 s), animations off, stay awake
/Users/iij/Library/Android/sdk/platform-tools/adb -s emulator-5600 install -r \
  /Users/iij/Desktop/AgentsFlow/android/app/build/outputs/apk/debug/app-debug.apk
./e2e.sh                           # all steps a..h; `./e2e.sh e` resumes from step e
./stop-isolated.sh                 # stops ONLY the pid in the pid file and what it spawned
```

## Scripts

| Script | Does |
|---|---|
| `env.sh`, `config.js` | shared constants; `TRANSCRIPTS` is computed from the scratch peer path the way Claude Code munges a cwd |
| `seed-store.js [--reset]` | scratch peer `CLAUDE.md` + a cheap stub `voice-task` skill; `store.json` with one tracked dir `peer-lisa-test` (LISA), no accounts, rotation off; `services.json` forced to mode `watch` |
| `build-desktop.sh` | `npm run build:electron`; `npm run build:renderer` (export to `renderer/out`, never `.next-dev`) only when sources are newer; refuses while another `next build` runs |
| `launch-isolated.js` | spawns Electron with `wrapper.js`, a scrubbed env, log to `pf-mobile.log`, pid to `pf-mobile.pid` |
| `wrapper.js` | offscreen `BrowserWindow` factory, no dock icon, side channel: `GET /info`, `GET /shot` (PNG), `POST /js` (body = JS) |
| `stop-isolated.sh` | SIGTERM, 5 s, SIGKILL for the recorded pid; then its own children (claude CLI processes excluded) |
| `pair.sh [--curl-only]` | dev pair code, then HTTP pairing or the `peersflow://pair` deep link on the emulator (grants notification/mic/camera first) |
| `ws-hello.js [token]` | 5 s on `/api/v1/events`, exit 0 on `welcome` + `conversations.updated` |
| `avd.sh create\|start\|stop\|status\|screenshot <file>` | emulator lifecycle |
| `ui.py` | uiautomator driver: `dump find wait tap type text exists has-text count swipe back home screenshot`; Compose test tags match as resource-ids |
| `transcript.sh latest\|count-user <text>\|show [file]` | reads the scratch peer's Claude Code transcripts |
| `e2e.sh [step]` | the acceptance run below |

## What each E2E step proves

| Step | Proves | Evidence |
|---|---|---|
| a pair | app data wiped, deep link opens pairing prefilled, submit lands on Home | `01-pairing.png`, `02-home.png` |
| b online | the status strip says the Mac is online | `03-home-online.png` |
| c spawn | Hi LISA from the phone creates a `voice` chat in the isolated store with contract `until-done`; assistant text streams to the phone | `04-hilisa.png`, `05-chat-stream.png` |
| d reply | a reply typed on the phone lands once in the transcript, the HTTP call completes, it is still once 20 s later, and the outbox stays empty | `06-reply.png` |
| e outbox | instance stopped: phone shows "Mac off", message waits in the outbox; after relaunch it lands exactly once and the outbox empties | `07-outbox.png`, `08-outbox-flushed.png` |
| f voice | real OpenAI speech-to-text and text-to-speech smoke test; no `sk-` in the log | `09-voice-smoke.log` |
| g outcomes | the voice chat finished; Outcomes lists it; the app posted a notification | `10-outcomes.png` |
| h desktop | the desktop Mobile panel creates a pairing QR | `11-desktop-mobile-panel.png` |

`e2e.sh` also writes `INDEX.md` and `timings.json` into the evidence folder. Test phrases carry a
per-run tag because `count-user` scans every transcript of the scratch peer, including old runs.

## Why the isolated instance is safe

- Single-instance lock, bridge socket, MCP configs, store and devices are all keyed on userData.
- `PEERSFLOW_HOOKGUARDS=0`: no guard install into `~/.claude/hooks`.
- `PEERSFLOW_WISPR_LEARNER=0`: otherwise a fresh ledger would write the real Wispr dictionary.
- `services.json` mode `watch`: a fresh userData defaults to `live`, which would put the user's
  real Docker projects to sleep and arm wake proxies on their ports.
- No accounts are seeded, so nothing writes the live Keychain. The memory guard stays dry-run.
- The launcher drops `CLAUDE*`, `PEERSFLOW_*`, `AGENTSFLOW_*`, `npm_*` from the inherited env.
- Both instances log into `~/Library/Logs/Peers Flow/main.log`; the harness log is `pf-mobile.log`.

## No-go list

- Never start, stop, signal, CDP-attach or modify the live app or `~/Library/Application Support/Peers Flow`.
- Never `pkill`/`killall` by name; kill only the recorded pid or the emulator by serial.
- Never start a second Google Chrome.app; never clear cookies.
- Never touch the other AVDs; never print the OpenAI key (the pair response carries it as `sttKey`).
- Gradle only through `android/gw`. `rm` only absolute paths under the job tmp or evidence dirs.

## Cleanup

`./stop-isolated.sh` stops the instance. `./avd.sh stop` stops the emulator. The scratch chats'
`claude --bg` sessions belong to the Claude daemon and survive; stop them with `claude stop <short>`
(the short ids are the first 8 characters of the transcript file names under `$TRANSCRIPTS`).
