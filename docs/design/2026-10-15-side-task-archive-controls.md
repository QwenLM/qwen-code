# Side-task archive controls

[English](2026-10-15-side-task-archive-controls.md) | [简体中文](2026-10-15-side-task-archive-controls.zh-CN.md)

## Status

Implemented in this change; verification is tracked in the pull request.

## Problem

Completed `side_task` sessions remain in the Web Shell side-task menu because their persisted transcripts stay in the active session catalog after the live child is reaped. The daemon already supports reversible session archive operations, but this menu does not expose them. Long-running coordinators therefore accumulate completed threads and must restart the daemon or close the parent to clear the list.

## Goals

- Let a user archive one completed side task from its menu entry.
- Let a user archive all currently completed side tasks in one action.
- Remove successfully archived tasks from the active list and close their open panel tabs.
- Let a user restore archived side tasks from the same menu.
- Keep live, unknown, and unsupported work protected from archive actions.
- Extend the existing archive route with an atomic idle guard and advertise it separately for compatible clients.

## Scope boundaries

This change does not add automatic TTL retention, a new daemon route, a migration, or transcript deletion. Archived side tasks remain recoverable through an Archived submenu in the side-task menu. TTL policy remains a follow-up to the managed child-session lifecycle work discussed in #14289.

## Design

The active side-task catalog retains the small presentation model already used by `ArtifactPanel` and adds an `archivable` decision derived from the authoritative session summary. A task is archivable only when it has no active prompt, no running background tasks, and its active-work observation is either `idle` or absent because the live child has already been reaped. Explicit `active`, `unknown`, and `unsupported` observations fail closed.

The daemon advertises `session_archive_idle_guard` when the existing archive route accepts `requireIdle: true`. The owning bridge checks its active-work snapshot immediately before setting the session to closing. Active, unknown, or unsupported work fails without closing or moving the transcript. A reaped child has no live bridge entry, so the existing persisted-session archive path remains available. This mutation-time guard prevents a task that resumed after the list snapshot from being archived.

When both `session_archive` and `session_archive_idle_guard` are advertised, each task entry exposes an Open/Archive submenu and the list exposes an Archive completed action. Both operations share one callback to the existing batch archive route with `requireIdle: true`.

Archive and restore must be workspace-qualified. Each callback groups the requested ids by the task's own `workspaceCwd` and calls `/workspaces/:workspace/sessions/archive` (or `.../unarchive`) through that workspace's client; an id with no recorded workspace keeps the legacy unscoped call. The unscoped routes resolve session ids against the primary workspace catalog, so without this a side task owned by an ordinary secondary workspace answers `notFound` and its transcript never changes state.

Successful and already-archived outcomes leave the active list. A `notFound` outcome does not: the task stays listed and its id is reported as a per-session error through the existing Web Shell error surface, so the UI never clears state for an operation the daemon did not perform. When `session_archive` is advertised, the same menu lists archived side tasks for the current parent and restores them through the workspace-qualified unarchive route. Repeated requests are safe because both routes are idempotent.

An archive result invalidates any older catalog request before updating the list, then starts one fresh listing. It also removes archived side-task tabs from the live panel, saved per-session buckets, deferred restored tabs, and browser persistence. An in-memory removal set prevents an already-running panel restore from reintroducing a tab; explicitly opening a restored task clears that marker.

## Validation plan

- Unit-test the completed/live classification boundary.
- Unit-test individual, bulk, disabled, restore, capability-gated, stale-list, partial-result, and saved-tab behavior.
- Unit-test the bridge's atomic idle check, daemon route validation, archive result, and SDK request body.
- Run the focused Web Shell tests, typecheck, lint, and format checks.
- Drive a real `qwen serve` Web Shell flow: create completed and running side tasks, archive one completed task, bulk-archive the remainder, confirm running work remains, restore an archived task, and confirm it returns to the active menu.

## Acceptance criteria

- Archive controls are absent unless both `session_archive` and `session_archive_idle_guard` are advertised.
- A completed side task can be archived without restarting the daemon or closing its parent.
- Archive completed removes all eligible tasks and preserves live or uncertain work.
- A failed archive remains in the list and produces a visible error.
- Archived tasks appear in the side-task menu and can be restored.
