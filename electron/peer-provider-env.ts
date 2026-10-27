// A peer can point Claude Code at a non-Anthropic endpoint through the `env`
// block of its `.claude/settings.json` (a local LiteLLM bridge, a llama-server,
// any Anthropic-compatible gateway). `claude -p` honours that block, but a
// `claude --bg` session does not: the CLI records the job's provider env from
// the LAUNCHING PROCESS's environment only (its `callerProviderEnv`) and hands
// that to the pre-warmed spare it claims, so the settings-file values never
// reach the worker and the session silently runs on the user's Claude account
// (seen with Claude Code 2.1.311: banner "Claude Max", 404 model_not_found,
// zero requests at the bridge).
//
// So for a local peer we read those maps ourselves and put the provider
// variables into the environment of the `claude --bg` we spawn. A peer with no
// such variables gets an empty result and keeps its exact old launch.
import * as fs from 'node:fs';
import * as path from 'node:path';

// Settings files in precedence order: later entries override earlier ones,
// matching Claude Code (`settings.local.json` beats the shared file).
const SETTINGS_FILES = ['settings.json', 'settings.local.json'];

/** True for a variable that changes which endpoint, credentials or models a session uses. */
export function isProviderEnvKey(key: string): boolean {
  return key === 'ANTHROPIC_BASE_URL'
    || key === 'ANTHROPIC_AUTH_TOKEN'
    || key === 'ANTHROPIC_API_KEY'
    || key === 'ANTHROPIC_MODEL'
    || key === 'ANTHROPIC_SMALL_FAST_MODEL'
    || key === 'ANTHROPIC_CUSTOM_HEADERS'
    || /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(key)
    || key.startsWith('CLAUDE_CODE_')
    || key === 'API_TIMEOUT_MS';
}

function readEnvMap(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // absent or unreadable — nothing to apply
  }
  try {
    const parsed = JSON.parse(raw) as { env?: unknown };
    const env = parsed?.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
    return out;
  } catch {
    console.warn('[agentsflow][provider-env] settings file is not valid JSON — ignored', { file });
    return {};
  }
}

/**
 * The provider variables a peer's settings set, merged across `dirs` (each
 * dir's `.claude/settings.json` then `.claude/settings.local.json`; later dirs
 * override earlier ones). Empty when nothing provider-related is configured.
 */
export function readPeerProviderEnv(dirs: string[]): Record<string, string> {
  const merged: Record<string, string> = {};
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    for (const name of SETTINGS_FILES) {
      for (const [k, v] of Object.entries(readEnvMap(path.join(resolved, '.claude', name)))) {
        if (isProviderEnvKey(k)) merged[k] = v;
      }
    }
  }
  return merged;
}

/** Log-safe view: the key names only, never a value (tokens and keys live here). */
export function providerEnvKeys(env: Record<string, string>): string[] {
  return Object.keys(env).sort();
}
