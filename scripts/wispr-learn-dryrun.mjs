#!/usr/bin/env node
// Shows what the Wispr learner WOULD do right now, against the real Wispr DB, without
// changing anything: which words it would add to the Dictionary, which glued
// auto-learned rows the janitor would soft-delete, and why candidates were turned down.
//
// It cannot write, three times over: the DB adapter is opened read-only (it throws on
// any write), the tick runs with dryRun, and persist:false keeps it away from the
// ledger, the audit log and the pid lock. The only file it may touch is the stopwords
// cache under the learner dir, and only when that cache is stale. maxDictations is raised
// so a long --since window is not cut to its oldest 100 dictations. Plain Node ESM, no
// dependencies; runs the compiled learner out of dist/.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(REPO, 'dist', 'electron', 'electron', 'wispr');
const HOME = os.homedir();
const DEFAULT_DB = path.join(HOME, 'Library', 'Application Support', 'Wispr Flow', 'flow.sqlite');
const DEFAULT_USER_DATA = path.join(HOME, 'Library', 'Application Support', 'Peers Flow');

const USAGE = `usage: node scripts/wispr-learn-dryrun.mjs [options]

Prints what the Wispr learner would insert / soft-delete. Never writes the DB,
the ledger, the audit log or the lock.

  --since <hours>     look at dictations from the last N hours (default 48)
  --db <path>         Wispr DB (default ${DEFAULT_DB})
  --user-data <dir>   Peers Flow userData (default ${DEFAULT_USER_DATA})
  --janitor           run the janitor regardless of when it last ran
  --json              print the raw report as JSON
  --verbose           also list rejected candidates with their reasons
  --help              this text

Needs a compiled tree: npm run build:electron`;

function parseArgs(argv) {
  const out = { since: 48, db: DEFAULT_DB, userData: DEFAULT_USER_DATA, janitor: false, json: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--janitor') { out.janitor = true; continue; }
    if (a === '--json') { out.json = true; continue; }
    if (a === '--verbose' || a === '-v') { out.verbose = true; continue; }
    const key = { '--since': 'since', '--db': 'db', '--user-data': 'userData' }[a];
    if (!key) throw new Error(`unknown argument: ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    out[key] = argv[++i];
  }
  out.since = Number(out.since);
  if (!Number.isFinite(out.since) || out.since <= 0) throw new Error('--since needs a positive number of hours');
  return out;
}

function fail(msg) {
  console.error(`wispr-learn-dryrun: ${msg}`);
  process.exit(2);
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(USAGE); fail(err.message); }
if (opts.help) { console.log(USAGE); process.exit(0); }

const modules = ['learner', 'wispr-db', 'truth-claude', 'truth-codex', 'vocabulary'];
for (const m of modules) {
  if (!fs.existsSync(path.join(DIST, `${m}.js`))) fail(`${path.join(DIST, `${m}.js`)} is missing — run npm run build:electron first`);
}
const req = createRequire(import.meta.url);
const [learner, wisprDb, truthClaude, truthCodex, vocabulary] = modules.map((m) => req(path.join(DIST, `${m}.js`)));

const dbPath = path.resolve(opts.db);
const db = wisprDb.createWisprDb({ dbPath, readOnly: true });
if (!db.readOnly) fail('refusing to run: DB adapter is not read-only');

const now = Date.now();
const sinceMs = now - opts.since * 3_600_000;
const deps = {
  userDataDir: path.resolve(opts.userData),
  db,
  truth: [
    truthClaude.createClaudeTruth({ projectsRoot: path.join(HOME, '.claude', 'projects') }),
    truthCodex.createCodexTruth({ sessionsRoot: path.join(HOME, '.codex', 'sessions') }),
  ],
  knownNames: () => vocabulary.collectKnownNames([], HOME),
  now: () => now,
  env: {},
};

// The learner's own tick line goes to stdout; keep stdout clean for --json.
const log = console.log;
if (opts.json) console.log = (...a) => console.error(...a);
const report = await learner.runLearnerTick(deps, { dryRun: true, sinceMs, persist: false, forceJanitor: opts.janitor, maxDictations: 5000 });
console.log = log;

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length ? 1 : 0);
}

const ts = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
console.log(`Wispr DB   ${dbPath}  (read-only)`);
console.log(`window     ${ts(sinceMs)} → ${ts(now - learner.SETTLE_MS)}  (${opts.since} h, settled rows only)`);
console.log(`janitor    ${opts.janitor ? 'forced' : 'only if due'}`);
console.log('');

if (report.skipped) console.log(`tick skipped: ${report.skipped}`);
for (const e of report.errors) console.log(`error: ${e}`);
const plan = report.plan;
if (!plan) process.exit(report.errors.length ? 1 : 0);

console.log(`paired ${plan.paired}   unpaired ${plan.unpaired}`);
console.log('');
console.log(`WOULD INSERT (${plan.inserts.length})`);
for (const i of plan.inserts) {
  console.log(`  ${i.phrase}  ←  ${i.observedSource ?? '—'}   ${i.kind}  evidence=${i.evidence}  ${i.why}`);
}
console.log('');
console.log(`WOULD SOFT-DELETE (${plan.deletes.length})`);
for (const d of plan.deletes) console.log(`  ${d.phrase}  ←  ${d.observedSource ?? '—'}   ${d.rule}`);

const hist = new Map();
for (const r of plan.rejected) hist.set(`reject:${r.reason}`, (hist.get(`reject:${r.reason}`) ?? 0) + 1);
for (const s of plan.skipped) hist.set(`skip:${s.reason}`, (hist.get(`skip:${s.reason}`) ?? 0) + 1);
console.log('');
console.log('REASONS');
const max = Math.max(1, ...hist.values());
for (const [k, n] of [...hist].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${String(n).padStart(5)}  ${'#'.repeat(Math.ceil((n / max) * 30))}`);
}
if (hist.size === 0) console.log('  (none)');

if (opts.verbose) {
  console.log('');
  console.log('REJECTED');
  for (const r of plan.rejected) console.log(`  ${r.candidate.heard}  →  ${r.candidate.sent}   ${r.reason}`);
  console.log('SKIPPED');
  for (const s of plan.skipped) console.log(`  ${s.key}   ${s.reason}`);
}
process.exit(report.errors.length ? 1 : 0);
