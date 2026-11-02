#!/usr/bin/env node
'use strict';
// Seeds the isolated instance: a cheap scratch peer named LISA and a minimal store.json.
// Usage: node seed-store.js [--reset]
//   --reset  wipes the isolated userData first (absolute path, under PF_TMP only).
// Without --reset an existing store.json keeps its conversations; only the peer row is ensured.
// A pre-seeded store.json also stops the legacy-store migration (electron/store.ts copies
// ~/Library/Application Support/Agents Flow/store.json into an EMPTY userData).
// Accounts are never seeded: the isolated instance must never write the live Keychain.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('./config');

const reset = process.argv.includes('--reset');

function assertUnderTmp(p) {
  const abs = path.resolve(p);
  if (!abs.startsWith(C.PF_TMP + '/') || abs === C.PF_TMP) throw new Error(`refusing to touch ${abs}: not under ${C.PF_TMP}`);
  return abs;
}

if (reset) {
  const target = assertUnderTmp(C.PF_USERDATA);
  if (target !== '/Users/iij/.claude/jobs/106e55f3/tmp/pf-mobile-userdata') throw new Error('unexpected userData path ' + target);
  execFileSync('/bin/rm', ['-rf', '/Users/iij/.claude/jobs/106e55f3/tmp/pf-mobile-userdata']);
  console.log('reset: wiped', target);
}

// Scratch peer: a CLAUDE.md that keeps every answer to one sentence, and an empty .claude/.
fs.mkdirSync(path.join(C.PF_SCRATCH_PEER, '.claude'), { recursive: true });
const claudeMd = [
  'You are a test peer for the Peers Flow phone app. Answer every message with ONE short sentence that repeats the user\'s words back, then stop. Never use tools unless asked. When a message starts with /voice-task, still answer in one sentence and finish with `<spoken>Test done.</spoken>`.',
  '',
  // Without this the echo replies read as unfinished work to Claude Code's job-state
  // classifier: an until-done voice chat then stays `working` and the Keeper nudges it forever.
  'Every reply is a complete, finished task: end it with the line `Done, nothing left to do.` and then `<spoken>Test done.</spoken>`.',
  '',
].join('\n');
fs.writeFileSync(path.join(C.PF_SCRATCH_PEER, 'CLAUDE.md'), claudeMd);
// A cheap STUB of the voice-task skill (never the real LISA one). Without any skill of that
// name Claude Code answers "Unknown command: /voice-task", runs no turn, and the voice chat
// sits in `blocked` forever.
const stubDir = path.join(C.PF_SCRATCH_PEER, '.claude', 'skills', 'voice-task');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'SKILL.md'), [
  '---',
  'name: voice-task',
  'description: Test stub of the phone voice-task skill. Answer in one sentence.',
  '---',
  '',
  'Answer the request in ONE short sentence that repeats the user\'s words back. Use no tools.',
  'Then, on its own line, write `<spoken>Test done.</spoken>` and stop.',
  '',
].join('\n'));

fs.mkdirSync(C.PF_USERDATA, { recursive: true });
const storePath = path.join(C.PF_USERDATA, 'store.json');
const peer = {
  id: C.PEER_ID,
  path: C.PF_SCRATCH_PEER,
  displayName: 'LISA',
  addedAt: new Date().toISOString(),
  customName: 'LISA',
};

let store = null;
if (fs.existsSync(storePath)) {
  try { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { store = null; }
}
if (!store || typeof store !== 'object') {
  store = {
    directories: [peer],
    conversations: [],
    dividers: [],
    todos: [],
    pinnedOrder: [],
    accounts: [],
    activeAccountId: null,
    rotationPolicy: { enabled: false, threshold: 95, resumeOnLimit: false },
    codexAccounts: [],
  };
  console.log('seeded new store');
} else {
  store.directories = Array.isArray(store.directories) ? store.directories : [];
  const existing = store.directories.find((d) => d && d.id === C.PEER_ID);
  if (existing) { existing.path = C.PF_SCRATCH_PEER; existing.displayName = 'LISA'; existing.customName = 'LISA'; }
  else store.directories.push(peer);
  // Never let an account sneak in.
  store.accounts = [];
  store.activeAccountId = null;
  store.rotationPolicy = { enabled: false, threshold: 95, resumeOnLimit: false };
  console.log('kept existing store (%d conversations), ensured peer row', (store.conversations || []).length);
}
// Sleeping services: a fresh userData defaults the loop to mode 'live', and it discovers the
// user's REAL Docker projects/containers globally, so an isolated instance would put them to
// sleep (docker stop) after their idle limit and arm wake proxies on their ports. 'watch'
// keeps the loop observe-only (electron/services/services.ts gates every sleep/arm on 'live').
const servicesPath = path.join(C.PF_USERDATA, 'services.json');
let services = null;
try { services = JSON.parse(fs.readFileSync(servicesPath, 'utf8')); } catch { services = null; }
if (!services || typeof services !== 'object') services = { version: 1, mode: 'watch', services: [] };
services.mode = 'watch';
fs.writeFileSync(servicesPath, JSON.stringify(services, null, 2));
console.log('services.json: mode watch');

const tmp = storePath + '.seed-tmp';
fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
fs.renameSync(tmp, storePath);
console.log('store:', storePath);
console.log('scratch peer:', C.PF_SCRATCH_PEER);
