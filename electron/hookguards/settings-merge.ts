// Merging the app's guard hooks into hooks.PreToolUse of ~/.claude/settings.json.
//
// Ownership is decided by the command path alone (no marker keys are ever
// written): a hook whose command contains INSTALL_DIR_MARK is ours and is
// rewritten on every pass; a hand-made hook pointing at ~/.claude/hooks/<name>
// for a name a PASSING guard supersedes is dropped. Everything else — crew.py,
// worktree-hop-warn.sh, unknown keys on groups and hooks — is kept verbatim and
// in its order. Pure: no fs, no clock.

import { INSTALL_DIR_MARK } from './manifest';

export interface HookCommand { type?: string; command?: string; [k: string]: unknown }
export interface HookGroup { matcher?: string; hooks?: HookCommand[]; [k: string]: unknown }
export interface MergeResult { groups: HookGroup[]; removedHandmade: string[]; changed: boolean }

export function isPeersflowHook(h: HookCommand): boolean {
  return typeof h?.command === 'string' && h.command.includes(INSTALL_DIR_MARK);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The supersedable name a hand-made hook runs, or null. Recognises the
 * `~/.claude/hooks/<name>`, `$HOME/…`, `${HOME}/…` and absolute-home
 * (`/Users/<x>/…`, `/home/<x>/…`) forms; `<name>` must end the path, so the
 * installed `…/hooks/peersflow/<name>` never matches.
 */
export function handmadeGuardName(h: HookCommand, names: readonly string[]): string | null {
  const cmd = h?.command;
  if (typeof cmd !== 'string' || cmd.includes(INSTALL_DIR_MARK)) return null;
  for (const name of names) {
    const re = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|/Users/[^/\\s'"]+|/home/[^/\\s'"]+)/\\.claude/hooks/${escapeRe(name)}(?=$|[\\s'";|&)])`);
    if (re.test(cmd)) return name;
  }
  return null;
}

/**
 * 1. drops our hooks from every group, 2. drops superseded hand-made hooks
 * (a group left without hooks is dropped), 3. inserts `desired` where the first
 * touched group was (else appends), 4. keeps unknown keys verbatim. Idempotent:
 * merging the result again with the same inputs changes nothing.
 */
export function mergePreToolUse(existing: HookGroup[], desired: HookGroup[], supersedeNames: readonly string[]): MergeResult {
  const kept: HookGroup[] = [];
  const removedHandmade: string[] = [];
  let insertAt = -1;
  for (const group of existing) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks : null;
    if (!hooks) {
      kept.push(group);
      continue;
    }
    const remaining: HookCommand[] = [];
    let touched = false;
    for (const h of hooks) {
      if (isPeersflowHook(h)) {
        touched = true;
        continue;
      }
      const name = handmadeGuardName(h, supersedeNames);
      if (name) {
        touched = true;
        removedHandmade.push(name);
        continue;
      }
      remaining.push(h);
    }
    if (touched && insertAt < 0) insertAt = kept.length;
    if (!touched) kept.push(group);
    else if (remaining.length) kept.push({ ...group, hooks: remaining });
  }
  const groups = insertAt < 0 ? [...kept, ...desired] : [...kept.slice(0, insertAt), ...desired, ...kept.slice(insertAt)];
  return { groups, removedHandmade, changed: JSON.stringify(groups) !== JSON.stringify(existing) };
}
