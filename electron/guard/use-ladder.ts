// Is this container in use? The guard never asks "is it big" — it asks whether
// anyone would miss it, in this order: the user pinned it · it cleans up after
// itself (--rm) · a live chat is working inside its project · it has done
// something lately (cpu, network, an open connection) · it is too young to
// judge. Only what fails every one of those is a stop candidate.
//
// Pure, so the ladder is pinned line by line in tests.

import * as os from 'os';
import type { ContainerVerdict } from '../../shared/types';
import type { StatsRow } from './docker-inventory';

export const YOUNG_MS = 30 * 60_000;

export interface ContainerFacts { name: string; project: string | null; projectDir: string | null; autoRemove: boolean; running: boolean; startedAt: number | null; pinned: boolean; liveCwds: string[]; lastActiveAt: number | null; firstSeenAt: number; idleMinutes: number; now: number }

/** Lexical only: no fs, so a symlinked path is compared as written. */
function norm(p: string): string | null {
  if (typeof p !== 'string' || !p.startsWith('/')) return null;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

/** `child` is `parent` or lies under it. Both absolute; trailing slashes ignored. */
export function pathWithin(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (!c || !p) return false;
  if (p === '/') return true;
  return c === p || c.startsWith(p + '/');
}

export const MIN_CHAT_DIR_SEGMENTS = 3;

/**
 * Does a live chat working in `chatDir` protect a container whose compose
 * project lives in `projectDir`? Either direction counts: the chat is inside
 * the project dir, or the project dir is inside the chat's directory (a compose
 * file in a subfolder of the repo the chat works on). The second direction is
 * refused for a chat sitting in `/`, `/Users`, the home dir or anything
 * shallower than three segments — that would protect every container at once.
 */
export function chatProtects(chatDir: string, projectDir: string | null): boolean {
  if (!projectDir) return false;
  if (pathWithin(chatDir, projectDir)) return true;
  const c = norm(chatDir);
  if (!c || c.split('/').filter(Boolean).length < MIN_CHAT_DIR_SEGMENTS) return false;
  if (c === norm(os.homedir())) return false;
  return pathWithin(projectDir, c);
}

/** cpu > 2 || net delta > 0 || conns > 0. */
export function isActive(prev: StatsRow | null, cur: StatsRow | null, establishedConns: number): boolean {
  if (establishedConns > 0) return true;
  if (!cur) return false;
  if (cur.cpuPct > 2) return true;
  if (!prev) return false;
  return cur.netRxBytes + cur.netTxBytes > prev.netRxBytes + prev.netTxBytes;
}

function dur(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h${String(min % 60).padStart(2, '0')}m` : `${min}m`;
}

/**
 * pinned → keep-pinned · autoRemove → keep-autoremove ·
 * liveCwds.some(c ⇒ projectDir && pathWithin(c, projectDir)) → keep-live-chat
 *   (also when projectDir lies inside the chat's directory — see chatProtects) ·
 * active within idleMinutes → keep-active ·
 * startedAt/firstSeenAt younger than max(YOUNG_MS, idleMinutes) → keep-young ·
 * else stop-candidate ("idle 2h13m, project vitaminology").
 *
 * A container that is not running is never a candidate (nothing to stop).
 */
export function containerVerdict(f: ContainerFacts): { verdict: ContainerVerdict; note: string } {
  if (f.pinned) return { verdict: 'keep-pinned', note: 'pinned by you' };
  if (f.autoRemove) return { verdict: 'keep-autoremove', note: 'started with --rm: stopping it would delete it' };
  const chat = f.liveCwds.find((c) => chatProtects(c, f.projectDir));
  if (chat !== undefined) return { verdict: 'keep-live-chat', note: `a live chat is working in ${chat}` };
  if (!f.running) return { verdict: 'keep-active', note: 'not running' };

  const idleMs = Math.max(1, f.idleMinutes) * 60_000;
  if (f.lastActiveAt !== null && f.now - f.lastActiveAt < idleMs) {
    return { verdict: 'keep-active', note: `active ${dur(f.now - f.lastActiveAt)} ago` };
  }
  // An app restart resets firstSeenAt, so nothing is judged idle on less than a
  // full window of this process's own observation.
  const youngMs = Math.max(YOUNG_MS, idleMs);
  if (f.startedAt !== null && f.now - f.startedAt < youngMs) {
    return { verdict: 'keep-young', note: `started ${dur(f.now - f.startedAt)} ago` };
  }
  if (f.now - f.firstSeenAt < youngMs) {
    return { verdict: 'keep-young', note: `watched for only ${dur(f.now - f.firstSeenAt)}` };
  }
  const idleSince = f.lastActiveAt ?? f.firstSeenAt;
  return { verdict: 'stop-candidate', note: `idle ${dur(f.now - idleSince)}, ${f.project ? `project ${f.project}${f.projectDir ? '' : ' (folder unknown)'}` : 'no project'}` };
}
