import { MOBILE_IPC } from '../../shared/mobile';
import type { MobileApi, MobileStatus } from '../../shared/mobile';

export function makeMobileApi(ipcRenderer: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(ch: string, ...a: unknown[]): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(ch: string, l: (...a: any[]) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(ch: string, l: (...a: any[]) => void): void;
}): MobileApi {
  return {
    status: () => ipcRenderer.invoke(MOBILE_IPC.status),
    startPairing: () => ipcRenderer.invoke(MOBILE_IPC.startPairing),
    cancelPairing: () => ipcRenderer.invoke(MOBILE_IPC.cancelPairing),
    revokeDevice: (id) => ipcRenderer.invoke(MOBILE_IPC.revoke, id),
    revokeAll: () => ipcRenderer.invoke(MOBILE_IPC.revokeAll),
    setPaused: (paused) => ipcRenderer.invoke(MOBILE_IPC.setPaused, paused),
    setDeviceScopes: (id, scopes) => ipcRenderer.invoke(MOBILE_IPC.setScopes, id, scopes),
    updateSettings: (patch) => ipcRenderer.invoke(MOBILE_IPC.updateSettings, patch),
    onUpdated: (cb) => {
      const l = (_e: unknown, s: MobileStatus) => cb(s);
      ipcRenderer.on(MOBILE_IPC.updated, l);
      return () => ipcRenderer.removeListener(MOBILE_IPC.updated, l);
    },
  };
}
