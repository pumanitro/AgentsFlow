// Wire protocol between Peers Flow (laptop) and the agent script it runs on a
// remote peer's machine. Kept dependency-free with `import type` only, because
// the agent script is shipped to the remote host as a lone file and must not
// pull in anything that exists only inside the app bundle.
import type { FileEntry, GitStatusResult, RemotePeerCache, SearchResult, SlashCommand } from './types';

// Bumped whenever a command or event changes shape; `hello` reports it so a
// stale bundle on the host is detected instead of misparsed.
export const REMOTE_PROTOCOL_VERSION = 1;
// Where `claude` / `node` usually live on a Mac; sshd's non-login PATH has none of them.
export const DEFAULT_EXTRA_PATH = ['~/.local/bin', '/opt/homebrew/bin', '/usr/local/bin'];
// The identity of a host everywhere in the app (status map, Conversation.host).
export function hostKeyOf(spec: { user: string; host: string }): string { return `${spec.user}@${spec.host}`; }
/** A `claude agents --json` row, as the remote CLI prints it (mirrors electron/claude-cli.ts ClaudeAgentJsonRow). */
export interface AgentRow { pid: number; cwd: string; kind: string; startedAt: number; sessionId: string; name?: string; state?: string; status?: string; waitingFor?: string }
/** `~/.claude/jobs/<short>/state.json` as parsed JSON (mirrors electron/claude-cli.ts JobState; keep it structurally identical). */
export interface JobStateJson { state?: string; detail?: string; tempo?: string; output?: { result?: string }; intent?: string; name?: string; nameSource?: string; sessionId?: string; daemonShort?: string; cwd?: string; createdAt?: string; updatedAt?: string; inFlight?: { tasks?: number; queued?: number; kinds?: string[] }; needs?: string; block?: { questions?: { question?: string; options?: { label?: string; description?: string }[] }[] } }
// One user/assistant turn streamed from a remote session transcript (`tail`).
export interface TranscriptRecord { type: 'user' | 'assistant'; text: string; at: string }
// fs.stat reduced to what the app needs; `exists: false` instead of ENOENT.
export interface StatResult { exists: boolean; isFile: boolean; isDirectory: boolean; size: number; mtimeMs: number }
export type AgentCommand =
  | { cmd: 'hello'; id: string }
  | { cmd: 'agents'; id: string }
  | { cmd: 'watch'; id: string; jobs: string[] }                                   // REPLACES the watched set
  | { cmd: 'job'; id: string; short: string }
  | { cmd: 'spawn'; id: string; cwd: string; prompt: string; args: string[] }      // runs: claude --bg <args...> <prompt>
  | { cmd: 'stop'; id: string; short: string }
  | { cmd: 'rm'; id: string; short: string }
  | { cmd: 'trust'; id: string; dir: string }
  | { cmd: 'skills'; id: string; dir: string | null }
  | { cmd: 'peerinfo'; id: string; dir: string }
  | { cmd: 'tail'; id: string; sessionId: string; cwd: string }
  | { cmd: 'untail'; id: string; sessionId: string }
  | { cmd: 'write'; id: string; path: string; contentBase64: string; mode?: number }
  | { cmd: 'read'; id: string; path: string; maxBytes?: number }
  | { cmd: 'stat'; id: string; path: string }
  | { cmd: 'list'; id: string; dir: string }
  | { cmd: 'gitstatus'; id: string; dir: string }
  | { cmd: 'mkfile'; id: string; path: string }
  | { cmd: 'rename'; id: string; from: string; to: string }
  | { cmd: 'remove'; id: string; path: string }
  | { cmd: 'search'; id: string; dir: string; query: string; caseSensitive?: boolean; isRegex?: boolean }
  | { cmd: 'fswatch'; id: string; dir: string }
  | { cmd: 'fsunwatch'; id: string; dir: string }
  | { cmd: 'exec'; id: string; argv: string[]; cwd?: string; timeoutMs?: number };
export type AgentEvent =
  | { t: 'hello'; id: string; protocol: number; hostname: string; home: string; pid: number; claudeVersion: string; nodeVersion: string }
  | { t: 'agents'; id: string; at: number; rows: AgentRow[] }                       // id '' = unsolicited push
  | { t: 'job'; id: string; short: string; state: JobStateJson | null; mtimeMs: number }   // id '' = watcher push
  | { t: 'spawned'; id: string; daemonShort: string | null; raw: string; code: number }
  | { t: 'done'; id: string; changed?: boolean }
  | { t: 'error'; id: string; message: string }
  | { t: 'skills'; id: string; entries: SlashCommand[] }
  | { t: 'peerinfo'; id: string; cache: Omit<RemotePeerCache, 'refreshedAt'> }
  | { t: 'transcript'; id: ''; sessionId: string; records: TranscriptRecord[] }
  | { t: 'file'; id: string; contentBase64: string; size: number; truncated: boolean }
  | { t: 'stat'; id: string; result: StatResult }
  | { t: 'list'; id: string; entries: FileEntry[] }
  | { t: 'gitstatus'; id: string; result: GitStatusResult }
  | { t: 'search'; id: string; result: SearchResult }
  | { t: 'fsevent'; id: ''; dir: string }
  | { t: 'exec'; id: string; code: number; stdout: string; stderr: string; timedOut: boolean };
