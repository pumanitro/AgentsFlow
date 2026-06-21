import type { AgentsFlowApi, Conversation, PinnedDivider, PinnedItemRef, TrackedDirectory, SpawnRequest, GitStatusResult, FileEntry, SearchOptions, SearchResult, SearchMatchLine } from '../../shared/types';

const STORE_KEY = 'agentsflow:mock:v3';

interface MockShape {
  directories: TrackedDirectory[];
  conversations: Conversation[];
  dividers: PinnedDivider[];
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
    pinnedOrder: [],
  };
}

function save(state: MockShape) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

const listeners = {
  convs: new Set<(c: Conversation[]) => void>(),
  dividers: new Set<(d: PinnedDivider[]) => void>(),
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
    }),

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
    listPinnedOrder: async () => state.pinnedOrder,
    reorderPinned: async (orderedRefs) => {
      const convIds = new Set(state.conversations.filter((c) => c.pinned).map((c) => c.id));
      const divIds = new Set(state.dividers.map((d) => d.id));
      const seen = new Set<string>();
      const next: PinnedItemRef[] = [];
      for (const r of orderedRefs) {
        if (!r || typeof r.id !== 'string') continue;
        const key = `${r.kind}:${r.id}`;
        if (seen.has(key)) continue;
        if (r.kind === 'conversation' && convIds.has(r.id)) { next.push(r); seen.add(key); }
        else if (r.kind === 'divider' && divIds.has(r.id)) { next.push(r); seen.add(key); }
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
        ? `# ${filePath.split('/').pop()}\n\n> Mock markdown — preload not connected in this browser session.\n\n## What this is\n\nA short demo of the **AgentsFlow** markdown editor. It supports:\n\n- *Italic* and **bold** text\n- Inline \`code\` and fenced blocks\n- Tables and task lists (GFM)\n- Links like [Claude Code](https://claude.com/code)\n\n## A code block\n\n\`\`\`ts\nimport { spawn } from 'child_process';\n\nasync function dispatch(prompt: string) {\n  const child = spawn('claude', ['--bg', '--permission-mode', 'bypassPermissions', prompt]);\n  return new Promise((resolve) => child.on('close', resolve));\n}\n\`\`\`\n\n## Tasks\n\n- [x] Render headings and lists\n- [x] Highlight code blocks\n- [ ] Live two-way sync (someday)\n\n## A table\n\n| Mode    | What you see                      |\n| ------- | --------------------------------- |\n| Edit    | Just the source                   |\n| Preview | Just the rendered view            |\n| Split   | Both side-by-side                 |\n\n> Tip: press \`⌘S\` to save.\n`
        : `// ${filePath}\n// (mock content — preload not connected in this browser session)\n\nexport function hello() {\n  return 'hello from ${filePath.split('/').pop()}';\n}\n`;
      return { content, size: content.length, truncated: false, binary: false };
    },
    writeTextFile: async (_fp: string, _content: string) => ({ ok: true as const }),
    createFile: async (_filePath: string) => ({ ok: true as const }),
    renamePath: async (_oldPath: string, _newPath: string) => ({ ok: true as const }),
    removePath: async (_target: string) => ({ ok: true as const }),
    copyImageToClipboard: async (_filePath: string) => ({ ok: true as const }),
    revealInFinder: async (_target: string) => ({ ok: true as const }),
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
