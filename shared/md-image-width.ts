// Persisting an image's display width across the markdown round-trip.
//
// BlockNote stores a resized image's width in the block's `previewWidth` prop,
// but serializing to markdown is lossy — `![alt](url)` has nowhere to put it,
// so every resize silently reverted on save → reopen. We encode the width as a
// `#w=<px>` URL fragment on the image ref: fragments are legal in markdown
// URLs, other renderers ignore them on <img> sources, and the file path part
// stays untouched (strip the fragment before resolving/reading the file).

const WIDTH_FRAGMENT = /#w=(\d+)$/;

/** The ref without its width fragment — safe to resolve against the filesystem. */
export function stripWidthFragment(ref: string): string {
  return ref.replace(WIDTH_FRAGMENT, '');
}

/** The encoded width in pixels, or null when the ref carries none. */
export function parseWidthFragment(ref: string): number | null {
  const m = WIDTH_FRAGMENT.exec(ref);
  if (!m) return null;
  const w = Number(m[1]);
  return Number.isFinite(w) && w > 0 ? w : null;
}

/**
 * The ref with its width fragment set to `width` (replacing any existing one),
 * or removed entirely when `width` is unset/invalid.
 */
export function withWidthFragment(ref: string, width: number | null | undefined): string {
  const clean = stripWidthFragment(ref);
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return clean;
  return `${clean}#w=${Math.round(width)}`;
}
