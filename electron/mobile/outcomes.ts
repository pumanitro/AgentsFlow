// Outcome feed for the mobile gateway: what a finished turn said (D11
// `<spoken>` / `<needs>` tags, or a plain-text fallback), and the moment a
// chat starts needing an answer. Pure + synchronous fs; no electron import.
import * as fs from 'fs';
import * as path from 'path';
import type { Conversation } from '../../shared/types';
import type { ConversationSummary, FeedItem, JobSlice, MobileConvState, NeedsYouItem, OutcomeItem } from '../../shared/mobile';
import type { FeedStore, LogFn } from './types';

const SPOKEN_MAX = 600;
const FALLBACK_MAX = 300;

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

export function extractOutcome(text: string): { spoken: string; needs?: string } {
  const src = text || '';
  const spokenM = /<spoken>([\s\S]*?)<\/spoken>/i.exec(src);
  if (spokenM) {
    const spoken = cap(spokenM[1].trim().replace(/\s*\n+\s*/g, ' ').replace(/\s+/g, ' '), SPOKEN_MAX);
    const needsM = /<needs>([\s\S]*?)<\/needs>/i.exec(src);
    const needs = needsM ? needsM[1].trim().replace(/\s+/g, ' ') : '';
    return needs ? { spoken, needs } : { spoken };
  }
  let t = src
    .replace(/```[\s\S]*?(```|$)/g, ' ')                 // code fences
    .replace(/<\/?[a-z][\w-]*>/gi, ' ')                    // stray tags
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')            // markdown links → their text
    .replace(/\bhttps?:\/\/[^\s)>\]]+/gi, ' ')             // URLs
    .replace(/(^|[\s(])(?:~\/|\/)[^\s)]*[^\s).,;:!?'"]/g, '$1') // absolute / home paths
    .replace(/`([^`]*)`/g, '$1')                           // inline code
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2') // emphasis
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?)/gm, '')     // headings, bullets, quotes
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  const sentences = t.match(/[^.!?]*[.!?]+(?=\s|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentences.length > 0) t = sentences.slice(0, 2).join(' ');
  return { spoken: cap(t, FALLBACK_MAX) };
}

interface FeedFile { version: 1; seq: number; items: FeedItem[] }

export function createFeedStore(filePath: string, max = 500): FeedStore {
  let seq = 0;
  let items: FeedItem[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<FeedFile>;
    if (raw && Array.isArray(raw.items)) {
      items = raw.items.filter((i): i is FeedItem => !!i && typeof i === 'object' && typeof (i as FeedItem).seq === 'number'
        && ((i as FeedItem).kind === 'outcome' || (i as FeedItem).kind === 'needs-you'));
      items.sort((a, b) => a.seq - b.seq);
    }
    const maxItemSeq = items.length ? items[items.length - 1].seq : 0;
    seq = Math.max(typeof raw?.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0, maxItemSeq);
  } catch { /* missing or corrupt: start empty */ }

  let timer: NodeJS.Timeout | null = null;
  const writeNow = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    const body: FeedFile = { version: 1, seq, items };
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch { /* best effort; next append retries */ }
  };
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(writeNow, 250);
    timer.unref?.();
  };
  return {
    append(item) {
      const full = { ...item, seq: ++seq } as FeedItem;
      items.push(full);
      if (items.length > max) items = items.slice(items.length - max);
      schedule();
      return full;
    },
    after(n) {
      return items.filter((i) => i.seq > n);
    },
    latestSeq() {
      return seq;
    },
    flushSync() {
      if (timer) writeNow();
    },
  };
}

export function createOutcomeWatcher(o: {
  feed: FeedStore;
  readLastAssistant: (conv: Conversation) => { text: string; at: string; uuid: string } | null;
  onItem: (item: FeedItem) => void;
  log: LogFn;
}): { tick(summaries: ConversationSummary[], convs: Conversation[], slice: (id: string) => JobSlice | null): void } {
  type Prev = { state: MobileConvState | null; lastUuid: string | null; lastQuestionKey: string | null };
  const prev = new Map<string, Prev>();
  let seeded = false;
  const questionKey = (s: JobSlice | null): string =>
    (s?.questions.map((q) => q.question).join('|') || s?.needs || '');

  return {
    tick(summaries, convs, slice) {
      const convById = new Map(convs.map((c) => [c.id, c] as const));
      const alive = new Set<string>();
      for (const s of summaries) {
        alive.add(s.id);
        let p = prev.get(s.id);
        if (!seeded) {
          // First sight only records the state: nothing is announced for what
          // was already true before the watcher started.
          let key: string | null = null;
          if (s.state === 'blocked') { try { key = questionKey(slice(s.id)) || null; } catch { key = null; } }
          prev.set(s.id, { state: s.state, lastUuid: null, lastQuestionKey: key });
          continue;
        }
        if (!p) { p = { state: null, lastUuid: null, lastQuestionKey: null }; prev.set(s.id, p); }
        const was = p.state;
        if ((was === 'working' || was === 'blocked' || was === 'starting') && (s.state === 'done' || s.state === 'idle')) {
          const conv = convById.get(s.id);
          let la: { text: string; at: string; uuid: string } | null = null;
          try { la = conv ? o.readLastAssistant(conv) : null; } catch (err) {
            o.log('[agentsflow][mobile] outcome: readLastAssistant failed', { conversationId: s.id, error: String(err) });
          }
          if (la && la.uuid !== p.lastUuid) {
            const { spoken, needs } = extractOutcome(la.text);
            const draft: Omit<OutcomeItem, 'seq'> = {
              kind: 'outcome', conversationId: s.id, title: s.title, peerName: s.peerName,
              at: la.at || new Date().toISOString(), spoken, ...(needs ? { needs } : {}), messageId: la.uuid,
            };
            const item = o.feed.append(draft);
            p.lastUuid = la.uuid;
            o.onItem(item);
          }
        }
        if (s.state === 'blocked') {
          let sl: JobSlice | null = null;
          try { sl = slice(s.id); } catch { sl = null; }
          const key = questionKey(sl);
          if (key && key !== p.lastQuestionKey && sl) {
            const draft: Omit<NeedsYouItem, 'seq'> = {
              kind: 'needs-you', conversationId: s.id, title: s.title, peerName: s.peerName,
              at: new Date().toISOString(), questions: sl.questions,
              ...(sl.needs ? { needs: sl.needs } : {}),
              ...(sl.suggestedReply ? { suggestedReply: sl.suggestedReply } : {}),
            };
            const item = o.feed.append(draft);
            p.lastQuestionKey = key;
            o.onItem(item);
          }
        } else {
          p.lastQuestionKey = null;
        }
        p.state = s.state;
      }
      seeded = true;
      for (const id of Array.from(prev.keys())) if (!alive.has(id)) prev.delete(id);
    },
  };
}
