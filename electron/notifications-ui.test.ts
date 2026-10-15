/**
 * The notification UI, rendered for real: the drawer's pointer card. There is
 * no in-app answering UI — agents ask in their chat and the user answers there
 * by typing. The renderer's .tsx is not part of the
 * electron build, so this test transpiles it on require (TypeScript's
 * transpileModule) and renders it with react-dom/server.
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { UserNotification } from '../shared/notifications';

const ROOT = path.resolve(__dirname, '../../..');   // dist/electron/electron → repo root

/* eslint-disable @typescript-eslint/no-var-requires */
type Loader = (m: NodeJS.Module & { _compile(code: string, file: string): void }, file: string) => void;
function hookTypeScript(): void {
  const ts = require('typescript') as typeof import('typescript');
  const exts = require.extensions as unknown as Record<string, Loader>;
  const load: Loader = (m, file) => {
    const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    });
    m._compile(out.outputText, file);
  };
  for (const ext of ['.ts', '.tsx']) if (!exts[ext]) exts[ext] = load;
}

const NOW = '2026-10-15T09:00:00.000Z';

const lisa = (extra: Partial<UserNotification> = {}): UserNotification => ({
  id: 'n-1',
  level: 'action',
  title: 'Abilitie timesheet (1–15 Oct) is ready — needs you',
  body: 'I prepared the timesheet PDF. I asked 3 questions in the chat.',
  source: { kind: 'routine', conversationId: 'conv-1', conversationTitle: 'Abilitie timesheet · 15 Oct 09:00', routineName: 'Abilitie timesheet' },
  createdAt: NOW,
  files: [{ path: '/Users/demo/Desktop/LISA/timesheets/oct.pdf', label: 'October timesheet (PDF)' }],
  ...extra,
});

const fileActions = {
  openFile: async () => ({ status: 'success' as const }),
  reveal: async () => ({ ok: true as const }),
};

// Every <button>…</button> with its attributes, so a test can check one by its label.
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], label: m[2].replace(/<[^>]+>/g, '') }));

let render: (el: unknown) => string;
let h: (type: unknown, props: Record<string, unknown>) => unknown;
let NotificationCard: (p: Record<string, unknown>) => unknown;

before(() => {
  hookTypeScript();
  const React = require(require.resolve('react', { paths: [ROOT] }));
  render = require(require.resolve('react-dom/server', { paths: [ROOT] })).renderToStaticMarkup;
  h = React.createElement;
  NotificationCard = require(path.join(ROOT, 'renderer/components/notifications/NotificationCard.tsx')).default;
});

describe('drawer notice (NotificationCard) is only a pointer', () => {
  it('shows title, chat name, "Look inside the chat", body, files, Open chat and Dismiss — no inputs, no send', () => {
    const html = render(h(NotificationCard, { n: lisa(), fileActions, onOpenChat: () => {}, onDismiss: () => {} }));
    assert.match(html, /Abilitie timesheet \(1–15 Oct\) is ready/);
    assert.match(html, /Abilitie timesheet · 15 Oct 09:00/);
    assert.match(html, /Look inside the chat — it needs you/);
    assert.match(html, /I asked 3 questions in the chat\./);
    assert.match(html, /October timesheet \(PDF\)/);
    assert.deepEqual(buttons(html).map((b) => b.label), ['Open', 'Reveal', 'Open chat ›', 'Dismiss']);
    assert.doesNotMatch(html, /<input|<textarea|<select/);
    assert.doesNotMatch(html, /Send answers|questions? and|to-do/);
  });

  it('Dismiss is always enabled', () => {
    const html = render(h(NotificationCard, { n: lisa(), fileActions, onOpenChat: () => {}, onDismiss: () => {} }));
    const dismiss = buttons(html).find((b) => b.label === 'Dismiss');
    assert.ok(dismiss);
    assert.doesNotMatch(dismiss.attrs, /disabled=""/);
  });

  it('a legacy notice still carrying questions / todos renders as a plain pointer', () => {
    const legacy = { ...lisa(), questions: [{ id: 'q1', text: 'Secret question?', kind: 'yesno' }], todos: [{ id: 't1', text: 'Secret to-do', done: false }] } as unknown as UserNotification;
    const html = render(h(NotificationCard, { n: legacy, fileActions, onOpenChat: () => {}, onDismiss: () => {} }));
    assert.doesNotMatch(html, /Secret question|Secret to-do/);
    assert.match(html, /Look inside the chat — it needs you/);
  });

  it('the in-chat question card is gone', () => {
    for (const f of ['ChatQuestionsCard.tsx', 'ChatQuestionsDock.tsx']) {
      assert.equal(fs.existsSync(path.join(ROOT, 'renderer/components/notifications', f)), false, f);
    }
  });
});
