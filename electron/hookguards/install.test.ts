// The installer end to end against a fake shipped dir whose selftests are tiny
// bash scripts (`exit 0` / `exit 1`) and a settings file shaped like the real
// one: snapshot rows, one backup, hand-made files moved aside, the shim dir set
// and unset, a malformed settings file left alone, and the start/recheck timer
// plumbing. Nothing outside mkdtemp is touched.

import { strict as assert } from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HookGuardsSnapshot } from '../../shared/hookguards';
import { realShapeSettings } from './fixtures/settings-real-shape';
import {
  __resetHookGuardsForTests, getHookGuardsSnapshot, recheckHookGuards, runInstall, startHookGuards, stopHookGuards,
} from './install';
import type { HookGuardsDeps } from './install';
import { HOOK_GUARDS, SHARED_FILES } from './manifest';
import { killShimDir } from './shim-path';

interface Sandbox { root: string; shipped: string; deps: HookGuardsDeps; snaps: HookGuardsSnapshot[]; logs: string[] }

/** A fake shipped dir: every manifest file exists; selftests exit 0 unless listed in `failing`. */
function sandbox(failing: string[] = [], settings: string | null = JSON.stringify(realShapeSettings(), null, 2)): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-install-'));
  const shipped = path.join(root, 'shipped');
  const rels = [...SHARED_FILES, ...HOOK_GUARDS.flatMap((s) => s.files)];
  for (const rel of rels) {
    fs.mkdirSync(path.dirname(path.join(shipped, rel)), { recursive: true });
    fs.writeFileSync(path.join(shipped, rel), '#!/bin/bash\nexit 0\n');
  }
  for (const s of HOOK_GUARDS) {
    const fail = failing.includes(s.id);
    fs.writeFileSync(path.join(shipped, s.selftest!), fail ? 'echo "case 3 broke" >&2\nexit 1\n' : 'echo "passed=2 failed=0"\nexit 0\n');
  }
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(hooks);
  for (const n of ['block-cookie-clearing.sh', 'block-second-chrome.sh', 'block-mass-kill.py', 'block-mass-kill.selftest.sh', 'mem-admission.sh', 'mem-admission.selftest.sh', 'crew.py', 'worktree-hop-warn.sh']) {
    fs.writeFileSync(path.join(hooks, n), `# hand-made ${n}\n`);
  }
  if (settings !== null) fs.writeFileSync(path.join(root, 'settings.json'), settings);
  const snaps: HookGuardsSnapshot[] = [];
  const logs: string[] = [];
  let t = 1_700_000_000_000;
  const deps: HookGuardsDeps = {
    shippedDir: shipped,
    installDir: path.join(root, 'peersflow'),
    supersededDir: path.join(root, 'peersflow-superseded'),
    handmadeHooksDir: hooks,
    settingsPath: path.join(root, 'settings.json'),
    backupDir: path.join(root, 'backups'),
    env: () => process.env,
    onSnapshot: (s) => snaps.push(s),
    log: (m) => logs.push(m),
    now: () => (t += 10),
    startDelayMs: 5,
  };
  return { root, shipped, deps, snaps, logs };
}

function ptuCommands(p: string): string[] {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return j.hooks.PreToolUse.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command));
}

afterEach(() => __resetHookGuardsForTests());

describe('runInstall', () => {
  test('all pass: files installed, settings rewritten once with a backup, hand-made files moved, shims on', async () => {
    const sb = sandbox();
    const before = fs.readFileSync(sb.deps.settingsPath, 'utf8');
    const s = await runInstall(sb.deps);
    assert.equal(s.phase, 'done');
    assert.equal(s.lastRun!.error, null);
    assert.equal(s.lastRun!.filesWritten, SHARED_FILES.length + HOOK_GUARDS.flatMap((g) => g.files).length);
    assert.equal(s.lastRun!.settingsChanged, true);
    assert.equal(fs.readFileSync(s.lastRun!.backup!, 'utf8'), before);
    assert.deepEqual(s.guards.map((g) => [g.id, g.state, g.registered]), HOOK_GUARDS.map((g) => [g.id, 'active', true]));
    assert.equal(s.guards[0].detail, 'passed=2 failed=0');
    assert.equal(s.guards[0].entry, path.join(sb.deps.installDir, 'block-cookie-clearing.sh'));
    assert.ok(s.guards.every((g) => g.verifiedAt && g.checkMs !== null));
    assert.equal(killShimDir(), path.join(sb.deps.installDir, 'bin'));
    assert.equal(s.shimDir, killShimDir());
    assert.deepEqual(ptuCommands(sb.deps.settingsPath), [
      '~/.claude/hooks/peersflow/block-cookie-clearing.sh',
      '~/.claude/hooks/peersflow/block-second-chrome.sh',
      'python3 ~/.claude/hooks/peersflow/block-mass-kill.py',
      '~/.claude/hooks/peersflow/mem-admission.sh',
      'python3 ~/.claude/hooks/crew.py hook',
      '~/.claude/hooks/worktree-hop-warn.sh',
    ]);
    const after = JSON.parse(fs.readFileSync(sb.deps.settingsPath, 'utf8'));
    assert.deepEqual(after.permissions, { allow: ['Bash(ls:*)'] });
    assert.deepEqual(after.hooks.Notification, realShapeSettings().hooks && (realShapeSettings().hooks as Record<string, unknown>).Notification);
    assert.equal(s.lastRun!.supersededMoved.length, 6);
    assert.deepEqual(fs.readdirSync(sb.deps.handmadeHooksDir).sort(), ['crew.py', 'worktree-hop-warn.sh']);
    assert.ok(fs.readdirSync(sb.deps.supersededDir).every((f) => /\.\d+$/.test(f)));
    assert.equal(fs.statSync(path.join(sb.deps.installDir, 'bin/pkill')).mode & 0o777, 0o755);
    // phases seen and kill-shims checked first
    assert.deepEqual([...new Set(sb.snaps.map((x) => x.phase))], ['installing', 'checking', 'done']);
    const firstChecking = sb.snaps.find((x) => x.guards.some((g) => g.state === 'checking'))!;
    assert.equal(firstChecking.guards.find((g) => g.state === 'checking')!.id, 'kill-shims');
    assert.ok(sb.logs.includes('settings written, backup ' + s.lastRun!.backup));
    assert.ok(sb.logs.some((l) => /^block-mass-kill ok \d+\.\ds$/.test(l)));
  });

  test('a second pass writes nothing and keeps the single backup', async () => {
    const sb = sandbox();
    await runInstall(sb.deps);
    const s2 = await runInstall(sb.deps);
    assert.equal(s2.phase, 'done');
    assert.equal(s2.lastRun!.filesWritten, 0);
    assert.equal(s2.lastRun!.settingsChanged, false);
    assert.equal(s2.lastRun!.backup, null);
    assert.equal(fs.readdirSync(sb.deps.backupDir).length, 1);
    assert.ok(sb.logs.includes('settings unchanged'));
    assert.ok(s2.guards.every((g) => g.state === 'active' && g.registered));
  });

  test('a failing hook guard is not registered and its hand-made entry + files stay', async () => {
    const sb = sandbox(['mem-admission']);
    const s = await runInstall(sb.deps);
    const row = s.guards.find((g) => g.id === 'mem-admission')!;
    assert.deepEqual([row.state, row.registered, row.verifiedAt, row.detail], ['failed', false, null, 'case 3 broke']);
    assert.ok(ptuCommands(sb.deps.settingsPath).includes('~/.claude/hooks/mem-admission.sh'));
    assert.ok(fs.existsSync(path.join(sb.deps.handmadeHooksDir, 'mem-admission.sh')));
    assert.ok(fs.existsSync(path.join(sb.deps.handmadeHooksDir, 'mem-admission.selftest.sh')));
    assert.ok(sb.logs.includes('mem-admission FAILED: case 3 broke'));
  });

  test('a guard that passed before and fails now is unregistered', async () => {
    const sb = sandbox();
    await runInstall(sb.deps);
    fs.writeFileSync(path.join(sb.shipped, 'block-mass-kill.selftest.sh'), 'exit 1\n');
    const s = await runInstall(sb.deps);
    assert.equal(s.lastRun!.settingsChanged, true);
    assert.ok(!ptuCommands(sb.deps.settingsPath).some((c) => c.includes('block-mass-kill')));
    assert.equal(s.guards.find((g) => g.id === 'block-mass-kill')!.registered, false);
  });

  test('failing shims → shim dir off; passing again → back on', async () => {
    const sb = sandbox(['kill-shims']);
    const s = await runInstall(sb.deps);
    assert.equal(killShimDir(), null);
    assert.equal(s.shimDir, null);
    const shims = s.guards.find((g) => g.id === 'kill-shims')!;
    assert.deepEqual([shims.state, shims.registered], ['failed', false]);
    fs.writeFileSync(path.join(sb.shipped, 'bin/shims.selftest.sh'), 'exit 0\n');
    await runInstall(sb.deps);
    assert.equal(killShimDir(), path.join(sb.deps.installDir, 'bin'));
  });

  test('malformed settings: files still installed and checked, nothing written, run-level error', async () => {
    const sb = sandbox([], '{ not json');
    const s = await runInstall(sb.deps);
    assert.equal(s.phase, 'error');
    assert.match(s.lastRun!.error!, /not valid JSON/);
    assert.equal(fs.readFileSync(sb.deps.settingsPath, 'utf8'), '{ not json');
    assert.ok(fs.existsSync(path.join(sb.deps.installDir, 'lib/killcheck.py')));
    assert.ok(!fs.existsSync(sb.deps.backupDir));
    assert.equal(s.lastRun!.supersededMoved.length, 0);
    assert.ok(fs.existsSync(path.join(sb.deps.handmadeHooksDir, 'block-mass-kill.py')));
    assert.ok(s.guards.filter((g) => g.id !== 'kill-shims').every((g) => !g.registered));
  });

  test('hooks.PreToolUse not an array → error, no write', async () => {
    const sb = sandbox([], JSON.stringify({ hooks: { PreToolUse: {} } }));
    const s = await runInstall(sb.deps);
    assert.equal(s.phase, 'error');
    assert.match(s.lastRun!.error!, /PreToolUse/);
    assert.equal(fs.readFileSync(sb.deps.settingsPath, 'utf8'), JSON.stringify({ hooks: { PreToolUse: {} } }));
  });

  test('missing settings / missing hooks → created', async () => {
    const sb = sandbox([], null);
    const s = await runInstall(sb.deps);
    assert.equal(s.phase, 'done');
    assert.equal(s.lastRun!.backup, null);
    assert.equal(ptuCommands(sb.deps.settingsPath).length, 4);
    const sb2 = sandbox([], JSON.stringify({ model: 'x' }));
    await runInstall(sb2.deps);
    assert.equal(JSON.parse(fs.readFileSync(sb2.deps.settingsPath, 'utf8')).model, 'x');
    assert.equal(ptuCommands(sb2.deps.settingsPath).length, 4);
  });

  test('missing shipped file → install error, every row failed, settings untouched', async () => {
    const sb = sandbox();
    fs.rmSync(path.join(sb.shipped, 'lib', 'killcheck.py'));
    const before = fs.readFileSync(sb.deps.settingsPath, 'utf8');
    const s = await runInstall(sb.deps);
    assert.equal(s.phase, 'error');
    assert.match(s.lastRun!.error!, /install failed/);
    assert.ok(s.guards.every((g) => g.state === 'failed'));
    assert.equal(fs.readFileSync(sb.deps.settingsPath, 'utf8'), before);
  });
});

describe('start / recheck', () => {
  test('idle snapshot before the first run; start schedules one pass; recheck coalesces', async () => {
    const idle = getHookGuardsSnapshot();
    assert.equal(idle.phase, 'idle');
    assert.ok(idle.guards.every((g) => g.state === 'pending'));
    const sb = sandbox();
    startHookGuards(sb.deps);
    startHookGuards(sb.deps); // no-op
    assert.equal(getHookGuardsSnapshot().installDir, sb.deps.installDir);
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => { if (sb.snaps.some((x) => x.phase === 'done')) { clearInterval(poll); resolve(); } }, 10);
    });
    assert.equal(sb.snaps.filter((x) => x.phase === 'installing').length, 1);
    const a = recheckHookGuards();
    const b = recheckHookGuards();
    assert.equal(a, b);
    assert.equal((await a).phase, 'done');
    assert.equal(getHookGuardsSnapshot().phase, 'done');
    stopHookGuards();
  });

  test('stop before the delay → no pass runs', async () => {
    const sb = sandbox();
    startHookGuards({ ...sb.deps, startDelayMs: 30 });
    stopHookGuards();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sb.snaps.length, 0);
  });
});
