import type { Conversation, MemLevel, RunContract } from '../../shared/types';

// Run contracts as the UI names and colours them. A contract is how far a chat
// is meant to go on its own: answer once, keep going until the work is done, or
// run until stopped. The Keeper (main process) enforces it; this file is only
// the vocabulary every view shares so the chip, the row badge and the sidebar
// card cannot drift apart.

export const CONTRACTS: RunContract[] = ['once', 'until-done', 'forever'];
export const CONTRACT_LABEL: Record<RunContract, string> = { once: 'Once', 'until-done': 'Until done', forever: 'Forever' };
export const CONTRACT_HINT: Record<RunContract, string> = {
  once: 'Runs your prompt and stops — the Keeper leaves it alone.',
  'until-done': 'If it stops short, the Keeper tells it to continue until it says the work is finished.',
  forever: 'The Keeper keeps it running — nudging it when idle, relaunching it if it dies — until you stop it.',
};
export const CONTRACT_GLYPH: Record<RunContract, string> = { once: '→', 'until-done': '⇥', forever: '∞' };
export const CONTRACT_COLOR: Record<RunContract, string> = { once: '#b2b8cc', 'until-done': '#3b82f6', forever: '#2dd4bf' }; // muted, info, teal
export const KEEPER_TICK_COLOR = '#2dd4bf'; // the Keeper sidebar card's identity tick (Peers accent / Accounts #a78bfa / Usage info / Notes ok)
export const GUARD_LEVEL_COLOR: Record<MemLevel, string> = { ok: '#4ade80', warn: '#fbbf24', closed: '#ff7847', critical: '#ef4444', unknown: '#8c93a8' };

// A row with no contract recorded behaves as 'once'.
export function effectiveContract(c: Pick<Conversation, 'contract'>): RunContract {
  return c.contract ?? 'once';
}

// The Keeper card's way back to 'once', worded as what it does to a running chat.
export const CONTRACT_STOP_LABEL = 'Stop keeping alive';
export const CONTRACT_STOP_HINT = 'Sets this chat back to Once — the Keeper leaves it alone from now on.';

// Row badges driven by `conv.keeper` (KeeperConvState.stalled / keptAlive).
export const KEEPER_STALLED_LABEL = 'stalled · needs you';
export const KEEPER_KEPT_ALIVE_LABEL = 'kept alive';

// A translucent fill of one of the hex colours above ("#rrggbb" + alpha byte),
// for chips and badges whose colour is not a Tailwind token (teal).
export function contractTint(hex: string, alpha = 0x26): string {
  return `${hex}${Math.max(0, Math.min(255, Math.round(alpha))).toString(16).padStart(2, '0')}`;
}
