// Staging the MCP server's require closure under userData (mcp-runtime.ts):
// layout + idempotence + pruning against a fake bundle, then the REAL compiled
// server — its closure must stay inside MCP_RUNTIME_FILES, and the staged copy
// must answer initialize + tools/list on its own.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCP_RUNTIME_FILES, readCurrentRuntime, relativeRequireClosure, stageMcpRuntime } from './mcp-runtime';

// __dirname at runtime is <outDir>/electron, so '..' is the bundleRoot mcp-bridge uses (dist/electron).
const REAL_BUNDLE_ROOT = path.join(__dirname, '..');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeBundle(tag: string): string {
  const root = tmp('pfr-bundle-');
  for (const rel of MCP_RUNTIME_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `// ${rel} ${tag}\n`);
  }
  return root;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

describe('stageMcpRuntime', () => {
  test('stages the layout once, then reuses it untouched', () => {
    const bundleRoot = fakeBundle('v1');
    const stageRoot = path.join(tmp('pfr-stage-'), 'mcp-runtime');
    const a = stageMcpRuntime({ bundleRoot, stageRoot });
    assert.equal(a.fresh, true);
    assert.match(a.hash, /^[0-9a-f]{40}$/);
    assert.equal(a.dir, path.join(stageRoot, a.hash));
    assert.equal(a.serverScript, path.join(a.dir, 'electron/mcp/agentsflow-mcp-server.js'));
    for (const rel of MCP_RUNTIME_FILES) {
      assert.equal(fs.readFileSync(path.join(a.dir, rel), 'utf8'), fs.readFileSync(path.join(bundleRoot, rel), 'utf8'));
    }
    assert.ok(fs.existsSync(path.join(a.dir, '.ok')));
    const cur = readJson(path.join(stageRoot, 'current.json'));
    assert.deepEqual(cur, { version: 1, hash: a.hash, dir: a.dir, serverScript: a.serverScript, bundleRoot, stagedAt: a.stagedAt });

    const curMtime = fs.statSync(path.join(stageRoot, 'current.json')).mtimeMs;
    const fileMtime = fs.statSync(a.serverScript).mtimeMs;
    const b = stageMcpRuntime({ bundleRoot, stageRoot });
    assert.equal(b.fresh, false);
    assert.equal(b.hash, a.hash);
    assert.equal(b.stagedAt, a.stagedAt);
    assert.equal(fs.statSync(path.join(stageRoot, 'current.json')).mtimeMs, curMtime);
    assert.equal(fs.statSync(a.serverScript).mtimeMs, fileMtime);
  });

  test('new content moves current.json; pruning keeps `keep` + current and clears stale tmp dirs', () => {
    const stageRoot = tmp('pfr-stage-');
    const a = stageMcpRuntime({ bundleRoot: fakeBundle('a'), stageRoot, keep: 1 });
    const b = stageMcpRuntime({ bundleRoot: fakeBundle('b'), stageRoot, keep: 1 });
    assert.notEqual(b.hash, a.hash);
    assert.equal(b.fresh, true);
    assert.equal(readJson(path.join(stageRoot, 'current.json')).hash, b.hash);
    // keep=1: b is newest and current, a goes.
    assert.ok(!fs.existsSync(a.dir));

    // Make b look old: current is never pruned even when it is not the newest.
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(b.dir, future, future);
    const c = stageMcpRuntime({ bundleRoot: fakeBundle('c'), stageRoot, keep: 1 });
    const staleTmp = path.join(stageRoot, '.tmp-stale');
    const freshTmp = path.join(stageRoot, '.tmp-fresh');
    fs.mkdirSync(staleTmp);
    fs.mkdirSync(freshTmp);
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(staleTmp, old, old);
    const again = stageMcpRuntime({ bundleRoot: fakeBundle('c'), stageRoot, keep: 1 });
    assert.equal(again.hash, c.hash);
    assert.ok(fs.existsSync(b.dir), 'newest by mtime is kept');
    assert.ok(fs.existsSync(c.dir), 'current is never pruned');
    assert.ok(!fs.existsSync(staleTmp), '.tmp-* older than 1 h is removed');
    assert.ok(fs.existsSync(freshTmp), 'a young .tmp-* may be another process mid-write');

    const d = stageMcpRuntime({ bundleRoot: fakeBundle('d'), stageRoot, keep: 1 });
    assert.ok(fs.existsSync(d.dir));
    assert.ok(fs.existsSync(b.dir));
    assert.ok(!fs.existsSync(c.dir));
  });

  test('a missing source file throws and leaves the previous current.json intact', () => {
    const stageRoot = tmp('pfr-stage-');
    const bundleRoot = fakeBundle('ok');
    stageMcpRuntime({ bundleRoot, stageRoot });
    const before = fs.readFileSync(path.join(stageRoot, 'current.json'), 'utf8');
    const broken = fakeBundle('broken');
    fs.rmSync(path.join(broken, 'electron/registry.js'));
    assert.throws(() => stageMcpRuntime({ bundleRoot: broken, stageRoot }), /electron\/registry\.js/);
    assert.equal(fs.readFileSync(path.join(stageRoot, 'current.json'), 'utf8'), before);
    assert.ok(readCurrentRuntime(stageRoot));
  });
});

describe('readCurrentRuntime', () => {
  test('null without current.json, and null once .ok is gone', () => {
    const stageRoot = tmp('pfr-stage-');
    assert.equal(readCurrentRuntime(stageRoot), null);
    const rt = stageMcpRuntime({ bundleRoot: fakeBundle('x'), stageRoot });
    const read = readCurrentRuntime(stageRoot);
    assert.equal(read?.hash, rt.hash);
    assert.equal(read?.serverScript, rt.serverScript);
    assert.equal(read?.fresh, false);
    fs.rmSync(path.join(rt.dir, '.ok'));
    assert.equal(readCurrentRuntime(stageRoot), null);
  });
});

describe('the real compiled server', () => {
  test('its relative require closure is exactly what gets staged', () => {
    const closure = relativeRequireClosure(REAL_BUNDLE_ROOT, 'electron/mcp/agentsflow-mcp-server.js');
    assert.ok(closure.includes('electron/mcp/agentsflow-mcp-server.js'));
    for (const rel of closure) {
      assert.ok((MCP_RUNTIME_FILES as readonly string[]).includes(rel), `${rel} is required by the server but not staged; add it to MCP_RUNTIME_FILES`);
    }
  });

  test('the staged copy answers initialize + tools/list on its own', async () => {
    const stageRoot = tmp('pfr-stage-');
    const rt = stageMcpRuntime({ bundleRoot: REAL_BUNDLE_ROOT, stageRoot });
    const store = path.join(tmp('pfr-store-'), 'store.json');
    fs.writeFileSync(store, '{}');
    // Drop any PEERSFLOW_* this test inherits from a Peers Flow session.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PEERSFLOW_')) env[k] = v;
    const child = spawn(process.execPath, [rt.serverScript], {
      env: { ...env, PEERSFLOW_STORE_PATH: store },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    const nonProtocol: string[] = [];
    const waiters = new Map<number, (m: { result?: { tools?: { name: string }[] } }) => void>();
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m: { jsonrpc?: string; id?: number; result?: { tools?: { name: string }[] } };
        try { m = JSON.parse(line); } catch { nonProtocol.push(line); continue; }
        if (m.jsonrpc !== '2.0') { nonProtocol.push(line); continue; }
        if (typeof m.id === 'number') waiters.get(m.id)?.(m);
      }
    });
    let next = 1;
    const call = (method: string, params: Record<string, unknown> = {}) => {
      const id = next++;
      return new Promise<{ result?: { tools?: { name: string }[] } }>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
        waiters.set(id, (m) => { clearTimeout(t); resolve(m); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    };
    try {
      await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-runtime.test', version: '1' } });
      const list = await call('tools/list');
      const names = (list.result?.tools ?? []).map((t) => t.name);
      for (const n of ['notify', 'delegate', 'run_routine', 'list_peers']) assert.ok(names.includes(n), `missing tool ${n}: ${names.join(', ')}`);
      assert.deepEqual(nonProtocol, []);
    } finally {
      child.kill();
    }
  });
});
