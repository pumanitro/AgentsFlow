// The Claude Code guard hooks Peers Flow ships under <repo>/guards and installs into
// ~/.claude/hooks/peersflow (electron/hookguards). Pure types + IPC names: imported by
// main, preload, the renderer and the browser mock. No runtime dependencies.

export type HookGuardId = 'block-cookie-clearing' | 'block-second-chrome' | 'block-mass-kill' | 'mem-admission' | 'kill-shims';
/** active = check passed and registered · failed = check failed, NOT registered · checking = its check is running · pending = not checked yet in this run */
export type HookGuardState = 'active' | 'failed' | 'checking' | 'pending';
export interface HookGuardRow {
  id: HookGuardId;
  title: string;               // plain words: "Mass-kill guard"
  what: string;                // one sentence a non-engineer understands
  state: HookGuardState;
  registered: boolean;         // hooks: listed in settings.json · kill-shims: prepended to every chat's PATH
  verifiedAt: string | null;   // ISO of the last passing check
  checkMs: number | null;      // how long the check took
  detail: string;              // last lines of the check (≤ 300 chars) or the error; '' when nothing to say
  entry: string;               // absolute path of the installed entry script
}
export interface HookGuardsRun {
  startedAt: string; finishedAt: string | null;
  filesWritten: number; settingsChanged: boolean;
  backup: string | null;       // settings backup written before a change, else null
  supersededMoved: string[];   // absolute destinations of hand-made files moved aside
  error: string | null;        // run-level failure (settings unreadable, install dir unwritable); rows keep their own detail
}
export interface HookGuardsSnapshot {
  at: string;
  phase: 'idle' | 'installing' | 'checking' | 'done' | 'error';
  installDir: string; settingsPath: string;
  shimDir: string | null;      // non-null only while the shims passed and are on spawned chats' PATH
  guards: HookGuardRow[];      // manifest order
  lastRun: HookGuardsRun | null;
}
export const HOOKGUARDS_IPC = { snapshot: 'hookguards:snapshot', recheck: 'hookguards:recheck', updated: 'hookguards:updated' } as const;
