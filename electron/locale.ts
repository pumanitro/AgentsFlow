/**
 * Make spawned children (the `claude` CLI, login shells) handle UTF-8 text
 * correctly.
 *
 * THE BUG THIS FIXES: Polish characters (and any non-ASCII — accents, em-dashes,
 * §, smart quotes) typed/sent through the chat come back mangled — e.g. "CAŁYCH"
 * is stored/copied as "CA≈ÅYCH". That garble is UTF-8 bytes re-interpreted as
 * **Mac Roman**, the legacy macOS encoding.
 *
 * macOS has TWO independent "what encoding is text in?" subsystems, and a
 * GUI-launched Electron app (started from Finder, not a configured terminal)
 * leaves BOTH pointing at non-UTF-8 defaults for its children:
 *
 *  1. CoreFoundation's *system encoding* — `CFStringGetSystemEncoding()`. Native
 *     binaries (claude is one) that turn a C string into a CFString without
 *     naming an explicit encoding get this default. It is selected by the env
 *     var `__CF_USER_TEXT_ENCODING` ("<uid>:<encoding>:<region>"); when its
 *     encoding field is 0 (or the var is absent) CF falls back to Mac Roman.
 *     This is what produced the "CA≈ÅYCH" corruption, and — crucially — it is
 *     NOT affected by LANG/LC_*. The only fix is to point the encoding field at
 *     UTF-8 (kCFStringEncodingUTF8 = 0x8000100).
 *
 *  2. The C library locale — `setlocale()` / mbstowcs / wcwidth, governed by
 *     LANG / LC_CTYPE. With no LANG the locale is C/POSIX (single-byte), which
 *     mis-measures and mis-slices multibyte UTF-8 in shells and other native
 *     tools. We pin LC_CTYPE/LANG to a UTF-8 locale for the same reason every
 *     terminal app (VS Code, Hyper) does.
 *
 * We only ever fill in UTF-8 where the environment isn't already UTF-8, so a
 * user's deliberate locale (e.g. pl_PL.UTF-8) and language/sort/number settings
 * are left untouched.
 *
 * Mutates and returns the same object for convenience.
 */
const UTF8_RE = /UTF-?8/i;
const DEFAULT_LOCALE = 'en_US.UTF-8';
// kCFStringEncodingUTF8 as it appears in __CF_USER_TEXT_ENCODING.
const CF_UTF8 = '0x8000100';

function applyLibcLocale(env: Record<string, string>): void {
  // Effective character-type locale, honoring POSIX precedence:
  // LC_ALL overrides LC_CTYPE, which overrides LANG.
  const effectiveCtype = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (UTF8_RE.test(effectiveCtype)) return;
  // A non-UTF-8 LC_ALL would override anything we set below, so drop it.
  if (env.LC_ALL) delete (env as Record<string, string | undefined>).LC_ALL;
  env.LC_CTYPE = DEFAULT_LOCALE;
  if (!UTF8_RE.test(env.LANG || '')) env.LANG = DEFAULT_LOCALE;
}

function applyCoreFoundationEncoding(env: Record<string, string>): void {
  if (process.platform !== 'darwin') return;
  const current = env.__CF_USER_TEXT_ENCODING || '';
  const [uidField, encodingField, regionField] = current.split(':');
  // Already UTF-8 → leave it alone.
  if (encodingField && /^0x0*8000100$/i.test(encodingField)) return;
  // Preserve the existing uid (CF matches it against the running uid); fall back
  // to the current process uid when the var is absent.
  const uid = uidField || `0x${(typeof process.getuid === 'function' ? process.getuid() : 0).toString(16).toUpperCase()}`;
  const region = regionField || '0';
  env.__CF_USER_TEXT_ENCODING = `${uid}:${CF_UTF8}:${region}`;
}

export function withUtf8Locale(env: Record<string, string>): Record<string, string> {
  applyLibcLocale(env);
  applyCoreFoundationEncoding(env);
  return env;
}
