// verifyGuard with a fake exec (pass / fail / timeout / missing entry /
// syntax-check fallback) and defaultExec against real tiny bash commands.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HookGuardSpec } from './manifest';
import { defaultExec, tailDetail, verifyGuard } from './verify';
import type { Exec, ExecResult } from './verify';

function installWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-verify-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body, { mode: 0o755 });
  }
  return dir;
}

function spec(over: Partial<HookGuardSpec> = {}): HookGuardSpec {
  return { id: 'block-mass-kill', title: 't', what: 'w', files: ['g.sh', 'g.selftest.sh'], selftest: 'g.selftest.sh', syntaxCheck: null, hook: null, supersedes: [], ...over };
}

function fakeExec(r: Partial<ExecResult>, calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = []): Exec {
  return async (cmd, args, o) => {
    calls.push({ cmd, args, cwd: o.cwd, timeoutMs: o.timeoutMs });
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...r };
  };
}

describe('verifyGuard', () => {
  test('pass: runs bash <abs selftest> in installDir with a 120 s timeout', async () => {
    const dir = installWith({ 'g.sh': '#!/bin/bash\n', 'g.selftest.sh': 'exit 0\n' });
    const calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = [];
    const r = await verifyGuard(spec(), dir, fakeExec({ stdout: 'a\nb\n\nc\npassed=3 failed=0\n' }, calls), {});
    assert.equal(r.ok, true);
    assert.equal(r.detail, 'b\nc\npassed=3 failed=0');
    assert.deepEqual(calls, [{ cmd: 'bash', args: [path.join(dir, 'g.selftest.sh')], cwd: dir, timeoutMs: 120_000 }]);
  });

  test('fail: non-zero exit carries the tail as detail', async () => {
    const dir = installWith({ 'g.sh': '', 'g.selftest.sh': '' });
    const r = await verifyGuard(spec(), dir, fakeExec({ code: 1, stderr: 'boom\n' }), {});
    assert.deepEqual([r.ok, r.detail], [false, 'boom']);
    const r2 = await verifyGuard(spec(), dir, fakeExec({ code: 3 }), {});
    assert.deepEqual([r2.ok, r2.detail], [false, 'exit 3']);
  });

  test('timeout fails with a plain reason', async () => {
    const dir = installWith({ 'g.sh': '', 'g.selftest.sh': '' });
    const r = await verifyGuard(spec(), dir, fakeExec({ code: 1, timedOut: true }), {});
    assert.equal(r.ok, false);
    assert.match(r.detail, /^timed out after 120s/);
  });

  test('missing or non-executable entry fails without running anything', async () => {
    const dir = installWith({ 'g.selftest.sh': '' });
    const calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = [];
    const r = await verifyGuard(spec(), dir, fakeExec({}, calls), {});
    assert.deepEqual([r.ok, r.detail], [false, 'g.sh is missing']);
    fs.writeFileSync(path.join(dir, 'g.sh'), '', { mode: 0o644 });
    fs.chmodSync(path.join(dir, 'g.sh'), 0o644);
    const r2 = await verifyGuard(spec(), dir, fakeExec({}, calls), {});
    assert.deepEqual([r2.ok, r2.detail], [false, 'g.sh is not executable']);
    assert.equal(calls.length, 0);
  });

  test('no selftest → syntax check (python / bash)', async () => {
    const dir = installWith({ 'g.py': 'x = 1\n', 'g.sh': 'true\n' });
    const calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = [];
    await verifyGuard(spec({ files: ['g.py'], selftest: null, syntaxCheck: 'python' }), dir, fakeExec({}, calls), {});
    await verifyGuard(spec({ files: ['g.sh'], selftest: null, syntaxCheck: 'bash' }), dir, fakeExec({}, calls), {});
    assert.equal(calls[0].cmd, 'python3');
    assert.equal(calls[0].args[0], '-c');
    assert.equal(calls[0].args[2], path.join(dir, 'g.py'));
    assert.deepEqual([calls[1].cmd, calls[1].args], ['bash', ['-n', path.join(dir, 'g.sh')]]);
  });

  test('tailDetail caps at 300 chars', () => {
    assert.equal(tailDetail('x'.repeat(500), '').length, 300);
  });
});

describe('defaultExec', () => {
  test('resolves exit code, output and timeouts (never rejects)', async () => {
    const o = { cwd: os.tmpdir(), env: process.env, timeoutMs: 10_000 };
    assert.deepEqual(await defaultExec('bash', ['-c', 'echo out; echo err >&2; exit 0'], o), { code: 0, stdout: 'out\n', stderr: 'err\n', timedOut: false });
    const fail = await defaultExec('bash', ['-c', 'exit 4'], o);
    assert.deepEqual([fail.code, fail.timedOut], [4, false]);
    const slow = await defaultExec('bash', ['-c', 'sleep 5'], { ...o, timeoutMs: 200 });
    assert.equal(slow.timedOut, true);
    assert.notEqual(slow.code, 0);
    const missing = await defaultExec('/nonexistent/hg-binary', [], o);
    assert.equal(missing.code, 127);
  });
});
