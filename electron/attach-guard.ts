import * as fs from 'fs';

// A chat pane must only ever show the chat. `claude attach` has two keys that
// leave it while the viewer process keeps running in our PTY: ← on an empty
// prompt opens the agents list ("agent view") in place, and Ctrl+Z "drops back
// to your shell" — there is no shell here. Both leave the attach's alternate
// screen first (ESC[?1049l), and the CLI offers no per-process switch to turn
// them off (`leftArrowOpensAgents: false` in ~/.claude.json covers interactive
// sessions only; attach ignores it). So the attach PTY watches its own output:
// once the chat screen is up, a 1049l means the viewer left the chat. If the
// process then exits, the session ended — a normal close. If it keeps
// running, it's showing something else, and the pane re-attaches.

const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';

/** How long a viewer may linger after leaving the chat screen before it counts as "somewhere else". */
export const LEFT_CHAT_GRACE_MS = 400;

/** Re-attach cap: more than this many inside the window means it's not a stray keypress. */
export const MAX_REATTACHES = 5;
export const REATTACH_WINDOW_MS = 60_000;

export interface ScreenWatch {
  /** True once the attach has drawn the chat (entered its alternate screen). */
  inChat: boolean;
}

/**
 * Feed one chunk of attach output. Returns the index in `data` where the
 * viewer leaves the chat screen, or -1. Everything before that index is still
 * the chat and may be shown; everything from it on must be held back.
 */
export function findChatExit(watch: ScreenWatch, data: string): number {
  const enter = data.lastIndexOf(ENTER_ALT);
  const leave = data.indexOf(LEAVE_ALT, watch.inChat ? 0 : Math.max(enter, 0));
  if (enter !== -1) watch.inChat = true;
  if (!watch.inChat || leave === -1) return -1;
  // Re-entered after leaving inside the same chunk (a redraw, not an exit).
  if (enter > leave) return -1;
  watch.inChat = false;
  return leave;
}

/** Drop timestamps outside the window and say whether another re-attach is allowed. */
export function allowReattach(history: number[], now: number): boolean {
  while (history.length > 0 && now - history[0] > REATTACH_WINDOW_MS) history.shift();
  return history.length < MAX_REATTACHES;
}

/**
 * Turn off ← → agents for interactive sessions (our `claude --resume` chats).
 * It's a global CLI setting in ~/.claude.json, so it also applies to the
 * user's own terminal sessions; `claude agents` still opens the list there.
 * Written only when it isn't already off, via temp file + rename so a reader
 * never sees half a file. Returns true when it changed the file.
 */
export function disableLeftArrowAgents(configPath: string): boolean {
  let raw: string;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return false; }
  let config: Record<string, unknown>;
  try { config = JSON.parse(raw); } catch { return false; }
  if (config.leftArrowOpensAgents === false) return false;
  config.leftArrowOpensAgents = false;
  const tmp = `${configPath}.agentsflow-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, configPath);
  return true;
}
