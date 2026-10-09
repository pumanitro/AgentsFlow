// Pure pieces of the poller's remote-peer handling, split out so they can be
// unit-tested without `electron` (poller.ts imports BrowserWindow and the store).
//
// The model: every conversation belongs to exactly one host — `c.host` (a
// hostKey) or this machine. A tick lists agents once per host, and a
// conversation is only ever matched against ITS host's rows. Matching a remote
// conversation against local rows (or another host's) could pair it with an
// unrelated session that happens to share an 8-char id prefix, and — worse —
// count a remote daemon as "missing" because it is absent from a listing that
// could never contain it.
import type { ClaudeAgentJsonRow, ListAgentsResult } from './claude-cli';
import type { Conversation } from '../shared/types';
import { findLiveRow } from './derive-state';

/** Key of this machine in the per-host maps; hostKeys are `user@host`, never empty. */
export const LOCAL_HOST = '';

export function hostOf(c: Pick<Conversation, 'host'>): string {
  return c.host || LOCAL_HOST;
}

/** Distinct remote hostKeys among the conversations the poller lists for (non-codex). */
export function remoteHostsOf(convs: Conversation[]): string[] {
  const hosts = new Set<string>();
  for (const c of convs) {
    if (c.provider === 'codex' || !c.host) continue;
    hosts.add(c.host);
  }
  return Array.from(hosts).sort();
}

const TERMINAL_STATES = new Set(['done', 'completed', 'failed', 'error']);

/**
 * hostKey → daemonShorts the host's agent script should watch. A remote job's
 * state.json can only be watched on its own machine, so instead of a local
 * fs.watch the poller hands each host the set it wants pushed.
 *
 * `shouldWatch` is the poller's own predicate (it consults live PTY viewers,
 * which lives in electron-land); the default is its pure half — non-terminal.
 * Shorts are de-duplicated and sorted so an unchanged plan is an identical
 * argument tick after tick.
 */
export function planRemoteWatch(
  convs: Conversation[],
  shouldWatch: (c: Conversation) => boolean = (c) => !TERMINAL_STATES.has((c.state || '').toLowerCase()),
): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const c of convs) {
    if (c.provider === 'codex' || !c.host || !c.daemonShort) continue;
    if (!shouldWatch(c)) continue;
    let s = sets.get(c.host);
    if (!s) { s = new Set(); sets.set(c.host, s); }
    s.add(c.daemonShort);
  }
  const plan = new Map<string, string[]>();
  for (const host of Array.from(sets.keys()).sort()) plan.set(host, Array.from(sets.get(host)!).sort());
  return plan;
}

/**
 * Hosts that were in the previous plan but are not in this one. Their watched
 * set must be explicitly emptied (`setWatched(host, [])`): `watch` REPLACES the
 * set on the host, so simply not mentioning a host leaves its last set — and its
 * pushes — running forever.
 */
export function droppedWatchHosts(previous: Iterable<string>, plan: Map<string, string[]>): string[] {
  const dropped: string[] = [];
  for (const host of previous) if (!plan.has(host)) dropped.push(host);
  return dropped.sort();
}

// Index the live `claude agents --json` rows once per tick so the per-conversation
// lookup is O(1) instead of an O(rows) scan for each of the (potentially hundreds
// of) conversations. Matching precedence mirrors findLiveRow: name → daemonShort
// (an 8-char sessionId prefix) → full sessionId.
export interface RowIndex {
  byName: Map<string, ClaudeAgentJsonRow>;
  byId: Map<string, ClaudeAgentJsonRow>;
  byShort: Map<string, ClaudeAgentJsonRow>;
}
export function buildRowIndex(rows: ClaudeAgentJsonRow[]): RowIndex {
  const byName = new Map<string, ClaudeAgentJsonRow>();
  const byId = new Map<string, ClaudeAgentJsonRow>();
  const byShort = new Map<string, ClaudeAgentJsonRow>();
  for (const r of rows) {
    if (r.name) byName.set(r.name, r);
    if (r.sessionId) {
      byId.set(r.sessionId, r);
      const short = r.sessionId.slice(0, 8);
      if (!byShort.has(short)) byShort.set(short, r);
    }
  }
  return { byName, byId, byShort };
}
export function lookupRow(index: RowIndex, rows: ClaudeAgentJsonRow[], c: Conversation): ClaudeAgentJsonRow | undefined {
  if (c.sessionName) { const r = index.byName.get(c.sessionName); if (r) return r; }
  if (c.daemonShort) {
    if (c.daemonShort.length === 8) { const r = index.byShort.get(c.daemonShort); if (r) return r; }
    else { const r = findLiveRow(c, rows); if (r) return r; } // rare: non-8-char short
  }
  if (c.sessionId) { const r = index.byId.get(c.sessionId); if (r) return r; }
  return undefined;
}

export interface HostRows { rows: ClaudeAgentJsonRow[]; index: RowIndex }

/**
 * One row set + index per host whose listing SUCCEEDED this tick. A host whose
 * listing failed is simply absent, which callers read as "unknown": its
 * conversations stay exactly as they were (no miss counting, no reaping) —
 * unknown is not absent.
 */
export function buildHostRowIndexes(results: Map<string, ListAgentsResult>): Map<string, HostRows> {
  const out = new Map<string, HostRows>();
  for (const [host, r] of results) {
    if (!r.ok) continue;
    out.set(host, { rows: r.rows, index: buildRowIndex(r.rows) });
  }
  return out;
}

// reapAttempts is keyed by daemonShort; two hosts can mint the same short, so a
// remote entry carries its host. Local keys stay the bare short.
export function reapKey(host: string, short: string): string {
  return host ? `${host}\u0000${short}` : short;
}
export function parseReapKey(key: string): { host: string; short: string } {
  const i = key.indexOf('\u0000');
  return i === -1 ? { host: LOCAL_HOST, short: key } : { host: key.slice(0, i), short: key.slice(i + 1) };
}
