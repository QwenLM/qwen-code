# ACP cancellation boundary for restored sessions

## Problem

An explicit user cancellation and an unexpected daemon termination can both restore as a trailing user turn without a model response. The existing continuation classifier sees both as `interrupted_prompt`, so it can restart work the user deliberately stopped.

The recovery decision needs durable user intent without changing the ACP protocol or making unexpected process termination unrecoverable.

## Design

Persist an append-only `system/turn_cancelled` record when a user explicitly stops a turn that is already present in the session JSONL.

- Daemon Cancel and running-prompt Remove use an acknowledged private ACP extension request. The child writes the boundary before the HTTP operation succeeds. Standard ACP Cancel remains available to direct ACP clients.
- Internal aborts caused by transport loss, failed forwarding, teardown, or child cleanup use the standard ACP notification with a private metadata stamp marking them as non-user cancellations.
- The cancellation write completes before the model request is aborted. Duplicate cancels share the in-flight write, and new prompts cannot append behind a boundary that may still fail.
- Explicit session Close and Delete request the same persistence before discarding live state. A structurally interrupted idle session uses the same boundary as an active prompt.
- Restore derives the active cancellation state from the reconstructed JSONL branch. Assistant, tool, telemetry, cron, and notification records do not erase it.
- A later user turn or rewind clears the state. Retry appends `system/turn_resumed` before re-running the persisted turn; cancellation and resumption writes are serialized so the latest user intent wins.
- Continuation keeps its existing structural classification but returns `accepted: false` when the active branch ends behind a cancellation boundary.

An unexpected `SIGKILL` cannot append the boundary, so its unfinished user or tool history remains eligible for continuation.

## Compatibility

- No upstream ACP method or schema changes are required; the implementation uses ACP extension methods and metadata.
- Legacy transcripts without the marker retain their current behavior.
- Running pending-prompt removal becomes asynchronous because its success now means the boundary is durable. All in-repository bridge consumers already await this operation.
- This change does not add WebShell automatic recovery. It only makes the continuation decision safe enough for that follow-up.

## Verification

1. Explicit Cancel, daemon restart, load, and continue returns `accepted: false`; the model request count remains one.
2. `SIGKILL`, daemon restart, load, and continue returns `accepted: true`; the model request count becomes two and the continued turn reaches a correlated terminal event.
3. Removing a running pending prompt persists the boundary before the HTTP response and remains rejected after restart.
4. Persistence failure does not abort or acknowledge a persisted turn.
5. Duplicate cancellation, cancellation-versus-retry, and cancellation-versus-new-prompt races preserve the latest durable user intent.
