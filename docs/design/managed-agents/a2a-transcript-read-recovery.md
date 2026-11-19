# Recover A2A task polling after transcript read errors

[English](a2a-transcript-read-recovery.md) | [简体中文](a2a-transcript-read-recovery.zh-CN.md)

## Problem and current behavior

A completed session-agent run may already have a durable reply when `GetTask` encounters a transient transcript read error. `jsonl.read` currently turns the failed read into an empty result for `SessionService`. The A2A session port falls back to `fs.access(R_OK)` on the active path, which can succeed even when reading fails and never checks the archived transcript. `observeTask` can then persist `TASK_STATE_FAILED` for a completed run marked `recorded: true`. Future polls return the kept failure. This behavior remains on upstream main at `02dc72342b`; session-based A2A is gated by `experimental.agentCollaboration`.

The earlier PR proposed opt-in read-error propagation. Its reviews identified the missing JSON-RPC translation and archived-path regression coverage. A separate review raised malformed JSONL and failures already persisted by older versions. [Issue #13738](https://github.com/QwenLM/qwen-code/issues/13738), [PR #13797](https://github.com/QwenLM/qwen-code/pull/13797).

## Proposed behavior

1. Add an optional `throwOnNonEnoentError` option to `SessionService.loadSession` and `loadArchivedSession`. Thread it through the existing record read and reuse the `jsonl.read` option of the same name. Keep the existing incomplete-read callback and preserve normal reconstruction, workspace validation, and the archive size limit. Existing callers keep the default behavior.
2. Enable the option for both reads in the default A2A port and remove `fs.access`. If the active loader returns no data, try the archived transcript. A Node filesystem exception during either lookup becomes `A2ASessionError('unavailable')`. Use `isNodeError` and the filesystem error's `syscall` to distinguish these failures from ordinary exceptions and coded argument errors. Keep the original diagnostic in the error logged by the transport. An unreadable active file stops observation even when an archived copy exists, since the archived copy may be stale. Preserve the existing oversized-archive failure and unexpected internal errors. An active or archived read that starts with no file still follows the existing `ENOENT` behavior. An error from a subsequent filesystem operation, such as `stat` after a successful active read, is an observation failure.
3. In the A2A JSON-RPC error boundary, map `A2ASessionError('unavailable')` to the existing `-32012` envelope. The caller sees the existing generic message and server diagnostics retain the error. `SendMessage`, `GetTask`, `ListTasks`, and `CancelTask` share the boundary and can all observe a recorded reply. `ListTasks` returns an error without a partial list when an observed reply is unreadable. Observations of earlier entries may already have saved results. The existing listing path observes entries before filtering and pagination. `SendMessage` may already have posted a run when observation fails, so resend with the same `messageId` and payload to retrieve that run. `CancelTask` can fail before issuing a cancellation when the initial observation fails, or after issuing it if the observation for the receipt fails. Cancellation and receipt recovery are separate from this read fix. Task results are written only after a successful terminal observation.

| Observation                                                                                                                                          | Result                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Recorded reply is readable                                                                                                                           | Return the recorded state and reply, and keep a terminal result as today                                            |
| Neither lookup returns session data, including ordinary `ENOENT` on open or initial archive `stat`, or the loaded conversation has no matching reply | Apply the existing run-state fallback, including failure for a completed run with a missing reply                   |
| A filesystem exception escapes either loader, for example `EIO` during a read, `EMFILE` at open, or `ENOENT` at the active post-read `stat`          | Return `-32012` in JSON-RPC. The failing observation performs no write to the task result                           |
| The archived transcript exceeds 64 MiB                                                                                                               | Retain the existing oversized-transcript failure path. The failing observation performs no write to the task result |

## Compatibility and scope

A2A requests stay scoped to the selected, trusted workspace runtime. The existing grant and caller-to-task mapping authorize observations. The port keeps that runtime's `workspaceCwd` and `sessionRuntimeBaseDir`; no new fallback to a different workspace is introduced. The changes use the existing task state, schema, storage and retry rules. Previously kept failures cannot be separated reliably from genuine missing replies, so there is no migration. Successful filesystem reads continue to use tolerant JSONL parsing. A damaged reply line can still be skipped by the parser. Archive and restore are outside the scope of this fix. In particular, a restore that renames the archived file between the archived `stat` and open can produce `ENOENT` on both lookups and follow the existing missing-data path. A permission probe or a second read cannot establish the outcome of the original read.

The service's only two state-loader entry points are the active and archived loaders. Production active consumers are core configuration, the service's fork and latest-session paths, `ChatRecordingService`, `SessionReferenceService`, CLI startup resume and fork, ACP `acpAgent` load paths, Ink resume, branch and preview, OpenTUI session switching, branching and picker preview, CLI slash export, daemon session export, terminal prompt ledger, live task service and realtime startup context, session-agent history fallback, and A2A. The archived loader serves daemon export and A2A. A2A alone opts into filesystem-error propagation.

## Validation and acceptance criteria

- Drive `GetTask` through the real Express JSON-RPC transport, default A2A session loader, and on-disk task mapping. Inject an asynchronous `EIO` with `syscall: 'read'` at the Node filesystem stream for a real readable active transcript and repeat for an archived one. During the fault, check `-32012` and the absence of a kept task result for the otherwise unobserved task. Remove the fault and poll the same task for `TASK_STATE_COMPLETED`, its reply, and the kept completed result.
- Include successful reads with no matching reply and a missing transcript as controls. Keep an active case where permission checks succeed throughout the injected failure. Check that a coded argument error without `syscall` still produces a sanitized internal response and the archive cap remains in effect. Confirm that other A2A methods that reach the same failing observation return the same sanitized unavailable response.
- Run the focused CLI A2A suites and core SessionService, JSONL, and A2A tests, then run build and typecheck. Record the test environment and any gaps.

## Design audit

1. Forward review traced the service consumers and the selected-runtime boundary. Reverse review identified stale archive fallback, the restore race, and partial effects from list and cancel. The design now describes those boundaries and distinguishes filesystem failures from internal errors.
2. Forward review verified whole-path coverage and translation parity. Reverse review separated ordinary path lookup `ENOENT` from post-read `stat` errors and scoped the no-write guarantee to the failing observation. A Node probe also verified that asynchronous `EIO` rejects after a partial prefix has been read.
3. Forward review confirmed both load paths and all four task methods reach the proposed handling. Reverse review checked `EMFILE`, ordinary `ENOENT`, and the oversized archive exception against the classification. No blocking findings remained.

## Verification results

On macOS 27.0 arm64, a local daemon probe used real on-disk transcripts, the default session port, and JSON-RPC. Both the active and archived fixtures returned the outcomes below after an asynchronous `EIO` while `access(R_OK)` continued to pass.

| Observation                       | Installed Qwen Code 0.27.3                     | Built CLI with the fix                                               |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| First `GetTask` during `EIO`      | `TASK_STATE_FAILED` was returned and kept      | JSON-RPC `-32012` was returned with no result kept                   |
| `GetTask` after reading recovered | The same kept `TASK_STATE_FAILED` was returned | `TASK_STATE_COMPLETED` was returned and kept with the original reply |

The healthy transcript returned its reply in both runs. A missing transcript and a readable transcript containing a reply for another run both returned the expected missing-reply failure in both runs. The fixed bundle ran with Node 22.18.0. The focused CLI and core suites passed 22 and 391 tests respectively. `npm run build`, `npm run bundle`, `npm run typecheck`, and focused ESLint and Prettier checks passed. Linux and Windows were not tested.
