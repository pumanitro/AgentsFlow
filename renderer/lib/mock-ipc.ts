import type { AgentsFlowApi, Conversation, TrackedDirectory, SpawnRequest, GitStatusResult, FileEntry } from '../../shared/types';

const STORE_KEY = 'agentsflow:mock:v2';

interface MockShape {
  directories: TrackedDirectory[];
  conversations: Conversation[];
}

function uuid() {
  return Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

function load(): MockShape {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    directories: [
      { id: uuid(), path: '/Users/demo/Projects/abi', displayName: 'abi', addedAt: new Date().toISOString() },
      { id: uuid(), path: '/Users/demo/Desktop/LISA', displayName: 'LISA', addedAt: new Date().toISOString() },
      { id: uuid(), path: '/Users/demo/IdeaProjects/nutrable', displayName: 'nutrable', addedAt: new Date().toISOString() },
    ],
    conversations: [],
  };
}

function save(state: MockShape) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

const listeners = {
  convs: new Set<(c: Conversation[]) => void>(),
  termData: new Set<(id: string, data: string) => void>(),
  termExit: new Set<(id: string) => void>(),
};

function fire(state: MockShape) {
  listeners.convs.forEach((cb) => cb(state.conversations));
}

export function createMockApi(): AgentsFlowApi {
  let state = load();

  return {
    listDirectories: async () => state.directories,
    addDirectory: async () => {
      const path = window.prompt('[mock] Enter directory absolute path:', '/Users/demo/Projects/new-project');
      if (!path) return null;
      const parts = path.split('/').filter(Boolean);
      const displayName = parts[parts.length - 1] || path;
      const d: TrackedDirectory = { id: uuid(), path, displayName, addedAt: new Date().toISOString() };
      state.directories = [...state.directories, d];
      save(state);
      return d;
    },
    removeDirectory: async (id) => {
      state.directories = state.directories.filter((d) => d.id !== id);
      save(state);
    },

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
      save(state);
      fire(state);

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
      state.conversations = state.conversations.map((c) => (c.id === id ? { ...c, pinned } : c));
      save(state);
      fire(state);
    },
    removeDirectoryWithHistory: async (id) => {
      const targets = state.conversations.filter((c) => c.directoryId === id);
      state.conversations = state.conversations.filter((c) => c.directoryId !== id);
      state.directories = state.directories.filter((d) => d.id !== id);
      save(state);
      fire(state);
      return { removedConversations: targets.length };
    },
    stopAgent: async (id) => {
      state.conversations = state.conversations.map((c) => (c.id === id ? { ...c, state: 'stopped', status: 'stopped' } : c));
      save(state);
      fire(state);
    },
    removeAgent: async (id) => {
      state.conversations = state.conversations.filter((c) => c.id !== id);
      save(state);
      fire(state);
    },

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
      return { channelId };
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
    saveImageFromPaste: async (_dir: string | null, _data: string, mime: string) => {
      const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      return { savedPath: `/mock/agentsflow/images/${Date.now()}.${ext}` };
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
    renamePath: async (_oldPath: string, _newPath: string) => ({ ok: true as const }),
    removePath: async (_target: string) => ({ ok: true as const }),
    copyImageToClipboard: async (_filePath: string) => ({ ok: true as const }),
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
  };
}
