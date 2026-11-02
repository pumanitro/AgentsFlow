import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createTailscaleHelper, parseServeStatus, parseStatusJson } from './tailscale';

const fx = path.resolve(__dirname, '../../../../electron/mobile/fixtures');
const statusJson = fs.readFileSync(path.join(fx, 'tailscale-status.json'), 'utf8');
const serveJson = fs.readFileSync(path.join(fx, 'tailscale-serve-status.json'), 'utf8');

test('parseStatusJson on fixture', () => {
  assert.deepEqual(parseStatusJson(statusJson), { dnsName: 'home-hub.tail1234.ts.net', ownerLogin: 'someone@gmail.com', backendState: 'Running' });
});

test('parseStatusJson on garbage', () => {
  assert.deepEqual(parseStatusJson('not json'), {});
  assert.deepEqual(parseStatusJson(''), {});
  assert.deepEqual(parseStatusJson('null'), {});
  assert.deepEqual(parseStatusJson('{}'), { dnsName: undefined, ownerLogin: undefined, backendState: undefined });
});

test('parseServeStatus', () => {
  assert.equal(parseServeStatus(serveJson, 47820, 8443), true);
  assert.equal(parseServeStatus(serveJson, 47821, 8443), false);
  assert.equal(parseServeStatus(serveJson, 47820, 443), false);
  assert.equal(parseServeStatus('garbage', 47820, 8443), false);
  assert.equal(parseServeStatus('{}', 47820, 8443), false);
  assert.equal(parseServeStatus(serveJson.replace('127.0.0.1', 'localhost'), 47820, 8443), true);
});

type Call = { cmd: string; args: string[]; t: number };
function scripted(script: (args: string[]) => { code: number; stdout?: string; stderr?: string }) {
  const calls: Call[] = [];
  const exec = async (cmd: string, args: string[], t: number) => {
    calls.push({ cmd, args, t });
    const r = script(args);
    return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  const logs: string[] = [];
  const h = createTailscaleHelper({ exec, socket: '/sock/ts', bin: '/bin/tailscale', log: (m) => logs.push(m) });
  return { h, calls, logs };
}

test('status: running, serve on', async () => {
  const { h, calls } = scripted((a) => a.includes('serve') ? { code: 0, stdout: serveJson } : { code: 0, stdout: statusJson });
  const s = await h.status(47820, 8443);
  assert.equal(s.available, true);
  assert.equal(s.serveOn, true);
  assert.equal(s.url, 'https://home-hub.tail1234.ts.net');
  assert.equal(s.ownerLogin, 'someone@gmail.com');
  assert.deepEqual(calls[0].args, ['--socket=/sock/ts', 'status', '--json']);
  assert.equal(calls[0].t, 8000);
  assert.deepEqual(calls[1].args, ['--socket=/sock/ts', 'serve', 'status', '--json']);
});

test('status: serve off, and zero-arg skips serve probe', async () => {
  const { h, calls } = scripted((a) => a.includes('serve') ? { code: 0, stdout: '{}' } : { code: 0, stdout: statusJson });
  assert.equal((await h.status(47820, 8443)).serveOn, false);
  calls.length = 0;
  const s = await h.status();
  assert.equal(s.available, true);
  assert.equal(calls.length, 1);
});

test('status: not running', async () => {
  const { h, calls } = scripted(() => ({ code: 0, stdout: statusJson.replace('Running', 'Stopped') }));
  const s = await h.status(47820, 8443);
  assert.equal(s.available, false);
  assert.equal(s.url, undefined);
  assert.equal(calls.length, 1);
});

test('status: nonzero exit surfaces first stderr line', async () => {
  const { h } = scripted(() => ({ code: 1, stderr: '\nfailed to connect\nmore' }));
  const s = await h.status();
  assert.equal(s.available, false);
  assert.equal(s.error, 'failed to connect');
});

test('status: binary missing', async () => {
  const { h } = scripted(() => ({ code: -1, stderr: 'ENOENT' }));
  const s = await h.status(1, 2);
  assert.equal(s.available, false);
  assert.equal(s.error, 'tailscale not found');
});

test('enableServe argv and failure', async () => {
  const ok = scripted(() => ({ code: 0 }));
  await ok.h.enableServe(47820, 8443);
  assert.deepEqual(ok.calls[0].args, ['--socket=/sock/ts', 'serve', '--bg', '--https=8443', 'http://127.0.0.1:47820']);
  assert.equal(ok.calls[0].cmd, '/bin/tailscale');
  assert.equal(ok.calls[0].t, 20_000);
  const bad = scripted(() => ({ code: 1, stderr: 'Serve is not enabled on your tailnet.\nvisit ...' }));
  await assert.rejects(() => bad.h.enableServe(47820, 8443), /Serve is not enabled/);
});

test('prewarmCert is best effort', async () => {
  const ok = scripted(() => ({ code: 0 }));
  await ok.h.prewarmCert('a.b.ts.net');
  assert.deepEqual(ok.calls[0].args, ['--socket=/sock/ts', 'cert', 'a.b.ts.net']);
  assert.equal(ok.calls[0].t, 60_000);
  const bad = scripted(() => ({ code: 1, stderr: 'nope' }));
  await bad.h.prewarmCert('x');
  assert.equal(bad.logs.length, 1);
});

test('every call uses only the injected socket', async () => {
  const { h, calls } = scripted((a) => a.includes('serve') ? { code: 0, stdout: serveJson } : { code: 0, stdout: statusJson });
  await h.status(47820, 8443); await h.enableServe(1024, 8443); await h.prewarmCert('x');
  for (const c of calls) assert.equal(c.args[0], '--socket=/sock/ts');
});
