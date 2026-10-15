#!/usr/bin/env node
// End-to-end probe for the `notify` MCP tool: spawns the built Peers Flow MCP
// server exactly the way a chat would (bridge socket + store path from a
// Peers Flow data dir), speaks JSON-RPC over stdio (initialize → tools/list →
// tools/call notify) and prints the tool names and the envelope. Exits 0 only
// when the envelope says `status: "success"`. Plain Node ESM, no dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', 'dist', 'electron', 'electron', 'mcp', 'agentsflow-mcp-server.js');
const TIMEOUT_MS = 15_000;

const USAGE = `usage: node scripts/pf-notify.mjs --user-data <dir> [--conversation <id>] [--root-dir <dir>] --json '<notify args>'

  --user-data <dir>     the Peers Flow data dir whose app should receive the notice
                        (its bridge socket is <dir>/peersflow-bridge.sock)
  --conversation <id>   the chat the notice comes from (answers go back there); default none
  --root-dir <dir>      the peer directory relative file paths resolve against; default cwd
  --json '<args>'       the notify arguments, e.g. '{"title":"Hi","level":"warn"}'
  --help                this text

Needs a built tree (npm run build). Exit 0 iff the envelope status is "success".`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    const key = { '--user-data': 'userData', '--conversation': 'conversation', '--root-dir': 'rootDir', '--json': 'json' }[a];
    if (!key) throw new Error(`unknown argument: ${a}`);
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    out[key] = argv[++i];
  }
  return out;
}

function fail(msg) {
  console.error(`pf-notify: ${msg}`);
  process.exit(2);
}

let opts;
try { opts = parseArgs(process.argv.slice(2)); } catch (err) { console.error(USAGE); fail(err.message); }
if (opts.help) { console.log(USAGE); process.exit(0); }
if (!opts.userData) { console.error(USAGE); fail('--user-data is required'); }
if (!opts.json) { console.error(USAGE); fail('--json is required'); }
let notifyArgs;
try { notifyArgs = JSON.parse(opts.json); } catch (err) { fail(`--json is not valid JSON: ${err.message}`); }
if (!fs.existsSync(SERVER)) fail(`MCP server not built: ${SERVER} (run npm run build)`);

const userData = path.resolve(opts.userData);
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    PEERSFLOW_BRIDGE_SOCK: path.join(userData, 'peersflow-bridge.sock'),
    PEERSFLOW_STORE_PATH: path.join(userData, 'store.json'),
    PEERSFLOW_ROOT_CONVERSATION_ID: opts.conversation ?? '',
    PEERSFLOW_ROOT_DIR: opts.rootDir ? path.resolve(opts.rootDir) : process.cwd(),
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
// The server logs to stderr; keep it for a failure report, drain so it never blocks.
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });

// Newline-delimited JSON-RPC, the same framing the server test's Client uses.
const waiters = new Map();
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
    try { m = JSON.parse(line); } catch { continue; }
    if (m?.jsonrpc !== '2.0' || typeof m.id !== 'number') continue;
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
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pf-notify', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await call('tools/list');
  const names = (list?.tools ?? []).map((t) => t.name);
  console.log(`tools: ${names.join(', ')}`);
  if (!names.includes('notify')) throw new Error('this MCP server has no notify tool (stale build?)');
  const res = await call('tools/call', { name: 'notify', arguments: notifyArgs });
  const text = res?.content?.[0]?.text ?? '';
  let envelope;
  try { envelope = JSON.parse(text); } catch { envelope = { status: 'failure', error: text || 'empty tool result' }; }
  console.log(JSON.stringify(envelope));
  code = envelope.status === 'success' ? 0 : 1;
} catch (err) {
  console.error(`pf-notify: ${err.message}`);
  if (stderr.trim()) console.error(stderr.trim());
  code = 1;
} finally {
  child.stdin.end();
  child.kill();
}
process.exit(code);
