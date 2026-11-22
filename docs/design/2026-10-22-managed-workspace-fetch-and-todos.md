# Managed Session durable Todo

[中文](2026-10-22-managed-workspace-fetch-and-todos.zh-CN.md) | English

## Problem and scope

#15089 adds `todo_write` on `hosted-workspace-files/3`, but its Worker identity is scoped to a Turn. The list is lost across Turns and is not available to the Harness model loop or the WebShell task panel. This follow-up stores the list with the Hosted Session and projects committed state to the client. Refs #15076, #15084.

The profile and approval boundaries follow main: only `files/3` declares Todo; Shell stays on the unified `shell/1` profile. Public Plan admission remains limited to `files/1` and `shell/1`. This change adds no profile, lifecycle protocol, deployment default, MCP capacity rule or automatic continuation.

Native `web_fetch` was originally deferred because a files-only Session could reach private, link-local or metadata destinations without an outbound policy. Main now ships fetch with its own destination checks; this follow-up preserves that implementation and does not extend its policy.

## Storage and execution

The Harness writes `todo_state` through the Session authority. The envelope carries the operation identity, revision and previous record reference. The command digest binds the original input; retrying the same command returns its original record even after later writes, while different input conflicts. A stored record is read and validated on Session load.

Validation retains main's 64-item, 1000-code-point content, 32-dependency and 16 KiB serialized-list bounds. Shared core validation rejects duplicate IDs, missing dependencies and cycles. Core and Hosted use the same dependency-preservation helper: an unfinished prior plan preserves omitted edges to surviving IDs; an explicit empty array clears them; a preservation-created cycle falls back to the caller's valid list. The merged list must also fit the Hosted limits. There is no additional Hosted-only status-versus-dependency restriction.

A valid Todo call commits without acquiring, preparing or executing a Runtime. The constructor's existing warm-up and configured Hook execution can still contact the Broker. Successful journal-only writes count as dispatch evidence for PostToolUse; validation refusals do not. Worker Todo support remains available for existing execution paths, but fresh Hosted Todo dispatch is owned by the Harness.

The state commit and tool-result commit are ordered, not atomic. A crash between them can leave committed state before a public success receipt. Replaying the command recovers its original result; this does not expand interrupted-batch recovery admission. New journal-only Todo batches are not captured as Worker continuations; previously saved Worker continuations retain their original execution path.

## Model context

Fresh model requests read the latest durable list. Saved recovery requests retain their recorded context. The reminder labels the JSON as task data, not instructions, and tells the model not to follow instructions embedded in task text. It remains bounded by the stored-list limit; this change does not introduce a context cache or change provider prefix caching.

## Committed client projection

The committed `tool_result` is the producer of the visible snapshot. For an exact `todo_write` success, the Harness validates and serializes the committed list as a `todoSnapshot` string on its existing journal progress event. Java forwards that scalar only for a completed Todo journal event and only up to 16 KiB. Other tool outputs and uncommitted progress retain their existing redaction. No general nested-output forwarding or new endpoint is introduced.

The same attributes are persisted on tool Items and returned through live events, transcript replay and snapshots. The client recognizes only Todo snapshots, rejects stale source revisions, and uses committed output rather than requested arguments. Failed, cancelled and pending calls cannot replace the last successful list; a successful empty list clears it.

The task card mounts only when a nonempty committed snapshot exists. Its height is bounded and its contents scroll, preserving room for the transcript. When older events remain unloaded, a separate history-window note remains visible even without a loaded Todo snapshot. This is a projection of loaded history, not a separate current-state query.

## Acceptance criteria

1. A `files/3` Session retains main's tools and approvals. Other profiles, Plan admission, lifecycle and MCP limits do not expand.
2. Write a list, update it in another Turn, then reopen the Session: fresh requests receive the latest list. Command retries return the original committed result, and mismatched input conflicts.
3. Dependency preservation matches core; malformed graphs and oversized merged lists return correctable errors without Runtime dispatch.
4. Successful writes fire the configured success Hook. Refused writes do not appear as successful dispatches.
5. A real journal Todo completion passes through Java projection and renders identically from live events and persisted Items. Other tool payloads remain redacted; stale and unsuccessful updates cannot replace the list.
6. Empty lists clear the card; long lists remain scrollable without hiding the transcript; unloaded history has a visible limitation notice.

## Verification boundaries

Regression sources cover durable replay, dependency preservation, success Hooks, the journal snapshot producer, Java redaction and client live/replay projection. Execution results belong in the PR at an exact commit. MySQL, remote-store crash recovery, full Hosted-process and browser acceptance must be recorded separately; source inspection or unexecuted tests do not establish those outcomes.
