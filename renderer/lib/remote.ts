// Small display/parse helpers for remote peers (tracked dirs on another
// machine over SSH). Pure functions only — safe on the server render.

/** SSH options textarea → argv: one argument per line, trimmed, empties dropped. */
export function parseSshArgs(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * A host name short enough for a sidebar chip: drops a `user@` prefix and keeps
 * the first DNS label (`patryk@theos-mac-studio.tail1234.ts.net` → `theos-mac-studio`).
 * IP addresses are kept whole — their first "label" means nothing on its own.
 */
export function shortHost(hostOrKey: string): string {
  const at = hostOrKey.lastIndexOf('@');
  const host = at >= 0 ? hostOrKey.slice(at + 1) : hostOrKey;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host;
  return host.split('.')[0] || host;
}

/**
 * Replace the home prefix with `~`. With a known `home` (the remote host's, from
 * its status) that exact prefix is used; otherwise the usual macOS/Linux shapes.
 */
export function collapseHome(path: string, home?: string): string {
  if (home) {
    const h = home.replace(/\/+$/, '');
    if (h && (path === h || path.startsWith(h + '/'))) return '~' + path.slice(h.length);
  }
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}
