# Safe Scheduled Task Session Deletion

[English](2026-10-15-scheduled-task-safe-delete.md) | [简体中文](2026-10-15-scheduled-task-safe-delete.zh-CN.md)

## Problem

Deleting a scheduled task removes its schedule and then closes the task-owned session. The close currently has force semantics. If the task turn started a background agent, shell, workflow, pending notification, or another active turn, deleting the task aborts that work and can discard its result without a notification.

Disabling a task does not close its session. Later automatic cleanup asks the owning ACP child whether the session still holds work and retains it on refusal or uncertainty. Delete should use the same safety boundary.

## Goals

- Delete the scheduled task immediately while preserving active work in its task-owned session.
- Close the session only after daemon safety checks pass and, when supported, the owning child atomically confirms that it has no active work.
- Reuse the existing idle reaper after a retained session's holds clear.
- Keep explicit user close, kill, shutdown, and same-request rollback semantics unchanged.

## Proposed solution

Add `closeIfUnheld` to `CloseSessionOpts`. When set, the bridge routes the request through its existing two-phase `closeIfChildUnheld` path instead of entering force-close directly.

Before contacting the child, the bridge retains a session with daemon-owned work, an in-progress restore, incomplete negotiated hold coverage, or a condemned owner. Otherwise, the first phase asks the owning child to close under its session close gate with `onlyIfUnheld: true`. A reported hold, timeout, transport uncertainty, or stale entry keeps the daemon entry live. If the child confirms the session is closed, the bridge rechecks entry identity and performs its existing local teardown. This preserves the concurrency and unknown-outcome behavior already used by the idle reaper while keeping the internal condemned-channel drain available only to prequalified automatic cleanup.

The scheduled-task DELETE route uses this option with the close reason `scheduled_task_deleted`. Same-request rollback continues to use force close because those sessions have not completed a task turn.

## Lifecycle and ownership

The scheduled task is removed from durable storage even when its session is retained. Channel delivery authorization for the deleted task is revoked. The retained session remains visible under its existing name while active work finishes. No new orphan-session marker or rename is introduced. Once the child reports no holds, the existing idle reaper closes the unattached session.

The daemon is authoritative for work it admitted but the child may not yet see. The owning ACP child is authoritative for child-side holds. Daemon snapshots may guide when cleanup is retried, but they do not authorize destruction.

## Compatibility

Explicit close callers leave `closeIfUnheld` unset and keep force semantics. ACP children that negotiated active-work support receive the conditional close probe. Older children follow the bridge's existing compatibility behavior for automatic cleanup.

No HTTP shape, persisted task schema, transcript schema, or Java control-plane contract changes.

## Risks

- A retained session can temporarily appear with the name of a task that no longer exists. This state is bounded by active work and, once the last event subscriber detaches, the existing idle reaper; an attached retained session is reclaimed only after that client goes away.
- The DELETE response does not distinguish immediate session close from safe retention. Both outcomes satisfy deletion of the scheduled task; session cleanup remains internal lifecycle behavior.

## Validation plan

- Verify the DELETE route requests `closeIfUnheld` only for task-owned sessions.
- Verify the bridge sends the child `onlyIfUnheld: true` and retains daemon state when the child reports a background hold.
- Verify daemon-owned work, incomplete hold coverage, restore-in-progress, and condemned-owner states retain without probing the child.
- Verify explicit close and rollback paths keep force semantics.
- Exercise the daemon scheduled-task delete flow and capture before/after evidence showing the task is deleted while held work survives.
- Run focused unit tests, build, typecheck, lint, formatting checks, correctness review, and simplicity review.

## Acceptance criteria

- Deleting a task cannot silently abort work represented by an active-work hold.
- A refused or uncertain conditional close leaves the session available for later cleanup.
- Daemon-owned work and unsafe owner lifecycle states cannot be bypassed by a direct conditional close.
- A session with no holds is removed through the existing bridge teardown.
- The task itself is deleted and cannot fire again.
- No new reaper, lifecycle state, persisted field, or public HTTP response field is added.
