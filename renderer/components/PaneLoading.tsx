import { DynamicOptionsLoadingProps } from 'next/dynamic';

// Loading placeholder for dynamically-imported panes. next/dynamic re-renders
// this with `error` set when a chunk fails to load (e.g. the renderer was
// rebuilt while this window was open, so its old chunk URLs now 404) — if the
// error is ignored the pane shows "Loading…" forever.
const paneLoading = (noun: string) =>
  function PaneLoading({ error, retry }: DynamicOptionsLoadingProps) {
    if (error) {
      return (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="text-sm text-err">
            The {noun} pane failed to load — the app was likely rebuilt while this window was open.
          </div>
          <div className="text-xs text-muted font-mono break-all max-w-md">{error.message}</div>
          <button
            onClick={retry}
            className="text-xs px-3 py-1 rounded-md bg-accent text-bg font-medium hover:bg-accent2"
          >
            Retry
          </button>
          <div className="text-xs text-muted">
            If retrying doesn&apos;t help, restart the app and reopen this window.
          </div>
        </div>
      );
    }
    return <div className="absolute inset-0 flex items-center justify-center text-muted text-sm">Loading {noun}…</div>;
  };

export default paneLoading;
