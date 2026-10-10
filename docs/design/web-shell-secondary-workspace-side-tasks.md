# Web Shell secondary workspace side tasks

[English](web-shell-secondary-workspace-side-tasks.md) | [简体中文](web-shell-secondary-workspace-side-tasks.zh-CN.md)

## Problem and scope

`/btw side <question>` opens an independent side-task conversation with a
snapshot of the parent's model context. Web Shell exposes this action in
secondary workspaces, but `POST /session/:id/side-task` rejects their sessions
with `non_primary_session_route_not_supported`.

Support side tasks for trusted ordinary secondary workspaces. Preserve primary
and internal workspace behavior, standalone-session rejection, and the existing
restrictions on branch, fork, and directory changes. Existing Managed-engine
and SSH side-task exclusions remain in effect.

## Design

Classify side-task creation as live-session-owner scoped. Use the existing
owner mutation wrapper instead of the primary/internal restriction wrapper.
Keep standalone rejection as an explicit option of the owner wrapper, enabled
only for side-task creation. The owner resolver retains trust checks and
rejects unknown, ambiguous, or unavailable owners without primary fallback.
The existing archive lock, runtime generation checks, response redaction, and
failed-creation cleanup remain in effect.

The resolved runtime's bridge already creates the child inside its bound
workspace. The ACP child snapshots the parent through its session service,
and the bridge restores the child and records `sourceType: side_task` and
`sourceId: <parent session id>` in that runtime. No new SDK method, endpoint,
or filesystem routing is needed.

Web Shell already stores the owner's workspace path on side-task tabs and
passes it to the nested session provider for loading and restoring the child.
Its existing `/workspace/:id/sessions` catalog route resolves the supplied
workspace and filters by source type and parent id; the legacy URL does not
imply primary-only lookup. Preserve these paths and add regression coverage.

## Affected files and risks

Production changes are confined to `packages/cli/src/serve/routes/session.ts`.
Tests cover daemon multi-workspace routing and Web Shell command, history, and
pane behavior. The main risks are losing standalone rejection or dispatching
creation, listing, or restore to a different workspace; tests must verify the
actual target and absence of primary-side mutation.

## Validation and acceptance criteria

- A trusted secondary parent can create a side task, including while responding.
  The child inherits parent context and can continue independently.
- The side task belongs to the same workspace and parent. Closing, reopening,
  and restoring it preserve its identity and transcript without duplication.
- Side-task history excludes another parent's and another workspace's tasks.
- Unknown, untrusted, ambiguous, or unavailable owners fail before creation;
  runtime invalidation cleans up only in the resolved workspace.
- Primary and internal creation still work. Standalone creation remains
  unsupported; branch, fork, and directory-change restrictions remain intact.
- Run the E2E baseline with global `qwen`, then verify with `node dist/cli.js`;
  build, typecheck, and run focused daemon and Web Shell tests.

## Open questions

None. This change expands the existing side-task route to ordinary secondary
owners without introducing another side-task protocol.
