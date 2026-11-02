#!/usr/bin/env node
'use strict';
// ws-hello.js <token> — opens /api/v1/events, sends hello{lastSeq:0}, prints every event type
// for 5 s. Exit 0 only if it saw `welcome` AND `conversations.updated`.
const C = require('./config');
const WebSocket = require(require.resolve('ws', { paths: [C.PF_REPO] }));

const token = process.argv[2] || (() => { try { return require('fs').readFileSync(require('path').join(C.PF_TMP, 'e2e-token'), 'utf8').trim(); } catch { return ''; } })();
if (!token) { console.error('usage: ws-hello.js <token>'); process.exit(2); }

const seen = new Set();
const ws = new WebSocket(`ws://127.0.0.1:${C.PF_PORT}/api/v1/events`, { headers: { authorization: `Bearer ${token}` } });
const t0 = Date.now();
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', lastSeq: 0 })));
ws.on('message', (data) => {
  let ev;
  try { ev = JSON.parse(String(data)); } catch { console.log('non-JSON frame'); return; }
  seen.add(ev.type);
  const extra = ev.type === 'conversations.updated' ? ` (${(ev.summaries || []).length} summaries)` : ev.type === 'welcome' ? ` (seq ${ev.seq})` : '';
  console.log(`+${Date.now() - t0}ms ${ev.type}${extra}`);
});
ws.on('unexpected-response', (_req, res) => { console.error(`upgrade refused: HTTP ${res.statusCode}`); process.exit(1); });
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => {
  ws.close();
  const ok = seen.has('welcome') && seen.has('conversations.updated');
  console.log(ok ? 'WS OK' : `WS FAIL: saw ${[...seen].join(', ') || 'nothing'}`);
  process.exit(ok ? 0 : 1);
}, 5000);
