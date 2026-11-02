#!/usr/bin/env node
'use strict';
// Launches the ISOLATED Peers Flow instance (own userData, offscreen, dev-mode gateway on 47822).
// Never touches the live app: single-instance lock, bridge socket, mcp configs and the store are
// keyed on userData (AGENTSFLOW_USER_DATA), the gateway uses 47822 (live default is 47820; 47821 is taken by ai-factory),
// guards are skipped (PEERSFLOW_HOOKGUARDS=0) and the Wispr learner is off (it would otherwise
// write the user's real Wispr dictionary from a fresh ledger).
// Usage: node launch-isolated.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const C = require('./config');

const ELECTRON = path.join(C.PF_REPO, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const WRAPPER = path.join(C.PF_E2E, 'wrapper.js');
const MAIN = path.join(C.PF_REPO, 'dist/electron/electron/main.js');
const TIMEOUT_MS = 60_000;

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function readPid() {
  try { const n = Number(fs.readFileSync(C.PF_PIDFILE, 'utf8').trim()); return Number.isInteger(n) && n > 0 ? n : null; } catch { return null; }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: 3000, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body || undefined);
  });
}

async function waitFor(label, fn, deadline) {
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fn();
      if (r.status === 200) return r.body;
      last = `HTTP ${r.status} ${r.body.slice(0, 200)}`;
    } catch (e) { last = e.message; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} not ready after ${TIMEOUT_MS / 1000}s (last: ${last})`);
}

function logTail(n) {
  try { return fs.readFileSync(C.PF_LOG, 'utf8').split('\n').slice(-n).join('\n'); } catch { return '(no log)'; }
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Do not leak the calling chat's identity or the LIVE app's wiring into the isolated instance.
    if (/^(CLAUDE|CLAUDECODE|AI_AGENT|PEERSFLOW_|AGENTSFLOW_|npm_|ELECTRON_|INIT_CWD|NODE_ENV|NODE_OPTIONS|TERM_PROGRAM)/.test(k)) continue;
    env[k] = v;
  }
  const keep = (env.PATH || '').split(':').filter((p) => p && !p.includes('node_modules/.bin'));
  const nodeBin = path.dirname(process.execPath);
  env.PATH = [path.join(os.homedir(), '.local/bin'), nodeBin, ...keep.filter((p) => p !== nodeBin)].join(':');
  Object.assign(env, {
    NODE_ENV: 'production',
    AGENTSFLOW_USER_DATA: C.PF_USERDATA,
    PEERSFLOW_HOOKGUARDS: '0',
    PEERSFLOW_WISPR_LEARNER: '0',
    PEERSFLOW_MOBILE_DEV: '1',
    PEERSFLOW_MOBILE_PORT: String(C.PF_PORT),
    PEERSFLOW_MOBILE_STT_KEY_FILE: '/Users/iij/Desktop/LISA/.env.local',
    PF_SIDE_PORT: String(C.PF_SIDE),
  });
  return env;
}

async function main() {
  if (!fs.existsSync(MAIN)) throw new Error(`missing ${MAIN}: run build-desktop.sh first`);
  if (!fs.existsSync(path.join(C.PF_USERDATA, 'store.json'))) throw new Error(`missing seeded store: run node seed-store.js first`);

  const existing = readPid();
  let pid;
  if (existing && alive(existing)) {
    console.log(`already running: pid ${existing}`);
    pid = existing;
  } else {
    for (const port of [C.PF_PORT, C.PF_SIDE]) {
      if (await portBusy(port)) throw new Error(`port ${port} is already in use by something else; not launching`);
    }
    const out = fs.openSync(C.PF_LOG, 'a');
    fs.writeSync(out, `\n===== launch ${new Date().toISOString()} =====\n`);
    const child = spawn(ELECTRON, [WRAPPER], { detached: true, stdio: ['ignore', out, out], env: cleanEnv(), cwd: C.PF_TMP });
    pid = child.pid;
    child.unref();
    fs.writeFileSync(C.PF_PIDFILE, String(pid));
    console.log(`launched pid ${pid} (log ${C.PF_LOG})`);
  }

  const deadline = Date.now() + TIMEOUT_MS;
  const t0 = Date.now();
  const info = await waitFor('side channel /info', () => request('GET', `http://127.0.0.1:${C.PF_SIDE}/info`), deadline);
  console.log('info:', info);
  const offer = await waitFor('gateway /dev/pair-code', () => request('POST', `http://127.0.0.1:${C.PF_PORT}/api/v1/dev/pair-code`, '{}'), deadline);
  console.log('pair-code:', offer);
  console.log(`ready in ${Date.now() - t0} ms`);
  const infoPid = JSON.parse(info).pid;
  if (infoPid !== pid) console.log(`note: side channel reports pid ${infoPid}, pid file has ${pid}`);
}

main().catch((e) => {
  console.error('launch-isolated FAILED:', e.message);
  console.error('--- log tail ---\n' + logTail(40));
  process.exit(1);
});
