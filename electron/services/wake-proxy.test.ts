import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as os from 'node:os';
import { after, test } from 'node:test';
import type { ServicePort } from '../../shared/services';
import { createWakeProxy, type WakeProxy } from './wake-proxy';

// Real sockets on 127.0.0.1, ports picked by the kernel (port 0) — never a
// well-known port of this machine.

const LO = '127.0.0.1' as const;
const children: ChildProcess[] = [];
const servers: net.Server[] = [];
const proxies: WakeProxy[] = [];
after(async () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  for (const s of servers) s.close();
  for (const p of proxies) await p.close();
});

async function freePort(host: string = LO): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, host, () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function echoServer(port: number, host: string = LO): Promise<net.Server> {
  const s = net.createServer((c) => c.on('data', (d) => c.end(`echo${port}:${d}`)));
  servers.push(s);
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, () => resolve(s));
  });
}

/** Connect, send `msg`, collect everything until the far end closes. */
function request(port: number, msg: string): Promise<{ data: string; refused: boolean }> {
  return new Promise((resolve) => {
    const c = net.connect(port, LO);
    let data = '';
    c.on('connect', () => c.write(msg));
    c.on('data', (d) => { data += d; });
    c.on('error', (err: NodeJS.ErrnoException) => resolve({ data, refused: err.code === 'ECONNREFUSED' }));
    c.on('close', () => resolve({ data, refused: false }));
  });
}

/** Like a real caller: a refused connect, or one reset from the backlog as the
 *  listener closed (the listeners are down mid-wake), is retried. */
async function requestRetrying(port: number, msg: string, ms = 5000): Promise<{ data: string; refused: boolean }> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await request(port, msg);
    if (r.data !== '' || Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, 50));
  }
}

function canBind(port: number, host: string = LO): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, host, () => s.close(() => resolve(true)));
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting');
}

function makeProxy(onWake: (id: string, port: ServicePort) => Promise<boolean>, holdMs?: number) {
  const lines: string[] = [];
  const p = createWakeProxy({ onWake, log: (m) => lines.push(m), holdMs });
  proxies.push(p);
  return { proxy: p, lines };
}

test('handoff: the held connection is piped to the real service that binds the same port', async () => {
  const port = await freePort();
  const woke: Array<[string, number]> = [];
  const { proxy } = makeProxy(async (id, p) => { woke.push([id, p.port]); await echoServer(p.port); return true; });
  const r = await proxy.arm('svc', [{ port, host: LO }]);
  assert.deepEqual(r, { armed: [{ port, host: LO }], failed: [] });
  assert.deepEqual(proxy.guarded('svc'), [port]);

  const res = await request(port, 'hello');
  assert.equal(res.data, `echo${port}:hello`);
  assert.deepEqual(woke, [['svc', port]]);
  assert.deepEqual(proxy.guarded('svc'), []);
  await proxy.close();
});

test('handoff to a separate process (python3 -m http.server) that starts after the wake', async () => {
  const port = await freePort();
  const { proxy } = makeProxy(async (_id, p) => {
    const child = spawn('python3', ['-m', 'http.server', String(p.port), '--bind', LO, '--directory', os.tmpdir()], { stdio: 'ignore' });
    children.push(child);
    return true;                                   // not ready yet: the proxy keeps retrying the connect
  });
  await proxy.arm('py', [{ port, host: LO }]);
  const res = await request(port, 'GET / HTTP/1.0\r\n\r\n');
  assert.match(res.data.split('\r\n')[0], /^HTTP\/1\.[01] 200/);
  await proxy.close();
});

test('two concurrent clients on two ports of one service → one onWake, both served', async () => {
  const [a, b] = [await freePort(), await freePort()];
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { proxy } = makeProxy(async () => {
    calls++;
    await gate;                                    // hold the wake until both clients are in
    await echoServer(a); await echoServer(b);
    return true;
  });
  await proxy.arm('two', [{ port: a, host: LO }, { port: b, host: LO }]);
  // Both are usually accepted in the same poll turn and held together; if the
  // second handshake lands as the listeners close it is refused (or reset out
  // of the backlog) by design and retried — either way the service is woken exactly once.
  const ra = requestRetrying(a, 'A');
  const rb = requestRetrying(b, 'B');
  setTimeout(release, 300);
  const [x, y] = await Promise.all([ra, rb]);
  assert.equal(x.data, `echo${a}:A`);
  assert.equal(y.data, `echo${b}:B`);
  assert.equal(calls, 1);
  await proxy.close();
});

test('onWake false → the held client sees the socket end and the ports are re-armed', async () => {
  const port = await freePort();
  let calls = 0;
  const { proxy, lines } = makeProxy(async () => { calls++; return false; });
  await proxy.arm('bad', [{ port, host: LO }]);
  const res = await request(port, 'x');
  assert.equal(res.data, '');
  assert.equal(res.refused, false);              // it was accepted, then ended
  await waitFor(() => proxy.guarded('bad').length === 1);
  assert.deepEqual(proxy.guarded('bad'), [port]);
  assert.ok(lines.some((l) => /re-armed/.test(l)), lines.join('\n'));
  // a later connection is a new episode
  await request(port, 'y');
  assert.equal(calls, 2);
  await proxy.close();
});

test('onWake that throws counts as a failed wake', async () => {
  const port = await freePort();
  const { proxy } = makeProxy(async () => { throw new Error('boom'); });
  await proxy.arm('throws', [{ port, host: LO }]);
  const res = await request(port, 'x');
  assert.equal(res.data, '');
  await waitFor(() => proxy.guarded('throws').length === 1);
  await proxy.close();
});

test('a service that never accepts → the held client is dropped after holdMs and the port re-armed', async () => {
  const port = await freePort();
  const { proxy } = makeProxy(async () => true, 600);
  await proxy.arm('mute', [{ port, host: LO }]);
  const t0 = Date.now();
  const res = await request(port, 'x');
  assert.equal(res.data, '');
  assert.ok(Date.now() - t0 >= 400, `dropped too early (${Date.now() - t0} ms)`);
  await waitFor(() => proxy.guarded('mute').length === 1);
  await proxy.close();
});

test('EADDRINUSE on arm → failed[], the other ports and services unaffected', async () => {
  const busy = await freePort();
  const free = await freePort();
  const other = await freePort();
  await echoServer(busy);
  const { proxy } = makeProxy(async () => true);
  await proxy.arm('other', [{ port: other, host: LO }]);
  const r = await proxy.arm('svc', [{ port: busy, host: LO }, { port: free, host: LO }]);
  assert.deepEqual(r.armed, [{ port: free, host: LO }]);
  assert.equal(r.failed.length, 1);
  assert.deepEqual(r.failed[0].port, { port: busy, host: LO });
  assert.equal(r.failed[0].error, 'EADDRINUSE');
  assert.deepEqual(proxy.guarded('svc'), [free]);
  assert.deepEqual(proxy.guarded('other'), [other]);
  // the busy port's owner still answers directly
  assert.equal((await request(busy, 'hi')).data, `echo${busy}:hi`);
  await proxy.close();
});

test('arm twice is idempotent; guarded of an unknown id is empty', async () => {
  const port = await freePort();
  const { proxy } = makeProxy(async () => true);
  await proxy.arm('svc', [{ port, host: LO }]);
  const again = await proxy.arm('svc', [{ port, host: LO }]);
  assert.deepEqual(again, { armed: [{ port, host: LO }], failed: [] });
  assert.deepEqual(proxy.guarded('svc'), [port]);
  assert.deepEqual(proxy.guarded('nope'), []);
  await proxy.close();
});

test('disarm while idle frees the port at once', async () => {
  const port = await freePort();
  const { proxy } = makeProxy(async () => true);
  await proxy.arm('svc', [{ port, host: LO }]);
  assert.equal(await canBind(port), false);
  await proxy.disarm('svc');
  assert.deepEqual(proxy.guarded('svc'), []);
  assert.equal(await canBind(port), true);
  await proxy.disarm('never-armed');             // no-op, no throw
  await proxy.close();
});

test('close() leaves no listeners and refuses later arms', async () => {
  const [a, b] = [await freePort(), await freePort()];
  const { proxy } = makeProxy(async () => true);
  await proxy.arm('one', [{ port: a, host: LO }]);
  await proxy.arm('two', [{ port: b, host: LO }]);
  await proxy.close();
  assert.deepEqual(proxy.guarded('one'), []);
  assert.deepEqual(proxy.guarded('two'), []);
  assert.equal(await canBind(a), true);
  assert.equal(await canBind(b), true);
  const r = await proxy.arm('one', [{ port: a, host: LO }]);
  assert.deepEqual(r.armed, []);
  assert.equal(r.failed.length, 1);
});

test("host '0.0.0.0': guarded on all interfaces, handed off to a service bound the same way", async () => {
  const port = await freePort('0.0.0.0');
  const { proxy } = makeProxy(async (_id, p) => { await echoServer(p.port, p.host); return true; });
  const r = await proxy.arm('wide', [{ port, host: '0.0.0.0' }]);
  assert.deepEqual(r.failed, []);
  assert.equal(await canBind(port, '0.0.0.0'), false);
  const res = await request(port, 'w');
  assert.equal(res.data, `echo${port}:w`);
  await proxy.close();
});
