// The Wispr learner's runtime: the timer, and everything around the planner that
// touches the outside world.
//
// planTick (plan.ts) is pure — given dictations, sent messages, the Dictionary and the
// ledger it says what to insert and what to soft-delete. This file decides WHEN to ask
// it and whether to act on the answer:
//
//   config / env    the kill switch and dry-run, re-read every tick so flipping
//                   config.json takes effect without a restart
//   schema guard    Wispr migrates its DB with app updates; one mismatch and we stop
//                   writing for the rest of the process rather than guess
//   pid lock        the dev build and the packaged app share one userData dir and can
//                   run at the same time — two learners would double-insert
//   backup          before the very first write, the whole Dictionary goes to a JSON
//                   file next to the ledger, so any damage is reversible by hand
//   audit           every write (and every would-be write in dry-run) is a line in
//                   audit.jsonl
//
// Write failures are logged and the next tick tries again; only a schema failure
// disables the learner.

import * as fs from 'fs';
import * as path from 'path';
import { appendAudit } from './audit';
import type { AuditEntry } from './audit';
import { emptyLedger, loadLedger } from './ledger';
import type { Ledger } from './ledger';
import { PAIR_BEFORE_MS } from './pairing';
import { planTick } from './plan';
import { loadStopwords } from './stopwords';
import { readAllMessages } from './truth-sources';
import { PEERS_FLOW_BUNDLE_IDS } from './types';
import type { LearnerConfig, LedgerState, PlanInput, SchemaCheck, Stopwords, TickPlan, TickReport, TruthSource, WisprDb } from './types';
import { parseWisprTimestamp, wisprNow } from './wispr-db';

const LOG = '[agentsflow][wispr-learner]';

export const TICK_MS = 5 * 60_000;
// Let startup (window, PTY re-attach burst, pollers) finish before the first scan.
export const FIRST_TICK_DELAY_MS = 60_000;
// Wispr may still rewrite a fresh History row (formatting pass, edits); and the user
// may still be fixing the pasted text before hitting send. Only rows this old are read.
export const SETTLE_MS = 20 * 60_000;
// A brand-new ledger starts a day back instead of at the beginning of History.
export const INITIAL_BACKFILL_MS = 24 * 3_600_000;
export const MAX_DICTATIONS_PER_TICK = 100;
export const JANITOR_EVERY_MS = 24 * 3_600_000;
// How far back Wispr's own output is counted to tell words it already knows; recounted daily.
const WISPR_COUNTS_WINDOW_MS = 90 * 24 * 3_600_000;
const WISPR_COUNTS_TTL_MS = 24 * 3_600_000;
// A lock older than this is from a process that hung or a pid that got recycled.
const LOCK_STALE_MS = 3_600_000;

export interface LearnerDeps {
  userDataDir: string;
  db: WisprDb;
  truth: TruthSource[];
  knownNames: () => string[];
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  plan?: (input: PlanInput) => TickPlan;
  stopwords?: () => Promise<Stopwords>;
  apps?: readonly string[];
}

export interface LearnerTickOptions {
  dryRun?: boolean;
  /** Read dictations from here instead of the ledger cursor (dry-run CLI). */
  sinceMs?: number;
  /** false = touch nothing on disk: no ledger, no audit, no lock. */
  persist?: boolean;
  /** Treat the daily janitor as due regardless of lastJanitorAt (dry-run CLI --janitor). */
  forceJanitor?: boolean;
  /** Cap on dictations read this tick (default MAX_DICTATIONS_PER_TICK); the dry-run CLI raises it to see a whole window. */
  maxDictations?: number;
}

export function learnerDir(userDataDir: string): string {
  return path.join(userDataDir, 'wispr-learner');
}

export function readConfig(dir: string, env: NodeJS.ProcessEnv = process.env): LearnerConfig {
  const cfg: LearnerConfig = { enabled: true, dryRun: false };
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as Partial<LearnerConfig> | null;
    if (v && typeof v === 'object') {
      if (typeof v.enabled === 'boolean') cfg.enabled = v.enabled;
      if (typeof v.dryRun === 'boolean') cfg.dryRun = v.dryRun;
    }
  } catch {
    /* no config.json = defaults */
  }
  // The env var wins: it is the emergency brake that works without editing files.
  const e = (env.PEERSFLOW_WISPR_LEARNER ?? '').trim().toLowerCase();
  if (e === '0' || e === 'off' || e === 'false') cfg.enabled = false;
  else if (e === 'dry') cfg.dryRun = true;
  return cfg;
}

// ----- process state -----
let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let running = false;
let lockFile: string | null = null;
let schemaVerdict: SchemaCheck | null = null;
let disabledReason: string | null = null;
let disabledAudited = false;
let dbMissingWarned = false;
let lastReport: TickReport | null = null;
let lastConfig: LearnerConfig = { enabled: true, dryRun: false };
let wisprCountsCache: { at: number; counts: Record<string, number> } | null = null;

function warn(msg: string, errors: string[]): void {
  errors.push(msg);
  console.warn(`${LOG} ${msg}`);
}

/** Wispr's own word counts, recounted at most once a day; a failed count is {} (the filter then just knows less). */
async function wisprCountsFor(db: WisprDb, now: number, errors: string[]): Promise<Record<string, number>> {
  if (wisprCountsCache && now - wisprCountsCache.at < WISPR_COUNTS_TTL_MS) return wisprCountsCache.counts;
  try {
    const counts = await db.readOutputWordCounts(wisprNow(now - WISPR_COUNTS_WINDOW_MS));
    wisprCountsCache = { at: now, counts };
    return counts;
  } catch (e) {
    warn(`wispr word counts failed: ${(e as Error).message}`, errors);
    return {};
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the pid exists, it just is not ours to signal.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** true = we hold the lock now; false = another live learner does. */
function takeLock(file: string, nowMs: number): boolean {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown; at?: unknown };
    if (
      typeof v.pid === 'number' && v.pid !== process.pid && typeof v.at === 'number' &&
      nowMs - v.at < LOCK_STALE_MS && pidAlive(v.pid)
    ) return false;
  } catch {
    /* absent or unreadable = free */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: nowMs }));
  return true;
}

/** Ledger state without side effects: loadLedger renames a corrupt file, which persist:false must not do. */
function peekLedger(file: string, initialCursor: string): LedgerState {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerState;
    if (v && v.version === 1 && typeof v.cursor === 'string') return { ...emptyLedger(initialCursor), ...v };
  } catch {
    /* fresh */
  }
  return emptyLedger(initialCursor);
}

export async function runLearnerTick(deps: LearnerDeps, opts: LearnerTickOptions = {}): Promise<TickReport> {
  const now = (deps.now ?? Date.now)();
  const persist = opts.persist !== false;
  if (running) return { at: now, skipped: 'running', dryRun: !!opts.dryRun, errors: [] };
  running = true;
  try {
    const report = await tick(deps, opts, now, persist);
    lastReport = report;
    return report;
  } finally {
    running = false;
  }
}

async function tick(deps: LearnerDeps, opts: LearnerTickOptions, now: number, persist: boolean): Promise<TickReport> {
  const started = Date.now();
  const dir = learnerDir(deps.userDataDir);
  const auditFile = path.join(dir, 'audit.jsonl');
  const errors: string[] = [];
  const config = readConfig(dir, deps.env ?? process.env);
  lastConfig = config;
  const dryRun = opts.dryRun ?? config.dryRun;
  const at = new Date(now).toISOString();
  const audit = (entries: AuditEntry[]): void => {
    if (!persist) return;
    try {
      appendAudit(auditFile, entries);
    } catch (e) {
      warn(`audit write failed: ${(e as Error).message}`, errors);
    }
  };

  if (!config.enabled) {
    if (!disabledAudited && persist) {
      disabledAudited = true;
      audit([{ at, action: 'disabled', why: 'config/env', dryRun }]);
    }
    return { at: now, skipped: 'disabled', dryRun, errors };
  }

  const { db } = deps;
  if (!db.exists()) {
    if (!dbMissingWarned) {
      dbMissingWarned = true;
      console.warn(`${LOG} Wispr database not found at ${db.dbPath}; waiting for it`);
    }
    return { at: now, skipped: 'db-missing', dryRun, errors };
  }

  if (!schemaVerdict) {
    try {
      schemaVerdict = await db.checkSchema();
    } catch (e) {
      // A transient read failure (DB locked) is not a verdict; ask again next tick.
      warn(`schema check failed: ${(e as Error).message}`, errors);
      return { at: now, skipped: 'schema', dryRun, errors };
    }
    if (!schemaVerdict.ok) {
      disabledReason = schemaVerdict.detail;
      warn(`disabled: ${schemaVerdict.detail}`, errors);
      audit([{ at, action: 'error', why: `schema: ${schemaVerdict.detail}`, dryRun }]);
    }
  }
  if (!schemaVerdict.ok) return { at: now, skipped: 'schema', dryRun, errors };

  if (persist) {
    const file = path.join(dir, 'learner.lock');
    try {
      if (!takeLock(file, now)) return { at: now, skipped: 'locked', dryRun, errors };
      lockFile = file;
    } catch (e) {
      warn(`lock failed: ${(e as Error).message}`, errors);
      return { at: now, skipped: 'locked', dryRun, errors };
    }
  }

  const ledgerFile = path.join(dir, 'ledger.json');
  const initialCursor = wisprNow(now - INITIAL_BACKFILL_MS);
  const ledger: Ledger | null = persist ? loadLedger(ledgerFile, initialCursor) : null;
  let state = ledger ? ledger.state : peekLedger(ledgerFile, initialCursor);
  const since = opts.sinceMs != null ? wisprNow(opts.sinceMs) : state.cursor;
  if (opts.sinceMs != null) state = { ...state, cursor: since };

  let plan: TickPlan;
  try {
    const dictations = await db.readDictations({
      apps: deps.apps ?? PEERS_FLOW_BUNDLE_IDS,
      afterTimestamp: since,
      throughTimestamp: wisprNow(now - SETTLE_MS),
      limit: opts.maxDictations ?? MAX_DICTATIONS_PER_TICK,
    });
    const janitorDue = !!opts.forceJanitor || now - state.lastJanitorAt >= JANITOR_EVERY_MS;
    if (dictations.length === 0 && !janitorDue) return { at: now, skipped: 'no-new', dryRun, errors };

    // Messages are needed from just before the oldest dictation (pairing) and from
    // wherever vocabulary ingest stopped, whichever is earlier.
    const from = Math.min(parseWisprTimestamp(since), state.messagesIngestedThrough || Infinity) - PAIR_BEFORE_MS;
    const messages = await readAllMessages(deps.truth, from, now);
    const dictionary = await db.readDictionary();
    const stopwords = await (deps.stopwords ?? (() => loadStopwords({ cacheFile: path.join(dir, 'stopwords.json') })))();
    const wisprCounts = await wisprCountsFor(db, now, errors);
    plan = (deps.plan ?? planTick)({
      dictations, messages, dictionary, stopwords, knownNames: deps.knownNames(), ledger: state, nowMs: now, janitorDue, wisprCounts,
    });
  } catch (e) {
    warn(`tick failed: ${(e as Error).message}`, errors);
    return { at: now, dryRun, errors };
  }

  const report: TickReport = { at: now, dryRun, plan, errors };
  if (dryRun) {
    audit([
      ...plan.inserts.map((i): AuditEntry => ({
        at, action: 'would-insert', phrase: i.phrase, observedSource: i.observedSource, kind: i.kind, why: i.why, dryRun,
      })),
      ...plan.deletes.map((d): AuditEntry => ({
        at, action: 'would-soft-delete', id: d.id, phrase: d.phrase, observedSource: d.observedSource, why: d.rule, dryRun,
      })),
    ]);
  } else {
    report.applied = await apply(deps, plan, state, dir, now, at, audit, errors);
  }

  if (!dryRun && ledger) {
    ledger.state = plan.ledger;
    try {
      await ledger.save();
    } catch (e) {
      warn(`ledger save failed: ${(e as Error).message}`, errors);
    }
  }
  console.log(
    `${LOG} tick paired=${plan.paired} unpaired=${plan.unpaired} inserts=${plan.inserts.length} ` +
    `deletes=${plan.deletes.length} dryRun=${dryRun} ms=${Date.now() - started}`,
  );
  return report;
}

async function apply(
  deps: LearnerDeps, plan: TickPlan, input: LedgerState, dir: string, now: number, at: string,
  audit: (e: AuditEntry[]) => void, errors: string[],
): Promise<{ inserted: number; softDeleted: number }> {
  const { db } = deps;
  const applied = { inserted: 0, softDeleted: 0 };
  const stamp = wisprNow(now);
  // The planner returns a fresh state; a backup taken on an earlier tick must survive it.
  const backupDoneAt = input.backupDoneAt ?? plan.ledger.backupDoneAt;
  plan.ledger.backupDoneAt = backupDoneAt;

  if (backupDoneAt == null && (plan.inserts.length > 0 || plan.deletes.length > 0)) {
    const file = path.join(dir, `dictionary-backup-${new Date(now).toISOString().replace(/:/g, '-')}.json`);
    try {
      const n = await db.exportDictionary(file);
      audit([{ at, action: 'backup', why: `${n} rows → ${path.basename(file)}`, dryRun: false }]);
      plan.ledger.backupDoneAt = now;
    } catch (e) {
      // No backup, no writes: the backup is what makes a bad write reversible.
      warn(`backup failed, skipping writes: ${(e as Error).message}`, errors);
      audit([{ at, action: 'error', why: `backup: ${(e as Error).message}`, dryRun: false }]);
      dropInserts(plan, new Set());
      return applied;
    }
  }

  if (plan.inserts.length > 0) {
    const idFor = new Map(plan.ledger.inserts.map((l) => [l.key, l.id]));
    const rows = plan.inserts.flatMap((i) => {
      const id = idFor.get(i.key);
      return id ? [{ id, phrase: i.phrase, observedSource: i.observedSource, now: stamp, planned: i }] : [];
    });
    for (const i of plan.inserts) {
      if (!idFor.has(i.key)) warn(`no ledger id for planned insert "${i.phrase}"`, errors);
    }
    let inserted = new Set<string>();
    try {
      const res = await db.insertDictionaryRows(rows.map(({ planned: _p, ...r }) => r));
      inserted = new Set(res.inserted);
    } catch (e) {
      warn(`insert failed: ${(e as Error).message}`, errors);
    }
    audit(rows.map((r): AuditEntry => inserted.has(r.id)
      ? { at, action: 'insert', id: r.id, phrase: r.phrase, observedSource: r.observedSource, kind: r.planned.kind, why: r.planned.why, dryRun: false }
      : { at, action: 'error', id: r.id, phrase: r.phrase, observedSource: r.observedSource, kind: r.planned.kind, why: 'insert not applied', dryRun: false }));
    applied.inserted = inserted.size;
    dropInserts(plan, inserted);
  }

  if (plan.deletes.length > 0) {
    try {
      const res = await db.softDelete(plan.deletes.map((d) => d.id), stamp);
      applied.softDeleted = res.updated;
      audit(plan.deletes.map((d): AuditEntry => ({
        at, action: 'soft-delete', id: d.id, phrase: d.phrase, observedSource: d.observedSource, why: d.rule, dryRun: false,
      })));
    } catch (e) {
      warn(`soft-delete failed: ${(e as Error).message}`, errors);
      audit([{ at, action: 'error', why: `soft-delete: ${(e as Error).message}`, dryRun: false }]);
    }
  }
  return applied;
}

/**
 * Forget this tick's planned inserts that did not land, so the ledger neither counts
 * them against the weekly caps nor marks them already-inserted (which would block a retry).
 */
function dropInserts(plan: TickPlan, landed: Set<string>): void {
  const planned = new Set(plan.inserts.map((i) => i.key));
  plan.ledger.inserts = plan.ledger.inserts.filter((l) => !planned.has(l.key) || landed.has(l.id));
}

export function startWisprLearner(deps: LearnerDeps): void {
  if (timer || firstTimer) return;
  const cfg = readConfig(learnerDir(deps.userDataDir), deps.env ?? process.env);
  lastConfig = cfg;
  const fire = (): void => {
    runLearnerTick(deps).catch((e) => console.warn(`${LOG} tick threw: ${(e as Error).message}`));
  };
  firstTimer = setTimeout(() => {
    firstTimer = null;
    fire();
    timer = setInterval(fire, TICK_MS);
    timer.unref?.();
  }, FIRST_TICK_DELAY_MS);
  firstTimer.unref?.();
  console.log(`${LOG} started (dryRun=${cfg.dryRun}, enabled=${cfg.enabled})`);
}

export function stopWisprLearner(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
  if (lockFile) {
    try {
      const v = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: unknown };
      if (v.pid === process.pid) fs.rmSync(lockFile, { force: true });
    } catch {
      /* already gone */
    }
    lockFile = null;
  }
}

export function getLearnerStatus(): { enabled: boolean; dryRun: boolean; lastReport: TickReport | null; disabledReason: string | null } {
  return { enabled: lastConfig.enabled && disabledReason == null, dryRun: lastConfig.dryRun, lastReport, disabledReason };
}

export function __resetForTests(): void {
  stopWisprLearner();
  running = false;
  schemaVerdict = null;
  disabledReason = null;
  disabledAudited = false;
  dbMissingWarned = false;
  lastReport = null;
  lastConfig = { enabled: true, dryRun: false };
  wisprCountsCache = null;
}
