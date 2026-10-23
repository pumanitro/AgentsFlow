#!/usr/bin/env node
// End-to-end probe for the staged MCP runtime: stages the compiled server's
// require closure out of a build tree (the same stageMcpRuntime Peers Flow runs
// before every spawn), then runs the STAGED copy exactly the way a chat's
// mcp-config does (Electron-as-Node), speaks JSON-RPC over stdio
// (initialize → tools/list) and prints the staged path and the tool names.
// Exits 0 only when the staged server lists all 11 tools. Plain Node ESM, no
// dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const TIMEOUT_MS = 15_000;
const EXPECTED_TOOLS = 11;
const DEFAULT_ELECTRON = '/Users/iij/Desktop/AgentsFlow/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';

const USAGE = `usage: node scripts/pf-runtime-check.mjs --bundle-root <dir> --stage-root <dir>

  --bundle-root <dir>   a compiled tree holding electron/mcp-runtime.js and
                        electron/mcp/agentsflow-mcp-server.js (e.g. dist/electron)
  --stage-root <dir>    where to stage the runtime (use a scratch dir, never the
                        live Peers Flow userData)
  --help                this text

Runs the staged server with $PF_ELECTRON (default ${DEFAULT_ELECTRON})
and ELECTRON_RUN_AS_NODE=1. Exit 0 iff it lists ${EXPECTED_TOOLS} tools.`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const key = { '--bundle-root': 'bundleRoot', '--stage-root': 'stageRoot' }[a];
    if (!key) throw new Error(`unknown argument: ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    out[key] = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`pf-runtime-check: ${msg}`);
  process.exit(2);
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(USAGE); fail(err.message); }
if (opts.help) { console.log(USAGE); process.exit(0); }
if (!opts.bundleRoot) { console.error(USAGE); fail('--bundle-root is required'); }
if (!opts.stageRoot) { console.error(USAGE); fail('--stage-root is required'); }

const bundleRoot = path.resolve(opts.bundleRoot);
const stageRoot = path.resolve(opts.stageRoot);
const runtimeModule = path.join(bundleRoot, 'electron', 'mcp-runtime.js');
if (!fs.existsSync(runtimeModule)) fail(`not a compiled tree: ${runtimeModule} is missing`);
const { stageMcpRuntime } = createRequire(import.meta.url)(runtimeModule);

let rt;
try { rt = stageMcpRuntime({ bundleRoot, stageRoot }); } catch (err) { fail(`staging failed: ${err.message}`); }
console.log(`staged: ${rt.serverScript} (${rt.fresh ? 'fresh' : 'reused'} ${rt.hash})`);

const command = process.env.PF_ELECTRON || DEFAULT_ELECTRON;
if (!fs.existsSync(command)) fail(`Electron binary not found: ${command} (set PF_ELECTRON)`);
const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-runtime-check-'));
const store = path.join(storeDir, 'store.json');
fs.writeFileSync(store, '{}');
// Drop any PEERSFLOW_* inherited from a Peers Flow chat: no bridge, an empty store.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PEERSFLOW_')));
const child = spawn(command, [rt.serverScript], {
  env: { ...env, ELECTRON_RUN_AS_NODE: '1', PEERSFLOW_STORE_PATH: store },
  stdio: ['pipe', 'pipe', 'pipe'],
});
// The server logs to stderr; keep it for a failure report, drain so it never blocks.
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });

// Newline-delimited JSON-RPC, the same framing the server test's Client uses.
const waiters = new Map();
const nonProtocol = [];
let buf = '';
let next = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    let m;
    try { m = JSON.parse(line); } catch { nonProtocol.push(line); continue; }
    if (m?.jsonrpc !== '2.0') { nonProtocol.push(line); continue; }
    if (typeof m.id !== 'number') continue;
    waiters.get(m.id)?.(m);
  }
});

function call(method, params = {}) {
  const id = next++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), TIMEOUT_MS);
    waiters.set(id, (m) => {
      clearTimeout(t);
      waiters.delete(id);
      if (m.error) reject(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`));
      else resolve(m.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

let code = 1;
try {
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pf-runtime-check', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await call('tools/list');
  const names = (list?.tools ?? []).map((t) => t.name);
  console.log(`tools (${names.length}): ${names.join(', ')}`);
  if (nonProtocol.length) console.error(`pf-runtime-check: non-protocol stdout: ${nonProtocol.join(' | ')}`);
  if (names.length !== EXPECTED_TOOLS) throw new Error(`expected ${EXPECTED_TOOLS} tools, got ${names.length}`);
  code = nonProtocol.length ? 1 : 0;
} catch (err) {
  console.error(`pf-runtime-check: ${err.message}`);
  if (stderr.trim()) console.error(stderr.trim());
  code = 1;
} finally {
  child.stdin.end();
  child.kill();
  fs.rmSync(storeDir, { recursive: true, force: true });
}
process.exit(code);
