import type { AgentsFlowApi, Conversation, PinnedDivider, PinnedItemRef, PinnedTodo, TrackedDirectory, SpawnRequest, GitStatusResult, FileEntry, SearchOptions, SearchResult, SearchMatchLine, WorktreeInfo } from '../../shared/types';
import { forkTitle } from '../../shared/fork-title';

const STORE_KEY = 'agentsflow:mock:v3';

interface MockShape {
  directories: TrackedDirectory[];
  conversations: Conversation[];
  dividers: PinnedDivider[];
  todos: PinnedTodo[];
  pinnedOrder: PinnedItemRef[];
}

function uuid() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

function load(): MockShape {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MockShape>;
      return {
        directories: parsed.directories ?? [],
        conversations: parsed.conversations ?? [],
        dividers: parsed.dividers ?? [],
        todos: parsed.todos ?? [],
        pinnedOrder: parsed.pinnedOrder ?? [],
      };
    }
  } catch {}
  return {
    directories: [
      { id: uuid(), path: '/Users/demo/Projects/abi', displayName: 'abi', addedAt: new Date().toISOString() },
      { id: uuid(), path: '/Users/demo/Desktop/LISA', displayName: 'LISA', addedAt: new Date().toISOString() },
      { id: uuid(), path: '/Users/demo/IdeaProjects/nutrable', displayName: 'nutrable', addedAt: new Date().toISOString() },
    ],
    conversations: [],
    dividers: [],
    todos: [],
    pinnedOrder: [],
  };
}

function save(state: MockShape) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

const listeners = {
  convs: new Set<(c: Conversation[]) => void>(),
  dividers: new Set<(d: PinnedDivider[]) => void>(),
  todos: new Set<(t: PinnedTodo[]) => void>(),
  pinnedOrder: new Set<(o: PinnedItemRef[]) => void>(),
  termData: new Set<(id: string, data: string) => void>(),
  termExit: new Set<(id: string) => void>(),
};

function fire(state: MockShape) {
  listeners.convs.forEach((cb) => cb(state.conversations));
}
function fireDividers(state: MockShape) {
  listeners.dividers.forEach((cb) => cb(state.dividers));
}
function fireTodos(state: MockShape) {
  listeners.todos.forEach((cb) => cb(state.todos));
}
function fireOrder(state: MockShape) {
  listeners.pinnedOrder.forEach((cb) => cb(state.pinnedOrder));
}

function dropRef(state: MockShape, ref: PinnedItemRef) {
  state.pinnedOrder = state.pinnedOrder.filter((r) => !(r.kind === ref.kind && r.id === ref.id));
}
function prependRef(state: MockShape, ref: PinnedItemRef) {
  dropRef(state, ref);
  state.pinnedOrder = [ref, ...state.pinnedOrder];
}
// Mirrors store.ts / pinned-order.ts: a fork lands directly below its source,
// staying in the source's section. Falls back to end-of-first-section when the
// anchor isn't in the list.
function insertRefAfter(state: MockShape, ref: PinnedItemRef, anchor: PinnedItemRef) {
  dropRef(state, ref);
  const anchorIdx = state.pinnedOrder.findIndex((r) => r.kind === anchor.kind && r.id === anchor.id);
  if (anchorIdx < 0) {
    insertRefAtEndOfFirstSection(state, ref);
    return;
  }
  state.pinnedOrder = [
    ...state.pinnedOrder.slice(0, anchorIdx + 1),
    ref,
    ...state.pinnedOrder.slice(anchorIdx + 1),
  ];
}
// Mirrors store.ts / pinned-order.ts: a freshly-spawned conv lands at the bottom
// of the first section — the group headed by the first divider, just before the
// second divider (or the very end of the list if there's one divider or none).
function insertRefAtEndOfFirstSection(state: MockShape, ref: PinnedItemRef) {
  dropRef(state, ref);
  const firstDividerIdx = state.pinnedOrder.findIndex((r) => r.kind === 'divider');
  if (firstDividerIdx < 0) {
    state.pinnedOrder = [...state.pinnedOrder, ref];
    return;
  }
  const secondDividerIdx = state.pinnedOrder.findIndex(
    (r, i) => i > firstDividerIdx && r.kind === 'divider',
  );
  const insertAt = secondDividerIdx < 0 ? state.pinnedOrder.length : secondDividerIdx;
  state.pinnedOrder = [
    ...state.pinnedOrder.slice(0, insertAt),
    ref,
    ...state.pinnedOrder.slice(insertAt),
  ];
}

export function createMockApi(): AgentsFlowApi {
  let state = load();

  // Fake worktree set so the Changes-view worktree section renders in the
  // browser demo. Mutable so `removeWorktree` visibly drops a row.
  let mockWorktrees: WorktreeInfo[] = [
    { path: '/Users/demo/Desktop/LISA', branch: 'master', head: '74dbe3b5', isMain: true, isCurrent: true, changedCount: 3, dirty: true, refBranch: 'master', ahead: 0, behind: 0, unpublished: 0, published: true },
    { path: '/Users/demo/Desktop/LISA/.claude/worktrees/collect-chats-script', branch: 'worktree-collect-chats-script', head: 'cbeb6dc2', isMain: false, isCurrent: false, changedCount: 0, dirty: false, refBranch: 'master', ahead: 0, behind: 4, unpublished: 0, published: true },
    { path: '/Users/demo/Desktop/LISA/.claude/worktrees/dpd-complaint', branch: 'worktree-dpd-complaint', head: 'ce1e91fc', isMain: false, isCurrent: false, changedCount: 2, dirty: true, refBranch: 'master', ahead: 1, behind: 0, unpublished: 1, published: false },
    // 3 commits ahead but only 2 outstanding — the rebase case the panel exists to get right.
    { path: '/Users/demo/Desktop/LISA/.claude/worktrees/nutrable-chat-script', branch: 'worktree-nutrable-chat-script', head: 'b36dd36a', isMain: false, isCurrent: false, changedCount: 0, dirty: false, refBranch: 'master', ahead: 3, behind: 2, unpublished: 2, published: false },
  ];

  return {
    listDirectories: async () => state.directories,
    listSlashCommands: async () => [
      { name: 'smart-commit', invocation: '/smart-commit', description: 'Generate a meaningful git commit message from recent history and changes.', scope: 'user' as const, kind: 'command' as const, source: '~/.claude/commands/smart-commit.md' },
      { name: 'diagnose', invocation: '/diagnose', description: 'Reproduce a reported bug live in Chrome and trace the data end-to-end.', scope: 'user' as const, kind: 'command' as const, source: '~/.claude/commands/diagnose.md' },
      { name: 'fig', invocation: '/fig', description: 'Use the Figma MCP server to match designs exactly.', scope: 'user' as const, kind: 'command' as const, source: '~/.claude/commands/fig.md' },
      { name: 'review', invocation: '/review', description: 'Review a pull request.', scope: 'project' as const, kind: 'skill' as const, source: '.claude/skills/review/SKILL.md' },
    ],
    addDirectory: async () => {
      const path = window.prompt('[mock] Enter directory absolute path:', '/Users/demo/Projects/new-project');
      if (!path) return null;
      const parts = path.split('/').filter(Boolean);
      const displayName = parts[parts.length - 1] || path;
      const d: TrackedDirectory = { id: uuid(), path, displayName, addedAt: new Date().toISOString() };
      state.directories = [...state.directories, d];
      // Re-link any conversations recorded for this path so re-adding restores
      // them under the new directoryId (matches the real Electron handler).
      state.conversations = state.conversations.map((c) =>
        c.directoryPath === path ? { ...c, directoryId: d.id, displayName } : c,
      );
      save(state);
      fire(state);
      return d;
    },
    removeDirectory: async (id) => {
      state.directories = state.directories.filter((d) => d.id !== id);
      save(state);
    },

    getMcpServerInfo: async () => ({
      serverName: 'peersflow',
      connected: true,
      scriptPath: '/mock/dist/electron/electron/mcp/agentsflow-mcp-server.js',
      configPath: '/mock/userData/peersflow-mcp.json',
      configJson: JSON.stringify(
        {
          mcpServers: {
            peersflow: {
              command: '/mock/Electron',
              args: ['/mock/dist/electron/electron/mcp/agentsflow-mcp-server.js'],
              env: { ELECTRON_RUN_AS_NODE: '1', PEERSFLOW_STORE_PATH: '/mock/userData/store.json' },
            },
          },
        },
        null,
        2,
      ),
      tools: [
        {
          name: 'mcp__peersflow__list_peers',
          title: 'List peers',
          description: 'Return the current Peers Flow registry: every tracked directory (peer), its path, the skills it exposes, and whether it has its own MCP connections.',
          usage: 'No arguments. Returns a markdown registry of all peers.',
        },
        {
          name: 'mcp__peersflow__delegate',
          title: 'Delegate work to a peer',
          description: "Ask another peer (a tracked directory) to deliver something. Spawns a fresh Claude rooted in that peer's directory and returns a structured result.",
          usage: 'delegate({ directory, goal, deliverable?, timeout_ms? })',
        },
      ],
      peers: state.directories.map((d) => ({
        id: d.id,
        displayName: d.displayName,
        path: d.path,
        exists: true,
        hasProjectMcp: d.displayName === 'abi',
        skills: d.displayName === 'abi' ? ['slack-connect', 'daily-digest'] : [],
      })),
      bridge: { socketPath: '/mock/userData/peersflow-bridge.sock', listening: true, socketFileExists: true, healthy: true },
    }),

    getPerfHistory: async () => {
      const n = 360; // 30 min at 5 s
      const now = Date.now();
      const points = Array.from({ length: n }, (_, i) => {
        const t = now - (n - 1 - i) * 5000;
        const phase = i / n;
        const burst = i > 200 && i < 260 ? 1 : 0; // a vitest storm in the middle
        const cpu = Math.round(30 + 20 * Math.sin(phase * 9) + burst * 60 + (i % 7));
        const test = burst * (300 + (i % 5) * 20);
        const build = i > 300 ? 120 + (i % 4) * 10 : 5;
        return {
          t,
          cpuBusyPct: Math.min(100, cpu),
          load1: Math.round((cpu / 100) * 16 * (1 + burst * 6) * 10) / 10,
          memUsedPct: 45 + Math.round(10 * phase) + burst * 15,
          lagMaxMs: burst ? 800 + (i % 9) * 400 : 5 + (i % 11) * 4,
          mainCpuPct: 2 + (i % 5),
          rendererCpuPct: 3 + (i % 3),
          agentsCpu: 20 + test + build,
          byCategory: { claude: 12 + (i % 6), test, build, search: i % 3 === 0 ? 4 : 0, git: 2 },
          agents: [
            { pid: 25470, cpu: 8 + test },
            { pid: 29465, cpu: 6 + build },
            { pid: 10241, cpu: 3 + (i % 4) },
            { pid: 8409, cpu: 1 },
          ],
          topProcs: [
            { name: 'Docker VM', cpu: 150 + (i % 10) * 3 },
            { name: 'Chrome', cpu: 90 + (i % 13) * 5 },
            { name: 'node (vitest)', cpu: test },
            { name: 'node', cpu: 40 + build / 2 },
            { name: 'claude', cpu: 20 + (i % 6) },
          ],
        };
      });
      return {
        intervalMs: 5000,
        points,
        agentNames: {
          '25470': { title: '10. V2 · /game-council listen a lot has changed', peer: 'atlas-of-doors', kind: 'session' },
          '29465': { title: 'Can we also measure how many people accept our cookie bars', peer: 'atlas-of-doors', kind: 'session' },
          '10241': { title: 'Performance monitor', peer: 'AgentsFlow', kind: 'session' },
          '8409': { title: null, peer: null, kind: 'spare' },
        },
      };
    },

    getPerfSnapshot: async () => ({
      at: new Date().toISOString(),
      system: { cpuBusyPct: 87, load1: 22.4, load5: 18.1, load15: 12.0, cores: 16, memTotalMB: 131072, memUsedMB: 43000, memUsedPct: 33, swapUsedMB: 0, memPressure: 'normal' },
      app: { uptimeS: 6600, mainCpuPct: 4.2, mainRssMB: 448, heapMB: 71, rendererCpuPct: 3.6, rendererRssMB: 300, gpuCpuPct: 5.8, totalRssMB: 850 },
      loop: { lagNowMs: 12, lagMaxMs: 4614, lagAvgMs: 140, stalls: 8, lastStallAt: new Date(Date.now() - 2 * 60_000).toISOString(), lastStallMs: 5434 },
      resources: { attachPtys: 1, resumePtys: 12, systemPtys: 68, convWatchers: 10, convs: 1738, bridgeOk: true },
      censusAt: new Date().toISOString(),
      agents: {
        totalCpu: 96.4,
        byCategory: { test: 62, claude: 22.3, search: 6.1, git: 3.2, shell: 1.8, mcp: 0.6, other: 0.4 },
        rows: [
          { pid: 25470, kind: 'session', sessionId: '85ca6a65', conversationId: 'c1', title: '10. V2 · /game-council listen a lot has changed', peer: 'atlas-of-doors', status: 'working', cpu: 61.2, selfCpu: 3.9, rssMB: 6200, procs: 21,
            tools: [
              { name: 'node (vitest)', cmd: '', category: 'test', cpu: 55.1, rssMB: 4100, count: 15 },
              { name: 'npm', cmd: 'exec vitest run --shard=2/4', category: 'test', cpu: 1.4, rssMB: 84, count: 1 },
              { name: 'rg', cmd: '-n --json season tools/', category: 'search', cpu: 0.8, rssMB: 12, count: 1 },
            ] },
          { pid: 29465, kind: 'session', sessionId: '99b7b9d3', conversationId: 'c2', title: 'Can we also measure how many people accept our cookie bars', peer: 'atlas-of-doors', status: 'working', cpu: 14.3, selfCpu: 6.4, rssMB: 900, procs: 4,
            tools: [
              { name: 'grep', cmd: '-rn cookie src/', category: 'search', cpu: 5.3, rssMB: 6, count: 1 },
              { name: 'git', cmd: 'status --porcelain', category: 'git', cpu: 2.6, rssMB: 20, count: 1 },
            ] },
          { pid: 8409, kind: 'spare', sessionId: null, conversationId: null, title: null, peer: null, status: null, cpu: 12.1, selfCpu: 12.1, rssMB: 430, procs: 2, tools: [] },
          { pid: 10241, kind: 'session', sessionId: '652a0c68', conversationId: 'c3', title: 'Performance monitor', peer: 'AgentsFlow', status: 'working', cpu: 8.8, selfCpu: 5.6, rssMB: 1200, procs: 3,
            tools: [ { name: 'tsc', cmd: '-p electron/tsconfig.json', category: 'build', cpu: 3.2, rssMB: 300, count: 1 } ] },
        ],
      },
      processes: {
        total: 1392, claude: 50, claudeRssMB: 13346, node: 63, vitest: 90, chrome: 87,
        topCpu: [
          { name: 'Chrome', cpu: 171, rssMB: 6200, count: 87, underAgents: { count: 19, cpu: 2 }, groups: [{ label: 'main profile', count: 42, cpu: 116 }, { label: 'claude job (throwaway)', count: 19, cpu: 0 }, { label: 'Zoom webview', count: 5, cpu: 0 }] },
          { name: 'Docker VM', cpu: 157, rssMB: 9400, count: 1, underAgents: { count: 0, cpu: 0 }, groups: [] },
          { name: 'node (vitest)', cpu: 120, rssMB: 4100, count: 90, underAgents: { count: 90, cpu: 120 }, groups: [{ label: 'roomforge', count: 90, cpu: 120 }] },
          { name: 'node', cpu: 55, rssMB: 11000, count: 51, underAgents: { count: 1, cpu: 0 }, groups: [{ label: 'atlas-of-doors', count: 12, cpu: 30 }, { label: 'influence', count: 14, cpu: 20 }, { label: 'roomforge', count: 4, cpu: 5 }] },
          { name: 'claude', cpu: 57, rssMB: 13346, count: 50, underAgents: { count: 0, cpu: 0 }, groups: [{ label: 'claude', count: 50, cpu: 57 }] },
        ],
      },
      docker: { containers: 19, top: [{ name: 'atlas-dash-db', cpu: 100.1, memMB: 205 }, { name: 'billing-api', cpu: 0.5, memMB: 531 }, { name: 'customer-ui', cpu: 0, memMB: 3732 }] },
      ops: {
        windowSince: new Date(Date.now() - 3 * 60_000).toISOString(),
        rows: [
          { label: 'git:worktrees', count: 21, totalMs: 110244, avgMs: 5249.7, maxMs: 11366, maxPeer: 'atlas-of-doors', overCount: 19 },
          { label: 'poll:listAgents', count: 20, totalMs: 97962, avgMs: 4898.1, maxMs: 19132, overCount: 12 },
          { label: 'accounts:usage', count: 80, totalMs: 79288, avgMs: 991.1, maxMs: 3380, overCount: 73 },
          { label: 'git:status', count: 45, totalMs: 23898, avgMs: 531.1, maxMs: 2174, maxPeer: 'atlas-of-doors', overCount: 43 },
        ],
        recentSlow: [
          { at: new Date(Date.now() - 20_000).toISOString(), label: 'git:worktrees', ms: 55295, peer: 'atlas-of-doors' },
          { at: new Date(Date.now() - 45_000).toISOString(), label: 'usage:get', ms: 26611 },
        ],
      },
      logPath: null,
    }),

    getBridgeHealth: async () => ({
      socketPath: '/mock/userData/peersflow-bridge.sock',
      listening: true,
      socketFileExists: true,
      healthy: true,
    }),

    getUsage: async () => ({
      ok: true,
      snapshot: {
        fetchedAt: new Date().toISOString(),
        plan: 'Max (20x)',
        meters: [
          { key: 'session', label: 'Current session', group: 'session', percent: 63, severity: 'normal', resetsAt: new Date(Date.now() + 4 * 60_000).toISOString(), isActive: false },
          { key: 'weekly_all', label: 'All models', group: 'weekly', percent: 81, severity: 'warning', resetsAt: new Date(Date.now() + 5 * 864e5).toISOString(), isActive: true },
          { key: 'weekly:fable', label: 'Fable', group: 'weekly', percent: 50, severity: 'normal', resetsAt: new Date(Date.now() + 5 * 864e5).toISOString(), isActive: false },
        ],
      },
    }),

    // Account pool. The browser demo has no keychain, so this is a static pool
    // that exercises the layout (active marker, per-account meters) without
    // pretending a switch is possible.
    listAccounts: async () => ({
      accounts: [
        { id: 'acct-1', email: 'first@gmail.com', configDir: '/Users/demo/.agentsflow/accounts/first-a1b2c3', accountUuid: 'uuid-1', subscriptionType: 'max', addedAt: new Date(Date.now() - 12 * 864e5).toISOString() },
        { id: 'acct-2', email: 'second@gmail.com', configDir: '/Users/demo/.agentsflow/accounts/second-d4e5f6', accountUuid: 'uuid-2', subscriptionType: 'max', addedAt: new Date(Date.now() - 3 * 864e5).toISOString() },
      ],
      activeId: 'acct-1',
    }),
    addAccount: async () => ({ ok: false as const, error: 'Signing in needs the desktop app.' }),
    probeAccount: async () => ({ status: 'pending' as const }),
    cancelAddAccount: async () => {},
    removeAccount: async () => {},
    switchAccount: async () => ({ ok: false as const, error: 'Switching needs the desktop app.' }),
    repairAccounts: async () => ({ accounts: [], activeId: null, authIssue: null }),
    getAccountUsage: async (id: string) => ({
      ok: true as const,
      snapshot: {
        fetchedAt: new Date().toISOString(),
        plan: 'Max (20x)',
        meters: [
          {
            key: 'session',
            label: 'Current session',
            group: 'session' as const,
            percent: id === 'acct-1' ? 93 : 12,
            severity: (id === 'acct-1' ? 'danger' : 'normal') as 'danger' | 'normal',
            resetsAt: new Date(Date.now() + 11 * 60_000).toISOString(),
            isActive: true,
          },
        ],
      },
    }),
    onAccountsUpdated: () => () => undefined,
    getRotationPolicy: async () => ({
      policy: { enabled: true, threshold: 95, resumeOnLimit: true },
      status: { lastEvent: null, lastEventAt: null, disabledReason: null },
    }),
    setRotationPolicy: async (policy) => ({
      policy,
      status: { lastEvent: null, lastEventAt: null, disabledReason: null },
    }),
    onRotationStatus: () => () => undefined,

    listConversations: async () => state.conversations,
    spawnAgent: async (req: SpawnRequest) => {
      const dir = state.directories.find((d) => d.id === req.directoryId);
      if (!dir) throw new Error('directory not found');
      const id = uuid();
      const sessionId = uuid() + '-' + uuid();
      const conv: Conversation = {
        id,
        sessionId,
        daemonShort: sessionId.slice(0, 8),
        sessionName: `agentsflow:${id}`,
        directoryId: dir.id,
        directoryPath: dir.path,
        displayName: dir.displayName,
        title: req.prompt.slice(0, 80),
        description: 'starting…',
        pinned: true,
        attachments: req.attachments ?? [],
        state: 'starting',
        status: 'starting',
        intent: req.prompt,
        createdAt: new Date().toISOString(),
        lastPrompt: req.prompt,
      };
      state.conversations = [conv, ...state.conversations];
      insertRefAtEndOfFirstSection(state, { kind: 'conversation', id: conv.id });
      save(state);
      fire(state);
      fireOrder(state);

      setTimeout(() => {
        state.conversations = state.conversations.map((c) =>
          c.id === id
            ? { ...c, state: 'working', status: 'working', description: 'analyzing the task…' }
            : c,
        );
        save(state);
        fire(state);
      }, 800);
      setTimeout(() => {
        const finalText = `mock result for: ${req.prompt.slice(0, 40)}`;
        state.conversations = state.conversations.map((c) =>
          c.id === id
            ? { ...c, state: 'done', status: 'completed', description: finalText }
            : c,
        );
        save(state);
        fire(state);
      }, 2500);

      return { conversationId: id, sessionId, daemonShort: conv.daemonShort };
    },
    forkConversation: async (conversationId: string) => {
      const src = state.conversations.find((c) => c.id === conversationId);
      if (!src) throw new Error('conversation not found');
      const id = uuid();
      const fork: Conversation = {
        ...src,
        id,
        sessionId: uuid() + '-' + uuid(),
        daemonShort: '',
        title: forkTitle(src.title || src.description),
        description: 'forked copy — open the chat to continue',
        pinned: true,
        state: 'idle',
        status: 'idle',
        createdAt: new Date().toISOString(),
        forkFromSessionId: src.sessionId,
      };
      state.conversations = [fork, ...state.conversations];
      insertRefAfter(state, { kind: 'conversation', id }, { kind: 'conversation', id: src.id });
      save(state);
      fire(state);
      fireOrder(state);
      return { conversationId: id };
    },
    updateConversationTitle: async (id, title) => {
      state.conversations = state.conversations.map((c) => (c.id === id ? { ...c, title } : c));
      save(state);
      fire(state);
    },
    setConversationPinned: async (id, pinned) => {
      const prev = state.conversations.find((c) => c.id === id);
      state.conversations = state.conversations.map((c) => (c.id === id ? { ...c, pinned } : c));
      if (prev && prev.pinned !== pinned) {
        if (pinned) prependRef(state, { kind: 'conversation', id });
        else dropRef(state, { kind: 'conversation', id });
      }
      save(state);
      fire(state);
      fireOrder(state);
    },
    removeDirectoryWithHistory: async (id) => {
      const targets = state.conversations.filter((c) => c.directoryId === id);
      state.conversations = state.conversations.filter((c) => c.directoryId !== id);
      state.directories = state.directories.filter((d) => d.id !== id);
      for (const t of targets) dropRef(state, { kind: 'conversation', id: t.id });
      save(state);
      fire(state);
      fireOrder(state);
      return { removedConversations: targets.length };
    },
    stopAgent: async (id) => {
      state.conversations = state.conversations.map((c) => (c.id === id ? { ...c, state: 'stopped', status: 'stopped' } : c));
      save(state);
      fire(state);
    },
    removeAgent: async (id) => {
      state.conversations = state.conversations.filter((c) => c.id !== id);
      dropRef(state, { kind: 'conversation', id });
      save(state);
      fire(state);
      fireOrder(state);
    },

    listDividers: async () => state.dividers,
    addDivider: async (afterRef) => {
      const divider: PinnedDivider = {
        id: uuid(),
        title: '',
        createdAt: new Date().toISOString(),
      };
      state.dividers = [divider, ...state.dividers];
      const ref: PinnedItemRef = { kind: 'divider', id: divider.id };
      dropRef(state, ref);
      if (!afterRef) {
        state.pinnedOrder = [ref, ...state.pinnedOrder];
      } else {
        const idx = state.pinnedOrder.findIndex((r) => r.kind === afterRef.kind && r.id === afterRef.id);
        if (idx < 0) {
          state.pinnedOrder = [ref, ...state.pinnedOrder];
        } else {
          state.pinnedOrder = [
            ...state.pinnedOrder.slice(0, idx),
            ref,
            ...state.pinnedOrder.slice(idx),
          ];
        }
      }
      save(state);
      fireDividers(state);
      fireOrder(state);
      return divider;
    },
    renameDivider: async (id, title) => {
      state.dividers = state.dividers.map((d) => (d.id === id ? { ...d, title } : d));
      save(state);
      fireDividers(state);
    },
    removeDivider: async (id) => {
      state.dividers = state.dividers.filter((d) => d.id !== id);
      dropRef(state, { kind: 'divider', id });
      save(state);
      fireDividers(state);
      fireOrder(state);
    },
    listTodos: async () => state.todos,
    addTodo: async (directoryId, afterRef) => {
      const todo: PinnedTodo = {
        id: uuid(),
        directoryId,
        text: '',
        createdAt: new Date().toISOString(),
        done: false,
      };
      state.todos = [todo, ...state.todos];
      const ref: PinnedItemRef = { kind: 'todo', id: todo.id };
      if (afterRef) insertRefAfter(state, ref, afterRef);
      else insertRefAtEndOfFirstSection(state, ref);
      save(state);
      fireTodos(state);
      fireOrder(state);
      return todo;
    },
    updateTodoText: async (id, text) => {
      state.todos = state.todos.map((t) => (t.id === id ? { ...t, text } : t));
      save(state);
      fireTodos(state);
    },
    setTodoDone: async (id, done) => {
      const prev = state.todos.find((t) => t.id === id);
      state.todos = state.todos.map((t) =>
        t.id === id ? { ...t, done, doneAt: done ? new Date().toISOString() : undefined } : t,
      );
      if (prev && prev.done !== done) {
        if (done) dropRef(state, { kind: 'todo', id });
        else prependRef(state, { kind: 'todo', id });
      }
      save(state);
      fireTodos(state);
      fireOrder(state);
    },
    removeTodo: async (id) => {
      state.todos = state.todos.filter((t) => t.id !== id);
      dropRef(state, { kind: 'todo', id });
      save(state);
      fireTodos(state);
      fireOrder(state);
    },
    onTodosUpdated: (cb) => { listeners.todos.add(cb); return () => listeners.todos.delete(cb); },

    listPinnedOrder: async () => state.pinnedOrder,
    reorderPinned: async (orderedRefs) => {
      const convIds = new Set(state.conversations.filter((c) => c.pinned).map((c) => c.id));
      const divIds = new Set(state.dividers.map((d) => d.id));
      const todoIds = new Set(state.todos.filter((t) => !t.done).map((t) => t.id));
      const seen = new Set<string>();
      const next: PinnedItemRef[] = [];
      for (const r of orderedRefs) {
        if (!r || typeof r.id !== 'string') continue;
        const key = `${r.kind}:${r.id}`;
        if (seen.has(key)) continue;
        if (r.kind === 'conversation' && convIds.has(r.id)) { next.push(r); seen.add(key); }
        else if (r.kind === 'divider' && divIds.has(r.id)) { next.push(r); seen.add(key); }
        else if (r.kind === 'todo' && todoIds.has(r.id)) { next.push(r); seen.add(key); }
      }
      state.pinnedOrder = next;
      save(state);
      fireOrder(state);
    },
    onDividersUpdated: (cb) => { listeners.dividers.add(cb); return () => listeners.dividers.delete(cb); },
    onPinnedOrderUpdated: (cb) => { listeners.pinnedOrder.add(cb); return () => listeners.pinnedOrder.delete(cb); },

    attachTerminal: async (conversationId) => {
      const channelId = uuid();
      setTimeout(() => {
        listeners.termData.forEach((cb) =>
          cb(
            channelId,
            `\r\n\x1b[33m[mock terminal — Electron-only Claude attach would run here]\x1b[0m\r\n` +
              `\x1b[2mAttached to conversation ${conversationId.slice(0, 8)}…\x1b[0m\r\n\r\n$ `,
          ),
        );
      }, 100);
      return { channelId, replay: '' };
    },
    attachShellTerminal: async (shellId, cwd) => {
      const channelId = uuid();
      const replay = `\r\n\x1b[33m[mock shell — Electron-only PTY would run here]\x1b[0m\r\n`
        + `\x1b[2mshell ${shellId.slice(0, 8)} · cwd: ${cwd}\x1b[0m\r\n\r\n$ `;
      return { channelId, replay };
    },
    killShell: async () => {},
    writeTerminal: async (channelId, data) => {
      listeners.termData.forEach((cb) => cb(channelId, data));
    },
    resizeTerminal: async () => {},
    detachTerminal: async (channelId) => {
      listeners.termExit.forEach((cb) => cb(channelId));
    },
    onTerminalData: (cb) => { listeners.termData.add(cb); return () => listeners.termData.delete(cb); },
    onTerminalExit: (cb) => { listeners.termExit.add(cb); return () => listeners.termExit.delete(cb); },
    onConversationsUpdated: (cb) => { listeners.convs.add(cb); return () => listeners.convs.delete(cb); },
    // The mock always broadcasts whole lists, so there is nothing to patch —
    // subscribing is a no-op rather than a missing method (the renderer treats
    // absence as "old preload" and would keep working either way).
    onConversationsPatched: () => () => undefined,
    // No real bridge in the browser mock — nothing ever asks to open a file.
    onOpenFile: () => () => undefined,

    gitStatus: async (): Promise<GitStatusResult> => ({
      isRepo: true,
      branch: 'feat/demo-branch',
      entries: [
        { path: 'src/components/Button.tsx', status: 'modified', staged: false, unstaged: true },
        { path: 'src/components/Card.tsx', status: 'modified', staged: true, unstaged: false },
        { path: 'src/lib/api.ts', status: 'modified', staged: false, unstaged: true },
        { path: 'src/lib/new-helper.ts', status: 'added', staged: true, unstaged: false },
        { path: 'src/pages/about.tsx', status: 'added', staged: true, unstaged: false },
        { path: 'src/styles/legacy.scss', status: 'deleted', staged: true, unstaged: false },
        { path: 'README.md', status: 'untracked', staged: false, unstaged: true },
        { path: 'scratch/notes.txt', status: 'untracked', staged: false, unstaged: true },
        { path: 'scratch/draft.md', status: 'untracked', staged: false, unstaged: true },
      ],
    }),
    // The demo can't recompute publish state, but it must at least echo the
    // reference back — the panel's chip renders `refBranch` from the data (so a
    // pinned-but-deleted branch visibly falls back), and a mock that always
    // said 'master' would look like the picker had failed.
    listWorktrees: async (_dirPath: string, refBranch?: string): Promise<WorktreeInfo[]> =>
      mockWorktrees.map((w) => ({ ...w, refBranch: refBranch ?? 'master' })),
    listBranches: async () => ({
      local: ['master', 'v3.1.0', 'worktree-dpd-complaint', 'worktree-nutrable-chat-script'],
      remote: ['origin/master', 'origin/v3.1.0'],
    }),
    removeWorktree: async (_repoDir: string, worktreePath: string) => {
      const before = mockWorktrees.length;
      mockWorktrees = mockWorktrees.filter((w) => w.path !== worktreePath || w.isMain);
      return mockWorktrees.length < before
        ? { ok: true as const }
        : { ok: false as const, error: 'mock — cannot remove that worktree' };
    },
    saveImageToDir: async (targetDir: string, _data: string, mime: string) => {
      const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      return { savedPath: `${targetDir}/pasted-${Date.now()}.${ext}` };
    },
    saveImageFromPaste: async (_data: string, mime: string) => {
      const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const now = new Date();
      const slug = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      return { savedPath: `/mock/pasted-images/${slug}/${Date.now()}.${ext}` };
    },

    readTextFile: async (filePath: string) => {
      const lower = filePath.toLowerCase();
      const isMd = lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.markdown');
      const content = isMd
        ? `# ${filePath.split('/').pop()}\n\n> Mock markdown — preload not connected in this browser session.\n\n## What this is\n\nA short demo of the **AgentsFlow** markdown editor. It supports:\n\n- *Italic* and **bold** text\n- Inline \`code\` and fenced blocks\n- Tables and task lists (GFM)\n- Links like [Claude Code](https://claude.com/code)\n\n## A code block\n\n\`\`\`ts\nimport { spawn } from 'child_process';\n\nasync function dispatch(prompt: string) {\n  const child = spawn('claude', ['--bg', '--permission-mode', 'bypassPermissions', prompt]);\n  return new Promise((resolve) => child.on('close', resolve));\n}\n\`\`\`\n\n## Tasks\n\n- [x] Render headings and lists\n- [x] Highlight code blocks\n- [ ] Live two-way sync (someday)\n\n## An image (resized to 300px)\n\n![screenshot](images/pasted-1700000000000-mock01.png#w=300)\n\n## A table\n\n| Mode    | What you see                      |\n| ------- | --------------------------------- |\n| Edit    | Just the source                   |\n| Preview | Just the rendered view            |\n| Split   | Both side-by-side                 |\n\n> Tip: press \`⌘S\` to save.\n`
        : `// ${filePath}\n// (mock content — preload not connected in this browser session)\n\nexport function hello() {\n  return 'hello from ${filePath.split('/').pop()}';\n}\n`;
      return { content, size: content.length, truncated: false, binary: false };
    },
    writeTextFile: async (_fp: string, _content: string) => ({ ok: true as const }),
    createFile: async (_filePath: string) => ({ ok: true as const }),
    renamePath: async (_oldPath: string, _newPath: string) => ({ ok: true as const }),
    removePath: async (_target: string) => ({ ok: true as const }),
    copyImageToClipboard: async (_filePath: string) => ({ ok: true as const }),
    revealInFinder: async (_target: string) => ({ ok: true as const }),
    probePath: async (_baseDir: string | null, _token: string) => null,
    startFileDrag: async (_filePath: string) => undefined,
    readBinaryFile: async (filePath: string) => {
      // A 1x1 transparent PNG to prove the wiring in browser mode.
      const blank = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Vx5y3wAAAAASUVORK5CYII=';
      return { dataUrl: `data:image/png;base64,${blank}`, mime: 'image/png', size: blank.length, truncated: false, error: `mock — not actually reading ${filePath}` };
    },

    listFiles: async (): Promise<FileEntry[]> => [
      { path: 'package.json', isIgnored: false },
      { path: 'tsconfig.json', isIgnored: false },
      { path: 'README.md', isIgnored: false },
      { path: 'src/index.tsx', isIgnored: false },
      { path: 'src/components/Button.tsx', isIgnored: false },
      { path: 'src/components/Card.tsx', isIgnored: false },
      { path: 'src/lib/api.ts', isIgnored: false },
      { path: 'src/lib/new-helper.ts', isIgnored: false },
      { path: 'src/pages/about.tsx', isIgnored: false },
      { path: 'src/styles/main.scss', isIgnored: false },
      { path: 'node_modules/react/package.json', isIgnored: true },
      { path: '.next/cache/data.bin', isIgnored: true },
    ],

    notesRoot: async (dirPath: string) => ({ root: `${dirPath}/.peersflow-notes-mock` }),
    globalNotesRoot: async () => ({ root: `/tmp/.peersflow-global-notes-mock` }),
    listNotes: async (): Promise<FileEntry[]> => [
      { path: 'scratch.md', isIgnored: false },
      { path: 'ideas/roadmap.md', isIgnored: false },
    ],

    searchFiles: async (_dir: string, query: string, opts?: SearchOptions): Promise<SearchResult> => {
      const empty: SearchResult = { files: [], totalMatches: 0, filesScanned: 0, truncated: false };
      if (!query) return empty;
      let re: RegExp;
      try {
        const flags = opts?.caseSensitive ? 'g' : 'gi';
        const pattern = opts?.isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(pattern, flags);
      } catch (err) {
        return { ...empty, error: `Invalid pattern: ${(err as Error).message}` };
      }
      // Reuse the mock file list + mock file content so the demo is interactive.
      const entries: FileEntry[] = [
        { path: 'package.json', isIgnored: false },
        { path: 'README.md', isIgnored: false },
        { path: 'src/index.tsx', isIgnored: false },
        { path: 'src/components/Button.tsx', isIgnored: false },
        { path: 'src/lib/api.ts', isIgnored: false },
      ];
      const out: SearchResult = { files: [], totalMatches: 0, filesScanned: 0, truncated: false };
      for (const e of entries) {
        const content = `// ${e.path}\n// (mock content)\nexport function hello() {\n  return 'hello from ${e.path}';\n}\n`;
        const lines = content.split('\n');
        const matches: SearchMatchLine[] = [];
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          const ranges: [number, number][] = [];
          let m: RegExpExecArray | null;
          while ((m = re.exec(lines[i])) !== null) {
            ranges.push([m.index, m.index + m[0].length]);
            if (m[0].length === 0) re.lastIndex++;
          }
          if (ranges.length) { matches.push({ line: i + 1, text: lines[i], ranges }); out.totalMatches++; }
        }
        out.filesScanned++;
        if (matches.length) out.files.push({ path: e.path, matches });
      }
      return out;
    },

    // File-watcher push API: no-op in mock mode (no real filesystem to watch
    // when running outside Electron). The slow heartbeat in FileTreeSidebar
    // still triggers refreshes so the demo data appears.
    watchFiles: async () => undefined,
    unwatchFiles: async () => undefined,
    onFilesUpdated: () => () => undefined,
  };
}
