// The registry is what every peer-aware session is told about its peers, so a
// wrong line here sends an agent looking for a path on the wrong machine.
// These tests pin the remote-peer rendering and prove a remote dir is described
// purely from its cache: the local path used below EXISTS and holds a skill, and
// the remote description must ignore both.

import { strict as assert } from 'node:assert';
import { after, describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildPeerInfo, buildRegistry, renderBootstrapPrompt, renderRegistryMarkdown, type SelfInfo } from './registry';
import type { RemotePeerCache, RemotePeerSpec, TrackedDirectory } from '../shared/types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-registry-'));
fs.mkdirSync(path.join(tmp, '.claude', 'skills', 'x'), { recursive: true });
fs.writeFileSync(path.join(tmp, '.claude', 'skills', 'x', 'SKILL.md'), '---\ndescription: local skill x\n---\n');
fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# local\n');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const spec: RemotePeerSpec = {
  host: 'studio.example',
  user: 'patryk',
  sshArgs: [],
  claudeBin: 'claude',
  nodeBin: 'node',
  extraPath: [],
  permissionMode: 'bypassPermissions',
};

function cache(over: Partial<RemotePeerCache> = {}): RemotePeerCache {
  return {
    refreshedAt: '2026-10-09T00:00:00.000Z',
    exists: true,
    hasClaudeMd: false,
    hasAgentsMd: true,
    hasProjectMcp: true,
    hasCodexConfig: false,
    skills: [{ name: 'remote-skill', description: 'on the studio', kind: 'skill' }],
    hostname: 'Theos-Mac-Studio',
    home: '/Users/patryk',
    claudeVersion: '2.1.295',
    nodeVersion: 'v26.0.0',
    ...over,
  };
}

const localDir: TrackedDirectory = { id: 'L', path: tmp, displayName: 'local-peer', addedAt: '2026-10-09T00:00:00.000Z' };
// Same path as the local dir on purpose: a remote dir must never be stat-ed here.
const remoteNoCache: TrackedDirectory = { id: 'R0', path: tmp, displayName: 'studio-new', addedAt: '2026-10-09T00:00:00.000Z', remote: spec };
const remoteCached: TrackedDirectory = { ...remoteNoCache, id: 'R1', displayName: 'studio', remoteCache: cache() };

describe('buildPeerInfo — remote peers', () => {
  test('without a cache: missing, no skills, hostname falls back to the ssh host', () => {
    const p = buildPeerInfo(remoteNoCache);
    assert.equal(p.exists, false);
    assert.deepEqual(p.skills, []);
    assert.equal(p.hasClaudeMd, false, 'local CLAUDE.md at the same path must not leak in');
    assert.deepEqual(p.remote, { hostKey: 'patryk@studio.example', hostname: 'studio.example' });
  });

  test('with a cache: every flag and skill comes from the cache', () => {
    const p = buildPeerInfo(remoteCached);
    assert.equal(p.exists, true);
    assert.equal(p.hasClaudeMd, false);
    assert.equal(p.hasAgentsMd, true);
    assert.equal(p.hasProjectMcp, true);
    assert.equal(p.hasCodexConfig, false);
    assert.deepEqual(p.skills.map((s) => s.name), ['remote-skill']);
    assert.deepEqual(p.remote, { hostKey: 'patryk@studio.example', hostname: 'Theos-Mac-Studio' });
  });

  test('cached skills are capped like local ones', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, description: '', kind: 'skill' as const }));
    const p = buildPeerInfo({ ...remoteCached, remoteCache: cache({ skills: many }) });
    assert.equal(p.skills.length, 24);
  });
});

describe('buildPeerInfo — local peers unchanged', () => {
  test('reads the local filesystem and has no remote field', () => {
    const p = buildPeerInfo(localDir);
    assert.equal(p.exists, true);
    assert.equal(p.hasClaudeMd, true);
    assert.deepEqual(p.skills, [{ name: 'x', description: 'local skill x', kind: 'skill' }]);
    assert.equal(p.remote, undefined);
  });
});

describe('renderBootstrapPrompt', () => {
  const reg = buildRegistry([localDir, remoteCached]);

  test('remote peer line names the host; local line has no host', () => {
    const out = renderBootstrapPrompt(reg);
    assert.ok(
      out.includes(`- **studio** — \`${tmp}\` on Theos-Mac-Studio (remote peer, ssh \`patryk@studio.example\`) · exposes: remote-skill · has its own MCP connections`),
      out,
    );
    assert.ok(out.includes(`- **local-peer** — \`${tmp}\` · exposes: x\n`), out);
  });

  test('without self there is no "Where you are running" section', () => {
    assert.ok(!renderBootstrapPrompt(reg).includes('## Where you are running'));
  });

  test('with self the section is present, before "How to collaborate"', () => {
    const self: SelfInfo = { hostKey: 'patryk@studio.example', hostname: 'Theos-Mac-Studio', dir: '/Users/patryk/pf-peer', displayName: 'studio' };
    const out = renderBootstrapPrompt(reg, self);
    const where = out.indexOf('## Where you are running');
    const how = out.indexOf('## How to collaborate');
    assert.ok(where > 0 && where < how, 'section must precede How to collaborate');
    assert.ok(
      out.includes(
        'You are running on **Theos-Mac-Studio** (ssh `patryk@studio.example`), inside the remote peer **studio** at `/Users/patryk/pf-peer`. Your working tree, your `~/.claude` skills and every path you print are on THAT machine.',
      ),
    );
    assert.ok(out.includes('Call `mcp__peersflow__whoami` for your exact ids'));
  });
});

describe('renderRegistryMarkdown', () => {
  test('remote peers carry a host line; local peers do not', () => {
    const out = renderRegistryMarkdown(buildRegistry([localDir, remoteCached]));
    assert.ok(out.includes('- host: Theos-Mac-Studio (remote peer, ssh `patryk@studio.example`)'), out);
    assert.equal(out.split('- host:').length - 1, 1);
  });
});
