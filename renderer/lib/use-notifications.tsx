import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { countsOf, isOpen } from '../../shared/notifications';
import type { NotificationsSnapshot, UserNotification } from '../../shared/notifications';
import { api } from './ipc';

// How long the bell glows after a new notice arrives.
const RING_MS = 1200;

export interface NotificationActions {
  markRead: (id: string) => Promise<UserNotification>;
  answer: (id: string, questionId: string, answer: string) => Promise<UserNotification>;
  setTodo: (id: string, todoId: string, done: boolean) => Promise<UserNotification>;
  sendAnswers: (id: string) => Promise<UserNotification>;
  dismiss: (id: string) => Promise<UserNotification>;
  openFile: (id: string, filePath: string) => Promise<{ status: 'success' | 'failure'; error?: string }>;
}

export interface NotificationsUI {
  available: boolean;
  list: UserNotification[];
  counts: { action: number; warn: number };
  open: boolean;
  setOpen: (open: boolean | ((o: boolean) => boolean)) => void;
  focusId: string | null;
  setFocusId: (id: string | null) => void;
  ring: boolean;
  /** The last "needs you" notice was just dismissed: the drawer says so in green. */
  justCleared: boolean;
  actions: NotificationActions;
}

const STALE = 'Notifications need a restart of Peers Flow.';
const stale = () => Promise.reject(new Error(STALE));

const NOOP_ACTIONS: NotificationActions = {
  markRead: stale, answer: stale, setTodo: stale, sendAnswers: stale, dismiss: stale, openFile: stale,
};

// Outside a provider (or before the first snapshot) the bell simply hides.
const NotificationsContext = createContext<NotificationsUI>({
  available: false,
  list: [],
  counts: { action: 0, warn: 0 },
  open: false,
  setOpen: () => {},
  focusId: null,
  setFocusId: () => {},
  ring: false,
  justCleared: false,
  actions: NOOP_ACTIONS,
});

/** Electron wraps a handler's rejection as "Error invoking remote method 'x': Error: …" — keep only the main message. */
function mainMessage(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  return new Error(raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '') || 'Something went wrong.');
}

/** Typing into a field or a terminal: a new notice must not steal the keyboard. */
function userIsTyping(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return !!el.closest('[contenteditable], .xterm');
}

/**
 * The notices from main: one `listNotifications` on mount, then every
 * `onNotificationsUpdated` push replaces the list.
 *
 * Stale-preload rule: in dev the renderer hot-reloads ahead of a preload that
 * was built before notifications existed. Every api member is optional, so a
 * missing `listNotifications` means "this main cannot do it yet" — the bell
 * stays hidden and every action rejects with a one-line hint, nothing throws.
 *
 * Auto-open rule: a snapshot with an open "action" id the previous snapshot did
 * not have focuses that card. If the user is typing (an input, a textarea, an
 * editor or a terminal has focus) only the bell rings and the badge grows;
 * otherwise the drawer opens by itself. The first snapshot after a (re)load is
 * the baseline, so a reload never pops the drawer for notices already seen.
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  const [list, setList] = useState<UserNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [ring, setRing] = useState(false);
  const [justCleared, setJustCleared] = useState(false);
  // Open ids of the previous snapshot; null until the baseline arrived.
  const seenRef = useRef<Set<string> | null>(null);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const apply = useCallback((snap: NotificationsSnapshot) => {
    const openOnes = snap.notifications.filter(isOpen);
    const prev = seenRef.current;
    seenRef.current = new Set(openOnes.map((n) => n.id));
    setList(openOnes);
    if (!prev) return;
    const fresh = openOnes.filter((n) => !prev.has(n.id));
    if (!fresh.length) return;
    setRing(true);
    if (ringTimer.current) clearTimeout(ringTimer.current);
    ringTimer.current = setTimeout(() => setRing(false), RING_MS);
    const action = fresh.find((n) => n.level === 'action');
    if (!action) return;
    setJustCleared(false);
    setFocusId(action.id);
    if (!userIsTyping()) setOpen(true);
  }, []);

  useEffect(() => {
    const a = api();
    if (typeof a.listNotifications !== 'function') return;
    setAvailable(true);
    let alive = true;
    a.listNotifications?.()
      .then((snap) => { if (alive) apply(snap); })
      .catch((e) => { console.warn('[agentsflow][notifications] list failed', e); });
    const offUpdated = a.onNotificationsUpdated?.((snap) => { if (alive) apply(snap); });
    // A click on the macOS banner: show that very notice.
    const offOpen = a.onNotificationOpen?.(({ id }) => { if (alive) { setFocusId(id); setOpen(true); } });
    return () => {
      alive = false;
      offUpdated?.();
      offOpen?.();
      if (ringTimer.current) clearTimeout(ringTimer.current);
    };
  }, [apply]);

  // The returned record lands at once; the push that follows confirms it.
  const merge = useCallback((n: UserNotification) => {
    setList((cur) => (isOpen(n) ? cur.map((x) => (x.id === n.id ? n : x)) : cur.filter((x) => x.id !== n.id)));
    return n;
  }, []);

  const actions = useMemo<NotificationActions>(() => {
    const call = <T,>(p: Promise<T> | undefined): Promise<T> => (p ? p.catch((e) => { throw mainMessage(e); }) : stale());
    return {
      markRead: (id) => call(api().markNotificationRead?.(id)).then(merge),
      answer: (id, q, answer) => call(api().answerNotification?.(id, q, answer)).then(merge),
      setTodo: (id, t, done) => call(api().setNotificationTodo?.(id, t, done)).then(merge),
      sendAnswers: (id) => call(api().sendNotificationAnswers?.(id)).then(merge),
      dismiss: (id) => call(api().dismissNotification?.(id)).then((n) => {
        merge(n);
        if (n.level === 'action') setJustCleared(true);
        return n;
      }),
      openFile: (id, filePath) => call(api().openNotificationFile?.(id, filePath)),
    };
  }, [merge]);

  // "Just cleared" is a moment, not a state: it ends when the drawer closes.
  useEffect(() => { if (!open) setJustCleared(false); }, [open]);

  const counts = useMemo(() => countsOf(list), [list]);
  const value = useMemo<NotificationsUI>(() => ({
    available, list, counts, open, setOpen, focusId, setFocusId, ring, justCleared, actions,
  }), [available, list, counts, open, focusId, ring, justCleared, actions]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotificationsUI(): NotificationsUI {
  return useContext(NotificationsContext);
}
