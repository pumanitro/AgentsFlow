// The sub-agent admission rule — the SAME rule as ~/.claude/tools/cpu-gate/mem.mjs
// (state critical, or fit.agents == 0) that the mem-admission hook applies. Peers Flow
// writes the admission-closed file and shows "mem closed" ONLY when this says no room.
//
// Owner's requirement (2026-11-02): keep a small amount of memory free so the Mac never
// restarts; otherwise let the peers use all of it. On that morning the old rule (closed
// after 5 min of "compressor > 32 GB") held agents out with 31 GB available, 0 swap and
// kernel pressure normal.
//
//   avail   = free + speculative + purgeable + file-backed + inactive        (parseMemSample)
//   reserve = max(RESERVE_FLOOR_GB, RESERVE_PCT % of total RAM)               (≈10.2 GB on 128 GB)
//   no room = kernel pressure 4  ||  swap > CRITICAL_SWAP_GB  ||  avail < CRITICAL_AVAIL_GB
//             ||  floor((avail − reserve) / PER_AGENT_GB) < 1
// Compressor size, kernel pressure 2 and lingering swap are notes, never a block.
// Lane leases are not seen here; the hook (mem-budget fit) subtracts them on top.
//
// Pure. Keep the numbers in step with mem.mjs DEFAULTS.

import type { MemSample } from '../../shared/types';

export const RESERVE_PCT = 8;
export const RESERVE_FLOOR_GB = 8;
export const CRITICAL_AVAIL_GB = 10;
export const CRITICAL_SWAP_GB = 24;
export const PER_AGENT_GB = 1.5;

export function reserveGB(totalGB: number): number {
  return Math.max(RESERVE_FLOOR_GB, (RESERVE_PCT / 100) * totalGB);
}

export interface AdmissionVerdict { room: boolean; agentsFit: number | null; reasons: string[] }

/** Unreadable availability fails OPEN on that term (like the hook); pressure and swap still count. */
export function admissionVerdict(s: MemSample, totalGB: number): AdmissionVerdict {
  const reasons: string[] = [];
  if (s.pressure === 4) reasons.push('kernel memory pressure critical');
  if (s.swapUsedGB > CRITICAL_SWAP_GB) reasons.push(`swap ${s.swapUsedGB.toFixed(1)} GB > ${CRITICAL_SWAP_GB}`);
  let agentsFit: number | null = null;
  if (s.availGB !== null) {
    if (s.availGB < CRITICAL_AVAIL_GB) reasons.push(`avail ${s.availGB.toFixed(1)} GB < ${CRITICAL_AVAIL_GB}`);
    const res = reserveGB(totalGB);
    agentsFit = Math.max(0, Math.floor((s.availGB - res) / PER_AGENT_GB + 1e-9));
    if (reasons.length) agentsFit = 0;
    else if (agentsFit < 1) reasons.push(`no room for one agent: avail ${s.availGB.toFixed(1)} GB − reserve ${res.toFixed(1)} < ${PER_AGENT_GB}`);
  } else if (reasons.length) {
    agentsFit = 0;
  }
  return { room: reasons.length === 0, agentsFit, reasons };
}
