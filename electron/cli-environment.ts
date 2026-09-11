import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Finder does not run a login shell. Discover common CLI installations without
// sourcing shell startup files (which may have interactive commands/side effects).
export function cliPath(current = process.env.PATH ?? '', home = os.homedir()): string {
  const candidates = current.split(path.delimiter).filter(Boolean);
  candidates.push(path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(home, '.volta/bin'), path.join(home, '.local/share/mise/shims'),
    path.join(home, '.asdf/shims'));
  const nvm = path.join(home, '.nvm/versions/node');
  try {
    const versions = fs.readdirSync(nvm).filter((v) => /^v\d+\.\d+\.\d+$/.test(v));
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    candidates.push(...versions.map((v) => path.join(nvm, v, 'bin')));
  } catch { /* nvm is optional */ }
  candidates.push('/usr/bin', '/bin', '/usr/sbin', '/sbin');
  return [...new Set(candidates)].join(path.delimiter);
}

process.env.PATH = cliPath();

export function agentEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: cliPath(), TERM_PROGRAM: 'PeersFlow' };
  // These identify the parent terminal/session; children have their own identity.
  for (const key of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CODEX_THREAD_ID', 'ITERM_SESSION_ID']) delete env[key];
  return env;
}
