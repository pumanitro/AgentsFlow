// The guard installer: puts the Claude Code guards Peers Flow ships (<repo>/guards)
// into ~/.claude/hooks/peersflow and registers the ones that work.
//
// One pass (runInstall):
//   1. installing — copies SHARED_FILES + every guard's files (byte-compare, so a
//      second pass writes nothing);
//   2. checking — the kill shims first (they gate every chat's PATH via
//      setKillShimDir), then each hook guard in manifest order, one child at a
//      time; a snapshot goes out after every row;
//   3. settings — only after all checks: our PreToolUse entries are rewritten to
//      exactly the PASSING guards, the hand-made entries they supersede are
//      dropped, a backup is taken before any write, and the superseded hand-made
//      files are moved aside (never deleted). A failing guard is unregistered and
//      its hand-made predecessor is left alone;
//   4. done (or error, with lastRun.error).
// Never throws. Every command is an async exec with a timeout — never a sync
// child process (a synchronous probe has frozen this app's main thread before).
// Imports only node builtins (never `electron`), so it loads under plain node in
// tests and scripts/pf-hookguards-check.mjs.

import * as fs from 'fs';
import * as path from 'path';
import type { HookGuardRow, HookGuardsRun, HookGuardsSnapshot } from '../../shared/hookguards';
import { supersedeHandmade, syncShippedFiles } from './files';
import { HOOK_GUARDS, SHARED_FILES, SHIM_BIN_REL } from './manifest';
import type { HookGuardSpec } from './manifest';
import { mergePreToolUse } from './settings-merge';
import type { HookGroup } from './settings-merge';
import { readSettingsJson, writeSettingsJsonWithBackup } from './settings-file';
import { killShimDir, setKillShimDir } from './shim-path';
import { defaultExec, verifyGuard } from './verify';
import type { Exec } from './verify';

export type { Exec, ExecResult } from './verify';

export interface HookGuardsDeps {
  shippedDir: string;        // <repo>/guards or <app.asar>/guards — read with fs.readFileSync ONLY (works inside asar; copyFileSync does not)
  installDir: string;        // ~/.claude/hooks/peersflow
  supersededDir: string;     // ~/.claude/hooks/peersflow-superseded
  handmadeHooksDir: string;  // ~/.claude/hooks
  settingsPath: string;      // ~/.claude/settings.json
  backupDir: string;         // ~/.claude/backups
  env: () => NodeJS.ProcessEnv;                 // selftests run with this (agentEnvironment(): jq/node/python3 on PATH)
  onSnapshot: (s: HookGuardsSnapshot) => void;
  log?: (msg: string, detail?: Record<string, unknown>) => void;
  exec?: Exec;               // test seam; default = async execFile with timeout, NEVER a sync child process
  now?: () => number;
  startDelayMs?: number;     // default 1_000
}

const START_DELAY_MS = 1_000;

let deps: HookGuardsDeps | null = null;
let timer: NodeJS.Timeout | null = null;
let inflight: Promise<HookGuardsSnapshot> | null = null;
let snapshot: HookGuardsSnapshot | null = null;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pendingRow(spec: HookGuardSpec, installDir: string): HookGuardRow {
  return {
    id: spec.id, title: spec.title, what: spec.what, state: 'pending', registered: false,
    verifiedAt: null, checkMs: null, detail: '', entry: installDir ? path.join(installDir, spec.files[0]) : '',
  };
}

function idleSnapshot(d: HookGuardsDeps | null, nowMs: number): HookGuardsSnapshot {
  const installDir = d?.installDir ?? '';
  return {
    at: new Date(nowMs).toISOString(), phase: 'idle', installDir, settingsPath: d?.settingsPath ?? '',
    shimDir: killShimDir(), guards: HOOK_GUARDS.map((s) => pendingRow(s, installDir)), lastRun: null,
  };
}

/** A passing selftest's summary line (`passed=33 failed=0`), else ''. */
function passSummary(detail: string): string {
  const lines = detail.split('\n').filter((l) => /pass/i.test(l));
  return lines.length ? lines[lines.length - 1] : '';
}

/** Our desired PreToolUse groups: one per PASSING hook guard, manifest order, C2 shape. */
function desiredGroups(passing: Set<string>): HookGroup[] {
  return HOOK_GUARDS.filter((s) => s.hook && passing.has(s.id)).map((s) => ({
    matcher: s.hook!.matcher,
    hooks: [{ type: 'command', command: s.hook!.command, timeout: s.hook!.timeout, statusMessage: s.hook!.statusMessage }],
  }));
}

function registeredIn(groups: HookGroup[], spec: HookGuardSpec): boolean {
  if (!spec.hook) return false;
  return groups.some((g) => Array.isArray(g.hooks) && g.hooks.some((h) => h?.command === spec.hook!.command));
}

/** One full pass, no timers (tests + scripts/pf-hookguards-check.mjs). Never throws. */
export async function runInstall(d: HookGuardsDeps): Promise<HookGuardsSnapshot> {
  const now = d.now ?? Date.now;
  const exec = d.exec ?? defaultExec;
  const log = d.log ?? (() => {});
  const iso = () => new Date(now()).toISOString();
  const run: HookGuardsRun = { startedAt: iso(), finishedAt: null, filesWritten: 0, settingsChanged: false, backup: null, supersededMoved: [], error: null };
  const rows = HOOK_GUARDS.map((s) => pendingRow(s, d.installDir));
  const publish = (phase: HookGuardsSnapshot['phase']): HookGuardsSnapshot => {
    const s: HookGuardsSnapshot = {
      at: iso(), phase, installDir: d.installDir, settingsPath: d.settingsPath, shimDir: killShimDir(),
      guards: rows.map((r) => ({ ...r })), lastRun: { ...run, supersededMoved: [...run.supersededMoved] },
    };
    snapshot = s;
    try { d.onSnapshot(s); } catch (err) { log(`onSnapshot threw: ${errMsg(err)}`); }
    return s;
  };
  const finish = (phase: 'done' | 'error'): HookGuardsSnapshot => {
    run.finishedAt = iso();
    return publish(phase);
  };

  try {
    // 1. installing
    publish('installing');
    try {
      const rels = [...SHARED_FILES, ...HOOK_GUARDS.flatMap((s) => s.files)];
      for (const sub of ['lib', SHIM_BIN_REL]) fs.mkdirSync(path.join(d.installDir, sub), { recursive: true });
      const r = syncShippedFiles(d.shippedDir, d.installDir, rels);
      run.filesWritten = r.written.length;
      if (r.written.length) log(`installed ${r.written.length} file(s)`, { written: r.written });
    } catch (err) {
      run.error = `install failed: ${errMsg(err)}`;
      log(run.error);
      setKillShimDir(null);
      for (const row of rows) { row.state = 'failed'; row.detail = run.error; }
      return finish('error');
    }

    // 2. checking — kill-shims first, then the hooks in manifest order, sequentially
    publish('checking');
    const order = [...HOOK_GUARDS.filter((s) => s.id === 'kill-shims'), ...HOOK_GUARDS.filter((s) => s.id !== 'kill-shims')];
    const passing = new Set<string>();
    for (const spec of order) {
      const row = rows.find((r) => r.id === spec.id)!;
      row.state = 'checking';
      publish('checking');
      let res: { ok: boolean; detail: string; ms: number };
      try {
        res = await verifyGuard(spec, d.installDir, exec, d.env());
      } catch (err) {
        res = { ok: false, detail: errMsg(err), ms: 0 };
      }
      row.checkMs = res.ms;
      if (res.ok) {
        passing.add(spec.id);
        row.state = 'active';
        row.verifiedAt = iso();
        row.detail = passSummary(res.detail);
        log(`${spec.id} ok ${(res.ms / 1000).toFixed(1)}s`);
      } else {
        row.state = 'failed';
        row.verifiedAt = null;
        row.detail = res.detail;
        log(`${spec.id} FAILED: ${res.detail.split('\n')[0] ?? ''}`);
      }
      if (spec.id === 'kill-shims') {
        setKillShimDir(res.ok ? path.join(d.installDir, SHIM_BIN_REL) : null);
        row.registered = killShimDir() !== null;
      }
      publish('checking');
    }

    // 3. settings
    const read = readSettingsJson(d.settingsPath);
    if (!read.ok) {
      run.error = read.error;
      log(`settings not touched: ${read.error}`);
      return finish('error');
    }
    const json = read.json;
    const hooksVal = json.hooks;
    if (hooksVal !== undefined && (!hooksVal || typeof hooksVal !== 'object' || Array.isArray(hooksVal))) {
      run.error = `${d.settingsPath}: "hooks" is not an object`;
      log(`settings not touched: ${run.error}`);
      return finish('error');
    }
    const hooksObj = (hooksVal ?? {}) as Record<string, unknown>;
    const ptu = hooksObj.PreToolUse;
    if (ptu !== undefined && !Array.isArray(ptu)) {
      run.error = `${d.settingsPath}: "hooks.PreToolUse" is not an array`;
      log(`settings not touched: ${run.error}`);
      return finish('error');
    }
    const supersedeNames = [...new Set(HOOK_GUARDS.filter((s) => passing.has(s.id)).flatMap((s) => s.supersedes))];
    const merged = mergePreToolUse((ptu ?? []) as HookGroup[], desiredGroups(passing), supersedeNames);
    let settingsOk = true;
    let finalGroups = (ptu ?? []) as HookGroup[];
    if (merged.changed) {
      try {
        const next = { ...json, hooks: { ...hooksObj, PreToolUse: merged.groups } };
        const w = writeSettingsJsonWithBackup(d.settingsPath, d.backupDir, next, now());
        run.settingsChanged = true;
        run.backup = w.backup;
        finalGroups = merged.groups;
        log(`settings written, backup ${w.backup ?? '(none: new file)'}`);
      } catch (err) {
        settingsOk = false;
        run.error = `settings write failed: ${errMsg(err)}`;
        log(run.error);
      }
    } else {
      log('settings unchanged');
    }
    for (const spec of HOOK_GUARDS) {
      if (!spec.hook) continue;
      const row = rows.find((r) => r.id === spec.id)!;
      row.registered = settingsOk && registeredIn(finalGroups, spec);
    }

    if (settingsOk && supersedeNames.length) {
      try {
        const moved = supersedeHandmade(d.handmadeHooksDir, d.supersededDir, supersedeNames, now(), d.installDir);
        for (const m of moved) {
          run.supersededMoved.push(m.to);
          log(`moved aside ${m.from} -> ${m.to}`);
        }
      } catch (err) {
        run.error = `moving superseded hooks failed: ${errMsg(err)}`;
        log(run.error);
      }
    }
    return finish(run.error ? 'error' : 'done');
  } catch (err) {
    run.error = run.error ?? errMsg(err);
    log(`install pass failed: ${run.error}`);
    return finish('error');
  }
}

function runCoalesced(d: HookGuardsDeps): Promise<HookGuardsSnapshot> {
  if (inflight) return inflight;
  inflight = runInstall(d).finally(() => { inflight = null; });
  return inflight;
}

/** Schedules the first pass after startDelayMs; a second call while started is a no-op. Never throws. */
export function startHookGuards(d: HookGuardsDeps): void {
  if (deps) return;
  deps = d;
  timer = setTimeout(() => {
    timer = null;
    void runCoalesced(d).catch(() => {});
  }, d.startDelayMs ?? START_DELAY_MS);
  timer.unref?.();
}

/** Clears the pending timer; a pass in flight finishes. */
export function stopHookGuards(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  deps = null;
}

export function getHookGuardsSnapshot(): HookGuardsSnapshot {
  return snapshot ?? idleSnapshot(deps, (deps?.now ?? Date.now)());
}

/** A full pass again; joins a pass already in flight. Before startHookGuards: the current snapshot. */
export function recheckHookGuards(): Promise<HookGuardsSnapshot> {
  if (inflight) return inflight;
  if (!deps) return Promise.resolve(getHookGuardsSnapshot());
  return runCoalesced(deps);
}

export function __resetHookGuardsForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  deps = null;
  inflight = null;
  snapshot = null;
  setKillShimDir(null);
}
