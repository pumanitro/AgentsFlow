// Test helper: the real command output captured under ./fixtures (see its README).
// Compiled tests run from <root>/dist/electron/electron/guard, so the sources
// are four levels up.

import * as fs from 'fs';
import * as path from 'path';

const DIR = path.resolve(__dirname, '../../../../electron/guard/fixtures');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}
