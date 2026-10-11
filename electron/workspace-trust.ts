// Workspace trust for directories Peers Flow spawns Claude sessions in.
//
// `claude --bg` refuses to start in a directory whose trust prompt was never
// accepted ("Workspace not trusted. Run `claude` in … once and accept the trust
// prompt"), and a background spawn has no TTY to show that prompt on. So a peer
// added through "+ Add directory" could never start a chat until the user went
// to a terminal and ran `claude` there by hand. Adding a directory as a peer is
// the user saying they trust it — and every session there already runs with
// bypassPermissions — so the trust is recorded for them before each spawn.
//
// The flag lives in `~/.claude.json` under `projects[<dir>].hasTrustDialogAccepted`,
// the same key the interactive prompt writes.

import * as fs from 'fs';
import * as path from 'path';
import { mainConfigJsonPath, withConfigLock } from './accounts';

/** `config` with `dir` marked trusted, or null when it already is. Pure. */
export function withWorkspaceTrust(config: any, dir: string): any | null {
  const projects = config?.projects && typeof config.projects === 'object' ? config.projects : {};
  const entry = projects[dir];
  if (entry?.hasTrustDialogAccepted === true) return null;
  return { ...config, projects: { ...projects, [dir]: { ...entry, hasTrustDialogAccepted: true } } };
}

/**
 * Records trust for `dir` in the CLI's config. Returns true when it wrote,
 * false when there was nothing to do or the config could not be read — an
 * unparseable file (mid-write by another process) is never overwritten.
 */
export async function ensureWorkspaceTrusted(dir: string, configPath = mainConfigJsonPath()): Promise<boolean> {
  // The CLI keys projects by its physical cwd, which is the resolved path.
  let key = path.resolve(dir);
  try { key = fs.realpathSync(key); } catch { /* missing dir — the spawn will say so */ }

  return withConfigLock(async () => {
    let config: any;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      return false;
    }
    const next = withWorkspaceTrust(config, key);
    if (!next) return false;
    const tmp = `${configPath}.agentsflow.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, configPath);
    console.log('[agentsflow][trust] accepted workspace trust', { dir: key });
    return true;
  }, configPath);
}
