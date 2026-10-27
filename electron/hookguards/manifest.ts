// What Peers Flow ships under <repo>/guards and installs into ~/.claude/hooks/peersflow.
// Paths are install-dir-relative (the two sides share one layout). Never imports `electron`.
import type { HookGuardId } from '../../shared/hookguards';

export const INSTALL_DIR_TILDE = '~/.claude/hooks/peersflow';   // written literally into settings.json commands (portable)
export const INSTALL_DIR_MARK = '/.claude/hooks/peersflow/';     // a hook command containing this is app-owned
export const SHIM_BIN_REL = 'bin';

export interface HookGuardHook { matcher: string; command: string; timeout: number; statusMessage: string }
export interface HookGuardSpec {
  id: HookGuardId; title: string; what: string;
  files: string[];                          // files[0] = entry script; all copied; 0755 (.md → 0644)
  selftest: string | null;                  // `bash <installDir>/<selftest>` exit 0 = pass
  syntaxCheck: 'bash' | 'python' | null;    // used only when selftest is null
  hook: HookGuardHook | null;               // null = not a settings.json hook (the shims)
  supersedes: string[];                     // hand-made basenames under ~/.claude/hooks to unregister + move aside once THIS guard passes
}
export const SHARED_FILES: readonly string[] = ['lib/killcheck.py', 'README.md'];
export const HOOK_GUARDS: readonly HookGuardSpec[] = [
  { id: 'block-cookie-clearing', title: 'Cookie guard', what: 'Refuses any command that would clear browser cookies or site data — the automation browser is the daily-driver browser.',
    files: ['block-cookie-clearing.sh', 'block-cookie-clearing.selftest.sh'], selftest: 'block-cookie-clearing.selftest.sh', syntaxCheck: null,
    hook: { matcher: 'Bash|mcp__claude-in-chrome__.*', command: `${INSTALL_DIR_TILDE}/block-cookie-clearing.sh`, timeout: 10, statusMessage: 'Checking for cookie-clearing' },
    supersedes: ['block-cookie-clearing.sh'] },
  { id: 'block-second-chrome', title: 'Second-Chrome guard', what: 'Refuses starting a second copy of Google Chrome, which would swallow every link the user clicks.',
    files: ['block-second-chrome.sh', 'block-second-chrome.selftest.sh'], selftest: 'block-second-chrome.selftest.sh', syntaxCheck: null,
    hook: { matcher: 'Bash', command: `${INSTALL_DIR_TILDE}/block-second-chrome.sh`, timeout: 10, statusMessage: 'Checking for a second Chrome launch' },
    supersedes: ['block-second-chrome.sh'] },
  { id: 'block-mass-kill', title: 'Mass-kill guard', what: 'Refuses a pkill or kill that would stop far more programs than intended: options after the pattern, kill -1, or a pattern matching more than 15 running processes.',
    files: ['block-mass-kill.py', 'block-mass-kill.selftest.sh'], selftest: 'block-mass-kill.selftest.sh', syntaxCheck: null,
    hook: { matcher: 'Bash', command: `python3 ${INSTALL_DIR_TILDE}/block-mass-kill.py`, timeout: 10, statusMessage: 'Checking for a mass kill' },
    supersedes: ['block-mass-kill.py', 'block-mass-kill.selftest.sh'] },
  { id: 'mem-admission', title: 'Memory admission', what: 'Holds a new sub-agent back while this Mac has no memory room for it, and tells the Keeper so the chat is resumed later.',
    files: ['mem-admission.sh', 'mem-admission.selftest.sh'], selftest: 'mem-admission.selftest.sh', syntaxCheck: null,
    hook: { matcher: 'Agent|Task', command: `${INSTALL_DIR_TILDE}/mem-admission.sh`, timeout: 60, statusMessage: 'Checking memory room for a sub-agent' },
    supersedes: ['mem-admission.sh', 'mem-admission.selftest.sh'] },
  { id: 'kill-shims', title: 'Kill shims', what: 'A pkill and kill on every chat\'s PATH that refuse the same dangerous calls before they reach the system, even from scripts.',
    files: ['bin/pkill', 'bin/kill', 'bin/shims.selftest.sh'], selftest: 'bin/shims.selftest.sh', syntaxCheck: null,
    hook: null, supersedes: [] },
];
