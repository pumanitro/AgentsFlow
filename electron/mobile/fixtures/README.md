# Mobile gateway test fixtures

All content here is SYNTHETIC. No real transcript, job file or tailnet was copied. The shapes match what Claude Code 2.1.x, the `claude` job-state files and `tailscale status --json` / `tailscale serve status --json` really write.

## transcript-sample.jsonl (21 lines, no trailing newline)
1. `last-prompt` bookkeeping entry: must be skipped.
2. `attachment` (SessionStart hook output): must be skipped.
3. User prompt with STRING content: `user.text`.
4. Injected skill text (`isMeta: true`, `turnCompanion: true`): must be hidden.
5. `api-request`: must be skipped.
6. `api-request-blob` carrying a system-reminder: must be skipped.
7. Assistant `thinking` part: `thinking`.
8. Assistant `text` part: `assistant.text`.
9. Assistant `tool_use` Bash with `description`: `tool_use`, summary like "Bash: npm test".
10. User `tool_result` with STRING content: `tool_result`.
11. Assistant `tool_use` Read with `file_path`: `tool_use`.
12. User `tool_result` with ARRAY content over 3000 chars: `tool_result` with `truncated: true`.
13. Sidechain assistant text: `subagent` / `sidechain: true`.
14. Sidechain user tool_result: sidechain handling.
15. `system` / `turn_duration`: must be skipped.
16. `queue-operation` with a task-notification: must be skipped.
17. `file-history-snapshot`: must be skipped.
18. User text ARRAY, not meta (a typed answer): `user.text`.
19. Final assistant text with `<spoken>` and `<needs>` tags: outcome extraction.
20. `cost-state`: must be skipped.
21. First 60 chars of line 8 with no newline: a half-written entry the readers must ignore (and not count in `end`).

## Job state
- `state-working.json`: working, active tempo, two in-flight tasks.
- `state-blocked.json`: blocked tempo with `needs`, `suggestedReply` and one question with two options.
- `state-done.json`: done with an output result.
- `timeline.jsonl`: 25 lines, increasing timestamps; the last three details are distinct ("Running the test suite", "Writing the summary report", "Waiting for review") for tail-20 tests.

## Tailscale
- `tailscale-status.json`: running backend, DNS name `home-hub.tail1234.ts.net.`, owner login `someone@gmail.com`.
- `tailscale-serve-status.json`: HTTPS on 8443 proxying `/` to `http://127.0.0.1:47820`.
