# Codex in Peers Flow

Select **Codex · default** in the bottom composer, choose a tracked directory,
and send a prompt. Leave the model field empty to use your configured Codex model,
or enter a model ID your account can access. Claude selections keep using Claude.

Codex uses your existing CLI sign-in. Run `codex login` once if needed; no API key
or credential copy is required by Peers Flow. Project `.codex/config.toml`, user
configuration, trusted plugins, and `AGENTS.md` are loaded by Codex. If a repository
has only `CLAUDE.md`, the peer bootstrap tells the agent to read it as project guidance.
Configured connections still need to be authenticated separately for each provider.

## Setup

Use Node 20+ and Codex CLI 0.154.0 or newer. Claude is needed only for Claude sessions
or delegation to Claude. On macOS, the app discovers Homebrew, `~/.local/bin`, nvm,
Volta, mise, and asdf installations when launched from Finder. Existing PATH order
wins. `CODEX_BIN` and `CLAUDE_BIN` can specify an alternate executable.

```sh
npm ci
npm run rebuild
npm test
npm run build
npm start
```

For a local macOS application bundle, run `npm exec electron-builder -- --dir --mac`.
The result is under `release/`. This is a local development build, not a notarized release.

Data stays in `~/Library/Application Support/Peers Flow/`. `AGENTSFLOW_USER_DATA`
can select an existing separate data directory for tests. Do not point two running
instances at the same store. Repository-specific setup notes belong in the ignored
`SETUP.local.md`; never commit user paths, account data, or sessions.

## Terminal colors

Embedded shells and Claude terminal views advertise `xterm-256color` and
`COLORTERM=truecolor`. Launcher flags such as `NO_COLOR=1` are cleared for interactive
terminals, and all sixteen ANSI theme colors are defined. Color-aware commands can
use the full 256-color palette or 24-bit RGB. Shell startup files can still choose
their own color preferences; no global shell configuration is changed.

## Accounts and usage

The **Accounts** and **Usage** panels show Claude and Codex separately within the
same sidebar sections. Codex displays the current CLI login, subscription, and
live quota windows. Codex account switching/rotation is not part of the Claude pool.

Use **Add Claude account**, enter the email and an optional label such as Personal
or Work, and complete the browser sign-in. Select the intended personal subscription
or organization. Multiple memberships may use the same email and Anthropic account
UUID; each organization gets a separate entry and credential vault. Adding an already
saved membership is rejected without changing the existing vault. Existing vault
paths remain unchanged. Labels, organization names, and plans distinguish the rows.

Adding a membership does not switch the current login. Click its row to switch;
with two saved Claude memberships, enable automatic switching if desired. Switching
changes the machine's Claude CLI login, including Claude sessions outside Peers Flow.

## Conversations and peers

- Open a pinned Codex row for its chat, file tree, editor, and shell. Leaving the chat
  does not stop the agent. The desktop app must remain running for active Codex turns.
- **Stop** interrupts the active turn. **Fork** makes a new Codex thread with the saved
  conversation history. Reopening after an app restart resumes the original thread.
- Questions and tool approvals appear in the chat. Each approval applies once. Codex
  sessions use workspace-write sandboxing and on-request approval, reviewed by the user;
  this does not change global Codex settings. Claude retains the upstream permission
  behavior, including its background-launch `bypassPermissions` mode.
- Paste images in either the initial composer or a Codex follow-up. They are passed as
  native Codex image inputs and tracked with the conversation's attachments.
- The MCP `delegate` tool accepts an optional provider. For example:

```json
{
  "directory": "Other project",
  "provider": "codex",
  "goal": "Inspect the test failures and return the affected files. Do not edit files.",
  "deliverable": "A short list of files and supporting evidence"
}
```

Omitting `provider` uses the calling conversation's provider. A delegated session
appears below its parent and returns its final text through the same bridge used by
Claude. Delegation is limited to one hop. The bridge must be available: a bridge
failure never silently launches a second agent or switches providers.

## Implementation

`electron/codex-protocol.ts` owns one local `codex app-server --stdio` child and its
JSON-RPC connection. `electron/codex-agent.ts` routes events and requests by thread ID,
keeps independent turn state, and loads history through `thread/items/list` pagination.
`renderer/components/CodexChat.tsx` renders the transcript and approval forms.

The normal Peers Flow store holds provider, thread ID, model, and final-result metadata.
Codex remains the source of truth for conversation history. Legacy records without a
provider load as Claude. Codex sessions never enter the Claude job poller, reaper,
account rotation, or terminal attach paths. The MCP configuration is scoped to each
root conversation and rebuilt on resume/fork.

Official protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server)
and [CLI options](https://learn.chatgpt.com/docs/cli/reference).

## Verification — 2026-09-11

The account update passes 296 tests, including Keychain credential isolation across
organizations belonging to one account UUID, duplicate membership rejection, unique
vaults for repeated emails, and Codex account/usage parsing. A desktop check accepted
another login attempt for an existing email and cancelled it without touching saved
memberships. Claude and Codex each completed a live test reply. Codex account/usage
reads succeeded; Claude's usage endpoint returned HTTP 429 during that check, while
its session authentication continued to work.


Verified on macOS arm64, Node 24.18.0, Electron 32.3.3, Claude Code 2.1.268, and Codex
0.154.0. The production renderer and Electron builds pass. Automated tests cover
concurrent conversations, approval ownership, stale requests, interruption, history,
forks, server disconnect/reconnect, bounded tool output, and CLI discovery.

Live desktop checks covered:

- A Codex reply, saved-history reload, and follow-up turn.
- Native approval cards, including accepting the local peer tools through the UI.
- Codex delegating to Claude and returning the child's result.
- Claude delegating to Codex and returning the child's result.
- A fork with a new thread ID and the original transcript.

## Current limits and inherited maintenance

- Account pool/rotation and per-conversation performance attribution remain
  Claude features. Both providers have current-login usage meters. Machine totals include all processes.
- Codex uses a native chat view; it is not the Codex terminal UI. Terminal slash
  commands such as `/model` are not interpreted. Set a model in the initial composer.
- Codex project/worktree directory changes are not yet reflected automatically in the
  file sidebar. The sidebar stays rooted at the selected peer.
- Form elicitation supports primitive fields (text, number, boolean, enums). Exotic
  nested MCP forms and unimplemented future server requests are not supported.
- The repository's existing Electron/Next dependency stack needs a separate update.
  A production dependency audit on 2026-09-11 reported six affected packages (one critical,
  four high, one moderate), including Next.js. The production UI is a static export;
  this build does not run a production Next.js HTTP server. That limits applicability
  of server-specific advisories but is not a security clearance for the dependency set.
