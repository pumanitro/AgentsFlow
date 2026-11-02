import * as crypto from 'crypto';
import { MOBILE_OWNER_HEADER, MOBILE_PAIR_SCHEME, type PairingOffer } from '../../shared/mobile';
import type { AuthOutcome, AuthService, DeviceRecord, DeviceStore, LogFn } from './types';

// Who may talk to the gateway: (1) outside dev mode the request must arrive
// through Tailscale Serve carrying the owner's login, (2) it must carry a
// bearer token minted at pairing. Tokens are stored only as sha256 hashes.

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_TTL_MS = 120_000;
const AUTHFAIL_LIMIT = 20;
const AUTHFAIL_WINDOW_MS = 60_000;
const PRUNE_EVERY = 1000;

type Headers = Record<string, string | string[] | undefined>;

export function hashToken(t: string): string {
  return crypto.createHash('sha256').update(t, 'utf8').digest('hex');
}

export function mintToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

const header = (h: Headers, name: string): string => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

function randomCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const normaliseCode = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function createAuthService(o: { devices: DeviceStore; devMode: boolean; ownerLogin: () => string; log: LogFn; now?: () => number }): AuthService {
  const now = o.now ?? Date.now;
  let offer: PairingOffer | null = null;
  let offerExpiresMs = 0;
  const windows = new Map<string, number[]>();
  let calls = 0;

  const allow = (key: string, limit: number, windowMs: number): boolean => {
    const t = now();
    if (++calls % PRUNE_EVERY === 0) {
      for (const [k, ts] of windows) if (!ts.length || ts[ts.length - 1] <= t - windowMs) windows.delete(k);
    }
    const ts = (windows.get(key) ?? []).filter((x) => x > t - windowMs);
    if (ts.length >= limit) { windows.set(key, ts); return false; }
    ts.push(t);
    windows.set(key, ts);
    return true;
  };

  const ownerOk = (headers: Headers): boolean => {
    if (o.devMode) return true;
    const owner = o.ownerLogin().trim().toLowerCase();
    return owner !== '' && header(headers, MOBILE_OWNER_HEADER).trim().toLowerCase() === owner;
  };

  const fail = (ip: string, status: 401 | 403, code: 'unauthorized' | 'forbidden', error: string): AuthOutcome => {
    if (!allow('authfail:' + ip, AUTHFAIL_LIMIT, AUTHFAIL_WINDOW_MS)) {
      return { ok: false, status: 429, code: 'rate_limited', error: 'too many failed attempts, slow down' };
    }
    return { ok: false, status, code, error };
  };

  const currentOffer = (): PairingOffer | null => {
    if (offer && now() >= offerExpiresMs) offer = null;
    return offer;
  };

  return {
    allow,
    ownerOk,
    authenticate(headers, ip) {
      if (!ownerOk(headers)) {
        o.log('auth rejected: owner header', { ip, got: header(headers, MOBILE_OWNER_HEADER) || null });
        return fail(ip, 403, 'forbidden', "request did not come through the owner's tailnet identity");
      }
      const m = /^Bearer\s+(\S+)\s*$/i.exec(header(headers, 'authorization'));
      if (!m) return fail(ip, 401, 'unauthorized', 'missing or malformed bearer token');
      const device = o.devices.findByTokenHash(hashToken(m[1]));
      if (!device || device.revokedAt) {
        o.log('auth rejected: unknown token', { ip });
        return fail(ip, 401, 'unauthorized', 'unknown or revoked device');
      }
      const nowIso = new Date(now()).toISOString();
      o.devices.touch(device.id, ip, nowIso);
      return { ok: true, device: { ...device, lastSeenAt: nowIso, lastIp: ip } };
    },
    createPairingCode(url, fingerprint) {
      const code = randomCode();
      offerExpiresMs = now() + PAIR_TTL_MS;
      offer = {
        code,
        url,
        expiresAt: new Date(offerExpiresMs).toISOString(),
        qr: `${MOBILE_PAIR_SCHEME}?url=${encodeURIComponent(url)}&code=${code}&fp=${fingerprint}`,
        fingerprint,
      };
      o.log('pairing offer created', { expiresAt: offer.expiresAt });
      return { ...offer };
    },
    currentOffer() { const c = currentOffer(); return c ? { ...c } : null; },
    cancelPairing() { offer = null; },
    redeemPairingCode(code, deviceName, ip) {
      const active = currentOffer();
      if (!active) { o.log('pair rejected: no active code', { ip }); return null; }
      const got = normaliseCode(typeof code === 'string' ? code : '');
      const want = normaliseCode(active.code);
      const a = Buffer.from(got);
      const b = Buffer.from(want);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        o.log('pair rejected: wrong code', { ip });
        return null;
      }
      offer = null;   // one code = one device
      const token = mintToken();
      const createdAt = new Date(now()).toISOString();
      const device: DeviceRecord = {
        id: crypto.randomBytes(6).toString('hex'),
        name: (typeof deviceName === 'string' ? deviceName : '').trim().slice(0, 60) || 'phone',
        tokenHash: hashToken(token),
        scopes: ['view', 'talk'],
        createdAt,
        lastSeenAt: createdAt,
        lastIp: ip,
        cursor: 0,
      };
      o.devices.add(device);
      o.log('device paired', { deviceId: device.id, name: device.name, ip });
      return { token, device: { ...device, scopes: [...device.scopes] } };
    },
  };
}
