// Test helper: command output under ./fixtures (see its README — two files are
// copies of the guard's real captures, one is hand-written). Compiled tests run
// from <root>/dist/electron/electron/services, so the sources are four levels up.

import * as fs from 'fs';
import * as path from 'path';

const DIR = path.resolve(__dirname, '../../../../electron/services/fixtures');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(DIR, name), 'utf8');
}
