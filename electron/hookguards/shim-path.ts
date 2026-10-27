// Where the kill shims (guards/bin → ~/.claude/hooks/peersflow/bin) live once the installer
// has verified them. Spawn-env builders prepend it to PATH; null = shims off. A tiny mutable
// holder on purpose: cli-environment.ts is the first import of main.ts and must not pull the
// installer (fs, child_process) in.
import * as path from 'path';

let shimDir: string | null = null;

export function setKillShimDir(dir: string | null): void { shimDir = dir; }
export function killShimDir(): string | null { return shimDir; }

/** Prepends the verified shim dir to env.PATH exactly once; returns the same object. No-op while the shims are off. */
export function withKillShims<T extends { PATH?: string }>(env: T): T {
  if (!shimDir) return env;
  const parts = (env.PATH ?? '').split(path.delimiter).filter((p) => p && p !== shimDir);
  env.PATH = [shimDir, ...parts].join(path.delimiter);
  return env;
}
