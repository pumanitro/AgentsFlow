// Is this service in use, and may it go to sleep? Asked in this order: an
// operation is already running on it · the user only wants it listed · it is
// already asleep · the user pinned it · someone is using it right now · (Docker
// Desktop only) a Docker project is awake or a container we do not manage runs ·
// memory is tight and it has been unused for a while (early sleep) · it was used
// within its idle limit · it has been watched too briefly to judge. Only what
// passes all of those is idle.
//
// Pure, so the ladder is pinned line by line in tests. Every `note` is shown to
// the user verbatim, in plain words.

import { SERVICE_DEFAULTS, type ServiceKind, type ServiceVerdict } from '../../shared/services';

export interface UseFacts {
  kind: ServiceKind; managed: boolean; pinned: boolean; awake: boolean; inflight: 'waking' | 'sleeping' | null;
  activeNow: boolean; activeDetail: string; lastUsedAt: number | null; observedSince: number; idleMinutes: number; now: number;
  memPressure: boolean; pressureIdleMinutes: number;
  dockerServicesAwake?: number; runningContainersOutside?: string[];
}

export interface UseVerdict { verdict: ServiceVerdict; note: string; idleForMinutes: number | null; early: boolean }

/** 7 → "7 min", 60 → "1 h", 250 → "4 h 10 min". */
export function fmtMinutes(min: number): string {
  const m = Math.max(0, Math.floor(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

function verdict(v: ServiceVerdict, note: string, idleForMinutes: number | null = null, early = false): UseVerdict {
  return { verdict: v, note, idleForMinutes, early };
}

export function serviceVerdict(f: UseFacts): UseVerdict {
  if (f.inflight === 'waking') return verdict('waking', 'waking up…');
  if (f.inflight === 'sleeping') return verdict('sleeping', 'going to sleep…');
  if (!f.managed) return verdict('unmanaged', 'listed only — Peers Flow never stops or starts it');
  if (!f.awake) {
    return f.kind === 'docker-desktop'
      ? verdict('asleep', 'Docker Desktop is off — it starts by itself when a Docker project wakes up')
      : verdict('asleep', 'asleep — wakes on the first request or when you click Wake');
  }

  // The idle clock: since the last use, or since we started watching it.
  const idleForMs = Math.max(0, f.now - (f.lastUsedAt ?? f.observedSince));
  const idleFor = Math.floor(idleForMs / 60_000);
  const watchedMs = f.now - f.observedSince;

  if (f.pinned) return verdict('pinned', 'pinned — never put to sleep', idleFor);
  if (f.activeNow) return verdict('in-use', f.activeDetail ? `in use right now — ${f.activeDetail}` : 'in use right now', 0);

  if (f.kind === 'docker-desktop') {
    const awake = f.dockerServicesAwake ?? 0;
    if (awake > 0) return verdict('in-use', `${awake} Docker ${awake === 1 ? 'project is' : 'projects are'} awake`, idleFor);
    const outside = f.runningContainersOutside ?? [];
    if (outside.length > 0) return verdict('blocked', `stays on: ${outside[0]} is running and is not managed here`, idleFor);
  }

  // Memory is tight: anything unused for the (shorter) pressure floor may go
  // early. Docker Desktop never does — it follows its containers.
  if (f.kind !== 'docker-desktop' && f.memPressure && idleForMs >= f.pressureIdleMinutes * 60_000 && watchedMs >= SERVICE_DEFAULTS.minObservationMs) {
    return verdict('idle', `memory is tight — not used for ${fmtMinutes(idleFor)}, going to sleep early (normally after ${fmtMinutes(f.idleMinutes)})`, idleFor, true);
  }

  if (f.lastUsedAt !== null && idleForMs < f.idleMinutes * 60_000) return verdict('in-use', `used ${fmtMinutes(idleFor)} ago`, idleFor);
  if (watchedMs < SERVICE_DEFAULTS.minObservationMs) {
    return verdict('too-new', `watched for only ${fmtMinutes(Math.max(0, watchedMs) / 60_000)} — judged after ${fmtMinutes(SERVICE_DEFAULTS.minObservationMs / 60_000)}`, idleFor);
  }
  return verdict('idle', `not used for ${fmtMinutes(idleFor)} — going to sleep`, idleFor);
}

/** An open connection, or more than 5 % CPU, is use. No reading is no use. */
export function processActive(cpuPct: number | null, conns: number): boolean {
  return conns > 0 || (cpuPct !== null && cpuPct > 5);
}

/**
 * Who goes to sleep first when memory is tight: the early candidates not
 * skipped, least recently used first (ties by id, so the order is stable).
 */
export function pressureQueue(rows: Array<{ id: string; early: boolean; lastUsedAt: number | null; observedSince: number; skip: boolean }>): string[] {
  return rows
    .filter((r) => r.early && !r.skip)
    .map((r) => ({ id: r.id, at: r.lastUsedAt ?? r.observedSince }))
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);
}
