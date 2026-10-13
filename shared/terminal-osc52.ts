// OSC 52 is how a program inside a terminal puts text on the clipboard of the
// machine the terminal window runs on: `ESC ] 52 ; <targets> ; <base64> BEL`.
// It is the only way copy can cross an ssh hop, so it is what Claude Code
// emits when it runs on a remote peer (its `claude attach` TUI grabs the mouse
// and does its own selection), and what vim/tmux/`printf` users rely on.
//
// xterm.js hands the handler everything after `52;`. A `?` payload asks the
// terminal to report its clipboard back — never answered, so a remote program
// cannot read this Mac's clipboard.

// Big enough for any real copy, small enough that a runaway program can't
// park hundreds of megabytes on the clipboard.
export const OSC52_MAX_BASE64 = 8 * 1024 * 1024;

export function decodeOsc52(payload: string): string | null {
  const semi = payload.indexOf(';');
  if (semi < 0) return null;
  const data = payload.slice(semi + 1).replace(/\s+/g, '');
  if (data === '?' || data.length > OSC52_MAX_BASE64) return null;
  // An empty payload means "clear the selection"; leave the clipboard alone.
  if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  try {
    const bin = atob(data);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return null;
  }
}
