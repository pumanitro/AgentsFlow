// The one tokenizer every learner module shares: pairing, candidates, stopwords,
// vocabulary and the dictionary lookups must all agree on what "the same word" is.

// A token starts with a letter or digit and continues through the joiners that live
// inside names (smart-commit, sferis.pl, snake_case, don't, 50/90). A leading '/' is
// kept so slash commands stay recognisable; edge joiners are stripped so "cron." = "cron".
const TOKEN_RE = /\/?[\p{L}\p{N}][\p{L}\p{N}'’\-._/]*/gu;
const EDGE_JOINERS = /^[.'’\-_/]+|[.'’\-_/]+$/gu;

/** Surface tokens, original case. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const slash = m[0].startsWith('/');
    const t = m[0].replace(EDGE_JOINERS, '');
    if (t) out.push(slash ? '/' + t : t);
  }
  return out;
}

/** Comparison key for one token: NFC, lowercase, curly→straight apostrophe, slash marker and edge joiners stripped. Diacritics are kept (ł ≠ l). */
export function normalizeWord(w: string): string {
  return w.normalize('NFC').replace(/’/g, "'").toLowerCase().replace(/^\//, '').replace(EDGE_JOINERS, '');
}

/** Comparison key for a phrase: normalized tokens joined by one space. */
export function normalizePhrase(p: string): string {
  return tokenize(p).map(normalizeWord).filter(Boolean).join(' ');
}

export const hasLetter = (s: string): boolean => /\p{L}/u.test(s);
export const hasDigit = (s: string): boolean => /\p{N}/u.test(s);
