/**
 * The 16 routine glyphs: 24x24 outline paths, drawn with a 2 px round stroke in
 * `currentColor` (see marks.tsx RoutineGlyph). Zero-length sub-paths ("h.01")
 * are dots - round caps turn them into circles.
 */
import type { RoutineIcon } from '../../../shared/routines';

export const GLYPH_PATHS: Record<RoutineIcon, string> = {
  reddit: 'M12 8c-4.4 0-8 2.2-8 5.5S7.6 19 12 19s8-2.2 8-5.5S16.4 8 12 8z M12 8l1.2-4 4 1 M8.5 13h.01 M15.5 13h.01 M9.5 16.2c1.5 1 3.5 1 5 0',
  mail: 'M3 6h18v12H3z M3 7l9 6 9-6',
  chart: 'M4 20V4 M4 20h16 M8 16v-5 M12 16V7 M16 16v-8',
  broom: 'M19 4l-7 8 M8 12l5 3.5-2.5 5.5L4 17.5z',
  bug: 'M9 8a3 3 0 016 0v1H9z M7 9h10v6a5 5 0 01-10 0z M12 9v11 M4 12h3 M17 12h3 M5 19l2-2 M19 19l-2-2 M9 5L7.5 3 M15 5l1.5-2',
  rocket: 'M12 3c3 2 5 5 5 9l-2 4H9l-2-4c0-4 2-7 5-9z M9 16l-3 3 M15 16l3 3 M12 9.5h.01 M10 20h4',
  book: 'M4 5h6a2 2 0 012 2v13a2 2 0 00-2-2H4z M20 5h-6a2 2 0 00-2 2v13a2 2 0 012-2h6z',
  bell: 'M6 17v-6a6 6 0 0112 0v6l2 2H4z M10 21h4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4',
  leaf: 'M5 19C5 10 10 5 20 4c0 10-5 15-13 15 M5 19l8-8',
  coin: 'M12 3a9 9 0 100 18 9 9 0 000-18z M14.5 9.2C14 8.4 13.1 8 12 8c-1.4 0-2.5.8-2.5 2s1 1.7 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1.1 0-2-.4-2.5-1.2 M12 6.5V8 M12 16v1.5',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  gear: 'M12 9a3 3 0 100 6 3 3 0 000-6z M12 3v3 M12 18v3 M3 12h3 M18 12h3 M5.6 5.6l2.1 2.1 M16.3 16.3l2.1 2.1 M18.4 5.6l-2.1 2.1 M7.7 16.3l-2.1 2.1',
  globe: 'M12 3a9 9 0 100 18 9 9 0 000-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18z M12 7v5l3 2',
  flask: 'M9 3h6 M10 3v6l-5 9a2 2 0 001.8 3h10.4a2 2 0 001.8-3l-5-9V3 M7.5 14h9',
};
