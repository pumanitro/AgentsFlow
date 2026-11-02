import type { TailnetInfo } from '../../shared/mobile';
import type { ExecFn, LogFn } from './types';

function parse(json: string): any {
  try { return JSON.parse(json); } catch { return null; }
}

export function parseStatusJson(json: string): { dnsName?: string; ownerLogin?: string; backendState?: string } {
  const j = parse(json);
  if (!j || typeof j !== 'object') return {};
  const self = j.Self;
  const dns = typeof self?.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '') : undefined;
  const uid = self?.UserID;
  const login = uid !== undefined && uid !== null ? j.User?.[String(uid)]?.LoginName : undefined;
  return {
    dnsName: dns || undefined,
    ownerLogin: typeof login === 'string' && login ? login : undefined,
    backendState: typeof j.BackendState === 'string' ? j.BackendState : undefined,
  };
}

export function parseServeStatus(json: string, port: number, httpsPort: number): boolean {
  const j = parse(json);
  const web = j?.Web;
  if (!web || typeof web !== 'object') return false;
  const wanted = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  for (const [host, cfg] of Object.entries<any>(web)) {
    if (!host.endsWith(`:${httpsPort}`)) continue;
    const proxy = cfg?.Handlers?.['/']?.Proxy;
    if (typeof proxy === 'string' && wanted.includes(proxy)) return true;
  }
  return false;
}

export function createTailscaleHelper(o: { exec: ExecFn; socket: string; bin: string; log: LogFn }): {
  status(port?: number, httpsPort?: number): Promise<TailnetInfo & { backendState?: string }>;
  serveOn(port: number, httpsPort: number): Promise<boolean>;
  enableServe(port: number, httpsPort: number): Promise<void>;
  prewarmCert(dns: string): Promise<void>;
} {
  const sock = `--socket=${o.socket}`;
  const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean);

  async function serveOn(port: number, httpsPort: number): Promise<boolean> {
    const r = await o.exec(o.bin, [sock, 'serve', 'status', '--json'], 8000);
    return r.code === 0 && parseServeStatus(r.stdout, port, httpsPort);
  }

  return {
    async status(port, httpsPort) {
      const r = await o.exec(o.bin, [sock, 'status', '--json'], 8000);
      const parsed = r.code === 0 ? parseStatusJson(r.stdout) : {};
      const available = r.code === 0 && parsed.backendState === 'Running' && !!parsed.dnsName;
      const info: TailnetInfo & { backendState?: string } = {
        available,
        serveOn: false,
        dnsName: parsed.dnsName,
        ownerLogin: parsed.ownerLogin,
        backendState: parsed.backendState,
      };
      if (available) info.url = `https://${parsed.dnsName}`;
      if (!available) {
        info.error = r.code === -1 ? 'tailscale not found' : firstLine(r.stderr)
          ?? (r.code === 0 ? `tailscale is ${parsed.backendState ?? 'not running'}` : undefined);
      }
      if (available && port !== undefined && httpsPort !== undefined) {
        try { info.serveOn = await serveOn(port, httpsPort); } catch (e) { o.log('tailscale serve status failed', { error: String(e) }); }
      }
      return info;
    },
    serveOn,
    async enableServe(port, httpsPort) {
      const r = await o.exec(o.bin, [sock, 'serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`], 20_000);
      if (r.code !== 0) throw new Error(firstLine(r.stderr) ?? `tailscale serve failed (exit ${r.code})`);
    },
    async prewarmCert(dns) {
      try {
        const r = await o.exec(o.bin, [sock, 'cert', dns], 60_000);
        if (r.code !== 0) o.log('tailscale cert prewarm failed', { code: r.code, stderr: firstLine(r.stderr) });
      } catch (e) { o.log('tailscale cert prewarm threw', { error: String(e) }); }
    },
  };
}
