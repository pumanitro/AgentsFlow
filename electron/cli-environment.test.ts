import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentEnvironment, cliPath } from './cli-environment';
import { setKillShimDir } from './hookguards/shim-path';

test('Finder PATH discovers nvm and Homebrew without a machine-specific path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peersflow-path-'));
  try {
    for (const v of ['v22.2.0', 'v24.1.0', 'not-a-version']) fs.mkdirSync(path.join(home, '.nvm/versions/node', v), { recursive: true });
    const entries = cliPath('/custom/bin:/usr/bin:/custom/bin', home).split(path.delimiter);
    assert.equal(entries[0], '/custom/bin');
    assert.equal(entries.filter((p) => p === '/custom/bin').length, 1);
    assert(entries.includes('/opt/homebrew/bin'));
    assert(entries.indexOf(path.join(home, '.nvm/versions/node/v24.1.0/bin')) < entries.indexOf(path.join(home, '.nvm/versions/node/v22.2.0/bin')));
    assert(!entries.some((p) => p.includes('not-a-version')));
  } finally { fs.rmSync(home, { recursive: true }); }
});

test('kill shims lead the agent PATH exactly once, and off means unchanged', () => {
  const saved = process.env.PATH;
  try {
    setKillShimDir(null);
    const before = agentEnvironment().PATH;
    setKillShimDir('/x/shims');
    process.env.PATH = `/usr/bin:/x/shims:${saved ?? ''}`;
    const parts = (agentEnvironment().PATH ?? '').split(path.delimiter);
    assert.equal(parts[0], '/x/shims');
    assert.equal(parts.filter((p) => p === '/x/shims').length, 1);
    setKillShimDir(null);
    process.env.PATH = saved;
    assert.equal(agentEnvironment().PATH, before);
  } finally { process.env.PATH = saved; setKillShimDir(null); }
});
