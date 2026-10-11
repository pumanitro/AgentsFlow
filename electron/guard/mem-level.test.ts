import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { MemSample } from '../../shared/types';
import {
  CRIT_COMPRESSED_GB, CRIT_CONFIRM_TICKS, OK_CONFIRM_TICKS, WARN_SUSTAINED_MS,
  nextLevel, parseMemSample, swapGrowthGBper5min,
} from './mem-level';
import type { LevelState } from './mem-level';
import { fixture } from './test-fixtures';

const T0 = Date.parse('2026-10-11T09:00:00Z');
const TICK = 30_000;

function sample(at: number, over: Partial<MemSample> = {}): MemSample {
  return { at, pressure: 1, compressedGB: 10, swapUsedGB: 1, availGB: 40, ...over };
}
function start(level: LevelState['level'] = 'ok'): LevelState {
  return { level, since: T0, reasons: [], warnSince: null, critTicks: 0, okTicks: 0 };
}
/** Feed samples one tick apart; returns every state. */
function walk(from: LevelState, overs: Array<Partial<MemSample> | null>, t0 = T0, step = TICK): LevelState[] {
  const out: LevelState[] = [];
  const samples: MemSample[] = [];
  let st = from;
  overs.forEach((o, i) => {
    const now = t0 + i * step;
    const s = o === null ? null : sample(now, o);
    if (s) samples.push(s);
    st = nextLevel(st, s, samples, now);
    out.push(st);
  });
  return out;
}

test('parseMemSample: the real vm_stat capture (fresh boot: empty compressor, no swap)', () => {
  const s = parseMemSample(fixture('vm_stat.txt'), fixture('pressure.txt'), fixture('swapusage.txt'), T0);
  assert.ok(s);
  assert.equal(s.at, T0);
  assert.equal(s.pressure, 1);
  assert.equal(s.compressedGB, 0);
  assert.equal(s.swapUsedGB, 0);
  // (free 1393043 + speculative 589581 + purgeable 104842 + file-backed 1760830) × 16384 B
  assert.equal(s.availGB, (3848296 * 16384) / 1024 ** 3);
  assert.ok(Math.abs((s.availGB ?? 0) - 58.72) < 0.01);
});

test('parseMemSample: compressor pages × page size, swap in M', () => {
  const s = parseMemSample(fixture('vm_stat-compressed-synthetic.txt'), '2\n', fixture('swapusage-synthetic.txt'), T0);
  assert.ok(s);
  assert.equal(s.pressure, 2);
  assert.ok(Math.abs(s.compressedGB - 56.8) < 0.01, `compressed ${s.compressedGB}`);
  assert.equal(s.swapUsedGB, 18.5);
});

test('parseMemSample: swap in G or K, kernel level 4, unknown level → null', () => {
  const vm = fixture('vm_stat.txt');
  assert.equal(parseMemSample(vm, '4', 'total = 20.00G  used = 18.50G  free = 1.50G', T0)?.swapUsedGB, 18.5);
  assert.equal(parseMemSample(vm, '4', 'total = 20.00G  used = 18.50G  free = 1.50G', T0)?.pressure, 4);
  assert.equal(parseMemSample(vm, '', 'used = 1048576.00K', T0)?.swapUsedGB, 1);
  assert.equal(parseMemSample(vm, '3', fixture('swapusage.txt'), T0)?.pressure, null);
  assert.equal(parseMemSample(vm, 'garbage', fixture('swapusage.txt'), T0)?.pressure, null);
});

test('parseMemSample: unreadable vm_stat or swap → null, never a made-up zero', () => {
  assert.equal(parseMemSample('', '1', fixture('swapusage.txt'), T0), null);
  assert.equal(parseMemSample('Pages free: 12.\n', '1', fixture('swapusage.txt'), T0), null);
  assert.equal(parseMemSample(fixture('vm_stat.txt').replace(/Pages occupied by compressor.*\n/, ''), '1', fixture('swapusage.txt'), T0), null);
  assert.equal(parseMemSample(fixture('vm_stat.txt'), '1', '', T0), null);
  assert.equal(parseMemSample(fixture('vm_stat.txt'), '1', 'sysctl: unknown oid', T0), null);
});

test('swapGrowth: null until five minutes of samples exist', () => {
  const samples: MemSample[] = [];
  for (let i = 0; i < 10; i++) samples.push(sample(T0 + i * TICK, { swapUsedGB: 1 + i }));   // 4.5 min span
  assert.equal(swapGrowthGBper5min(samples, T0 + 9 * TICK), null);
  assert.equal(swapGrowthGBper5min([], T0), null);
  assert.equal(swapGrowthGBper5min([sample(T0)], T0), null);
});

test('swapGrowth: the difference against the sample five minutes back', () => {
  const samples: MemSample[] = [];
  for (let i = 0; i <= 12; i++) samples.push(sample(T0 + i * TICK, { swapUsedGB: 10 + i * 0.25 }));
  // latest i=12 (13.0 GB) vs i=2 (10.5 GB), exactly 5 min apart
  assert.equal(swapGrowthGBper5min(samples, T0 + 12 * TICK), 2.5);
});

test('swapGrowth: normalised to five minutes, negative when swap drains', () => {
  const up = [sample(T0, { swapUsedGB: 10 }), sample(T0 + 6 * 60_000, { swapUsedGB: 13 })];
  assert.equal(swapGrowthGBper5min(up, T0 + 6 * 60_000), 2.5);
  const down = [sample(T0, { swapUsedGB: 10 }), sample(T0 + 5 * 60_000, { swapUsedGB: 8 })];
  assert.equal(swapGrowthGBper5min(down, T0 + 5 * 60_000), -2);
});

test('swapGrowth: a sampling gap (sleep) is not a trend', () => {
  const gap = [sample(T0, { swapUsedGB: 1 }), sample(T0 + 3 * 60 * 60_000, { swapUsedGB: 9 })];
  assert.equal(swapGrowthGBper5min(gap, T0 + 3 * 60 * 60_000), null);
});

test('swapGrowth: samples after `now` are ignored', () => {
  const s = [sample(T0, { swapUsedGB: 1 }), sample(T0 + 5 * 60_000, { swapUsedGB: 2 }), sample(T0 + 10 * 60_000, { swapUsedGB: 30 })];
  assert.equal(swapGrowthGBper5min(s, T0 + 5 * 60_000), 1);
});

test('ladder: unreadable sample → unknown', () => {
  const st = nextLevel(start('ok'), null, [], T0 + TICK);
  assert.equal(st.level, 'unknown');
  assert.equal(st.since, T0 + TICK);
  assert.deepEqual(st.reasons, ['memory sample unreadable']);
});

test('ladder: ok requires OK_CONFIRM_TICKS clean ticks (from unknown at launch)', () => {
  assert.equal(OK_CONFIRM_TICKS, 2);
  const [a, b] = walk(start('unknown'), [{}, {}]);
  assert.equal(a.level, 'unknown');
  assert.equal(b.level, 'ok');
  assert.equal(b.warnSince, null);
});

test('ladder: each warn signal alone is warn at once — kernel 2, compressed > 32, swap > 8', () => {
  for (const o of [{ pressure: 2 as const }, { compressedGB: 32.1 }, { swapUsedGB: 8.1 }]) {
    const [st] = walk(start('ok'), [o]);
    assert.equal(st.level, 'warn', JSON.stringify(o));
    assert.equal(st.reasons.length, 1);
    assert.equal(st.warnSince, T0);
  }
  // the thresholds themselves are not over the line
  assert.equal(walk(start('ok'), [{ compressedGB: 32, swapUsedGB: 8 }, { compressedGB: 32, swapUsedGB: 8 }])[1].level, 'ok');
});

test('ladder: leftover swap — over the line, not growing, compressor and kernel calm — is not a reason', () => {
  // 2026-10-11 afternoon: the 28 GB model was unloaded, 10.7 GB of swap stayed behind.
  const history: MemSample[] = [];
  for (let i = 0; i <= 12; i++) history.push(sample(T0 + i * TICK, { swapUsedGB: 10.9 - i * 0.01 }));
  const now = T0 + 12 * TICK;
  const calm = history[history.length - 1];
  const closed = { ...start('closed'), warnSince: T0 };
  const a = nextLevel(closed, calm, history, now);
  assert.equal(a.level, 'closed');
  assert.deepEqual(a.reasons, ['clearing (1/2)']);
  assert.equal(nextLevel(a, calm, history, now).level, 'ok');
  // the same swap with a full compressor, a kernel warn, or still growing is live
  assert.deepEqual(nextLevel(closed, { ...calm, compressedGB: 33 }, history, now).reasons.length, 2);
  assert.equal(nextLevel(closed, { ...calm, pressure: 2 }, history, now).reasons.length, 2);
  const growing = history.map((h, i) => ({ ...h, swapUsedGB: 9 + i * 0.1 }));
  assert.deepEqual(nextLevel(closed, growing[12], growing, now).reasons, ['swap 10.2 GB > 8']);
});

test('ladder: the 2026-10-11 morning — avail 22–36 GB is never a reason, compressed 56.8 is warn', () => {
  const [low] = walk(start('ok'), [{ availGB: 2 }, { availGB: 2 }]).slice(-1);
  assert.equal(low.level, 'ok');
  const [st] = walk(start('ok'), [{ availGB: 30, compressedGB: 56.8 }]);
  assert.equal(st.level, 'warn');
});

test('ladder: warn → closed once warn has been sustained for 5 minutes', () => {
  assert.equal(WARN_SUSTAINED_MS, 5 * 60_000);
  const states = walk(start('ok'), Array.from({ length: 12 }, () => ({ compressedGB: 40 })));
  // ticks at 0 … 5.5 min: closed from the tick at exactly 5:00 (index 10)
  assert.deepEqual(states.slice(0, 10).map((s) => s.level), Array(10).fill('warn'));
  assert.equal(states[10].level, 'closed');
  assert.equal(states[10].since, T0 + 10 * TICK);
  assert.equal(states[11].level, 'closed');
  assert.equal(states[11].since, T0 + 10 * TICK);
});

test('ladder: one unreadable sample does not restart the sustained-warn clock', () => {
  const overs: Array<Partial<MemSample> | null> = Array.from({ length: 11 }, () => ({ compressedGB: 40 }));
  overs[5] = null;
  const states = walk(start('ok'), overs);
  assert.equal(states[5].level, 'unknown');
  assert.equal(states[10].level, 'closed');
});

test('ladder: critical requires CRIT_CONFIRM_TICKS consecutive ticks', () => {
  assert.equal(CRIT_CONFIRM_TICKS, 2);
  const [a, b] = walk(start('ok'), [{ pressure: 4 }, { pressure: 4 }]);
  assert.equal(a.level, 'warn');
  assert.equal(a.critTicks, 1);
  assert.ok(a.reasons.some((r) => r.includes('confirming critical (1/2)')));
  assert.equal(b.level, 'critical');
  assert.equal(b.since, T0 + TICK);
});

test('ladder: a single critical blip between calm ticks never reaches critical', () => {
  const states = walk(start('ok'), [{ pressure: 4 }, {}, { pressure: 4 }, {}, { pressure: 4 }]);
  assert.ok(states.every((s) => s.level !== 'critical'), states.map((s) => s.level).join(','));
});

test('ladder: compressed 61 GB ⇒ critical', () => {
  assert.equal(CRIT_COMPRESSED_GB, 60);
  const states = walk(start('ok'), [{ compressedGB: 61 }, { compressedGB: 61 }]);
  assert.equal(states[1].level, 'critical');
  assert.ok(states[1].reasons[0].includes('compressed 61.0 GB > 60'));
  // exactly 60 is not over the line
  assert.equal(walk(start('ok'), [{ compressedGB: 60 }, { compressedGB: 60 }])[1].level, 'warn');
});

test('ladder: kernel pressure 4 ⇒ critical', () => {
  const states = walk(start('ok'), [{ pressure: 4 }, { pressure: 4 }]);
  assert.equal(states[1].level, 'critical');
  assert.deepEqual(states[1].reasons, ['kernel memory pressure critical']);
});

test('ladder: swap growing 2.5 GB / 5 min ⇒ critical, while swap itself is still under the warn line', () => {
  // +0.25 GB per tick from 1 GB: growth is known from the 11th sample on
  const overs = Array.from({ length: 13 }, (_, i) => ({ swapUsedGB: 1 + i * 0.25 }));
  const states = walk(start('ok'), overs);
  assert.deepEqual(states.slice(0, 10).map((s) => s.level), Array(10).fill('ok'));
  assert.equal(states[10].level, 'warn');          // first confirming tick
  assert.equal(states[11].level, 'critical');
  assert.ok(states[11].reasons.some((r) => r.includes('swap growing 2.5 GB / 5 min')));
  assert.ok(overs[11].swapUsedGB < 8);
});

test('ladder: growth under the line (1.875 GB / 5 min) is not critical', () => {
  const overs = Array.from({ length: 14 }, (_, i) => ({ swapUsedGB: 1 + i * 0.1875 }));
  assert.ok(walk(start('ok'), overs).every((s) => s.level === 'ok'));
});

test('ladder: leaving critical — the held level is never critical, and ok takes two clean ticks', () => {
  const states = walk(start('ok'), [{ pressure: 4 }, { pressure: 4 }, {}, {}]);
  assert.deepEqual(states.map((s) => s.level), ['warn', 'critical', 'closed', 'ok']);
  assert.deepEqual(states[2].reasons, ['clearing (1/2)']);
});

test('ladder: critical easing to warn signals reads closed, and re-entering critical needs two ticks again', () => {
  const states = walk(start('ok'), [{ pressure: 4 }, { pressure: 4 }, { pressure: 2 }, { pressure: 4 }, { pressure: 4 }]);
  assert.deepEqual(states.map((s) => s.level), ['warn', 'critical', 'closed', 'closed', 'critical']);
});

test('ladder: closed holds through one clean tick, then ok clears the warn clock', () => {
  const overs: Array<Partial<MemSample>> = [...Array.from({ length: 11 }, () => ({ compressedGB: 33 })), {}, {}, { compressedGB: 33 }];
  const states = walk(start('ok'), overs);
  assert.equal(states[10].level, 'closed');
  assert.equal(states[11].level, 'closed');
  assert.equal(states[12].level, 'ok');
  assert.equal(states[13].level, 'warn');           // a fresh warn, not straight back to closed
  assert.equal(states[13].warnSince, T0 + 13 * TICK);
});

test('ladder: `since` moves only when the level changes', () => {
  const states = walk(start('ok'), [{}, {}, { pressure: 2 }, { pressure: 2 }]);
  assert.equal(states[1].since, T0);
  assert.equal(states[2].since, T0 + 2 * TICK);
  assert.equal(states[3].since, T0 + 2 * TICK);
});
