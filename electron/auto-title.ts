/**
 * Auto-title: once, right after a chat is created from a typed prompt, ask a
 * small model (Haiku, on the user's own Claude subscription via `claude -p`)
 * for a 1–4 word title. Applied only if the row still carries the title it was
 * created with — a manual rename in the meantime always wins, and nothing ever
 * renames the chat again afterwards.
 */
export const AUTO_TITLE_MAX_WORDS = 4;

export const AUTO_TITLE_SYSTEM_PROMPT =
  "You name chat conversations. Reply with ONLY a title of 1 to 4 words for the user's request: " +
  'no quotes, no punctuation at the end, no explanation. Use the language of the request.';

/** The prompt sent to the model: image markers and slash commands carry no topic. */
export function autoTitleInput(prompt: string): string {
  const cleaned = prompt
    .replace(/\[Image #\d+\]/g, ' ')
    .replace(/(^|\s)\/[\w:-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  return cleaned;
}

/** Normalise the model's reply into a ≤4-word title, or null when unusable. */
export function sanitizeAutoTitle(raw: string): string | null {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const cleaned = line
    .replace(/^(title\s*:\s*)/i, '')
    .replace(/[*_`#]/g, '')
    .replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .trim();
  if (!cleaned) return null;
  const words = cleaned.split(/\s+/).slice(0, AUTO_TITLE_MAX_WORDS);
  const title = words.join(' ').slice(0, 60).trim();
  return title || null;
}
