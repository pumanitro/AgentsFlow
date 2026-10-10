import * as path from 'path';
import { v4 as uuid } from 'uuid';
import type { RoutinesStore } from './routines-api';
import type { AgentProvider, TrackedDirectory } from '../shared/types';
import type { Routine, RoutineIcon, RoutineSchedule } from '../shared/routines';

export interface SeedRoutine { seedKey: string; name: string; peerBasename: string; prompt: string; schedule: RoutineSchedule; icon: RoutineIcon; provider: AgentProvider }

// The peer is named by basename, never by path: source-hygiene.test.ts fails the
// build on any home-directory literal, and the path differs per machine anyway.
export const SEED_ROUTINES: SeedRoutine[] = [
  { seedKey: 'reddit-daily', name: 'Reddit daily', peerBasename: 'atlas-of-doors', prompt: '/reddit-daily-routine', schedule: { cadence: 'daily', time: '09:00' }, icon: 'reddit', provider: 'claude' },
];

function findPeer(dirs: TrackedDirectory[], basename: string): TrackedDirectory | undefined {
  const want = basename.toLowerCase();
  // posix basename: a remote peer's path is a path on another (unix) machine.
  return dirs.find((d) =>
    path.posix.basename(d.path || '').toLowerCase() === want || (d.displayName || '').toLowerCase() === want);
}

/** Idempotent on seedKey. Peer = first tracked dir with path.basename(dir.path) or displayName equal (case-insensitive) to peerBasename, remote dirs included. Found → enabled: true, createdAt = enabledAt = nowIso. Not found → created with directoryId '' and enabled: false (the preview says "Peer not tracked — Edit to pick one"). Never re-enables, never re-points an existing seed, never brings back a seed the owner deleted. */
export function ensureSeedRoutines(store: RoutinesStore, dirs: TrackedDirectory[], nowIso: string): { created: Routine[]; skipped: string[] } {
  const created: Routine[] = [];
  const skipped: string[] = [];
  const existing = new Set(store.listRoutines().map((r) => r.seedKey).filter(Boolean));
  for (const seed of SEED_ROUTINES) {
    if (existing.has(seed.seedKey) || store.isSeedDeleted(seed.seedKey)) { skipped.push(seed.seedKey); continue; }
    const peer = findPeer(dirs, seed.peerBasename);
    const routine: Routine = {
      id: uuid(),
      name: seed.name,
      directoryId: peer?.id ?? '',
      provider: seed.provider,
      prompt: seed.prompt,
      schedule: { ...seed.schedule },
      icon: seed.icon,
      enabled: Boolean(peer),
      createdAt: nowIso,
      updatedAt: nowIso,
      ...(peer ? { enabledAt: nowIso } : {}),
      seedKey: seed.seedKey,
    };
    created.push(store.addRoutine(routine));
  }
  return { created, skipped };
}
