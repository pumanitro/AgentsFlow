import { ReactNode, useEffect, useState } from 'react';
import { api } from '../lib/ipc';
import { parseSshArgs } from '../lib/remote';
import { AddRemoteRequest, RemoteProbeResult, TrackedDirectory } from '../../shared/types';

interface Props {
  onClose: () => void;
  onAdded: (dir: TrackedDirectory) => void;
}

// One labelled input. `hint` is a single muted line under the field.
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-text">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full bg-panel2 border border-border rounded-md px-2.5 py-1.5 text-sm text-text font-mono outline-none focus:border-accent placeholder:text-muted/60';

/**
 * Track a directory on another machine (a "remote peer") over SSH. Opened from
 * the home sidebar's "+ Add remote peer" button instead of the native folder
 * dialog, which can't see another Mac. Same shell as SettingsModal: dimmed
 * backdrop, Escape or a click outside closes it.
 *
 * "Test connection" runs probeRemoteDirectory (no side effects); "Add" runs
 * addRemoteDirectory and hands the new TrackedDirectory to `onAdded`.
 */
export default function AddRemoteModal({ onClose, onAdded }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [user, setUser] = useState('');
  const [host, setHost] = useState('');
  const [path, setPath] = useState('');
  const [sshArgsText, setSshArgsText] = useState('');
  const [claudeBin, setClaudeBin] = useState('claude');
  const [nodeBin, setNodeBin] = useState('node');
  const [envFile, setEnvFile] = useState('');
  const [busy, setBusy] = useState<'probe' | 'add' | null>(null);
  const [probe, setProbe] = useState<RemoteProbeResult | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Required: user, host, and an absolute remote path.
  const pathOk = path.trim().startsWith('/');
  const valid = user.trim() !== '' && host.trim() !== '' && pathOk;

  const buildRequest = (): AddRemoteRequest => ({
    host: host.trim(),
    user: user.trim(),
    sshArgs: parseSshArgs(sshArgsText),
    claudeBin: claudeBin.trim() || 'claude',
    nodeBin: nodeBin.trim() || 'node',
    envFile: envFile.trim() || undefined,
    extraPath: [], // main fills DEFAULT_EXTRA_PATH
    permissionMode: 'bypassPermissions',
    path: path.trim(),
    displayName: displayName.trim() || undefined,
  });

  const testConnection = async () => {
    if (!valid || busy) return;
    setBusy('probe');
    setProbe(null);
    try {
      setProbe(await api().probeRemoteDirectory(buildRequest()));
    } catch (err) {
      setProbe({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!valid || busy) return;
    setBusy('add');
    setAddError(null);
    try {
      const res = await api().addRemoteDirectory(buildRequest());
      if (res.ok) onAdded(res.dir);
      else setAddError(res.error);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg max-h-full bg-panel border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden"
      >
        <header className="shrink-0 px-5 py-3 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold text-text flex items-center gap-2">
            <span className="text-accent" aria-hidden>⇅</span>
            Add remote peer
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text px-2 py-1 rounded hover:bg-panel2"
            aria-label="Close add remote peer"
          >✕</button>
        </header>

        <form
          className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-3"
          onSubmit={(e) => { e.preventDefault(); add(); }}
        >
          <Field label="Display name (optional)" hint="Defaults to the remote folder name.">
            <input className={inputCls} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="studio-bot" autoFocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SSH user">
              <input className={inputCls} value={user} onChange={(e) => setUser(e.target.value)} placeholder="patryk" required />
            </Field>
            <Field label="SSH host">
              <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} placeholder="theos-mac-studio" required />
            </Field>
          </div>
          <Field label="Remote directory" hint={path.trim() && !pathOk ? 'Must be an absolute path.' : 'Absolute path on the remote machine.'}>
            <input className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/demo/projects/bot" required />
          </Field>
          <Field
            label="SSH options"
            hint="One argument per line. Binaries inside ProxyCommand need absolute paths."
          >
            <textarea
              className={`${inputCls} min-h-[96px] resize-y text-xs`}
              value={sshArgsText}
              onChange={(e) => setSshArgsText(e.target.value)}
              spellCheck={false}
              placeholder={['-o', 'IdentitiesOnly=yes', '-i', '/Users/demo/.ssh/id_ed25519', '-o', 'ProxyCommand=/opt/homebrew/bin/tailscale --socket=/Users/demo/.tailscale-user/tailscaled.sock nc %h %p'].join('\n')}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="claude binary">
              <input className={inputCls} value={claudeBin} onChange={(e) => setClaudeBin(e.target.value)} placeholder="claude" />
            </Field>
            <Field label="node binary">
              <input className={inputCls} value={nodeBin} onChange={(e) => setNodeBin(e.target.value)} placeholder="node" />
            </Field>
          </div>
          <Field label="Env file (optional)" hint="Sourced on the remote before every claude/node command.">
            <input className={inputCls} value={envFile} onChange={(e) => setEnvFile(e.target.value)} placeholder="~/.config/peersflow/env" />
          </Field>
          <div className="text-[11px] text-muted">Sessions run with bypassPermissions, like local peers.</div>

          {/* Probe result: what the host reported, or why it failed. */}
          {probe && (
            probe.ok ? (
              <div className="rounded-md border border-border bg-panel2 px-3 py-2 text-xs font-mono flex flex-col gap-0.5">
                <span className="text-ok">Connected to {probe.hostname ?? host}</span>
                <span className="text-muted">claude {probe.claudeVersion ?? '?'} · node {probe.nodeVersion ?? '?'}</span>
                <span className={probe.dirExists ? 'text-muted' : 'text-err'}>
                  {probe.dirExists ? 'Directory exists' : 'Directory not found on the remote'}
                </span>
              </div>
            ) : (
              <div className="text-xs text-err font-mono break-words">{probe.error ?? 'Connection failed'}</div>
            )
          )}
          {addError && <div className="text-xs text-err font-mono break-words">{addError}</div>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={testConnection}
              disabled={!valid || busy !== null}
              className="px-3 py-1.5 rounded-md border border-border text-sm text-text hover:bg-panel2 disabled:opacity-50 disabled:cursor-not-allowed"
            >{busy === 'probe' ? 'Testing…' : 'Test connection'}</button>
            <button
              type="submit"
              disabled={!valid || busy !== null}
              className="px-3 py-1.5 rounded-md bg-accent text-bg text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >{busy === 'add' ? 'Adding…' : 'Add'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
