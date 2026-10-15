import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { allAnswered, canDismiss, missingForDismiss, needsSend } from '../../../shared/notifications';
import type { NotificationQuestion, UserNotification } from '../../../shared/notifications';
import { formatSlot } from '../../../shared/routine-schedule';
import { api } from '../../lib/ipc';
import { useNotificationsUI } from '../../lib/use-notifications';

const PRIMARY = 'px-3 py-1 text-[11px] uppercase tracking-wider rounded-md bg-accent text-bg font-semibold hover:bg-accent2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-accent';
// The Routines preview's button, so Dismiss reads as one of the app's own.
const BTN = 'px-3 py-1 text-[11px] uppercase tracking-wider rounded-md border border-border bg-panel text-muted hover:text-text hover:bg-panel2 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-panel disabled:hover:text-muted';
const CHIP_BTN = 'px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded border border-border bg-panel text-muted hover:text-text hover:bg-panel2';

export const hhmm = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
};
const basename = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const answered = (q: NotificationQuestion) => typeof q.answer === 'string' && q.answer.length > 0;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One "needs you" notice. Collapsed it is a title, where it came from and a
 * call to action; expanded it holds the files, the agent's questions, the
 * user's own to-dos, "Send answers" and Dismiss — which stays locked, with
 * the reason under it, until missingForDismiss() is empty.
 */
export default function NotificationCard({ n, expanded, onToggle }: { n: UserNotification; expanded: boolean; onToggle: () => void }) {
  const router = useRouter();
  const { actions } = useNotificationsUI();
  const [fileMsg, setFileMsg] = useState<{ text: string; err: boolean } | null>(null);
  const [qErr, setQErr] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // readAt is "the user has looked at it": stamped on the first expand only.
  useEffect(() => {
    if (expanded && !n.readAt) actions.markRead(n.id).catch(() => {});
  }, [expanded, n.id, n.readAt, actions]);

  const answer = (q: NotificationQuestion, value: string) => {
    if (value === (q.answer ?? '')) return;
    actions.answer(n.id, q.id, value)
      .then(() => setQErr((cur) => { const next = { ...cur }; delete next[q.id]; return next; }))
      .catch((e) => setQErr((cur) => ({ ...cur, [q.id]: errText(e) })));
  };
  const openFile = (path: string, label: string) => {
    actions.openFile(n.id, path)
      .then((r) => setFileMsg(r.status === 'success' ? { text: `Opened ${label}`, err: false } : { text: r.error ?? `Could not open ${label}`, err: true }))
      .catch((e) => setFileMsg({ text: errText(e), err: true }));
  };
  const reveal = (path: string) => {
    api().revealInFinder(path)
      .then((r) => { if (!r.ok) setFileMsg({ text: r.error, err: true }); })
      .catch((e) => setFileMsg({ text: errText(e), err: true }));
  };
  const send = () => {
    setSending(true);
    setErr(null);
    actions.sendAnswers(n.id).catch((e) => setErr(errText(e))).finally(() => setSending(false));
  };
  const dismiss = () => {
    setErr(null);
    actions.dismiss(n.id).catch((e) => setErr(errText(e)));
  };

  const missing = missingForDismiss(n);
  const delivery = n.answersDelivery;
  const from = n.source.conversationTitle ?? n.source.routineName ?? 'a chat';
  const convId = n.source.conversationId;

  return (
    <div className="border border-orange-500/55 border-l-[3px] border-l-orange-500 rounded-md bg-panel2/45">
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="w-full text-left p-2.5 flex gap-2 items-start">
        <span className="mt-1.5 shrink-0 w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
        <span className="text-[13px] font-semibold leading-[18px] text-text">{n.title}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle" title={`Arrived ${formatSlot(n.createdAt)}`}>{hhmm(n.createdAt)}</span>
        <span className={`shrink-0 text-muted text-[11px] leading-[18px] transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
      </button>
      <div className="pl-6 pr-2.5 text-[11px] text-subtle flex flex-wrap items-center gap-1.5">
        <span>from <span className="text-muted">{from}</span></span>
        {convId && (
          <>
            <span>·</span>
            <button type="button" className="text-accent hover:underline" onClick={() => router.push({ pathname: '/session', query: { id: convId } })}>Open chat ›</button>
          </>
        )}
      </div>
      {n.body && <div className="pl-6 pr-2.5 pt-1.5 pb-2.5 text-[12px] leading-[17px] text-muted whitespace-pre-wrap break-words">{n.body}</div>}

      {!expanded && (
        <div className="pl-6 pr-2.5 pb-2.5">
          <button type="button" className={PRIMARY} onClick={onToggle}>
            {n.questions.length ? `Answer ${n.questions.length} question${n.questions.length === 1 ? '' : 's'} ›` : 'See what to do ›'}
          </button>
        </div>
      )}

      {expanded && (
        <div className="px-2.5 pb-2.5 flex flex-col gap-3">
          {n.files.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {n.files.map((f) => {
                const label = f.label ?? basename(f.path);
                return (
                  <div key={f.path} className="flex items-center gap-2 rounded-md border border-border bg-panel px-2 py-1.5 text-[12px]" title={f.path}>
                    <span aria-hidden="true">📄</span>
                    <span className="truncate min-w-0 flex-1 text-text">{label}</span>
                    <button type="button" className={CHIP_BTN} onClick={() => openFile(f.path, label)}>Open</button>
                    <button type="button" className={CHIP_BTN} onClick={() => reveal(f.path)}>Reveal</button>
                  </div>
                );
              })}
              {fileMsg && <div className={`text-[11px] ${fileMsg.err ? 'text-err' : 'text-subtle'}`}>{fileMsg.text}</div>}
            </div>
          )}

          {n.questions.length > 0 && (
            <ol className="flex flex-col gap-2.5">
              {n.questions.map((q, i) => (
                <li key={q.id} className="flex flex-col gap-1">
                  <div className="flex gap-1.5 text-[12px] text-text">
                    <span className="text-subtle font-mono">{i + 1}.</span>
                    <span className="flex-1">{q.text}</span>
                    {answered(q) && <span className="text-ok" title="Answered">✓</span>}
                  </div>
                  <div className="pl-4 flex flex-col gap-1">
                    {q.kind === 'yesno' && (
                      <div className="flex gap-1.5">
                        {(['yes', 'no'] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            aria-pressed={q.answer === v}
                            onClick={() => answer(q, v)}
                            className={`px-3 py-0.5 text-[11px] uppercase tracking-wider rounded-md border ${q.answer === v ? 'bg-accent text-bg border-accent font-semibold' : 'border-border bg-panel text-muted hover:text-text hover:bg-panel2'}`}
                          >{v === 'yes' ? 'Yes' : 'No'}</button>
                        ))}
                      </div>
                    )}
                    {q.kind === 'choice' && (
                      <div className="flex flex-col gap-0.5" role="radiogroup">
                        {(q.choices ?? []).map((c) => (
                          <label key={c} className="flex items-center gap-2 text-[12px] text-muted hover:text-text cursor-pointer">
                            <input type="radio" name={`${n.id}-${q.id}`} checked={q.answer === c} onChange={() => answer(q, c)} className="accent-accent" />
                            {c}
                          </label>
                        ))}
                      </div>
                    )}
                    {q.kind === 'text' && (
                      <input
                        type="text"
                        value={drafts[q.id] ?? q.answer ?? ''}
                        placeholder="Type your answer"
                        onChange={(e) => setDrafts((cur) => ({ ...cur, [q.id]: e.target.value }))}
                        onBlur={(e) => answer(q, e.target.value.trim())}
                        onKeyDown={(e) => { if (e.key === 'Enter') answer(q, e.currentTarget.value.trim()); }}
                        className="w-full bg-panel border border-border rounded px-2 py-1 text-sm text-text outline-none focus:border-accent"
                      />
                    )}
                    {q.hint && <div className="text-[11px] text-subtle">{q.hint}</div>}
                    {qErr[q.id] && <div className="text-[11px] text-err">{qErr[q.id]}</div>}
                  </div>
                </li>
              ))}
            </ol>
          )}

          {n.todos.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="text-[11px] uppercase tracking-wider text-muted">Your to-dos</div>
              {n.todos.map((t) => (
                <label key={t.id} className="flex items-start gap-2 text-[12px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={t.done}
                    onChange={(e) => { actions.setTodo(n.id, t.id, e.target.checked).catch((er) => setErr(errText(er))); }}
                    className="mt-0.5 accent-accent"
                  />
                  <span className={t.done ? 'line-through text-muted' : 'text-text'}>{t.text}</span>
                </label>
              ))}
            </div>
          )}

          <div className="border-t border-border/60 pt-2.5 flex flex-col gap-2">
            {needsSend(n) && (!delivery || !delivery.ok) && (
              <div className="flex items-center gap-2 flex-wrap">
                <button type="button" className={PRIMARY} disabled={!allAnswered(n) || sending} onClick={send}>
                  {sending ? 'Sending…' : delivery ? 'Try again' : 'Send answers to the agent'}
                </button>
                {delivery && !delivery.ok && <span className="text-[11px] text-err">Could not deliver: {delivery.error ?? 'unknown error'}</span>}
              </div>
            )}
            {delivery?.ok && <div className="text-[11px] text-ok">✓ Sent to the chat ‘{n.source.conversationTitle ?? 'the chat'}’</div>}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`${BTN}${canDismiss(n) ? ' text-ok border-ok' : ''}`}
                disabled={!canDismiss(n)}
                title={missing.length ? `Unlocks when: ${missing.join(', ')}` : 'Everything is done — clear this notice'}
                onClick={dismiss}
              >Dismiss</button>
              <span className={`text-[11px] leading-[15px] ${missing.length ? 'text-subtle' : 'text-ok'}`}>
                {missing.length ? `Unlocks when: ${missing.join(', ')}` : '✓ All done — you can clear it'}
              </span>
            </div>
            {err && <div className="text-[11px] text-err">{err}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
