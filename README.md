# AgentsFlow

![Home – pinned conversations and tracked directories](./assets/screenshots/home.png)
![Embedded terminal attached to a background session](./assets/screenshots/terminal.png)
![File editor with git-aware sidebar](./assets/screenshots/file-editor.png)

Electron + Next.js desktop UI for **Claude Code's background agents** — track only the sessions this app launches, treat them like a to-do list, and inspect the working tree of each one without leaving the window.

> Status: early. Built against Claude Code CLI **v2.1.139+** (`claude agents` / `claude --bg`).

## Why

Built to scratch three specific itches working with Claude Code day-to-day:

1. **Agent management in the CLI is ugly.** `claude agents` is functional but unpleasant to live in — no real overview, no pinning, no per-directory grouping. AgentsFlow turns background sessions into a visual to-do list scoped to the agents *you* launched from this app.
2. **No native Markdown editor.** When an agent is working in a repo full of `.md` files, there's nowhere to read or edit them comfortably without alt-tabbing to another app. AgentsFlow ships an Obsidian-style live Markdown editor inline, next to the chat.
3. **No tree preview.** Watching agents touch a codebase is hard without seeing the working tree. AgentsFlow shows a `git status`-colored file tree per session, with an embedded shell, so you can inspect changes the moment the agent finishes — no terminal-juggling.

## Highlights

- **Pinned conversations as a to-do list** — every spawn is pinned by default; click ✓ Done to archive into the directory's history. ↻ Reopen brings it back.
- **Per-directory history** — ⋯ menu on each tracked-directory card opens the full list (pinned + done) for that repo.
- **Live status + auto-titles** — title comes from Claude's auto-generated short name (e.g. "joke delivery response"), description streams in from `state.json/detail` via `fs.watch` so changes appear within tens of milliseconds.
- **Embedded terminal** — clicking a pinned row attaches to that session via `claude attach <short>` inside an `xterm.js` panel. `⌘+←` (or the Back button) detaches; `⌘+→` from home opens the focused row.
- **File / git sidebar** — every session view has a left sidebar with two modes:
  - **Changes** — `git status` tree, colored by status (red = untracked, yellow = modified, green = added, etc.)
  - **Files** — full project tree, with the same git colors layered on, ignored files & dirs faded
  - Expand/collapse state is persisted per conversation.
- **Image paste** — paste an image into the spawn input; it's saved to `<dir>/.agentsflow/images/` and the absolute path is appended to the prompt so Claude can `Read` it. Auto-cleaned when the conversation is removed (and orphan-swept on startup).
- **Help modal** — `ⓘ` button in the top right lists all shortcuts and shows the app version.

## Requirements

- Node 18+
- Claude Code CLI v2.1.139+ on `$PATH` (`claude --version`)
- macOS (the only platform tested so far)

## Develop

```bash
npm install
npm run rebuild      # rebuild node-pty against Electron headers (one-time)
npm run dev          # next dev + electron, hot-reloads renderer
```

DevTools auto-opens (detached) in dev mode.

## Production build & run

```bash
npm run build        # next build (static export) + tsc Electron
npm run start        # launch Electron with the prebuilt renderer
```

## How it works

- Each dispatched session is launched as `claude --bg --permission-mode bypassPermissions <prompt>` in the chosen tracked directory; no `--name` is passed so Claude auto-generates the title.
- The session's `daemonShort` is parsed from `claude --bg` stdout; the full `sessionId` is resolved by polling `claude agents --json` (stdout is read via a tempfile to dodge an 8 KB pipe-truncation issue in Electron).
- Per-session metadata is read directly from `~/.claude/jobs/<short>/state.json` — watched with `fs.watch` for instant updates, with a 30-second fallback tick from `claude agents --json` to catch missed events.
- Attaching spawns `claude attach <short>` via `node-pty` and pipes it to xterm; detaching kills only the PTY — the background session keeps running.

## Storage

A single JSON file under Electron's `userData` directory.
- macOS: `~/Library/Application Support/AgentsFlow/store.json` (or `…/Electron/store.json` if the productName isn't set).

Per-conversation tree-expand state is in the renderer's `localStorage`.

## Keyboard

| Where | Keys | What |
|---|---|---|
| Home | `↑` / `↓` | Move focus between pinned conversations |
| Home | `⌘+→` (or `Alt+→`) | Open the focused conversation's terminal |
| Terminal | `⌘+←` (or `Alt+←`) | Detach and return to home |
| Terminal | `Shift+Esc` | Same |
| Anywhere | `Esc` | Close modal |

## License

MIT. See [LICENSE](./LICENSE).
