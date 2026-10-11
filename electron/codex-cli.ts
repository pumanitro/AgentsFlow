import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { agentEnvironment, cliPath } from './cli-environment';

// Which Codex CLI this app runs, and why it is not simply `codex` on PATH.
//
// The app-server is a long-lived detached process; the chat pane is a fresh
// `codex resume --remote` every time it is opened. Resolving both by bare name
// ties every open chat to whatever the global install looks like at that
// instant — and a global install is not a stable thing:
//
//  - 2026-09-18: the TUI in a chat pane offered its self-update, Enter took
//    the default ("Update now"), and `npm install -g @openai/codex` started
//    INSIDE that pane's PTY. The pane closed a second later, the PTY was killed
//    and npm died between retiring 0.154.0 and linking 0.155.0: no `codex` on
//    PATH, a 13 MB stub where the 222 MB binary belongs. Every Codex chat then
//    exited 1 on open, while the threads themselves ran on untouched in the
//    daemon.
//  - A SUCCESSFUL update is not safe either. npm deletes the old package, which
//    is the directory the running daemon loads `codex-code-mode-host` and its
//    resources from, and the next pane is a new-version TUI on an old-version
//    server.
//
// Pinning is not staying behind. `codexUpgradeAvailable` notices a newer healthy
// global install, and `codex-upgrade.ts` restarts the server onto it as soon as
// nothing is running — so the app follows every update within minutes, but only
// ever onto an install that has finished and runs.
//
// So the CLI is pinned per daemon. When a server is started, the healthy global
// install is cloned into `<userData>/codex/cli/<version>/` (an APFS clone: no
// bytes copied) and the server runs from that copy; a record beside the pidfile
// names it, and every later TUI / `codex queue` uses the record. A global
// update — finished, interrupted or still running — cannot reach a running
// chat. The new version is picked up the next time a server starts. If the
// global install is broken at that moment, the newest kept snapshot is used
// instead of failing.

/** `<serverDir>/cli` — one directory per pinned CLI version. */
export function codexCliDir(serverDir: string): string {
  return path.join(serverDir, 'cli');
}

/** Beside the pidfile: which CLI the app-server behind this socket was started with. */
export function codexCliRecordPath(serverDir: string): string {
  return path.join(serverDir, 'app-server.cli.json');
}

export type CodexCliSource =
  | 'env'                // CODEX_BIN — an explicit override is used verbatim
  | 'snapshot'           // private clone of the healthy global npm install
  | 'global'             // a non-npm install (Homebrew, standalone): pinned by real path
  | 'fallback-snapshot'; // the global install is broken; an older kept clone

export interface CodexCli {
  /** Absolute path to spawn. */
  bin: string;
  /** `X.Y.Z` from `codex --version`, or '' for an unprobed CODEX_BIN. */
  version: string;
  source: CodexCliSource;
}

/** Snapshots kept after a pin: the pinned one plus one to fall back on. */
const KEEP_SNAPSHOTS = 2;
/**
 * How long an install must have been left alone before it is followed. npm
 * writes the launcher's package.json early and the 222 MB binary late; a version
 * read in between is a half-written install that happens to have a name.
 */
export const INSTALL_SETTLE_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;

/** Process boundary, as a seam: tests swap these instead of touching a real install. */
export const cliSystem = {
  /** The machine's own `codex`, wherever PATH discovery finds it. */
  findGlobal: (): string | null => findOnPath('codex'),
  /** `<bin> --version` → `X.Y.Z`, or null when it cannot run (missing, truncated, killed). */
  version: (bin: string): Promise<string | null> => new Promise((resolve) => {
    execFile(bin, ['--version'], { env: agentEnvironment(), timeout: VERSION_TIMEOUT_MS }, (error, stdout) => {
      const match = error ? null : /(\d+\.\d+\.\d+[^\s]*)/.exec(String(stdout));
      resolve(match ? match[1] : null);
    });
  }),
  /** Copy a directory tree; `-c` clones on APFS, and plain `-R` covers everything else. */
  copyTree: (from: string, to: string): Promise<void> => new Promise((resolve, reject) => {
    execFile('/bin/cp', ['-cR', from, to], (cloneError) => {
      if (!cloneError) return resolve();
      fs.rmSync(to, { recursive: true, force: true });
      execFile('/bin/cp', ['-R', from, to], (copyError) => (copyError ? reject(copyError) : resolve()));
    });
  }),
};

/** First executable `name` on `searchPath`, as an absolute path. */
export function findOnPath(name: string, searchPath = cliPath()): string | null {
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

/**
 * The `@openai/codex` package directory behind an npm-style launcher
 * (`…/@openai/codex/bin/codex.js`), or null for any other kind of install.
 * Only this layout is self-contained enough to clone: the launcher resolves the
 * native binary from its own `node_modules`.
 */
export function npmPackageRoot(realBin: string): string | null {
  const binDir = path.dirname(realBin);
  const root = path.dirname(binDir);
  const isLauncher = path.basename(realBin) === 'codex.js' && path.basename(binDir) === 'bin';
  return isLauncher && path.basename(root) === 'codex' && path.basename(path.dirname(root)) === '@openai' ? root : null;
}

function snapshotBin(serverDir: string, version: string): string {
  return path.join(codexCliDir(serverDir), version, 'bin', 'codex.js');
}

/** Kept snapshot versions, newest first. */
function snapshotVersions(serverDir: string): string[] {
  let names: string[] = [];
  try { names = fs.readdirSync(codexCliDir(serverDir)).filter((name) => /^\d+\.\d+\.\d+/.test(name)); }
  catch { return []; }
  return names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

async function snapshot(serverDir: string, packageRoot: string, version: string): Promise<string> {
  const bin = snapshotBin(serverDir, version);
  if (await cliSystem.version(bin) === version) return bin;
  const target = path.dirname(path.dirname(bin));
  // Copy beside the target, prove the copy runs, and only then rename it into
  // place: nothing half-written or unrunnable ever sits under a version name —
  // the failure this file exists to absorb. (A copy that is complete but does
  // not run is a layout whose native binary lives outside the launcher's
  // package, e.g. hoisted beside it.)
  const staging = path.join(codexCliDir(serverDir), `.staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(codexCliDir(serverDir), { recursive: true });
  try {
    await cliSystem.copyTree(packageRoot, staging);
    if (await cliSystem.version(path.join(staging, 'bin', 'codex.js')) !== version) {
      throw new Error(`a copy of ${packageRoot} does not run on its own`);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return bin;
}

function prune(serverDir: string, keep: string): void {
  const versions = snapshotVersions(serverDir);
  const kept = new Set([keep, ...versions.filter((v) => v !== keep).slice(0, KEEP_SNAPSHOTS - 1)]);
  for (const version of versions) {
    if (!kept.has(version)) fs.rmSync(path.join(codexCliDir(serverDir), version), { recursive: true, force: true });
  }
  try {
    for (const name of fs.readdirSync(codexCliDir(serverDir))) {
      if (name.startsWith('.staging-')) fs.rmSync(path.join(codexCliDir(serverDir), name), { recursive: true, force: true });
    }
  } catch { /* no snapshots yet */ }
}

function readRecord(serverDir: string): CodexCli | null {
  try {
    const record = JSON.parse(fs.readFileSync(codexCliRecordPath(serverDir), 'utf8'));
    return typeof record?.bin === 'string' && path.isAbsolute(record.bin) ? record as CodexCli : null;
  } catch { return null; }
}

async function resolve(serverDir: string): Promise<CodexCli> {
  const globalBin = cliSystem.findGlobal();
  const version = globalBin ? await cliSystem.version(globalBin) : null;
  if (globalBin && version) {
    const realBin = fs.realpathSync(globalBin);
    const packageRoot = npmPackageRoot(realBin);
    if (!packageRoot) return { bin: realBin, version, source: 'global' };
    try {
      return { bin: await snapshot(serverDir, packageRoot, version), version, source: 'snapshot' };
    } catch (error) {
      // No private copy (disk full, odd filesystem): the live install still works today.
      console.warn('[agentsflow][codex-cli] could not snapshot the Codex CLI — running the global install', { packageRoot, error: (error as Error).message });
      return { bin: realBin, version, source: 'global' };
    }
  }
  for (const kept of snapshotVersions(serverDir)) {
    const bin = snapshotBin(serverDir, kept);
    if (await cliSystem.version(bin) === kept) {
      console.warn('[agentsflow][codex-cli] the global Codex CLI is missing or broken — using the kept snapshot', { globalBin, kept });
      return { bin, version: kept, source: 'fallback-snapshot' };
    }
  }
  throw new Error(globalBin
    ? `The Codex CLI at ${globalBin} does not run (an interrupted update leaves it like this). Reinstall it: npm install -g @openai/codex`
    : 'The Codex CLI is not installed or not on PATH. Install it: npm install -g @openai/codex — or set CODEX_BIN.');
}

// Two callers pinning the same server must not race two copies into one directory.
const inflight = new Map<string, Promise<CodexCli>>();

/**
 * Choose and record the CLI for a server that is ABOUT TO START. This is the
 * only moment the app moves to a newer Codex: a running server keeps the
 * version it was started with until it is next started.
 */
export function pinCodexCli(serverDir: string): Promise<CodexCli> {
  const running = inflight.get(serverDir);
  if (running) return running;
  const attempt = (async () => {
    if (process.env.CODEX_BIN) return { bin: process.env.CODEX_BIN, version: '', source: 'env' as const };
    const cli = await resolve(serverDir);
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(codexCliRecordPath(serverDir), `${JSON.stringify({ ...cli, pinnedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
    if (cli.source !== 'global') prune(serverDir, cli.version);
    console.log('[agentsflow][codex-cli] pinned', cli);
    return cli;
  })().finally(() => { if (inflight.get(serverDir) === attempt) inflight.delete(serverDir); });
  inflight.set(serverDir, attempt);
  return attempt;
}

/**
 * The CLI that belongs to the RUNNING server: what the chat pane's TUI and the
 * `codex queue` fallback must use. A server from before this record existed has
 * none, so it is adopted on first use — pinned to today's healthy install.
 */
export async function pinnedCodexCli(serverDir: string): Promise<CodexCli> {
  if (process.env.CODEX_BIN) return { bin: process.env.CODEX_BIN, version: '', source: 'env' };
  const record = readRecord(serverDir);
  if (record && fs.existsSync(record.bin)) return record;
  return pinCodexCli(serverDir);
}

export interface CodexUpgrade { from: string; to: string; }

// `--version` costs a process; an install that has not changed is not asked twice.
const probedVersions = new Map<string, string | null>();

/**
 * Is the machine's Codex a different, finished, working version than the one
 * the running server reports? Null for "nothing to do" in every other case —
 * including an install that is missing, mid-write or broken, which must never
 * be followed.
 */
export async function codexUpgradeAvailable(serverVersion: string, now = Date.now()): Promise<CodexUpgrade | null> {
  if (process.env.CODEX_BIN || !serverVersion) return null;
  const globalBin = cliSystem.findGlobal();
  if (!globalBin) return null;
  let realBin: string; let stamp: fs.Stats; let declared: string | null = null;
  try {
    realBin = fs.realpathSync(globalBin);
    const packageRoot = npmPackageRoot(realBin);
    const manifest = packageRoot ? path.join(packageRoot, 'package.json') : realBin;
    stamp = fs.statSync(manifest);
    if (packageRoot) declared = String(JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? '') || null;
  } catch { return null; }
  if (declared === serverVersion) return null;
  if (now - stamp.mtimeMs < INSTALL_SETTLE_MS) return null;
  const key = `${realBin}:${stamp.mtimeMs}`;
  if (!probedVersions.has(key)) {
    const probed = await cliSystem.version(globalBin);
    // A failure is not remembered: a binary still being written runs a moment later.
    if (probed === null) return null;
    probedVersions.clear();
    probedVersions.set(key, probed);
  }
  const version = probedVersions.get(key) ?? null;
  if (!version || version === serverVersion) return null;
  if (declared && declared !== version) return null; // The launcher and the binary disagree: mid-install.
  return { from: serverVersion, to: version };
}
