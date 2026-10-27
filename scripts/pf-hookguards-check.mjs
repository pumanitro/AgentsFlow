#!/usr/bin/env node
// End-to-end probe for the guard installer (electron/hookguards/install.ts),
// run against a SANDBOX — never the live ~/.claude. Copies the user's
// ~/.claude/settings.json and the top-level regular files of ~/.claude/hooks
// into a fresh mkdtemp dir (read-only access to the real ones, nothing else),
// runs the compiled runInstall there with shippedDir = <repo>/guards, prints the
// rows, the before/after PreToolUse commands, the backup and the moved files,
// then runs it a second time. Exits 0 only when all 5 guards are active, the
// crew.py / worktree-hop-warn.sh groups are unchanged and the second pass
// wrote nothing. Leaves the sandbox for inspection. Plain Node ESM, no deps.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_JS = path.join(REPO, 'dist', 'electron', 'electron', 'hookguards', 'install.js');
const REAL_CLAUDE = path.join(os.homedir(), '.claude');
const KEEP_GROUPS = ['crew.py', 'worktree-hop-warn.sh'];

function fail(msg) {
  console.error(`pf-hookguards-check: ${msg}`);
  process.exit(2);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/pf-hookguards-check.mjs\n\nRuns the compiled guard installer against a sandbox copy of ~/.claude/settings.json\nand ~/.claude/hooks. Exit 0 iff all 5 guards pass and a second pass is a no-op.');
  process.exit(0);
}
if (!fs.existsSync(INSTALL_JS)) fail('run npm run build:electron first');
const { runInstall } = createRequire(import.meta.url)(INSTALL_JS);

// ── sandbox ────────────────────────────────────────────────────────────────
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-hookguards-check-'));
const sb = {
  hooks: path.join(ROOT, 'hooks'),
  settings: path.join(ROOT, 'settings.json'),
  backups: path.join(ROOT, 'backups'),
  install: path.join(ROOT, 'peersflow'),
  superseded: path.join(ROOT, 'peersflow-superseded'),
};
for (const d of [sb.hooks, sb.backups, sb.install, sb.superseded]) fs.mkdirSync(d, { recursive: true });
const realHooks = path.join(REAL_CLAUDE, 'hooks');
let copied = 0;
if (fs.existsSync(realHooks)) {
  for (const e of fs.readdirSync(realHooks, { withFileTypes: true })) {
    if (!e.isFile()) continue; // top-level regular files only: no dirs, no symlinks
    const src = path.join(realHooks, e.name);
    fs.writeFileSync(path.join(sb.hooks, e.name), fs.readFileSync(src), { mode: fs.statSync(src).mode & 0o777 });
    copied++;
  }
}
const realSettings = path.join(REAL_CLAUDE, 'settings.json');
if (fs.existsSync(realSettings)) fs.writeFileSync(sb.settings, fs.readFileSync(realSettings));
console.log(`sandbox: ${ROOT} (${copied} hook file(s) copied)`);

function readPtu() {
  try {
    const p = JSON.parse(fs.readFileSync(sb.settings, 'utf8'))?.hooks?.PreToolUse;
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
const commandsOf = (groups) => groups.flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks.map((h) => h?.command) : []));
const keptGroups = (groups) => KEEP_GROUPS.map((n) => groups.filter((g) => commandsOf([g]).some((c) => typeof c === 'string' && c.includes(n))));

const envPath = ['/opt/homebrew/bin', process.env.PATH ?? ''].filter(Boolean).join(path.delimiter);
let lastPhase = '';
const deps = {
  shippedDir: path.join(REPO, 'guards'),
  installDir: sb.install,
  supersededDir: sb.superseded,
  handmadeHooksDir: sb.hooks,
  settingsPath: sb.settings,
  backupDir: sb.backups,
  env: () => ({ ...process.env, PATH: envPath }),
  onSnapshot: (s) => {
    if (s.phase !== lastPhase) console.log(`phase: ${s.phase}`);
    lastPhase = s.phase;
  },
  log: (m) => console.log(`  log: ${m}`),
};

// ── pass 1 ─────────────────────────────────────────────────────────────────
const before = readPtu();
const s1 = await runInstall(deps);
const after = readPtu();
console.log('\nguards (id state registered checkMs detail):');
for (const g of s1.guards) console.log(`  ${g.id} ${g.state} ${g.registered} ${g.checkMs ?? '-'} ${JSON.stringify(g.detail)}`);
console.log('\nPreToolUse before:');
for (const c of commandsOf(before)) console.log(`  ${c}`);
console.log('PreToolUse after:');
for (const c of commandsOf(after)) console.log(`  ${c}`);
console.log(`\nbackup: ${s1.lastRun?.backup ?? '(none)'}`);
console.log(`moved: ${s1.lastRun?.supersededMoved?.length ? '' : '(none)'}`);
for (const m of s1.lastRun?.supersededMoved ?? []) console.log(`  ${m}`);
if (s1.lastRun?.error) console.log(`run error: ${s1.lastRun.error}`);

const problems = [];
const notActive = s1.guards.filter((g) => g.state !== 'active');
if (notActive.length) problems.push(`not active: ${notActive.map((g) => g.id).join(', ')}`);
if (JSON.stringify(keptGroups(before)) !== JSON.stringify(keptGroups(after))) problems.push('crew.py / worktree-hop-warn.sh groups changed');

// ── pass 2 ─────────────────────────────────────────────────────────────────
console.log('\nsecond pass:');
const s2 = await runInstall(deps);
console.log(`  filesWritten=${s2.lastRun?.filesWritten} settingsChanged=${s2.lastRun?.settingsChanged}`);
if (!(s2.lastRun?.filesWritten === 0 && s2.lastRun?.settingsChanged === false)) problems.push('second pass was not a no-op');

console.log(`\nsandbox left at: ${ROOT}`);
if (problems.length) {
  for (const p of problems) console.error(`pf-hookguards-check: FAIL ${p}`);
  process.exit(1);
}
console.log('pf-hookguards-check: OK');
process.exit(0);
