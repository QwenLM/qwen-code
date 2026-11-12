# Hook execution records E2E plan

[English](hook-execution-records-e2e.md) | [简体中文](hook-execution-records-e2e.zh-CN.md)

## Environment and baseline

Use macOS with Node.js >=22, an isolated temporary workspace, QWEN_HOME, QWEN_RUNTIME_DIR, trusted-folders file and local OpenAI-compatible mock server. Disable automatic updates, background memory and scheduled jobs in the temporary configuration. Do not use personal settings, credentials or transcripts. Always terminate the daemon and mock server after a group.

Check the baseline with `qwen --version` and `qwen serve --help`, then start `qwen serve --no-web --workspace <temporary-workspace> --port <free-port>`. Repeat against `node dist/cli.js serve` after `npm run build && npm run typecheck && npm run bundle`. The baseline installed binary was 0.22.0: command hooks execute, but Hook lifecycle records and the Hook query route are absent. This binary also predates turn-index; do not interpret that difference as a current-main regression.

Configure real command hooks that read JSON from stdin, append one line containing only event/session/prompt identities to an isolated probe file, and emit controlled JSON or exit codes. The local model returns deterministic streaming responses; for retry/continue it first returns a completed HTTP 400 error. Keep daemon admission IDs separate from the canonical user-record promptId.

## Acceptance groups

| Group                    | Actions                                                                                                                                                             | Expected result                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Basic transport          | Create a session, subscribe to SSE, submit one prompt with UserPromptSubmit, MessageDisplay and Stop hooks; inspect JSONL and the Hook endpoint.                    | Three actual executions, six lifecycle records, three unique UUIDs. Live and persisted identities agree.                                                                                        |
| Outcomes                 | Run success, exit-2/policy block, exit-1 error, a one-second timeout, cancellation and an async hook.                                                               | Outcomes remain separate; successful async handoff is dispatched, rejected handoff is error. Dispatch duration is not execution duration or success.                                            |
| Counts                   | Run parallel hooks and overlapping MessageDisplay batches; cancel a three-hook sequential batch during its first execution; start with an already cancelled signal. | Count actual starts only. No UUID collision or skipped terminal; unstarted hooks contribute nothing.                                                                                            |
| Turn identity            | Trigger retry:true, ordinary continue and a Stop hook that blocks once.                                                                                             | New admission IDs preserve the original history promptId; UserPromptSubmit is not repeated by ordinary continue.                                                                                |
| Ownership                | Overlap sessions/workspaces, change the active session while a hook runs, and execute a child-agent hook.                                                           | Start/end keep their original owner; child/unowned/session-lifecycle hooks do not enter main-turn totals.                                                                                       |
| Recovery                 | Reconnect, restart the daemon, read a cold session, load it, and replay duplicate, out-of-order, end-only and start-only events.                                    | Unique counts and terminal results agree; start-only becomes unknown/partial; cold query does not start a session.                                                                              |
| Branch changes           | Fork, delete a turn while telemetry arrives, and rewind a custom /advisor command whose UserPromptExpansion precedes the user record; repeat after restart/load.    | Fork identities remap; deleted/rewound records and late ends cannot reappear.                                                                                                                   |
| Pagination               | Persist 1,001 executions, read 50, append another execution, then follow nextStart with the original snapshot.                                                      | Every old-snapshot page reports the same 1,001-execution summary. A fresh snapshot sees the append. Cross-workspace snapshots and start without snapshot are rejected.                          |
| Safety and compatibility | Put a sentinel in command/environment/error/block reason; feed metadata to the existing chat normalizer and textual replay.                                         | Sentinel is absent from new records/network fields; no blank chat rows or diagnostic text in model history/export. Old turns are unrecorded and managed history unsupported, with null summary. |

Use both `GET /session/:id/turns/:promptId/hooks` and `GET /workspaces/:workspace/session/:id/turns/:promptId/hooks`. URL-encode promptId. Follow `nextStart` with the returned `snapshot`; compare whole-turn summaries across pages.

## Deterministic regression commands

Run each command from its named package directory, after building workspace dependencies:

- Core: `npx vitest run src/telemetry/hook-lifecycle-contract.test.ts src/telemetry/hook-lifecycle.test.ts src/hooks/hook-execution-context.test.ts src/hooks/hookPlanner.test.ts src/hooks/hookEventHandler.test.ts src/services/session-hook-history.test.ts src/services/sessionService.test.ts src/services/chat-recording-message-deletion.test.ts src/services/chatRecordingService.test.ts src/services/session-turn-state.test.ts`.
- ACP bridge: `npx vitest run src/bridge.test.ts src/compactionEngine.test.ts src/execution-lifecycle.test.ts`.
- CLI: `npx vitest run src/acp-integration/session/Session.test.ts src/serve/multi-workspace-sessions.test.ts -t 'lifecycle subscriptions|reads hook pages'`.
- SDK: `npx vitest run test/hook-lifecycle.test.ts test/hook-history-api.test.ts test/unit/daemon-public-surface.test.ts`, then `npm run typecheck:public-surface`.

Do not run two coverage-enabled Vitest processes in the same package or clean dependency outputs while tests consume them. Check the SDK browser entry bundles successfully with platform=browser and that published declarations have no Core imports. The PR's separate E2E report records actual command-hook observations and distinguishes them from unit/integration tests.
