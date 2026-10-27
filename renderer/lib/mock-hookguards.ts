import type { HookGuardRow, HookGuardsSnapshot } from '../../shared/hookguards';

// What the Guards card shows in the browser mock: four guards on, the memory
// guard off because its helper script is missing — the case worth looking at.
export function buildMockHookGuardsSnapshot(): HookGuardsSnapshot {
  const now = Date.now();
  const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();
  const installDir = '/Users/demo/.claude/hooks/peersflow';
  const passed = (row: Omit<HookGuardRow, 'state' | 'registered' | 'detail'>): HookGuardRow =>
    ({ ...row, state: 'active', registered: true, detail: '' });

  const guards: HookGuardRow[] = [
    passed({
      id: 'block-cookie-clearing',
      title: 'Cookie guard',
      what: 'Stops a chat from wiping your browser logins while it drives a web page.',
      verifiedAt: minsAgo(4),
      checkMs: 420,
      entry: `${installDir}/block-cookie-clearing.sh`,
    }),
    passed({
      id: 'block-second-chrome',
      title: 'Second-Chrome guard',
      what: 'Stops a chat from opening a hidden second Chrome that would swallow the links you click.',
      verifiedAt: minsAgo(4),
      checkMs: 390,
      entry: `${installDir}/block-second-chrome.sh`,
    }),
    passed({
      id: 'block-mass-kill',
      title: 'Mass-kill guard',
      what: 'Stops a chat from closing dozens of your programs at once with one mistyped command.',
      verifiedAt: minsAgo(4),
      checkMs: 1800,
      entry: `${installDir}/block-mass-kill.py`,
    }),
    {
      id: 'mem-admission',
      title: 'Memory guard',
      what: 'Holds back new helper agents when the Mac is about to run out of memory.',
      state: 'failed',
      registered: false,
      verifiedAt: null,
      checkMs: 19200,
      detail: 'mem-budget.mjs not found — this guard needs ~/.claude/tools/cpu-gate/mem-budget.mjs; it fails open without it',
      entry: `${installDir}/mem-admission.sh`,
    },
    passed({
      id: 'kill-shims',
      title: 'Kill-command guard',
      what: 'Checks every kill command a chat runs, even ones started from scripts, before it closes anything.',
      verifiedAt: minsAgo(3),
      checkMs: 650,
      entry: `${installDir}/bin/pkill`,
    }),
  ];

  const superseded = ['block-cookie-clearing.sh', 'block-second-chrome.sh', 'block-mass-kill.py', 'block-mass-kill.selftest.sh', 'mem-admission.sh', 'mem-admission.selftest.sh'];
  return {
    at: minsAgo(3),
    phase: 'done',
    installDir,
    settingsPath: '/Users/demo/.claude/settings.json',
    shimDir: `${installDir}/bin`,
    guards,
    lastRun: {
      startedAt: minsAgo(4),
      finishedAt: minsAgo(3),
      filesWritten: 13,
      settingsChanged: true,
      backup: '/Users/demo/.claude/backups/settings.json.backup.1793000000000',
      supersededMoved: superseded.map((f) => `/Users/demo/.claude/hooks/peersflow-superseded/${f}.1793000000000`),
      error: null,
    },
  };
}
