// A file the gateway rewrites every 30 s. On the next start the previous file
// says when the Mac was last alive and whether it went down cleanly: the phone
// shows "Mac was offline from … to …" instead of guessing.

import * as fs from 'fs';
import * as path from 'path';
import type { ServerHealth } from '../../shared/mobile';
import type { Heartbeat } from './types';

interface FileShape { at: string; startedAt: string; cleanShutdownAt?: string }

function readPrev(filePath: string): FileShape | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) return null;
    return raw as FileShape;
  } catch {
    return null;
  }
}

function writeAtomic(filePath: string, data: FileShape): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
  }
}

export function createHeartbeat(filePath: string, o: { intervalMs?: number; now?: () => number } = {}): Heartbeat {
  const intervalMs = o.intervalMs ?? 30_000;
  const now = o.now ?? Date.now;
  let startedAtMs = now();
  let startedIso = new Date(startedAtMs).toISOString();
  let outage: ServerHealth['lastOutage'] = null;
  let timer: NodeJS.Timeout | null = null;

  const beat = (): void => writeAtomic(filePath, { at: new Date(now()).toISOString(), startedAt: startedIso });

  return {
    get startedAt() { return startedAtMs; },
    start() {
      if (timer) return;
      startedAtMs = now();
      startedIso = new Date(startedAtMs).toISOString();
      const prev = readPrev(filePath);
      outage = prev
        ? {
            from: prev.at,
            to: startedIso,
            clean: !!prev.cleanShutdownAt && Date.parse(prev.cleanShutdownAt) >= Date.parse(prev.at) - intervalMs,
          }
        : null;
      beat();
      timer = setInterval(beat, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      const at = new Date(now()).toISOString();
      writeAtomic(filePath, { at, startedAt: startedIso, cleanShutdownAt: at });
    },
    lastOutage() { return outage ? { ...outage } : null; },
  };
}
