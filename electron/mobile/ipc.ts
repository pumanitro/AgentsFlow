import * as QRCode from 'qrcode';
import { MOBILE_IPC } from '../../shared/mobile';
import type { MobileScope, MobileSettings, MobileStatus, PairingOffer } from '../../shared/mobile';
import type { MobileGateway } from './types';

const OFFLINE: MobileStatus = {
  running: false, port: 0, devMode: false, paused: false, connectedSockets: 0, devices: [],
  settings: { ownerLogin: '', sttKeySet: false, vocabulary: [], httpsPort: 8443 },
  tailnet: { available: false, serveOn: false }, pairing: null, lastError: 'gateway not running',
};

export function registerMobileIpc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain: { handle(ch: string, fn: (...a: any[]) => any): void },
  gateway: () => MobileGateway | null,
  push: (s: MobileStatus) => void,
): void {
  const qrCache = new Map<string, string>();
  async function qrFor(offer: PairingOffer): Promise<string> {
    let url = qrCache.get(offer.code);
    if (!url) {
      url = await QRCode.toDataURL(offer.qr, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
      qrCache.clear();                       // only the live code matters
      qrCache.set(offer.code, url);
    }
    return url;
  }
  async function withQr(s: MobileStatus): Promise<MobileStatus> {
    if (!s.pairing) return s;
    try { return { ...s, pairing: { ...s.pairing, qrDataUrl: await qrFor(s.pairing) } }; } catch { return s; }
  }
  async function current(): Promise<MobileStatus> {
    const g = gateway();
    return g ? withQr(g.status()) : OFFLINE;
  }

  let subscribed: MobileGateway | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  function trySubscribe(): void {
    const g = gateway();
    if (!g || g === subscribed) return;
    subscribed = g;
    if (poll) { clearInterval(poll); poll = null; }
    g.onStatus((s) => { void withQr(s).then(push).catch(() => undefined); });
  }
  function ensureSubscribed(): void {
    trySubscribe();
    if (!subscribed && !poll) {
      poll = setInterval(trySubscribe, 2000);
      poll.unref?.();
    }
  }
  const mutate = async <T>(fn: (g: MobileGateway) => T): Promise<T | undefined> => {
    const g = gateway();
    if (!g) return undefined;
    const r = fn(g);
    push(await current());
    return r;
  };

  ipcMain.handle(MOBILE_IPC.status, async () => { ensureSubscribed(); return current(); });
  ipcMain.handle(MOBILE_IPC.startPairing, async () => {
    const g = gateway();
    if (!g) throw new Error('gateway not running');
    const offer = g.startPairing();
    const out = { ...offer, qrDataUrl: await qrFor(offer) };
    push(await current());
    return out;
  });
  ipcMain.handle(MOBILE_IPC.cancelPairing, async () => { await mutate((g) => g.cancelPairing()); });
  ipcMain.handle(MOBILE_IPC.revoke, async (_e: unknown, id: string) => { await mutate((g) => g.revokeDevice(id)); });
  ipcMain.handle(MOBILE_IPC.revokeAll, async () => { await mutate((g) => g.revokeAll()); });
  ipcMain.handle(MOBILE_IPC.setPaused, async (_e: unknown, p: boolean) => { await mutate((g) => g.setPaused(!!p)); });
  ipcMain.handle(MOBILE_IPC.setScopes, async (_e: unknown, id: string, scopes: MobileScope[]) => { await mutate((g) => g.setDeviceScopes(id, scopes)); });
  ipcMain.handle(MOBILE_IPC.updateSettings, async (_e: unknown, patch: Parameters<MobileGateway['updateSettings']>[0]): Promise<MobileSettings> => {
    const r = await mutate((g) => g.updateSettings(patch));
    return r ?? OFFLINE.settings;
  });
}
