import * as fs from 'fs';
import * as path from 'path';
import type { MobileScope } from '../../shared/mobile';
import type { DeviceFileSettings, DeviceRecord, DeviceStore } from './types';

// Paired phones + gateway settings live in <userData>/mobile-devices.json.
// The file holds token HASHES only (never a token) plus the STT key, so it is
// written 0600. Loading is sanitising: a corrupt or foreign row is dropped,
// never allowed to take the gateway down.

const FILE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 200;
const TOUCH_WRITE_MIN_MS = 30_000;
const REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_VOCABULARY = 200;
const SCOPES: MobileScope[] = ['view', 'talk', 'admin'];

interface FileShape { version: number; devices: DeviceRecord[]; settings: DeviceFileSettings }

const defaultSettings = (): DeviceFileSettings => ({ ownerLogin: '', sttKey: '', vocabulary: [], paused: false, httpsPort: 8443, publicUrl: '' });

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function sanitizeScopes(v: unknown): MobileScope[] {
  const want = new Set((Array.isArray(v) ? v : []).filter((s): s is MobileScope => SCOPES.includes(s as MobileScope)));
  want.add('view');
  return SCOPES.filter((s) => want.has(s));
}

export function sanitizeVocabulary(v: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(v) ? v : []) {
    if (typeof raw !== 'string') continue;
    const w = raw.trim();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_VOCABULARY) break;
  }
  return out;
}

function sanitizeDevice(d: any): DeviceRecord | null {
  if (!d || typeof d !== 'object') return null;
  const id = str(d.id);
  const tokenHash = str(d.tokenHash);
  if (!id || tokenHash === undefined) return null;
  const createdAt = str(d.createdAt) ?? new Date(0).toISOString();
  const out: DeviceRecord = {
    id,
    name: str(d.name) || 'phone',
    tokenHash,
    // Scopes on disk are taken as written (minus unknown ones); `view` is
    // re-added because every paired device can at least look.
    scopes: sanitizeScopes(d.scopes),
    createdAt,
    lastSeenAt: str(d.lastSeenAt) ?? createdAt,
    cursor: typeof d.cursor === 'number' && Number.isFinite(d.cursor) ? d.cursor : 0,
  };
  const lastIp = str(d.lastIp);
  if (lastIp) out.lastIp = lastIp;
  const revokedAt = str(d.revokedAt);
  if (revokedAt) { out.revokedAt = revokedAt; out.tokenHash = ''; }
  return out;
}

// Only an https:// origin (no path) is accepted: the phone refuses plain http outside the emulator.
export function normalizePublicUrl(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return '';
  try { const u = new URL(v.trim()); return u.protocol === 'https:' ? u.origin : ''; } catch { return ''; }
}

function sanitizeSettings(s: any): DeviceFileSettings {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  return {
    ownerLogin: (str(s.ownerLogin) ?? '').trim().toLowerCase(),
    sttKey: str(s.sttKey) ?? '',
    vocabulary: sanitizeVocabulary(s.vocabulary),
    paused: s.paused === true,
    httpsPort: Number.isInteger(s.httpsPort) && s.httpsPort > 0 && s.httpsPort < 65536 ? s.httpsPort : d.httpsPort,
    publicUrl: normalizePublicUrl(s.publicUrl),
  };
}

function load(filePath: string): FileShape {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const devices = (Array.isArray(raw?.devices) ? raw.devices : []).map(sanitizeDevice).filter((d: DeviceRecord | null): d is DeviceRecord => !!d);
    return { version: FILE_VERSION, devices, settings: sanitizeSettings(raw?.settings) };
  } catch {
    return { version: FILE_VERSION, devices: [], settings: defaultSettings() };
  }
}

export function createDeviceStore(filePath: string, now: () => number = Date.now): DeviceStore {
  const data = load(filePath);
  let timer: NodeJS.Timeout | null = null;
  let lastTouchWrite = 0;

  const prune = (): void => {
    const cutoff = now() - REVOKED_RETENTION_MS;
    data.devices = data.devices.filter((d) => !d.revokedAt || !(Date.parse(d.revokedAt) < cutoff));
  };
  prune();

  const writeNow = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    prune();
    const tmp = `${filePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, filePath);
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    }
  };
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
    timer.unref?.();
  };

  const find = (id: string): DeviceRecord | undefined => data.devices.find((d) => d.id === id);
  const copy = (d: DeviceRecord): DeviceRecord => ({ ...d, scopes: [...d.scopes] });
  const revokeRow = (d: DeviceRecord, at: string): void => {
    if (!d.revokedAt) d.revokedAt = at;
    d.tokenHash = '';
  };

  return {
    list() { prune(); return data.devices.map(copy); },
    get(id) { const d = find(id); return d ? copy(d) : null; },
    findByTokenHash(h) {
      if (!h) return null;
      const d = data.devices.find((x) => !x.revokedAt && x.tokenHash === h);
      return d ? copy(d) : null;
    },
    add(rec) {
      const clean = sanitizeDevice(rec);
      if (!clean) return;
      data.devices = data.devices.filter((d) => d.id !== clean.id);
      data.devices.push(clean);
      schedule();
    },
    touch(id, ip, nowIso) {
      const d = find(id);
      if (!d) return;
      d.lastSeenAt = nowIso;
      d.lastIp = ip;
      if (now() - lastTouchWrite >= TOUCH_WRITE_MIN_MS) { lastTouchWrite = now(); schedule(); }
    },
    setCursor(id, seq) {
      const d = find(id);
      if (!d || !Number.isFinite(seq)) return;
      d.cursor = seq;
      schedule();
    },
    setScopes(id, scopes) {
      const d = find(id);
      if (!d) return;
      d.scopes = sanitizeScopes(scopes);
      schedule();
    },
    revoke(id) {
      const d = find(id);
      if (!d) return;
      revokeRow(d, new Date(now()).toISOString());
      schedule();
    },
    revokeAll() {
      const at = new Date(now()).toISOString();
      for (const d of data.devices) revokeRow(d, at);
      schedule();
    },
    settings() { return { ...data.settings, vocabulary: [...data.settings.vocabulary] }; },
    updateSettings(patch) {
      const next = { ...data.settings, ...patch };
      data.settings = sanitizeSettings(next);
      if (patch.sttKey !== undefined && typeof patch.sttKey === 'string') data.settings.sttKey = patch.sttKey;
      schedule();
      return this.settings();
    },
    flushSync() { writeNow(); },
  };
}
