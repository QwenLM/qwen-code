# Unified VS Code session history

[中文版](./vscode-session-source-switch.zh-CN.md)

## Context

Users should be able to open terminal-created conversations directly in VS Code. The source switch introduced in #11584 did not match that requirement: creation source is metadata, not a separate history or editing boundary.

## Decision

The history dialog shows ordinary conversations from the same workspace in one list, including VS Code, terminal, browser, and unattributed legacy conversations. There are no source tabs, source badges, or source-based restrictions on rename and delete. The existing protection against deleting the currently open conversation remains.

Deleting an ordinary conversation reaches beyond this client: the daemon closes the session and runs the same ownership-verified worktree cleanup it runs for any delete. A checkout with uncommitted work is preserved. Otherwise the checkout is removed, and its worktree branch is deleted only when a non-force `git branch -d` accepts it — so an already-merged branch goes with the checkout, while commits that are not yet merged survive on the branch.

The companion uses the existing workspace-scoped organized catalog with active archive state, all groups, and no source filter. This provides opaque, tie-safe pagination without changing the daemon protocol. Child sessions and explicitly attributed background-task/channel sessions are excluded from the conversation list. A visible Load more control permits advancing even when a page contains only filtered records. Failed requests retain the visible rows and cursor for retry; a truncated catalog produces an incomplete-history notice.

Only creation of a new conversation supplies VS Code source attribution. Restoring any existing conversation omits it, including after a reload. The host persists the existing string session id without requiring source sidecar state. Previously stored sidecars are ignored, and the old conversation store is left untouched. Legacy daemon conversations need no allowlist because the unified query already includes them. A bootstrap invalidates in-flight history requests and clears the previous runtime's rows and cursor.

## Scope

This is a VS Code companion change. Shared Web Shell, daemon ownership and pagination, Live attribution, and terminal behavior are unchanged. Missing source attribution on machine-generated sessions is a separate backend issue; the UI cannot reliably infer it.

## Verification

- One list includes ordinary VS Code, terminal, browser, and legacy conversations without a source selection.
- Opening an existing conversation, including after a host reload, does not supply replacement source attribution; new conversations still carry VS Code attribution.
- Ordinary conversations share the same row actions, with the current-conversation delete protection preserved.
- Sparse pages can advance, failures can retry the same cursor, and incomplete history is visible.
