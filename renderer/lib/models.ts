import { useEffect, useState } from 'react';
import { api } from './ipc';
import type { AgentProvider } from '../../shared/types';

/**
 * What the composer may offer, per provider.
 *
 * Claude's aliases are a fixed list the CLI understands. Codex's are whatever
 * the installed Codex CLI reports, which is why they are fetched rather than
 * typed by hand — a free-text box was the old answer and it shipped typos
 * straight into a launch.
 */
export interface ModelOption {
  id: string;
  label: string;
  isDefault?: boolean;
}

export const CLAUDE_MODELS: ModelOption[] = [
  { id: '', label: 'Default' },
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

const CODEX_TTL_MS = 10 * 60_000;
// Module scope, so switching provider back and forth (or opening a second
// composer) does not re-shell-out to the Codex CLI every time.
let codexCache: { at: number; models: ModelOption[] } | null = null;
let codexInFlight: Promise<ModelOption[]> | null = null;

async function fetchCodexModels(): Promise<ModelOption[]> {
  const fresh = codexCache && Date.now() - codexCache.at < CODEX_TTL_MS;
  if (fresh && codexCache) return codexCache.models;
  if (codexInFlight) return codexInFlight;
  codexInFlight = (async () => {
    let models: ModelOption[] = [];
    try {
      const a = api();
      const list = typeof a.listCodexModels === 'function' ? await a.listCodexModels() : [];
      models = (list ?? []).map((m) => ({ id: m.id, label: m.displayName || m.id, isDefault: m.isDefault }));
    } catch {
      models = [];
    }
    codexCache = { at: Date.now(), models };
    codexInFlight = null;
    return models;
  })();
  return codexInFlight;
}

/** Drops the cache so the next read re-asks the CLI (e.g. after a Codex sign-in). */
export function resetCodexModelCache(): void {
  codexCache = null;
}

export function useProviderModels(provider: AgentProvider): {
  models: ModelOption[];
  loading: boolean;
  unavailable: boolean;
} {
  const [models, setModels] = useState<ModelOption[]>(provider === 'codex' ? [] : CLAUDE_MODELS);
  const [loading, setLoading] = useState(provider === 'codex');

  useEffect(() => {
    if (provider !== 'codex') {
      setModels(CLAUDE_MODELS);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void fetchCodexModels().then((list) => {
      if (!alive) return;
      setModels(list);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [provider]);

  // "No models" is the Codex CLI being absent, not an empty catalogue — the
  // menu says so instead of offering nothing and looking broken.
  return { models, loading, unavailable: provider === 'codex' && !loading && models.length === 0 };
}

const KEYS: Record<AgentProvider, string> = {
  claude: 'agentsflow.spawnModel.claude',
  codex: 'agentsflow.spawnModel.codex',
};
// The single pre-provider key, which held either a bare alias ('fable') or a
// provider-prefixed one ('claude:fable').
const LEGACY_KEY = 'agentsflow.spawnModel';
const MIGRATED_KEY = 'agentsflow.spawnModel.migrated';

function migrateOnce(): void {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    localStorage.setItem(MIGRATED_KEY, '1');
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    if (localStorage.getItem(KEYS.claude) !== null) return;
    // Only a Claude pick carries over; a 'codex:' legacy value said nothing
    // about which Claude model was wanted.
    if (legacy.startsWith('codex:')) return;
    const id = legacy.startsWith('claude:') ? legacy.slice('claude:'.length) : legacy;
    if (CLAUDE_MODELS.some((m) => m.id === id)) localStorage.setItem(KEYS.claude, id);
  } catch { /* localStorage unavailable */ }
}

export function loadModelPick(provider: AgentProvider): string {
  try {
    migrateOnce();
    return localStorage.getItem(KEYS[provider]) ?? '';
  } catch {
    return '';
  }
}

export function saveModelPick(provider: AgentProvider, id: string): void {
  try { localStorage.setItem(KEYS[provider], id); } catch { /* ignore */ }
}

// Which provider the composers open on. A conversation is bound to the provider
// it starts on for its whole life, so this is only the default for the NEXT one
// — remembered because whoever spawns three Codex chats in a row wants the
// fourth to start there too.
const PROVIDER_KEY = 'agentsflow.spawnProvider';

/** The two providers in the order the pickers list them. */
export const PROVIDERS: AgentProvider[] = ['claude', 'codex'];

export function loadProviderPick(): AgentProvider {
  try {
    return localStorage.getItem(PROVIDER_KEY) === 'codex' ? 'codex' : 'claude';
  } catch {
    return 'claude';
  }
}

export function saveProviderPick(provider: AgentProvider): void {
  try { localStorage.setItem(PROVIDER_KEY, provider); } catch { /* ignore */ }
}

/** The label for a pick, falling back to the raw id for a model we don't know. */
export function modelLabel(provider: AgentProvider, id: string, models: ModelOption[]): string {
  const found = models.find((m) => m.id === id);
  if (found) return found.label;
  if (!id) return 'Default';
  return id;
}
