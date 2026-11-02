import * as fs from 'node:fs';
import { MOBILE_DEFAULT_PORT } from '../../shared/mobile';

/** Parse a .env-style file: `export KEY=val`, single/double quotes, # comments, CRLF. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.length >= 2) {
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

function readUtf8OrNull(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

export function readMobileEnv(
  env: NodeJS.ProcessEnv,
  readFile: (p: string) => string | null = readUtf8OrNull,
): { devMode: boolean; port: number; sttKeyFromEnv: string | null } {
  const devMode = env.PEERSFLOW_MOBILE_DEV === '1';
  const p = Number(env.PEERSFLOW_MOBILE_PORT);
  const port = Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : MOBILE_DEFAULT_PORT;
  let sttKeyFromEnv: string | null = env.PEERSFLOW_MOBILE_STT_KEY?.trim() || null;
  if (!sttKeyFromEnv && env.PEERSFLOW_MOBILE_STT_KEY_FILE) {
    const text = readFile(env.PEERSFLOW_MOBILE_STT_KEY_FILE);
    sttKeyFromEnv = (text ? parseDotenv(text)['OPENAI_API_KEY'] : undefined) || null;
  }
  return { devMode, port, sttKeyFromEnv };
}
