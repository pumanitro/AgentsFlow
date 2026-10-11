/**
 * Execution defaults for every Codex session launched by Peers Flow: full
 * filesystem/network access and no interactive command approvals, matching
 * Claude's bypassPermissions mode. These are app-local launch settings; they
 * do not change Codex config files or OS/browser/Computer Use consent.
 *
 * Codex 0.154.0's generated thread/start, thread/fork and thread/resume schemas
 * accept `approvalPolicy` and `sandbox` (not the SDK's option names). The daemon
 * uses the same values through `-c approval_policy=…` and `-c sandbox_mode=…`.
 */
export const CODEX_DEFAULT_APPROVAL_POLICY = 'never';
export const CODEX_DEFAULT_SANDBOX = 'danger-full-access';
