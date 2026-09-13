import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HANDOVER_MAX_CHARS, buildHandoverPrompt, codexHistoryText, condense, extractClaudeTurns, forkKickoff, planFork } from './handover';
import type { Conversation } from '../shared/types';

// A small stand-in for a Claude Code transcript: the entry shapes a handover
// actually meets — a user turn, an assistant turn that edited a file and ran a
// command, the tool results those produced, and the noise entries in between.
const JSONL = [
  JSON.stringify({ type: 'summary', summary: 'not a turn' }),
  JSON.stringify({ type: 'user', message: { content: 'add a retry to the poller' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'Looking at the poller now.' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/electron/poller.ts', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'retry' } },
      ],
    },
  }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '17 tests passed' }] } }),
  JSON.stringify({ type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text: "You've hit your session limit" }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done — the retry is in.' }] } }),
  'not json at all',
  '',
].join('\n');

test('extractClaudeTurns: keeps user and assistant text, drops everything else', () => {
  const turns = extractClaudeTurns(JSONL);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'assistant']);
  assert.equal(turns[0].text, 'add a retry to the poller');
  assert.equal(turns[2].text, 'Done — the retry is in.');
});

test('extractClaudeTurns: a tool_use carries the file it touched, not just its name', () => {
  // "[used tool Edit]" says work happened somewhere; the path says where, which
  // is what stops the next agent starting the same edit over.
  const [, assistant] = extractClaudeTurns(JSONL);
  assert.match(assistant.text, /\[edited \/repo\/electron\/poller\.ts\]/);
  assert.match(assistant.text, /\[ran: npm test\]/);
  assert.match(assistant.text, /\[used tool Grep\]/);
});

test('extractClaudeTurns: a long command is truncated rather than pasted whole', () => {
  const command = 'echo ' + 'x'.repeat(500);
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const [turn] = extractClaudeTurns(line);
  assert.equal(turn.text.length, '[ran: ]'.length + 200);
});

test('extractClaudeTurns: a turn that is only a tool result is not a turn', () => {
  const line = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } });
  assert.deepEqual(extractClaudeTurns(line), []);
});

test('extractClaudeTurns: a rate-limited turn is not history', () => {
  assert.equal(extractClaudeTurns(JSONL).some((t) => /session limit/.test(t.text)), false);
});

test('condense: the newest turns are the ones that survive the budget', () => {
  const turns = [
    { role: 'user' as const, text: 'oldest' },
    { role: 'assistant' as const, text: 'middle' },
    { role: 'user' as const, text: 'newest' },
  ];
  const out = condense(turns, 40);
  assert.match(out, /newest/);
  assert.equal(/oldest/.test(out), false);
  // Order is restored: a transcript read backwards is not a transcript.
  assert.ok(out.indexOf('middle') < out.indexOf('newest'));
});

test('condense: one turn over budget is kept whole rather than dropped to nothing', () => {
  const out = condense([{ role: 'user', text: 'a'.repeat(500) }], 10);
  assert.match(out, /^USER: a{500}$/);
});

test('condense: an oversized single turn is clipped at 2000 characters', () => {
  const out = condense([{ role: 'assistant', text: 'b'.repeat(5000) }], HANDOVER_MAX_CHARS);
  assert.equal(out.length, 'ASSISTANT: '.length + 2001); // 2000 chars + the ellipsis
});

test('codexHistoryText: tool entries are dropped, roles are normalised', () => {
  const out = codexHistoryText([
    { role: 'user', text: 'build it' },
    { role: 'tool', text: 'ls -la' },
    { role: 'assistant', text: 'built' },
    { role: 'assistant', text: '   ' },
  ]);
  assert.equal(out, 'USER: build it\n\nASSISTANT: built');
});

test('buildHandoverPrompt: names the previous agent, the reason and the history', () => {
  const prompt = buildHandoverPrompt({
    from: 'claude',
    history: 'USER: do the thing\n\nASSISTANT: did it',
    userMessage: 'carry on',
    reason: 'Claude ran out of headroom',
  });
  assert.match(prompt, /handed over to you from Claude Code \(Claude ran out of headroom\)/);
  assert.match(prompt, /=== Previous conversation with Claude Code \(most recent last\) ===/);
  assert.match(prompt, /ASSISTANT: did it/);
  assert.match(prompt, /The user's message:\ncarry on$/);
});

test('buildHandoverPrompt: no history says so instead of pretending there was none', () => {
  // Silence about an unreadable transcript reads to the new agent as "nothing
  // has happened yet", which is exactly the restart-from-scratch this avoids.
  const prompt = buildHandoverPrompt({ from: 'codex', history: '   ', userMessage: '' });
  assert.match(prompt, /handed over to you from Codex\./);
  assert.match(prompt, /previous transcript could not be read/);
  assert.equal(/=== Previous conversation/.test(prompt), false);
  // An empty user message still has to ask for something.
  assert.match(prompt, /The user's message:\ncontinue$/);
});

// ---------------------------------------------------------------------------
// Planning a fork to the other provider
// ---------------------------------------------------------------------------

const AT = '2026-09-13T10:00:00.000Z';

function source(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    provider: 'claude',
    sessionId: 'claude-session',
    daemonShort: 'abcd1234',
    sessionName: '',
    directoryId: 'dir-1',
    directoryPath: '/repo',
    displayName: 'repo',
    title: 'Fix the parser',
    description: 'working',
    pinned: true,
    attachments: [],
    state: 'working',
    status: 'working',
    intent: 'fix the parser',
    createdAt: '2026-09-12T09:00:00.000Z',
    lastPrompt: 'fix the parser',
    ...over,
  };
}

test('planFork: a fork to Codex names the session to read rather than copying it', () => {
  // The Claude transcript is a file that keeps growing while the source runs,
  // so the plan records where to find it and the Codex thread reads it when it
  // starts — copying it here would freeze it at the moment of the click.
  const plan = planFork({ source: source(), target: 'codex', at: AT });
  assert.deepEqual(plan.row.handover, {
    from: 'claude',
    sessionId: 'claude-session',
    directoryPath: '/repo',
    at: AT,
    reason: 'forked from Claude',
  });
  assert.equal(plan.prompt, forkKickoff('claude'));
  assert.equal(plan.title, 'V2 · Fix the parser');
  assert.equal(plan.row.description, 'forked to Codex — starting…');
});

test('planFork: a fork to Claude carries the transcript inside its first message', () => {
  // A Codex thread lives in the app-server, which forgets it on a restart, so
  // this direction has no "read it later" option.
  const plan = planFork({
    source: source({ provider: 'codex', sessionId: 'thread-9', title: 'Fix the parser' }),
    target: 'claude',
    at: AT,
    history: 'USER: fix the build\n\nASSISTANT: build is green',
  });
  assert.equal(plan.row.handover, undefined, 'nothing is left pending — the seed has already been sent');
  assert.match(plan.prompt, /handed over to you from Codex \(forked from Codex\)/);
  assert.match(plan.prompt, /ASSISTANT: build is green/);
  assert.ok(plan.prompt.endsWith(forkKickoff('codex')));
});

test('planFork: the row records the kickoff line, not the seed that is sent', () => {
  // `lastPrompt` shows in the list and is written to the store on every save; a
  // whole transcript in it is unreadable in one place and wasteful in the other.
  const plan = planFork({ source: source({ provider: 'codex' }), target: 'claude', at: AT, history: 'x'.repeat(5000) });
  assert.equal(plan.row.lastPrompt, forkKickoff('codex'));
  assert.equal(plan.row.intent, forkKickoff('codex'));
  assert.ok(plan.prompt.length > 4000, 'the message actually sent still carries it');
});

test('planFork: a source that entered a worktree is continued in that worktree', () => {
  const plan = planFork({ source: source({ worktreePath: '/repo/.worktrees/parser' }), target: 'codex', at: AT });
  assert.equal(plan.cwd, '/repo/.worktrees/parser');
  assert.equal(plan.row.handover?.directoryPath, '/repo/.worktrees/parser');
});

test('forkKickoff: the fork is asked to report, not to start working', () => {
  // The source is still running in the same directory; two agents editing the
  // same files off the same transcript is the thing to design out.
  assert.match(forkKickoff('claude'), /^This conversation was forked to you from Claude Code\./);
  assert.match(forkKickoff('codex'), /Do not start any work until asked\.$/);
});
