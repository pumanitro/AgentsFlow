// Custom vocabulary for the phone's speech-to-text: peer names, folder names
// and the user's own extra words. Pure; no electron import.
import * as path from 'path';
import type { TrackedDirectory } from '../../shared/types';
import type { VocabularyResponse } from '../../shared/mobile';

const ALWAYS = ['Peers Flow', 'LISA', 'Claude', 'Codex'];
const MAX_WORDS = 200;

export function buildVocabulary(dirs: TrackedDirectory[], extra: string[], nowIso: string): VocabularyResponse {
  const sources: string[] = [...ALWAYS];
  for (const d of dirs) {
    if (d.displayName) sources.push(d.displayName);
    if (d.path) sources.push(path.basename(d.path));
  }
  for (const e of extra) if (typeof e === 'string') sources.push(e);

  const words: string[] = [];
  const seen = new Set<string>();
  const add = (w: string): void => {
    const t = w.replace(/[<>]/g, '').trim();
    if (!t) return;
    const k = t.toLocaleLowerCase();
    if (seen.has(k) || words.length >= MAX_WORDS) return;
    seen.add(k);
    words.push(t);
  };
  for (const s of sources) {
    add(s);
    for (const tok of s.split(/[^\p{L}\p{N}]+/u)) if (tok.length >= 3) add(tok);
  }
  return { words, updatedAt: nowIso };
}
