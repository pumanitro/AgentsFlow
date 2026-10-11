/**
 * The replay buffer behind every persistent PTY (shells, `claude --resume`,
 * the Codex TUI): the recent output a re-mounted terminal is rebuilt from.
 *
 * Its own module, like `resume-args.ts`, so it can be unit-tested without
 * `electron` or `node-pty`.
 *
 * Eviction drops whole chunks from the front, and a chunk boundary is wherever
 * the kernel happened to cut a read — as likely inside `\x1b[38;5;49m` as
 * between two frames. Replaying from such a cut prints the tail of the torn
 * sequence as text ("5;49m" in the top-left corner of a chat, 2026-09-14) and
 * leaves the parser in whatever state that fragment implied. So a trimmed
 * buffer replays from the first ESC it holds: an escape sequence is always a
 * valid place to start parsing, and whatever sat before it belonged to a
 * sequence whose head is gone.
 */
export interface ReplayBuffer {
  buffer: string[];        // chunks of recent output, capped by total bytes
  bufferBytes: number;
  trimmed: boolean;        // true once eviction has dropped the buffer's head
}

export function appendBuffer(s: ReplayBuffer, data: string, maxBytes: number): void {
  s.buffer.push(data);
  s.bufferBytes += data.length;
  while (s.bufferBytes > maxBytes && s.buffer.length > 1) {
    const removed = s.buffer.shift()!;
    s.bufferBytes -= removed.length;
    s.trimmed = true;
  }
}

/** The buffer as one string for the renderer to write into a fresh terminal. */
export function replayText(s: ReplayBuffer): string {
  if (s.buffer.length === 0) return '';
  if (!s.trimmed) return s.buffer.join('');
  for (let i = 0; i < s.buffer.length; i++) {
    const at = s.buffer[i].indexOf('\x1b');
    if (at === -1) continue;
    return s.buffer[i].slice(at) + s.buffer.slice(i + 1).join('');
  }
  // No escape sequence anywhere: plain text, and a torn word is harmless.
  return s.buffer.join('');
}
