import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { LagRing, attributeAgents, categorize, classifyClaude, cpuBusyBetween, displayName, exeFromArgs, parsePsLines, parsePsOutput, parseDockerStats, parsePressureLevel, parseVmStat, shortCmd } from './sysmon';
import { perfVerdict, fmtMs, fmtMB, memorySeverity } from '../shared/perf-severity';
import type { PerfSnapshot } from '../shared/types';

test('LagRing: reports the latest, worst and mean sample over its window', () => {
  const r = new LagRing(4);
  assert.deepEqual(r.stats(), { now: 0, max: 0, avg: 0 });
  r.push(10); r.push(4600); r.push(20);
  assert.deepEqual(r.stats(), { now: 20, max: 4600, avg: Math.round(4630 / 3) });
  // Overflow drops the oldest sample first (the 10), then the 4.6s stall ages out.
  r.push(5); r.push(7);
  assert.deepEqual(r.stats(), { now: 7, max: 4600, avg: Math.round((4600 + 20 + 5 + 7) / 4) });
  r.push(1);
  assert.deepEqual(r.stats(), { now: 1, max: 20, avg: Math.round((20 + 5 + 7 + 1) / 4) });
});

test('cpuBusyBetween: busy fraction of the delta, clamped, null on no delta', () => {
  const a = [{ user: 100, nice: 0, sys: 100, idle: 800, irq: 0 }];
  const b = [{ user: 150, nice: 0, sys: 150, idle: 900, irq: 0 }];
  assert.equal(cpuBusyBetween(a, b), 50);
  assert.equal(cpuBusyBetween(a, a), null);
  const saturated = [{ user: 1100, nice: 0, sys: 100, idle: 800, irq: 0 }];
  assert.equal(cpuBusyBetween(a, saturated), 100);
});

test('displayName: folds helper and worker variants into one row each', () => {
  assert.equal(displayName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Chrome');
  assert.equal(displayName('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)'), 'Chrome');
  assert.equal(displayName('/Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell'), 'Chrome (headless)');
  assert.equal(displayName('node (vitest 12)'), 'node (vitest)');
  assert.equal(displayName('/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine'), 'Docker VM');
  assert.equal(displayName('claude'), 'claude');
});

test('parsePsOutput: census counts, claude RSS, and top-CPU aggregation by name', () => {
  const ps = [
    '  100     1  14.1 448224 /x/Electron.app/Contents/MacOS/Electron',
    '  200   100   6.1 578832 claude',
    '  201   100   5.0 572016 claude',
    '  300     1  12.4  80096 node (vitest 5)',
    '  301     1   9.9  77824 node (vitest 12)',
    '  400     1  30.0 100000 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --restore',
    '  401   400  20.0  50000 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/151/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU) --type=gpu-process --no-sandbox',
    '  500     1   0.0   6480 ps',
    '  600     1 216.0 9474848 /System/.../com.apple.Virtualization.VirtualMachine',
    '  700     1   0.0  40000 node',
    '  800     1  30.0   2000 (ps)',
    '  801     1  30.0   2000 (ps)',
    `  ${process.pid}     1  99.0  1000 self-should-be-skipped`,
  ].join('\n');
  // Our own `ps` child (pid 500) is excluded; the zombie `(ps)` storm is NOT —
  // it is real load and shows up under the bare name.
  const c = parsePsOutput(ps, [process.pid, 500]);
  assert.equal(c.total, 11);
  assert.equal(c.claude, 2);
  assert.equal(c.claudeRssMB, Math.round((578832 + 572016) / 1024));
  assert.equal(c.node, 3);
  assert.equal(c.vitest, 2);
  assert.equal(c.chrome, 2);
  // "Who runs them": the two claude workers are agents, so nothing is *under* an
  // agent here except what the tree says (nothing — flat fixture).
  assert.deepEqual(c.topCpu.find((r) => r.name === 'Chrome')!.groups, [{ label: 'main profile', count: 2, cpu: 50 }]);
  assert.deepEqual(c.topCpu.map((r) => [r.name, r.cpu, r.count]), [
    ['Docker VM', 216, 1],
    ['ps', 60, 2],
    ['Chrome', 50, 2],
    ['node (vitest)', 22, 2],
    ['AgentsFlow (Electron)', 14, 1],
    ['claude', 11, 2],
  ]);
});

function snap(over: Partial<PerfSnapshot['system']> = {}, loop: Partial<PerfSnapshot['loop']> = {}): PerfSnapshot {
  return {
    at: '2026-08-26T13:30:00.000Z',
    system: { cpuBusyPct: 20, load1: 4, load5: 4, load15: 4, cores: 16, memTotalMB: 131072, memUsedMB: 40000, memUsedPct: 30, swapUsedMB: 0, memPressure: null, ...over },
    app: { uptimeS: 1, mainCpuPct: 1, mainRssMB: 1, heapMB: 1, rendererCpuPct: 1, rendererRssMB: 1, gpuCpuPct: 0, totalRssMB: 1 },
    loop: { lagNowMs: 1, lagMaxMs: 10, lagAvgMs: 2, stalls: 0, lastStallAt: null, lastStallMs: 0, ...loop },
    resources: {},
    censusAt: null,
    agents: null,
    processes: null,
    docker: null,
    ops: { windowSince: '', rows: [], recentSlow: [] },
    logPath: null,
  };
}

test('perfVerdict: healthy machine is normal with a two-number badge', () => {
  const v = perfVerdict(snap());
  assert.equal(v.severity, 'normal');
  assert.equal(v.badge, '20% · 10ms');
  assert.equal(v.badgeLong, 'CPU 20% · lag 10ms');
});

test('perfVerdict: an oversubscribed machine is danger even when the app itself is idle', () => {
  const v = perfVerdict(snap({ load1: 152, cpuBusyPct: 100 }));
  assert.equal(v.severity, 'danger');
  assert.match(v.reason, /load 152 on 16 cores/);
});

test('perfVerdict: event-loop lag alone escalates (warning at 250ms, danger at 1s)', () => {
  assert.equal(perfVerdict(snap({}, { lagMaxMs: 300 })).severity, 'warning');
  assert.equal(perfVerdict(snap({}, { lagMaxMs: 4600 })).severity, 'danger');
  assert.equal(perfVerdict(snap({}, { lagMaxMs: 4600 })).badge, '20% · 4.6s');
});

test('perfVerdict: falls back to load in the badge before the first CPU delta exists', () => {
  assert.equal(perfVerdict(snap({ cpuBusyPct: null })).badge, 'L4 · 10ms');
  assert.equal(perfVerdict(snap({ cpuBusyPct: null })).badgeLong, 'load 4 · lag 10ms');
});

test('formatters', () => {
  assert.equal(fmtMs(55295), '55s');
  assert.equal(fmtMs(4614), '4.6s');
  assert.equal(fmtMs(120), '120ms');
  assert.equal(fmtMB(13346), '13 GB');
  assert.equal(fmtMB(1300), '1.3 GB');
  assert.equal(fmtMB(448), '448 MB');
});

test('parseVmStat: Activity-Monitor style used = active + wired + compressed − purgeable', () => {
  const text = [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    'Pages free:                                  1600211.',
    'Pages active:                                2132136.',
    'Pages inactive:                              2080546.',
    'Pages speculative:                             68422.',
    'Pages throttled:                                   0.',
    'Pages wired down:                             500656.',
    'Pages purgeable:                               45368.',
    '"Translation faults":                    21017870176.',
    'Pages occupied by compressor:                 100000.',
  ].join('\n');
  const total = 137438953472; // 128 GB
  const v = parseVmStat(text, total);
  assert.ok(v);
  assert.equal(v.totalMB, 131072);
  const expectedPages = 2132136 + 500656 + 100000 - 45368;
  assert.equal(v.usedMB, Math.round((expectedPages * 16384) / 1024 / 1024));
  // A 128 GB box with 25 GB truly free must NOT read as ~99% used.
  assert.ok(v.usedMB / v.totalMB < 0.5, `used fraction ${v.usedMB / v.totalMB}`);
  assert.equal(parseVmStat('garbage', total), null);
});

test('parsePressureLevel + memorySeverity: the kernel level outranks the used-%', () => {
  assert.equal(parsePressureLevel('1\n'), 'normal');
  assert.equal(parsePressureLevel('2'), 'warning');
  assert.equal(parsePressureLevel('4'), 'critical');
  assert.equal(parsePressureLevel(''), null);
  assert.equal(memorySeverity({ memUsedPct: 99, memPressure: 'normal' }), 'warning');
  assert.equal(memorySeverity({ memUsedPct: 90, memPressure: 'normal' }), 'normal');
  assert.equal(memorySeverity({ memUsedPct: 40, memPressure: 'critical' }), 'danger');
  assert.equal(memorySeverity({ memUsedPct: 90, memPressure: null }), 'warning');
});

test('exeFromArgs: bundle paths with spaces, plain tokens, zombies', () => {
  assert.equal(
    exeFromArgs('/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/151/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --lang=en'),
    '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/151/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)',
  );
  assert.equal(exeFromArgs('/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /x/dist/electron/electron/mcp/agentsflow-mcp'), '/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
  assert.equal(exeFromArgs('node /x/tools/season-loop/rounds.mjs --journal=/y'), 'node');
  assert.equal(exeFromArgs('claude --resume abc --permission-mode bypassPermissions'), 'claude');
  assert.equal(exeFromArgs('(ps)'), 'ps');
  assert.equal(exeFromArgs('node (vitest 9)'), 'node');
});

test('classifyClaude: sessions, spares, and plumbing', () => {
  const s = classifyClaude('claude', 'claude --resume ab28def4-8c42-476d-bd92-31c8e194769c --permission-mode bypassPermissions --mcp-config /U/Library/Application Support/Peers Flow/mcp-configs/4d9cee57-cc35-4b80-b0c0-a5dbdee17b16.json --append-system-prompt x');
  assert.deepEqual(s, { isClaude: true, kind: 'session', sessionId: 'ab28def4-8c42-476d-bd92-31c8e194769c', conversationId: '4d9cee57-cc35-4b80-b0c0-a5dbdee17b16' });
  // A fork's own session id wins over the --resume source.
  assert.equal(classifyClaude('claude', 'claude --resume aaaaaaaa-1 --fork-session --session-id bbbbbbbb-2').sessionId, 'bbbbbbbb-2');
  assert.equal(classifyClaude('claude', 'claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/f9042c1e.claim.sock').kind, 'spare');
  assert.equal(classifyClaude('claude', 'claude bg-pty-host --bg-pty-host /tmp/x.pty.sock 200 50 -- /v/2.1.246 --bg-spare /tmp/x.claim.sock').kind, null);
  assert.equal(classifyClaude('/Users/x/.local/bin/claude', '/Users/x/.local/bin/claude daemon run --json-path /x').kind, null);
  assert.equal(classifyClaude('claude', 'claude').kind, 'session'); // a plain terminal session
  assert.equal(classifyClaude('node', 'node claude-something').isClaude, false);
});

test('categorize + shortCmd: tool buckets and human argument strings', () => {
  assert.equal(categorize('rg', 'rg -n foo src'), 'search');
  assert.equal(categorize('grep', 'grep -rn foo .'), 'search');
  assert.equal(categorize('git', 'git status --porcelain'), 'git');
  assert.equal(categorize('node (vitest)', 'node (vitest 3)'), 'test');
  assert.equal(categorize('npm', 'npm exec vitest run --shard=2/4'), 'test');
  assert.equal(categorize('tsc', 'tsc -p electron/tsconfig.json'), 'build');
  assert.equal(categorize('zsh', '/bin/zsh -c source /x/snapshot.sh && ls'), 'shell');
  assert.equal(categorize('agentsflow-mcp', '/x/Electron /x/mcp/agentsflow-mcp'), 'mcp');
  assert.equal(categorize('Chrome (headless)', '/x/chrome-headless-shell --headless'), 'browser');
  assert.equal(categorize('caffeinate', 'caffeinate -i -t 300'), 'other');
  assert.equal(shortCmd('npm', 'npm', 'npm exec vitest run   --shard=2/4'), 'exec vitest run --shard=2/4');
  assert.equal(shortCmd('zsh', '/bin/zsh', '/bin/zsh -c source /x/snapshot.sh && ls'), '');
  assert.equal(shortCmd('node', 'node', 'node /Users/x/IdeaProjects/atlas/tools/season-loop/rounds.mjs --journal=/y'), 'rounds.mjs --journal=/y');
  assert.equal(shortCmd('git', '/usr/bin/git', '/usr/bin/git status'), 'status');
  assert.equal(shortCmd('Chrome (headless)', '/x/chrome-headless-shell', '/x/chrome-headless-shell --type=gpu-process --no-sandbox --headless'), 'gpu-process');
  assert.equal(categorize('Chrome (headless)', '/Users/x/Library/Caches/ms-playwright/chromium/chrome-headless-shell --type=renderer'), 'browser');
});

test('attributeAgents: bills each subtree to its nearest agent, names it via the resolver', () => {
  const ps = [
    // daemon → pty-host → spare (agent) → tools
    '   70     1   0.6  10000 /Users/x/.local/bin/claude daemon run --json-path /x/daemon.json',
    '   80    70   0.1   5000 claude bg-pty-host --bg-pty-host /tmp/x.pty.sock 200 50 -- /v --bg-spare /tmp/s1.claim.sock',
    '   81    80  30.0 400000 claude bg-spare --bg-spare /tmp/s1.claim.sock',
    '   82    81   0.0   3000 /bin/zsh -c source /x/snapshot.sh && npm test',
    '   83    82   1.4  80000 npm exec vitest run --shard=2/4',
    '   84    83   0.0 900000 node (vitest)',
    '   85    84  25.0  80000 node (vitest 1)',
    '   86    84  20.0  80000 node (vitest 2)',
    '   87    81   0.0   2000 caffeinate -i -t 300',
    // an AgentsFlow-spawned chat with a delegated child chat (its own row)
    '  100    46   5.6 600000 claude --resume 652a0c68-1 --mcp-config /U/Peers Flow/mcp-configs/4d9cee57-000a.json --append-system-prompt x',
    '  101   100   0.2  90000 /x/Electron.app/Contents/MacOS/Electron /x/dist/electron/electron/mcp/agentsflow-mcp',
    '  102   101   8.0 500000 claude --resume 99999999-2 --mcp-config /U/Peers Flow/mcp-configs/4d9cee57-000b.json',
    '  103   102   6.0   4000 grep -rn cookie src/',
    '  104   100   2.0  20000 /usr/bin/git status --porcelain',
    // unrelated
    '  200     1  50.0  10000 /System/Library/Frameworks/Virtualization.framework/x/com.apple.Virtualization.VirtualMachine',
  ].join('\n');
  const procs = parsePsLines(ps);
  const seen: Array<{ pid: number; sessionId: string | null; conversationId: string | null }> = [];
  const r = attributeAgents(procs, (q) => {
    seen.push(q);
    if (q.pid === 81) return { sessionId: 'spare-session', conversationId: 'conv-s', title: 'Spare chat', peer: 'LISA', status: 'working' };
    if (q.conversationId === '4d9cee57-000a') return { conversationId: '4d9cee57-000a', sessionId: q.sessionId, title: 'Perf monitor', peer: 'AgentsFlow', status: 'working' };
    if (q.conversationId === '4d9cee57-000b') return { conversationId: '4d9cee57-000b', sessionId: q.sessionId, title: 'Cookie bars', peer: 'atlas-of-doors', status: 'blocked' };
    return null;
  });
  assert.deepEqual(r.rows.map((x) => [x.pid, x.title, x.cpu, x.selfCpu, x.procs]), [
    [81, 'Spare chat', 76.4, 30, 6],
    [102, 'Cookie bars', 14, 8, 1],
    [100, 'Perf monitor', 7.8, 5.6, 2], // the delegated chat's subtree is NOT folded in
  ]);
  const spare = r.rows[0];
  assert.equal(spare.kind, 'spare');
  assert.equal(spare.peer, 'LISA');
  assert.deepEqual(spare.tools.map((t) => [t.name, t.cmd, t.category, t.cpu, t.count]), [
    ['node (vitest)', '', 'test', 45, 3],
    ['npm', 'exec vitest run --shard=2/4', 'test', 1.4, 1],
  ]);
  assert.deepEqual(r.rows[1].tools.map((t) => [t.name, t.cmd, t.category, t.cpu]), [['grep', '-rn cookie src/', 'search', 6]]);
  assert.deepEqual(r.rows[2].tools.map((t) => [t.name, t.cmd, t.category, t.cpu]), [['git', 'status --porcelain', 'git', 2]]);
  assert.equal(r.totalCpu, 98.2);
  assert.deepEqual(r.byCategory, { claude: 43.6, test: 46.4, search: 6, git: 2, mcp: 0.2 });
  // The resolver saw the ids parsed from argv.
  assert.deepEqual(seen.find((q) => q.pid === 100), { pid: 100, sessionId: '652a0c68-1', conversationId: '4d9cee57-000a' });
  assert.deepEqual(seen.find((q) => q.pid === 81), { pid: 81, sessionId: null, conversationId: null });
});

test('groupLabel: Chrome by profile, node by project, others by command', () => {
  const rec = (args: string, exe = exeFromArgs(args)) => ({ pid: 1, ppid: 0, cpu: 0, rssKB: 0, exe, args });
  const { groupLabel } = require('./sysmon') as typeof import('./sysmon');
  assert.equal(groupLabel('Chrome', rec('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --restore-last-session')), 'main profile');
  assert.equal(groupLabel('Chrome', rec('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/iij/Library/Application Support/Google/ChromeAuto --remote-debugging-port=9222')), 'main profile');
  assert.equal(groupLabel('Chrome', rec('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=9701 --user-data-dir=/private/tmp/claude-501/x/chrome')), 'claude job (throwaway)');
  assert.equal(groupLabel('Chrome', rec('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/iij/Library/Caches/us.zoom.xos/ZoomCefWebView')), 'Zoom webview');
  assert.equal(groupLabel('Chrome (headless)', rec('/x/chrome-headless-shell --headless')), 'headless (Playwright)');
  assert.equal(groupLabel('node', rec('node /Users/iij/IdeaProjects/atlas-of-doors/.claude/worktrees/x/node_modules/.bin/vite')), 'atlas-of-doors');
  assert.equal(groupLabel('node', rec('node /Users/iij/Desktop/AgentsFlow/dist/x.js')), 'AgentsFlow');
  assert.equal(groupLabel('node (vitest)', rec('node (vitest 3)')), 'vitest worker');
  assert.equal(groupLabel('node', rec('node --max-old-space-size=8192 --import tsx dashboard/api/server.mjs')), 'server.mjs');
  assert.equal(groupLabel('node', rec('node /private/tmp/claude-501/x/scratchpad/serve-d.mjs')), 'serve-d.mjs');
  assert.equal(groupLabel('node', rec('node --watch server/index.ts')), 'index.ts');
  assert.equal(groupLabel('git', rec('/usr/bin/git status --porcelain')), 'git status');
  assert.equal(groupLabel('claude', rec('claude bg-spare --bg-spare /tmp/s.claim.sock')), 'bg worker');
  assert.equal(groupLabel('claude', rec('claude --resume abc --append-system-prompt "peer at /Users/iij/Desktop/abi`"')), 'session');
  assert.equal(groupLabel('claude', rec('claude bg-pty-host --bg-pty-host /tmp/x.pty.sock')), 'daemon / pty-host');
  assert.equal(groupLabel('AgentsFlow (Electron)', rec('/x/Electron.app/Contents/MacOS/Electron /Users/iij/Desktop/AgentsFlow/dist/main.js')), 'main');
  assert.equal(groupLabel('AgentsFlow (Electron)', rec('/x/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer) --type=renderer --user-data-dir=/x')), 'renderer');
});

test('buildCensus: counts processes under agents and groups them by origin', () => {
  const ps = [
    '   81     1  30.0 400000 claude bg-spare --bg-spare /tmp/s1.claim.sock',
    '   85    81  25.0  80000 node /Users/iij/IdeaProjects/roomforge/node_modules/.bin/vitest run',
    '   90     1  10.0  50000 node /Users/iij/IdeaProjects/influence/node_modules/nx/bin/run-executor.js',
    '   91     1   5.0  50000 node /Users/iij/IdeaProjects/influence/node_modules/nx/src/daemon/server/start.js',
  ].join('\n');
  const c = parsePsOutput(ps, []);
  const node = c.topCpu.find((r) => r.name === 'node')!;
  assert.deepEqual(node.underAgents, { count: 1, cpu: 25 });
  assert.deepEqual(node.groups, [
    { label: 'roomforge', count: 1, cpu: 25 },
    { label: 'influence', count: 2, cpu: 15 },
  ]);
});

test('parseDockerStats: names, CPU and memory in MB, sorted by CPU', () => {
  const d = parseDockerStats('atlas-dash-db\t100.09%\t205.2MiB / 20GiB\ncustomer-ui\t0.01%\t3.645GiB / 20GiB\nredis\t0.30%\t16.44MiB / 20GiB\n');
  assert.equal(d.containers, 3);
  assert.deepEqual(d.top.map((r) => [r.name, r.cpu, r.memMB]), [
    ['atlas-dash-db', 100.1, 205],
    ['redis', 0.3, 16],
    ['customer-ui', 0, 3732],
  ]);
});

test('history: recordHistoryPoint appends points with the cheap metrics even before any census', () => {
  const { recordHistoryPoint, getPerfHistory } = require('./sysmon') as typeof import('./sysmon');
  const before = getPerfHistory().points.length;
  recordHistoryPoint();
  recordHistoryPoint();
  const h = getPerfHistory();
  assert.equal(h.intervalMs, 5000);
  assert.equal(h.points.length, before + 2);
  const p = h.points[h.points.length - 1];
  assert.ok(p.t > 0);
  assert.equal(typeof p.load1, 'number');
  assert.equal(typeof p.mainCpuPct, 'number');
  assert.equal(typeof p.lagMaxMs, 'number');
  // No census has run in this process: census-derived series are null, not 0.
  assert.equal(p.agents, null);
  assert.equal(p.byCategory, null);
  assert.equal(p.topProcs, null);
  assert.equal(p.memUsedPct, null);
  assert.ok(h.points[h.points.length - 1].t >= h.points[h.points.length - 2].t);
});
