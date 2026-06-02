import { Component, ReactNode } from 'react';

interface Props {
  /** Shown above the error so the user knows which pane failed. */
  label: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/chunk-load failures in a single pane so they surface as a
 * visible, recoverable message instead of a silent blank pane.
 *
 * Dynamically-imported panes (Terminal, FileEditor, …) live in separate
 * webpack chunks. If a chunk fails to load — a wedged dev server, an HMR
 * hiccup, or the packaged-app asset-path issues we've hit before — the
 * `dynamic()` import rejects and React would otherwise render nothing, leaving
 * whatever pane sits behind it showing through (e.g. the black terminal). This
 * boundary turns that into an explicit error with a reload button.
 */
export default class PaneErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error(`[agentsflow] ${this.props.label} pane failed to render`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isChunkError = /Loading chunk|ChunkLoadError|dynamically imported module|Failed to fetch/i.test(
      `${error.name} ${error.message}`,
    );

    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg text-center px-6">
        <div className="text-sm text-text font-medium">
          {this.props.label} failed to load
        </div>
        <div className="text-xs text-muted max-w-md">
          {isChunkError
            ? 'A code chunk could not be loaded. This usually means the dev server needs a restart (clear .next) or the app needs a reload.'
            : error.message}
        </div>
        <button
          onClick={() => window.location.reload()}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-bg font-medium hover:bg-accent2"
        >
          Reload
        </button>
      </div>
    );
  }
}
