# Transactional cross-session switching

## Problem

The WebUI historically detached the current session, stopped its event stream, and cleared its transcript before a target `loadSession` or `resumeSession` completed. A slow or failed restore therefore left the user without the still-healthy source session. The WebShell also keyed its main provider by the requested session, so controlled navigation remounted the provider before the target was usable.

## Scope

This change makes only cross-logical-session load and resume transactional. A logical target is the normalized `(sessionId, workspaceCwd)` pair. Initial bootstrap, same-logical reload, client-id replacement, full resync, memory repair, and branch adoption retain their existing behavior and are follow-up work.

Modern transactional behavior requires a successful capability snapshot that advertises `client_identity` and concrete client IDs for both attachments. A daemon that explicitly lacks the feature retains the legacy destructive path. Unknown capabilities or malformed modern responses fail closed and preserve the source.

## Coordinator

Each provider owns one raw restore slot and one desired intent. Restore equivalence includes the normalized session and workspace plus the effective replay shape: `resume/none`, `load/all`, or `load/recent(N)`. The provider snapshots the effective page when admitting the intent, after applying daemon pagination capability, and uses that snapshot for the initial request, queued execution, and retries. Only exact shapes coalesce; a non-equivalent request rejects the prior public intent, permanently marks any different raw result as superseded, and replaces the queued intent, while the already-running SDK request continues to settlement because it is not cancellable. The superseded result is never adopted even if a later intent returns to its shape; its attachment is detached once on a best-effort basis. A timed-out raw request that has not been superseded by a different shape may still satisfy an exact-shape retry. The queued deadline begins when the caller requests the switch, so an expired target never starts a restore.

Commit is guarded by the desired intent, absolute deadline, provider environment, local lifecycle, source logical identity, and restored target identity. A same-shape retry may adopt a late raw result only when an ordinary timeout left the lifecycle unchanged; an explicit lifecycle cancellation fences that result even if a later intent returns to the same shape. Timeout, SDK failure, supersede, staging failure, and commit are explicit competing terminal states rather than an implicit `Promise.race`.

## Staging and commit

Replay is normalized into an unsubscribed shadow transcript store in batches of at most 512 events. The compacted replay and live journal arrays are traversed directly and are not concatenated. Only bounded summaries of notices and side-channel events are retained. Staging never writes the visible transcript, connection, prompt maps, notices, or workspace signals.

After the final guard succeeds, one synchronous commit flushes the source runner's legal buffered events, stops its stream, installs the target transcript/history/session/workspace/client and connection ref, notifies the WebShell wrapper, publishes staged side effects, and settles source-local prompt waiters. The public load promise resolves only after those synchronous owners agree. Target metadata and SSE start afterward without a second restore. Source detach is asynchronous, single-attempt, and never blocks the public result or the next restore.

## WebShell ownership

For modern daemons, the main workspace wrapper keeps one provider instance and separates the desired target from the committed target. Workspace resolution and restore failures continue rendering the committed source. A synchronous commit callback advances wrapper ownership before the public promise resolves. Stable failed targets are latched so unrelated renders do not retry them; a controlled failure rolls the host back only while the failed desired generation is still current.

Session transition state gates new prompt and mutation entry points while preserving the source event stream, existing prompt completion, cancellation, permissions, and read-only controls. UI navigation uses an invocation token plus an attachment-identity snapshot so stale completion handlers cannot clear or focus a newer request. Session-owned worktree, branch, git intent, and recap state are not cleared until ownership commits.

## Compatibility and risks

Legacy daemons keep the old keyed/destructive behavior. Cleanup is deliberately best effort: a failed detach can leave an invisible client reference until the existing reaper runs. Staging temporarily holds the source transcript and target replay at once, and CPU-heavy restore work in a shared ACP child can still delay source events. This change does not optimize JSONL reading, selective replay, or daemon capacity.

## Verification

Unit coverage exercises delayed success/failure, exact-target coalescing, latest-only serialization, controlled switching, malformed ownership, write gating, synchronous commit ownership, source events during preparation, wrapper remount compatibility, workspace resolution failure, invocation fencing, and post-commit catch-up timeout behavior. A focused JSDOM/real-daemon test delays delivery of an already-completed target restore response and verifies that the source remains usable until atomic commit; a structured 504 must leave the source intact.
