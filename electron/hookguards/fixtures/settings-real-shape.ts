// A settings.json shaped like the user's real one on 2026-10-27 (six PreToolUse
// groups: four hand-made guards around crew.py and worktree-hop-warn.sh), plus
// unknown keys the installer must carry through verbatim. Returns a fresh copy.

export function realShapeSettings(): Record<string, unknown> {
  return {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|mcp__claude-in-chrome__.*', hooks: [{ type: 'command', command: '~/.claude/hooks/block-cookie-clearing.sh', timeout: 10, statusMessage: 'Checking for cookie-clearing' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/block-second-chrome.sh', timeout: 10, statusMessage: 'Checking for a second Chrome launch' }] },
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/block-mass-kill.py', timeout: 10, statusMessage: 'Checking for a mass kill' }] },
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/crew.py hook', timeout: 15 }], note: 'keep me' },
        { matcher: 'EnterWorktree', hooks: [{ type: 'command', command: '~/.claude/hooks/worktree-hop-warn.sh', timeout: 5, extra: { a: 1 } }] },
        { matcher: 'Agent|Task', hooks: [{ type: 'command', command: '~/.claude/hooks/mem-admission.sh', timeout: 60, statusMessage: 'Checking memory room for a sub-agent' }] },
      ],
      Notification: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/notify.sh' }] }],
    },
  };
}
