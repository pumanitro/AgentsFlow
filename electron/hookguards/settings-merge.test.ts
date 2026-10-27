// mergePreToolUse against a fixture shaped like today's real settings.json:
// which groups go, which stay (and where), unknown keys, idempotence, and the
// three ways a hand-made command names its hook.

import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { realShapeSettings } from './fixtures/settings-real-shape';
import { HOOK_GUARDS } from './manifest';
import { handmadeGuardName, isPeersflowHook, mergePreToolUse } from './settings-merge';
import type { HookGroup } from './settings-merge';

function ptu(): HookGroup[] {
  return (realShapeSettings().hooks as { PreToolUse: HookGroup[] }).PreToolUse;
}

function desiredFor(ids: string[]): HookGroup[] {
  return HOOK_GUARDS.filter((s) => s.hook && ids.includes(s.id)).map((s) => ({
    matcher: s.hook!.matcher,
    hooks: [{ type: 'command', command: s.hook!.command, timeout: s.hook!.timeout, statusMessage: s.hook!.statusMessage }],
  }));
}

function supersedes(ids: string[]): string[] {
  return HOOK_GUARDS.filter((s) => ids.includes(s.id)).flatMap((s) => s.supersedes);
}

const HOOK_IDS = ['block-cookie-clearing', 'block-second-chrome', 'block-mass-kill', 'mem-admission'];
const commands = (gs: HookGroup[]) => gs.flatMap((g) => (g.hooks ?? []).map((h) => h.command));

describe('settings-merge', () => {
  test('replaces the 4 hand-made guard groups, keeps crew.py / worktree-hop-warn in order with their keys', () => {
    const r = mergePreToolUse(ptu(), desiredFor(HOOK_IDS), supersedes(HOOK_IDS));
    assert.equal(r.changed, true);
    assert.deepEqual(commands(r.groups), [
      '~/.claude/hooks/peersflow/block-cookie-clearing.sh',
      '~/.claude/hooks/peersflow/block-second-chrome.sh',
      'python3 ~/.claude/hooks/peersflow/block-mass-kill.py',
      '~/.claude/hooks/peersflow/mem-admission.sh',
      'python3 ~/.claude/hooks/crew.py hook',
      '~/.claude/hooks/worktree-hop-warn.sh',
    ]);
    assert.deepEqual(r.removedHandmade.sort(), ['block-cookie-clearing.sh', 'block-mass-kill.py', 'block-second-chrome.sh', 'mem-admission.sh']);
    const orig = ptu();
    assert.deepEqual(r.groups[4], orig[3], 'crew group verbatim, unknown key kept');
    assert.deepEqual(r.groups[5], orig[4], 'worktree group verbatim, nested unknown key kept');
  });

  test('idempotent: a second merge changes nothing', () => {
    const first = mergePreToolUse(ptu(), desiredFor(HOOK_IDS), supersedes(HOOK_IDS));
    const second = mergePreToolUse(first.groups, desiredFor(HOOK_IDS), supersedes(HOOK_IDS));
    assert.equal(second.changed, false);
    assert.deepEqual(second.groups, first.groups);
    assert.deepEqual(second.removedHandmade, []);
  });

  test('a failing guard keeps its hand-made group', () => {
    const passing = HOOK_IDS.filter((id) => id !== 'mem-admission');
    const r = mergePreToolUse(ptu(), desiredFor(passing), supersedes(passing));
    assert.ok(commands(r.groups).includes('~/.claude/hooks/mem-admission.sh'));
    assert.ok(!commands(r.groups).includes('~/.claude/hooks/peersflow/mem-admission.sh'));
    assert.ok(!r.removedHandmade.includes('mem-admission.sh'));
  });

  test('an app-owned entry for a now-failing guard is removed', () => {
    const first = mergePreToolUse(ptu(), desiredFor(HOOK_IDS), supersedes(HOOK_IDS)).groups;
    const passing = HOOK_IDS.filter((id) => id !== 'block-mass-kill');
    const r = mergePreToolUse(first, desiredFor(passing), supersedes(passing));
    assert.equal(r.changed, true);
    assert.ok(!commands(r.groups).some((c) => c?.includes('block-mass-kill')));
    assert.equal(commands(r.groups).length, 5);
  });

  test('a mixed group keeps its other hooks; a group without hooks is untouched', () => {
    const existing: HookGroup[] = [
      { matcher: 'X', other: true } as HookGroup,
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 1 }, { type: 'command', command: '~/.claude/hooks/block-second-chrome.sh' }] },
    ];
    const r = mergePreToolUse(existing, desiredFor(['block-second-chrome']), supersedes(['block-second-chrome']));
    assert.deepEqual(r.groups[0], existing[0]);
    assert.equal(r.groups[1].hooks![0].command, '~/.claude/hooks/peersflow/block-second-chrome.sh');
    assert.deepEqual(r.groups[2], { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 1 }] });
  });

  test('nothing touched → desired is appended; nothing desired and nothing touched → unchanged', () => {
    const base: HookGroup[] = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }];
    const r = mergePreToolUse(base, desiredFor(['block-mass-kill']), []);
    assert.equal(r.groups.length, 2);
    assert.equal(r.groups[1].hooks![0].command, 'python3 ~/.claude/hooks/peersflow/block-mass-kill.py');
    assert.equal(mergePreToolUse(base, [], []).changed, false);
  });

  test('tilde, $HOME, ${HOME} and absolute-home forms are all recognised; the installed path is not', () => {
    const names = ['block-mass-kill.py', 'mem-admission.sh'];
    assert.equal(handmadeGuardName({ command: 'python3 ~/.claude/hooks/block-mass-kill.py' }, names), 'block-mass-kill.py');
    assert.equal(handmadeGuardName({ command: 'python3 $HOME/.claude/hooks/block-mass-kill.py' }, names), 'block-mass-kill.py');
    assert.equal(handmadeGuardName({ command: 'python3 "${HOME}/.claude/hooks/block-mass-kill.py"' }, names), 'block-mass-kill.py');
    assert.equal(handmadeGuardName({ command: '/Users/someone/.claude/hooks/mem-admission.sh' }, names), 'mem-admission.sh');
    assert.equal(handmadeGuardName({ command: '/home/someone/.claude/hooks/mem-admission.sh --x' }, names), 'mem-admission.sh');
    assert.equal(handmadeGuardName({ command: '~/.claude/hooks/peersflow/mem-admission.sh' }, names), null);
    assert.equal(handmadeGuardName({ command: '~/.claude/hooks/mem-admission.sh.bak' }, names), null);
    assert.equal(handmadeGuardName({ command: '~/.claude/hooks/crew.py hook' }, names), null);
    assert.equal(isPeersflowHook({ command: '~/.claude/hooks/peersflow/mem-admission.sh' }), true);
    assert.equal(isPeersflowHook({ command: '~/.claude/hooks/mem-admission.sh' }), false);
  });
});
