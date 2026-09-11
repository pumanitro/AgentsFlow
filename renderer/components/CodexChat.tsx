import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CodexReply, CodexRequest, CodexSnapshot } from '../../shared/codex';
import { api } from '../lib/ipc';
import { imageFilesFromPaste, savePastedImages, type PastedImage } from '../lib/paste-image';

const stateLabel = (state: string) => ({ 'needs-input': 'Needs your input', inProgress: 'Working', done: 'Done', working: 'Working', idle: 'Ready', stopped: 'Stopped', completed: 'Completed', error: 'Error' }[state] || state);

function RequestCard({ request, reply }: { request: CodexRequest; reply: (value: CodexReply) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [content, setContent] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries((request.schema?.properties || {}) as Record<string, { type?: string }>).filter(([, field]) => field.type === 'boolean').map(([key]) => [key, false])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields = (request.schema?.properties || {}) as Record<string, { type?: string; title?: string; description?: string; enum?: string[] }>;
  const required = (request.schema?.required || []) as string[];
  const respond = async (accept: boolean) => {
    setBusy(true); setError('');
    try { await reply({ accept, answers, content }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <form className="rounded-lg border border-amber-500/60 bg-panel p-4 my-3" onSubmit={(e) => { e.preventDefault(); void respond(true); }}>
    <h3 className="font-semibold mb-2">{request.title}</h3>
    <pre className="text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto mb-3">{request.detail}</pre>
    {request.url && <a href={request.url} target="_blank" rel="noreferrer" className="text-accent underline">Open connection request</a>}
    {request.questions?.map((q) => <label key={q.id} className="block text-sm mb-3">
      <span className="block mb-1">{q.question}</span>
      {q.options?.map((o) => <button key={o.label} type="button" title={o.description} onClick={() => setAnswers({ ...answers, [q.id]: o.label })} className={`mr-2 mb-2 px-2 py-1 rounded border ${answers[q.id] === o.label ? 'border-accent text-accent' : 'border-border'}`}>{o.label}</button>)}
      <input aria-label={q.question} type={q.isSecret ? 'password' : 'text'} required value={answers[q.id] || ''} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} className="w-full bg-bg border border-border rounded p-2" placeholder="Your answer" />
    </label>)}
    {Object.entries(fields).map(([key, field]) => <label key={key} className="block text-sm mb-3">{field.title || key}
      {field.description && <span className="block text-xs text-muted">{field.description}</span>}
      {field.enum ? <select aria-label={field.title || key} required={required.includes(key)} value={String(content[key] ?? '')} onChange={(e) => setContent({ ...content, [key]: e.target.value })} className="block w-full p-2 bg-bg border border-border rounded"><option value="">Choose…</option>{field.enum.map((v) => <option key={v}>{v}</option>)}</select>
      : field.type === 'boolean' ? <input type="checkbox" checked={Boolean(content[key])} onChange={(e) => setContent({ ...content, [key]: e.target.checked })} className="ml-2" />
      : <input required={required.includes(key)} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} value={String(content[key] ?? '')} onChange={(e) => setContent({ ...content, [key]: field.type === 'number' || field.type === 'integer' ? Number(e.target.value) : e.target.value })} className="block w-full p-2 bg-bg border border-border rounded" />}
    </label>)}
    {error && <p role="alert" className="text-red-400 text-sm mb-2">{error}</p>}
    <div className="flex gap-2"><button disabled={busy} type="submit" className="px-3 py-1.5 bg-accent text-bg rounded">{request.questions ? 'Submit answer' : 'Allow once'}</button><button disabled={busy} type="button" onClick={() => void respond(false)} className="px-3 py-1.5 border border-border rounded">Decline</button></div>
  </form>;
}

export default function CodexChat({ conversationId }: { conversationId: string; directoryPath: string }) {
  const [snapshot, setSnapshot] = useState<CodexSnapshot | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [images, setImages] = useState<PastedImage[]>([]);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    let alive = true;
    const unsub = api().onCodexUpdated((s) => { if (alive && s.conversationId === conversationId) setSnapshot(s); });
    api().codexSnapshot(conversationId).then((s) => { if (alive) setSnapshot(s); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; unsub(); };
  }, [conversationId]);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [snapshot]);
  const working = snapshot?.state === 'working' || snapshot?.state === 'needs-input';
  const send = async () => {
    if (busy || working || !prompt.trim()) return;
    setBusy(true); setError(''); follow.current = true;
    try { await api().codexSend(conversationId, prompt, images.map((i) => i.savedPath)); setPrompt(''); setImages([]); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="h-full flex flex-col min-h-0 bg-bg text-text">
    <div className="px-4 py-2 border-b border-border flex justify-between text-xs text-muted"><span>Codex · {snapshot ? stateLabel(snapshot.state) : 'Connecting'}</span><span>Uses your Codex sign-in</span></div>
    <div ref={scroll} onScroll={() => { const el = scroll.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; }} className="flex-1 min-h-0 overflow-auto p-5 select-text">
      <div className="max-w-4xl mx-auto">
        {snapshot?.hasOlder && <button className="text-sm text-accent mb-4" onClick={() => { follow.current = false; api().codexSnapshot(conversationId, true).then(setSnapshot).catch((e) => setError(e.message)); }}>Load earlier messages</button>}
        {snapshot?.entries.map((entry) => entry.role === 'tool' ? <details key={entry.id} className="mb-2 text-xs rounded border border-border bg-panel p-2"><summary className="cursor-pointer truncate text-muted">{entry.status ? `${stateLabel(entry.status)} · ` : ''}{entry.text.split('\n')[0]}</summary><pre className="mt-2 whitespace-pre-wrap break-words max-h-80 overflow-auto">{entry.text}</pre></details>
          : <article key={entry.id} className={`mb-5 rounded-lg p-4 ${entry.role === 'user' ? 'bg-panel border border-border' : ''}`}><div className="text-[10px] uppercase tracking-wider text-muted mb-2">{entry.role === 'user' ? 'You' : 'Codex'}</div><div className="prose prose-invert max-w-none text-sm break-words"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown></div></article>)}
        {snapshot?.requests.map((request) => <RequestCard key={request.id} request={request} reply={(value) => api().codexReply(conversationId, request.id, value)} />)}
        {(error || snapshot?.error) && <p role="alert" className="text-red-400 text-sm whitespace-pre-wrap break-words p-3">{error || snapshot?.error}<button type="button" className="block text-accent underline mt-2" onClick={() => { setError(''); api().codexSnapshot(conversationId).then(setSnapshot).catch((e) => setError(e.message)); }}>Reconnect</button></p>}
        {!snapshot && !error && <p className="text-muted text-sm">Connecting to Codex…</p>}
      </div>
    </div>
    <form className="p-3 border-t border-border bg-panel" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      {images.length > 0 && <div className="flex gap-2 mb-2">{images.map((img) => <button key={img.id} type="button" title="Remove attached image" onClick={() => setImages(images.filter((i) => i.id !== img.id))}><img src={img.dataUrl} alt="Attached image" className="h-16 rounded" /></button>)}</div>}
      <div className="flex gap-2"><textarea aria-label="Message Codex" value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} onPaste={async (e) => { const files = imageFilesFromPaste(e); if (!files.length) return; e.preventDefault(); const res = await savePastedImages(files); setImages((prev) => [...prev, ...res.images]); if (res.error) setError(res.error); }} placeholder={working ? 'Codex is working. You can draft your next message here.' : 'Continue with Codex…'} rows={2} className="flex-1 resize-none bg-bg border border-border rounded p-2 text-sm outline-none focus:border-accent" />
        {working ? <button type="button" onClick={() => api().stopAgent(conversationId).catch((e) => setError(e.message))} className="self-end px-3 py-2 border border-border rounded text-sm">Stop</button> : <button disabled={busy || !prompt.trim()} type="submit" className="self-end px-4 py-2 bg-accent text-bg rounded text-sm disabled:opacity-40">{busy ? 'Sending…' : 'Send'}</button>}
      </div>
    </form>
  </div>;
}
