import { useEffect, useState } from 'react';
import { api } from '../lib/ipc';
import type { McpServerInfo } from '../../shared/types';

interface Props {
  onClose: () => void;
}

export default function McpModal({ onClose }: Props) {
  const [info, setInfo] = useState<McpServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    api()
      .getMcpServerInfo()
      .then((i) => { if (alive) setInfo(i); })
      .catch((e) => { if (alive) setError(String(e?.message ?? e)); });
    return () => { alive = false; };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[82vh] bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-text flex items-center gap-2">
              MCP server
              {info && (
                <span
                  className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${
                    info.connected
                      ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                      : 'border-amber-500/40 text-amber-300 bg-amber-500/10'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${info.connected ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                  {info.connected ? 'wired into new sessions' : 'not built yet'}
                </span>
              )}
            </div>
            <div className="text-xs text-muted">
              {info ? `${info.serverName} · peer awareness & delegation` : 'Peers Flow'}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text px-2 py-1 rounded hover:bg-panel2"
            title="Close (Esc)"
          >✕</button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {error && (
            <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
              Failed to load MCP info: {error}
            </div>
          )}
          {!info && !error && <div className="text-sm text-muted">Loading…</div>}

          {info && (
            <>
              {info.bridge && (
                <section>
                  <div
                    className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
                      info.bridge.healthy
                        ? 'border-emerald-500/40 bg-emerald-500/10'
                        : 'border-red-500/40 bg-red-500/10'
                    }`}
                  >
                    <span
                      className={`mt-1 w-2 h-2 rounded-full shrink-0 ${
                        info.bridge.healthy ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-text">
                        Delegation bridge: {info.bridge.healthy ? 'live' : 'DOWN'}
                      </div>
                      <div className="text-[12px] text-muted mt-0.5 leading-snug">
                        {info.bridge.healthy
                          ? 'Delegations spawn tracked, watchable sub-peer sessions that appear nested under their root on the home screen.'
                          : 'Delegations cannot reach the app and fall back to headless, unwatchable runs (no sub-peer row). Restart Peers Flow to restore it.'}
                      </div>
                      <div className="text-[11px] text-muted/80 font-mono mt-1 break-all">
                        listening={String(info.bridge.listening)} · socketFile={String(info.bridge.socketFileExists)} · {info.bridge.socketPath}
                      </div>
                    </div>
                  </div>
                </section>
              )}

              <section>
                <p className="text-sm text-text/90 leading-relaxed">
                  Every session Peers Flow spawns automatically loads this MCP server and a fresh
                  snapshot of your tracked directories. A session uses it to discover its{' '}
                  <span className="text-text font-medium">peers</span> and to{' '}
                  <span className="text-text font-medium">delegate</span> work across directories.
                </p>
              </section>

              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">Tools</h3>
                <ul className="space-y-2.5">
                  {info.tools.map((t) => (
                    <li key={t.name} className="rounded-lg border border-border bg-panel2/40 px-3 py-2.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <code className="text-[12.5px] text-accent font-mono break-all">{t.name}</code>
                        <span className="text-[11px] text-muted shrink-0">{t.title}</span>
                      </div>
                      <p className="text-[13px] text-text/85 mt-1.5 leading-snug">{t.description}</p>
                      <code className="block text-[11.5px] text-muted font-mono mt-1.5">{t.usage}</code>
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">
                  Peers · {info.peers.length} tracked
                </h3>
                {info.peers.length === 0 ? (
                  <div className="text-sm text-muted">No peers tracked yet.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {info.peers.map((p) => (
                      <li
                        key={p.id}
                        className="grid grid-cols-[minmax(0,140px)_minmax(0,1fr)] gap-3 items-start text-[13px] py-1 border-b border-border/50 last:border-0"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-medium text-text truncate" title={p.displayName}>{p.displayName}</span>
                          {p.hasProjectMcp && (
                            <span title="Has its own MCP connections (.mcp.json)" className="text-[10px] text-accent shrink-0">⚡MCP</span>
                          )}
                          {!p.exists && <span title="Path missing" className="text-[10px] text-amber-400 shrink-0">⚠</span>}
                        </div>
                        <div className="min-w-0">
                          <div className="text-muted font-mono text-[11.5px] truncate" title={p.path}>{p.path}</div>
                          {p.skills.length > 0 && (
                            <div className="text-[11.5px] text-text/70 mt-0.5">
                              exposes: {p.skills.join(', ')}
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="text-[11px] uppercase tracking-wider text-muted mb-2">How sessions connect</h3>
                <p className="text-[12.5px] text-muted mb-2">
                  Peers Flow passes this config to every spawned session via{' '}
                  <code className="font-mono text-text/80">--mcp-config</code>. It lives at{' '}
                  <code className="font-mono text-text/80 break-all">{info.configPath}</code>.
                </p>
                <pre className="text-[11.5px] font-mono text-text/85 bg-panel2/60 border border-border rounded-lg p-3 overflow-x-auto whitespace-pre">
{info.configJson}
                </pre>
              </section>
            </>
          )}
        </div>

        <footer className="shrink-0 px-5 py-2.5 border-t border-border text-[11px] text-muted flex items-center gap-1.5">
          Press
          <kbd className="inline-flex items-center justify-center min-w-[28px] h-6 px-1.5 rounded border border-border bg-panel2 text-[11px] font-mono text-text">Esc</kbd>
          or click outside to close
        </footer>
      </div>
    </div>
  );
}
