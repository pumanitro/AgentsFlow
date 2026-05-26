import * as path from 'path';
import { TrackedDirectory } from '../shared/types';

function segments(p: string): string[] {
  return p.split(path.sep).filter(Boolean);
}

export function computeDisplayName(absPath: string, others: TrackedDirectory[]): string {
  const segs = segments(absPath);
  if (segs.length === 0) return absPath;

  let depth = 1;
  while (depth <= segs.length) {
    const candidate = segs.slice(-depth).join('/');
    const collision = others.some((o) => o.path !== absPath && segments(o.path).slice(-depth).join('/') === candidate);
    if (!collision) return candidate;
    depth++;
  }
  return absPath;
}

export function recomputeAllDisplayNames(dirs: TrackedDirectory[]): TrackedDirectory[] {
  return dirs.map((d) => ({ ...d, displayName: computeDisplayName(d.path, dirs) }));
}
