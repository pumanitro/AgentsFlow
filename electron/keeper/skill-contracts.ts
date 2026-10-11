// Skill contracts: how a chat declares its own run contract. The /until-done
// and /forever skills run INSIDE a chat and cannot reach the app, so they leave
// a note — one JSON file per session under SKILL_CONTRACTS_DIR — and the app
// applies it to the conversation that owns the session, then removes the file.
// `once` is the same note used as the stop control (`/until-done stop`).
//
// The skill is a shell script that never imports this module, so the file is
// the whole interface: anything that does not parse as a schema-1 note is
// removed, and a note no conversation claimed within SKILL_CONTRACT_TTL_MS is
// dropped (the chat was not started from Peers Flow, or is long gone).

import * as fs from 'fs';
import * as path from 'path';
import type { RunContract } from '../../shared/types';
import { LOCKS_DIR } from './paths';

export const SKILL_CONTRACTS_DIR = path.join(LOCKS_DIR, 'keeper-contracts');
export const SKILL_CONTRACT_TTL_MS = 24 * 60 * 60 * 1000;
// A file younger than this that does not parse may be half-written.
const HALF_WRITTEN_GRACE_MS = 10_000;

export interface SkillContractNote {
  schema: 1;
  at: string;          // ISO
  sessionId: string;
  contract: RunContract;
  goal: string;        // the finish line / what to keep doing, in the user's words; may be ''
  cwd: string;
}

const CONTRACTS: RunContract[] = ['once', 'until-done', 'forever'];

export function parseSkillContractNote(json: string): SkillContractNote | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.schema !== 1) return null;
  if (typeof r.sessionId !== 'string' || !r.sessionId.trim()) return null;
  if (typeof r.at !== 'string' || !Number.isFinite(Date.parse(r.at))) return null;
  if (!CONTRACTS.includes(r.contract as RunContract)) return null;
  return {
    schema: 1,
    at: r.at,
    sessionId: r.sessionId.trim(),
    contract: r.contract as RunContract,
    goal: typeof r.goal === 'string' ? r.goal : '',
    cwd: typeof r.cwd === 'string' ? r.cwd : '',
  };
}

/**
 * Every readable note, oldest first. Rubbish and notes past the TTL are
 * removed on the way. Async throughout: this runs on a main-process timer.
 */
export async function listSkillContractNotes(dir: string = SKILL_CONTRACTS_DIR, now: number = Date.now()): Promise<Array<{ file: string; note: SkillContractNote }>> {
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ file: string; note: SkillContractNote }> = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue; // a writer's temp file
    const file = path.join(dir, name);
    try {
      const [text, st] = await Promise.all([fs.promises.readFile(file, 'utf8'), fs.promises.stat(file)]);
      const note = parseSkillContractNote(text);
      const age = now - st.mtimeMs;
      if (!note) {
        if (age > HALF_WRITTEN_GRACE_MS) await consumeSkillContractNote(file);
        continue;
      }
      if (now - Date.parse(note.at) > SKILL_CONTRACT_TTL_MS) {
        await consumeSkillContractNote(file);
        continue;
      }
      out.push({ file, note });
    } catch {
      /* vanished between readdir and read — nothing to do */
    }
  }
  return out.sort((a, b) => Date.parse(a.note.at) - Date.parse(b.note.at));
}

/** Removes a note. Never throws. */
export async function consumeSkillContractNote(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file);
  } catch {
    /* already gone */
  }
}
