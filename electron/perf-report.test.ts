import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildPerfReport, downsamplePoints, rankOverRange, reportBasename, serializeReportData, seriesStats, sparkline } from './perf-report';
import type { PerfHistory, PerfHistoryPoint, PerfSnapshot } from '../shared/types';

function point(t: number, over: Partial<PerfHistoryPoint> = {}): PerfHistoryPoint {
  return {
    t,
    cpuBusyPct: 50,
    load1: 8,
    memUsedPct: 60,
    lagMaxMs: 20,
    mainCpuPct: 4,
    rendererCpuPct: 2,
    agentsCpu: 100,
    byCategory: { test: 80, claude: 20 },
    agents: [{ pid: 111, cpu: 90 }, { pid: 222, cpu: 10 }],
    topProcs: [{ name: 'node (vitest)', cpu: 120 }],
    topActions: [{ pid: 111, name: 'node (vitest)', cmd: '', category: 'test', cpu: 80, rssMB: 400, count: 4 }],
    threads: { total: 9000, running: 30, underAgents: 1200 },
    ...over,
  };
}

const NOW = 1_800_000_000_000;

function history(points: PerfHistoryPoint[]): PerfHistory {
  return {
    intervalMs: 5000,
    points,
    agentNames: {
      '111': { title: 'vitest storm', peer: 'roomforge', kind: 'session' },
      '222': { title: null, peer: null, kind: 'spare' },
    },
  };
}

const snapshot: PerfSnapshot = {
  at: new Date(NOW).toISOString(),
  system: {
    cpuBusyPct: 100, load1: 207, load5: 180, load15: 120, cores: 16,
    memTotalMB: 131072, memUsedMB: 82000, memUsedPct: 63, swapUsedMB: 0,
    memPressure: 'normal', threads: { total: 11587, running: 272, underAgents: 2969 },
  },
  app: { uptimeS: 6600, mainCpuPct: 14.4, mainRssMB: 448, heapMB: 71, rendererCpuPct: 2.3, rendererRssMB: 300, gpuCpuPct: 1, totalRssMB: 850 },
  loop: { lagNowMs: 12, lagMaxMs: 4614, lagAvgMs: 140, stalls: 8, lastStallAt: new Date(NOW - 120_000).toISOString(), lastStallMs: 5434 },
  resources: { attachPtys: 1, convs: 1738, bridgeOk: true },
  censusAt: new Date(NOW).toISOString(),
  agents: {
    rows: [{
      pid: 111, kind: 'session', sessionId: 's1', conversationId: 'c1', title: 'vitest storm', peer: 'roomforge',
      status: 'working', cpu: 227, selfCpu: 4, rssMB: 4100, procs: 15,
      tools: [{ name: 'node (vitest)', cmd: '', category: 'test', cpu: 220, rssMB: 4000, count: 14 }],
    }],
    totalCpu: 227,
    byCategory: { test: 220, claude: 7 },
    topActions: [{ pid: 111, name: 'node (vitest)', cmd: '', category: 'test', cpu: 220, rssMB: 4000, count: 14 }],
  },
  processes: {
    total: 1392, claude: 50, claudeRssMB: 13346, node: 63, vitest: 90, chrome: 87,
    topCpu: [{ name: 'node (vitest)', cpu: 227, rssMB: 4100, count: 90, underAgents: { count: 90, cpu: 227 }, groups: [{ label: 'roomforge', count: 90, cpu: 227 }] }],
  },
  docker: null,
  ops: {
    windowSince: new Date(NOW - 180_000).toISOString(),
    rows: [{ label: 'conv:list', count: 12, totalMs: 4800, avgMs: 400, maxMs: 2200, maxPeer: 'atlas-of-doors', overCount: 3 }],
    recentSlow: [{ at: new Date(NOW - 60_000).toISOString(), label: 'conv:list', ms: 2200, peer: 'atlas-of-doors' }],
  },
  logPath: '/tmp/main.log',
};

test('seriesStats: percentiles over the non-null samples only', () => {
  assert.equal(seriesStats([]), null);
  assert.equal(seriesStats([null, undefined]), null);
  const st = seriesStats([1, null, 2, 3, 4, 100]);
  assert.equal(st!.n, 5);
  assert.equal(st!.min, 1);
  assert.equal(st!.max, 100);
  assert.equal(st!.med, 3);
  assert.equal(st!.mean, 22);
});

test('sparkline: flat series is flat, a spike reaches the top block', () => {
  assert.equal(sparkline([]), '');
  // Flat draws at mid-height: full blocks would read as "pinned at maximum".
  assert.equal(sparkline([5, 5, 5, 5]), '▄▄▄▄');
  const s = sparkline([0, 0, 0, 100]);
  assert.equal(s.length, 4);
  assert.equal(s[0], '▁');
  assert.equal(s[3], '█');
});

test('downsamplePoints: averages levels but keeps the worst lag in each bucket', () => {
  const points = Array.from({ length: 20 }, (_, i) => point(NOW - (20 - i) * 5000, {
    cpuBusyPct: i < 10 ? 10 : 90,
    lagMaxMs: i === 3 ? 4000 : 10,
  }));
  const rows = downsamplePoints(points, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cpuBusyPct, 10);
  assert.equal(rows[1].cpuBusyPct, 90);
  // The 4 s freeze survives the fold — averaging it away would hide the reason
  // anyone opened the panel.
  assert.equal(rows[0].lagMaxMs, 4000);
  assert.equal(rows[1].lagMaxMs, 10);
});

test('downsamplePoints: never invents rows for a short history', () => {
  assert.deepEqual(downsamplePoints([], 30), []);
  assert.equal(downsamplePoints([point(NOW)], 30).length, 1);
});

test('rankOverRange: mean is over the whole window, not the samples seen', () => {
  const points = [
    point(NOW - 15_000, { agents: [{ pid: 111, cpu: 100 }] }),
    point(NOW - 10_000, { agents: [{ pid: 111, cpu: 100 }] }),
    point(NOW - 5_000, { agents: [{ pid: 111, cpu: 100 }, { pid: 999, cpu: 400 }] }),
    point(NOW, { agents: [{ pid: 111, cpu: 100 }] }),
  ];
  const ranked = rankOverRange(points, (p) => p.agents, (a) => String(a.pid), (a) => `pid ${a.pid}`, (a) => a.cpu);
  // 999 peaked 4× higher but ran for one sample in four, so it ranks below the
  // agent that burned 100% throughout.
  assert.equal(ranked[0].key, '111');
  assert.equal(ranked[0].meanCpu, 100);
  assert.equal(ranked[1].key, '999');
  assert.equal(ranked[1].meanCpu, 100);
  assert.equal(ranked[1].peakCpu, 400);
  assert.equal(ranked[1].samples, 1);
});

test('buildPerfReport: carries the verdict, the window and the named contributors', () => {
  const points = Array.from({ length: 60 }, (_, i) => point(NOW - (60 - i) * 5000));
  const { markdown, data, summary } = buildPerfReport({ snapshot, history: history(points), rangeMin: 15, now: NOW });

  assert.match(markdown, /# Performance report/);
  assert.match(markdown, /Verdict: DANGER/);
  assert.match(markdown, /last \*\*last 15 min\*\*|window: \*\*last 15 min\*\*/);
  // Agents are named, not left as pids, when the history knows them.
  assert.match(markdown, /roomforge · vitest storm/);
  // The command behind the spike is quoted verbatim.
  assert.match(markdown, /node \(vitest\)/);
  // This app's own slow IPC ops make it in.
  assert.match(markdown, /conv:list/);
  assert.equal(data.samples, 60);
  assert.equal(data.rangeMin, 15);
  assert.equal(data.history!.points.length, 60);
  assert.match(summary, /15 min · 60 samples · danger/);
});

test('buildPerfReport: only the chosen window is included', () => {
  const points = [
    point(NOW - 40 * 60_000, { cpuBusyPct: 3 }), // outside a 15 min window
    point(NOW - 60_000),
    point(NOW - 30_000),
  ];
  const { data } = buildPerfReport({ snapshot, history: history(points), rangeMin: 15, now: NOW });
  assert.equal(data.samples, 2);
  assert.equal(data.history!.points.every((p) => p.t >= NOW - 15 * 60_000), true);
});

test('buildPerfReport: survives an empty history instead of throwing', () => {
  const { markdown, data } = buildPerfReport({ snapshot, history: null, rangeMin: 60, now: NOW });
  assert.equal(data.samples, 0);
  assert.match(markdown, /nothing to trend yet/);
  // The live snapshot is still fully reported.
  assert.match(markdown, /Machine right now/);
});

test('reportBasename: sortable, carries the window', () => {
  const name = reportBasename(15, new Date(2026, 7, 27, 15, 4, 11));
  assert.equal(name, 'perf-2026-08-27T15-04-11-15m');
});

test('serializeReportData: valid JSON with one history point per line', () => {
  const points = Array.from({ length: 5 }, (_, i) => point(NOW - (5 - i) * 5000));
  const { data } = buildPerfReport({ snapshot, history: history(points), rangeMin: 15, now: NOW });
  const text = serializeReportData(data);
  const parsed = JSON.parse(text);
  assert.equal(parsed.samples, 5);
  assert.equal(parsed.history.points.length, 5);
  assert.equal(parsed.snapshot.system.cores, 16);
  // One line per sample — a 1 h window stays readable with a line-based tool.
  assert.equal(text.split('\n').filter((l) => l.startsWith('    {"t":')).length, 5);
});

test('serializeReportData: still valid JSON when there is no history at all', () => {
  const { data } = buildPerfReport({ snapshot, history: null, rangeMin: 15, now: NOW });
  assert.equal(JSON.parse(serializeReportData(data)).history, null);
});
