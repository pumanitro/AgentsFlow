import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { consumeSkillContractNote, listSkillContractNotes, parseSkillContractNote, SKILL_CONTRACT_TTL_MS } from './skill-contracts';

const note = (over: Record<string, unknown> = {}) => JSON.stringify({
  schema: 1, at: '2026-10-11T10:00:00Z', sessionId: 'abc12345-0000', contract: 'forever', goal: 'run the council', cwd: '/tmp/p', ...over,
});

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skill-contracts-'));
}

test('parses a schema-1 note and defaults the optional text', () => {
  assert.deepEqual(parseSkillContractNote(note()), {
    schema: 1, at: '2026-10-11T10:00:00Z', sessionId: 'abc12345-0000', contract: 'forever', goal: 'run the council', cwd: '/tmp/p',
  });
  const bare = parseSkillContractNote(note({ goal: undefined, cwd: 7 }));
  assert.equal(bare?.goal, '');
  assert.equal(bare?.cwd, '');
});

test('accepts all three contracts — once is the stop control', () => {
  for (const c of ['once', 'until-done', 'forever']) assert.equal(parseSkillContractNote(note({ contract: c }))?.contract, c);
});

test('rejects anything that is not a usable note', () => {
  assert.equal(parseSkillContractNote('{'), null);
  assert.equal(parseSkillContractNote('[]'), null);
  assert.equal(parseSkillContractNote(note({ schema: 2 })), null);
  assert.equal(parseSkillContractNote(note({ sessionId: '  ' })), null);
  assert.equal(parseSkillContractNote(note({ at: 'yesterday' })), null);
  assert.equal(parseSkillContractNote(note({ contract: 'until done' })), null);
});

test('lists notes oldest first and skips temp files', async () => {
  const dir = tmp();
  const now = Date.parse('2026-10-11T10:05:00Z');
  fs.writeFileSync(path.join(dir, 'b.json'), note({ at: '2026-10-11T10:02:00Z', sessionId: 'b' }));
  fs.writeFileSync(path.join(dir, 'a.json'), note({ at: '2026-10-11T10:01:00Z', sessionId: 'a' }));
  fs.writeFileSync(path.join(dir, '.c.json.tmp.1'), note({ sessionId: 'c' }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const got = await listSkillContractNotes(dir, now);
  assert.deepEqual(got.map((g) => g.note.sessionId), ['a', 'b']);
  assert.ok(fs.existsSync(path.join(dir, '.c.json.tmp.1')));
});

test('removes rubbish once it is old enough to not be half-written, and notes past the TTL', async () => {
  const dir = tmp();
  const bad = path.join(dir, 'bad.json');
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(bad, '{');
  fs.writeFileSync(old, note({ at: '2026-10-01T00:00:00Z' }));
  // Fresh rubbish survives one look.
  assert.deepEqual(await listSkillContractNotes(dir, Date.now()), []);
  assert.ok(fs.existsSync(bad));
  assert.ok(!fs.existsSync(old), 'a note past the TTL is dropped');
  // …and is removed once it has had time to be finished.
  await listSkillContractNotes(dir, Date.now() + 60_000);
  assert.ok(!fs.existsSync(bad));
  assert.ok(SKILL_CONTRACT_TTL_MS > 60_000);
});

test('a missing folder is an empty list, and consuming twice never throws', async () => {
  assert.deepEqual(await listSkillContractNotes(path.join(tmp(), 'nope')), []);
  const dir = tmp();
  const f = path.join(dir, 'a.json');
  fs.writeFileSync(f, note());
  await consumeSkillContractNote(f);
  await consumeSkillContractNote(f);
  assert.ok(!fs.existsSync(f));
});
