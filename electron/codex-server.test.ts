import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  codexLogPath,
  codexPidPath,
  codexServerDir,
  codexSocketPath,
  describesOurServer,
  ensureCodexServer,
  probeCodexServer,
  readCodexPid,
  stopCodexServer,
} from './codex-server';

// A stand-in for `codex app-server --listen unix://…`: it speaks the same
// WebSocket-over-unix-socket transport and answers `initialize`, so the
// lifecycle tests below prove ensure/reuse/stop without needing Codex or a
// network. String.raw keeps the CRLF escapes literal in the generated file.
const FAKE_CODEX = String.raw`#!/usr/bin/env node
const net = require('net');
const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const args = process.argv.slice(2);
if (args[0] !== 'app-server') process.exit(2);
const listen = args[args.indexOf('--listen') + 1] || '';
const sock = listen.replace(/^unix:\/\//, '');
if (!sock) process.exit(3);
require('fs').writeFileSync(sock + '.argv.json', JSON.stringify(args));
function frame(op, payload) {
  const n = payload.length;
  let h;
  if (n < 126) { h = Buffer.alloc(2); h[1] = n; }
  else if (n < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  h[0] = 0x80 | op;
  return Buffer.concat([h, payload]);
}
net.createServer((s) => {
  let buf = Buffer.alloc(0);
  let up = false;
  s.on('error', () => {});
  s.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    if (!up) {
      const e = buf.indexOf('\r\n\r\n');
      if (e < 0) return;
      const head = buf.subarray(0, e).toString('latin1');
      buf = buf.subarray(e + 4);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head)[1];
      const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
      s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      up = true;
    }
    for (;;) {
      if (buf.length < 2) break;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let n = buf[1] & 0x7f;
      let o = 2;
      if (n === 126) { if (buf.length < 4) break; n = buf.readUInt16BE(2); o = 4; }
      else if (n === 127) { if (buf.length < 10) break; n = Number(buf.readBigUInt64BE(2)); o = 10; }
      let m = null;
      if (masked) { if (buf.length < o + 4) break; m = buf.subarray(o, o + 4); o += 4; }
      if (buf.length < o + n) break;
      const p = Buffer.from(buf.subarray(o, o + n));
      if (m) for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
      buf = buf.subarray(o + n);
      if (op === 0x1) {
        let msg = null;
        try { msg = JSON.parse(p.toString('utf8')); } catch (err) { msg = null; }
        if (msg && msg.id !== undefined && msg.method) {
          s.write(frame(0x1, Buffer.from(JSON.stringify({ id: msg.id, result: { serverInfo: { name: 'fake' } } }))));
        }
      } else if (op === 0x8) {
        s.end(frame(0x8, p.subarray(0, 2)));
      }
    }
  });
}).listen(sock);
setInterval(() => {}, 1 << 30);
`;

/** Calls ensureCodexServer, prints the handle, and exits — proving the server outlives it. */
const SPAWNER = String.raw`const mod = require(process.argv[2]);
mod.ensureCodexServer({ userData: process.argv[3] }).then(
  (handle) => { process.stdout.write(JSON.stringify(handle)); process.exit(0); },
  (error) => { process.stderr.write(String((error && error.stack) || error)); process.exit(1); },
);
`;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Sandbox { dir: string; userData: string; bin: string; spawner: string }

function sandbox(binary = FAKE_CODEX): Sandbox {
  // Short prefix on purpose: a unix socket path is capped at ~104 bytes.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cs-'));
  const bin = path.join(dir, 'fake-codex');
  fs.writeFileSync(bin, binary, { mode: 0o755 });
  const spawner = path.join(dir, 'spawner.js');
  fs.writeFileSync(spawner, SPAWNER);
  return { dir, userData: dir, bin, spawner };
}

async function cleanup(box: Sandbox): Promise<void> {
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = box.bin;
  try { await stopCodexServer(box.userData); } catch { /* best effort */ }
  if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
  fs.rmSync(box.dir, { recursive: true, force: true });
}

async function withFakeCodex(run: (box: Sandbox) => Promise<void>, binary = FAKE_CODEX): Promise<void> {
  const box = sandbox(binary);
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = box.bin;
  try { await run(box); }
  finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    await cleanup(box);
  }
}

test('socket, pidfile and log all live under <userData>/codex', () => {
  const userData = '/tmp/Peers Flow';
  assert.equal(codexServerDir(userData), '/tmp/Peers Flow/codex');
  assert.equal(codexSocketPath(userData), '/tmp/Peers Flow/codex/app-server.sock');
  assert.equal(codexPidPath(userData), '/tmp/Peers Flow/codex/app-server.pid');
  assert.equal(codexLogPath(userData), '/tmp/Peers Flow/codex/app-server.log');
});

test('only an app-server on our own socket is ever a kill candidate', () => {
  const sock = '/Users/me/Library/Application Support/Peers Flow/codex/app-server.sock';
  assert.equal(describesOurServer(`node /usr/local/bin/codex app-server --listen unix://${sock} -c x=1`, sock), true);
  // Someone else's app-server, on the shared control socket.
  assert.equal(describesOurServer('codex app-server --listen unix:///Users/me/.codex/app-server-control/app-server-control.sock', sock), false);
  // The old stdio child, and unrelated processes.
  assert.equal(describesOurServer('codex app-server --stdio', sock), false);
  assert.equal(describesOurServer('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', sock), false);
  assert.equal(describesOurServer('', sock), false);
});

test('ensureCodexServer starts a server, reuses it, and stops only ours', { timeout: 60_000 }, async () => {
  await withFakeCodex(async (box) => {
    const first = await ensureCodexServer({ userData: box.userData });
    assert.equal(first.started, true);
    assert.equal(first.socketPath, codexSocketPath(box.userData));
    assert.ok(first.pid > 0);
    assert.equal(readCodexPid(box.userData), first.pid);
    assert.equal(alive(first.pid), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(first.socketPath + '.argv.json', 'utf8')), [
      'app-server', '--listen', `unix://${first.socketPath}`,
      '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"',
    ], 'the daemon must start with the same execution defaults as its threads');

    const second = await ensureCodexServer({ userData: box.userData });
    assert.equal(second.started, false, 'a live server must be reused, never duplicated');
    assert.equal(second.pid, first.pid);

    await stopCodexServer(box.userData);
    assert.equal(alive(first.pid), false, 'stopCodexServer must actually stop it');
    assert.equal(fs.existsSync(codexSocketPath(box.userData)), false);
    assert.equal(fs.existsSync(codexPidPath(box.userData)), false);
  });
});

test('the server outlives the process that spawned it', { timeout: 60_000 }, async () => {
  await withFakeCodex(async (box) => {
    const module = path.join(__dirname, 'codex-server.js');
    const output = execFileSync(process.execPath, [box.spawner, module, box.userData], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_BIN: box.bin },
    });
    const handle = JSON.parse(output) as { pid: number; started: boolean; socketPath: string };
    assert.equal(handle.started, true);

    // The spawner has exited (execFileSync waited for it). The server has not.
    await delay(250);
    assert.equal(alive(handle.pid), true, 'detached + unref must leave the server running');
    assert.equal(await probeCodexServer(handle.socketPath), true, 'and it must still answer initialize');

    const rejoined = await ensureCodexServer({ userData: box.userData });
    assert.equal(rejoined.started, false);
    assert.equal(rejoined.pid, handle.pid);
  });
});

test('a stale socket file left by a dead server does not block a restart', { timeout: 60_000 }, async () => {
  await withFakeCodex(async (box) => {
    fs.mkdirSync(codexServerDir(box.userData), { recursive: true });
    fs.writeFileSync(codexSocketPath(box.userData), 'not really a socket');
    fs.writeFileSync(codexPidPath(box.userData), '999999\n');
    const handle = await ensureCodexServer({ userData: box.userData });
    assert.equal(handle.started, true);
    assert.equal(await probeCodexServer(handle.socketPath), true);
  });
});

test('a missing binary reports something actionable instead of hanging', { timeout: 60_000 }, async () => {
  const box = sandbox();
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = path.join(box.dir, 'no-such-codex');
  try {
    await assert.rejects(
      ensureCodexServer({ userData: box.userData }),
      /Cannot start Codex app-server.*CODEX_BIN/s,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test('a binary that dies immediately is reported with its log path', { timeout: 60_000 }, async () => {
  const dying = '#!/usr/bin/env node\nconsole.error("boom");\nprocess.exit(7);\n';
  const box = sandbox(dying);
  const previous = process.env.CODEX_BIN;
  process.env.CODEX_BIN = box.bin;
  try {
    await assert.rejects(
      ensureCodexServer({ userData: box.userData }),
      /exited immediately \(code 7\).*app-server\.log/s,
    );
    assert.match(fs.readFileSync(codexLogPath(box.userData), 'utf8'), /boom/);
  } finally {
    if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous;
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test('probeCodexServer is false for a path nothing is listening on', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cs-'));
  assert.equal(await probeCodexServer(path.join(dir, 'absent.sock'), 500), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('stopCodexServer leaves a pid it does not own alone', { timeout: 60_000 }, async () => {
  const box = sandbox();
  try {
    fs.mkdirSync(codexServerDir(box.userData), { recursive: true });
    // Our own pid, which `ps` will not describe as an app-server on our socket.
    fs.writeFileSync(codexPidPath(box.userData), `${process.pid}\n`);
    await stopCodexServer(box.userData);
    assert.equal(alive(process.pid), true, 'the ps ownership check is the only thing between us and a stray kill');
    assert.equal(fs.existsSync(codexPidPath(box.userData)), false);
  } finally {
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});
