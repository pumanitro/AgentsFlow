import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureWorkspaceTrusted, withWorkspaceTrust } from './workspace-trust';

test('withWorkspaceTrust adds a trusted entry for a directory the CLI has never seen', () => {
  const out = withWorkspaceTrust({ numStartups: 3, projects: { '/a': { hasTrustDialogAccepted: true } } }, '/new/peer');
  assert.deepEqual(out, {
    numStartups: 3,
    projects: { '/a': { hasTrustDialogAccepted: true }, '/new/peer': { hasTrustDialogAccepted: true } },
  });
});

test('withWorkspaceTrust keeps the other keys of an existing project entry', () => {
  const out = withWorkspaceTrust({ projects: { '/p': { allowedTools: ['x'], hasTrustDialogAccepted: false } } }, '/p');
  assert.deepEqual(out, { projects: { '/p': { allowedTools: ['x'], hasTrustDialogAccepted: true } } });
});

test('withWorkspaceTrust returns null when the directory is already trusted', () => {
  assert.equal(withWorkspaceTrust({ projects: { '/p': { hasTrustDialogAccepted: true } } }, '/p'), null);
});

test('ensureWorkspaceTrusted writes the trust flag a `claude --bg` spawn checks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
  const config = path.join(tmp, '.claude.json');
  const peer = path.join(tmp, 'roomforge');
  fs.mkdirSync(peer);
  fs.writeFileSync(config, JSON.stringify({ userID: 'u', projects: {} }));

  assert.equal(await ensureWorkspaceTrusted(peer, config), true);
  const json = JSON.parse(fs.readFileSync(config, 'utf8'));
  // Keyed by the physical path: that is what the CLI's cwd resolves to.
  assert.equal(json.projects[fs.realpathSync(peer)].hasTrustDialogAccepted, true);
  assert.equal(json.userID, 'u');
  assert.equal(await ensureWorkspaceTrusted(peer, config), false, 'second call is a no-op');
});

test('ensureWorkspaceTrusted never rewrites a config it cannot parse', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));
  const config = path.join(tmp, '.claude.json');
  fs.writeFileSync(config, '{ half-written');
  assert.equal(await ensureWorkspaceTrusted(tmp, config), false);
  assert.equal(fs.readFileSync(config, 'utf8'), '{ half-written');
});
