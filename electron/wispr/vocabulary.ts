// "Which words does this user actually send?" — running statistics over every message
// typed or dictated into Peers Flow, and the mining step that turns them into
// Dictionary suggestions.
//
// Corrections (heard → sent) need a dictation to go wrong first. Vocabulary does not:
// a word the user keeps sending that Wispr's dictionary lacks — a project name, a
// hyphenated skill, a domain — is exactly what Wispr will mishear next. Plain lowercase
// words are left alone even when frequent ("implement" ×50 is English, not a name);
// only words that LOOK like names, or ARE names we know of, are suggested.

import * as fs from 'fs';
import * as path from 'path';
import type { UserMessage, VocabCandidate, VocabEntry, VocabStats } from './types';
import { VOCAB_MIN_COUNT } from './types';
import { normalizeWord, tokenize, hasDigit } from './text';

const MAX_SESSIONS = 5;
const MAX_FORMS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
// Share of sightings that must be capitalized mid-sentence before a plain word counts as
// a proper noun ("Open Figma now"). Sentence-initial capitals say nothing.
const MID_CAPS_SHARE = 0.7;

const startsUpper = (t: string): boolean => /^\p{Lu}/u.test(t);
const SENTENCE_END = new Set(['.', '?', '!', ':', '\n']);

/** True when the token at `index` follows other text on the same sentence. */
function midSentence(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') continue;
    return !SENTENCE_END.has(ch);
  }
  return false;
}

function addForm(e: VocabEntry, form: string): void {
  if (Object.hasOwn(e.f, form)) e.f[form]++;
  else if (Object.keys(e.f).length < MAX_FORMS) e.f[form] = 1;
  // Full: further forms are dropped, so the dominant form stays stable.
}

export function ingestMessages(stats: VocabStats, messages: UserMessage[], isStopword: (key: string) => boolean): void {
  for (const m of messages) {
    let cursor = 0;
    for (const token of tokenize(m.text)) {
      // tokenize strips edge joiners, so the token is a substring of its match; scanning
      // forward from the previous hit recovers its position for the mid-sentence check.
      const bare = token.startsWith('/') ? token.slice(1) : token;
      const found = m.text.indexOf(bare, cursor);
      const index = found >= 0 ? found : cursor;
      if (found >= 0) cursor = found + bare.length;

      // Paths, fractions and slash commands are not words anyone dictates as written.
      if (token.includes('/')) continue;
      const key = normalizeWord(token);
      if (key.length < 3 || /^\p{N}+$/u.test(key) || isStopword(key)) continue;

      // hasOwn, not `stats[key] ??`: "constructor" is a word people send.
      const e = Object.hasOwn(stats, key) ? stats[key] : (stats[key] = { c: 0, s: [], f: {}, mid: 0, last: 0 });
      e.c++;
      if (!e.s.includes(m.sessionId) && e.s.length < MAX_SESSIONS) e.s.push(m.sessionId);
      addForm(e, token);
      if (startsUpper(token) && midSentence(m.text, index)) e.mid++;
      if (m.at > e.last) e.last = m.at;
    }
  }
}

export function pruneVocab(stats: VocabStats, nowMs: number, opts: { maxKeys?: number; maxAgeMs?: number } = {}): void {
  const { maxKeys = 20_000, maxAgeMs = 30 * DAY_MS } = opts;
  for (const k of Object.keys(stats)) if (nowMs - stats[k].last > maxAgeMs) delete stats[k];
  const keys = Object.keys(stats);
  if (keys.length <= maxKeys) return;
  keys.sort((a, b) => stats[a].last - stats[b].last);
  for (const k of keys.slice(0, keys.length - maxKeys)) delete stats[k];
}

function dominantForm(e: VocabEntry): string {
  let best = '';
  let n = -1;
  for (const [form, c] of Object.entries(e.f)) if (c > n) [best, n] = [form, c];
  return best;
}

function nameLike(key: string, form: string, e: VocabEntry): boolean {
  if (hasDigit(key) || /[-._]/.test(key)) return true;
  if (/^.+\p{Lu}/u.test(form)) return true; // inner capital: AgentsFlow, WYTFURNIA, iPhone
  return e.c > 0 && e.mid / e.c >= MID_CAPS_SHARE;
}

export function mineVocabulary(
  stats: VocabStats,
  ctx: { isStopword(k: string): boolean; inDictionary(k: string): boolean; knownNames: string[] },
  opts: { minCount?: number; minSessions?: number } = {},
): VocabCandidate[] {
  const { minCount = VOCAB_MIN_COUNT, minSessions = 2 } = opts;
  const known = new Set(ctx.knownNames.map(normalizeWord).filter(Boolean));
  const out: VocabCandidate[] = [];
  for (const [key, e] of Object.entries(stats)) {
    if (e.c < minCount || e.s.length < minSessions) continue;
    if (ctx.inDictionary(key) || ctx.isStopword(key)) continue;
    const word = dominantForm(e);
    if (!word) continue;
    const why = known.has(key) ? 'known-name' : nameLike(key, word, e) ? 'name-like' : null;
    if (why) out.push({ word, key, count: e.c, sessions: e.s.length, why });
  }
  return out.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
}

function listNames(dir: string, pick: (d: fs.Dirent) => string | null): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(pick).filter((n): n is string => !!n);
  } catch {
    return [];
  }
}

/** Names the user is likely to say: peer folders, installed skills, agent definitions. */
export function collectKnownNames(peerPaths: string[], home: string): string[] {
  const names = [
    ...peerPaths.map((p) => path.basename(p.replace(/[/\\]+$/, ''))),
    ...listNames(path.join(home, '.claude', 'skills'), (d) =>
      d.isDirectory() || d.isSymbolicLink() ? d.name : null,
    ),
    ...listNames(path.join(home, '.claude', 'agents'), (d) =>
      d.name.endsWith('.md') && !d.isDirectory() ? d.name.slice(0, -3) : null,
    ),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = n.trim();
    if (!t || t.startsWith('.') || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
