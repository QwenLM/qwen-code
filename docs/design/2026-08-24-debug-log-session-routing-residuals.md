# Debug log session routing residuals

## Problem

ACP hosts multiple sessions in one process, while the debug logger retains a
process-wide fallback for the single-session CLI. PR #9538 made
`sessionIdContext` take precedence over that fallback, but several entry points
still ran without a context and each `Config` construction or rotation could
replace the fallback.

The remaining failures have three ownership classes:

- Live or persisted-session work belongs to the target session.
- Workspace discovery belongs to its dedicated workspace discovery Config.
- Non-interactive OpenAI log housekeeping is process-scoped because jobs are
  deduplicated by log directory, not by session.

## Design

All ACP session Config creation, including new, load, resume, and transcript
replay, runs inside `sessionIdContext`. A true new session receives its ID
before Config loading, while the intentionally id-less transcript replay Config
inherits the requested session's existing context. Config construction and
rotation only update the process-wide debug fallback when no session context is
active. The workspace MCP discovery Config receives its own explicit context,
so neither kind of daemon Config can move the single-session fallback.

Generating the ID before Config loading must not change session-management
behavior: the caller-id occupancy check exists to protect caller-chosen IDs
from case-twins, so a daemon-generated fresh UUID is marked as such
(`sessionIdGenerated`) and skips the check — otherwise the id-less creation
hot path would pay two readdirs per session and a transient FS error would
fail closed into a spurious `session_id_conflict`.

MCP budget callbacks and persisted-session delete/rename operations restore the
target session context at callback or dispatch time. Budget notifications keep
the stable ACP-facing session ID in their payload, while debug logging follows
the Config's current ID after a `/clear` rotation. This is required even when
the callback was registered under a context because its eventual invoker may
belong to a shared transport or another async resource. A dead-session ID is
bound only after the existing path-safe session ID validation; arbitrary caller
text must never become a debug-log filename.

Non-interactive housekeeping explicitly exits `sessionIdContext`. Its queue is
process-scoped and may be shared by sessions that resolve to the same log
directory, so assigning it to the first or latest session would both be wrong.
With daemon Configs prevented from replacing the fallback, process-scoped logs
remain in the bootstrap log.

The latest-log alias remains best-effort. After calling the existing
best-effort `updateSymlink`, the debug logger verifies the link's target and
clears its dedup marker only when the latest scheduled update failed. This lets
the next write for that session retry without changing the shared symlink API,
while preserving serialized cross-session updates. Retries are bounded: after a
few consecutive failures the marker stays sticky (one attempt per session
change, the pre-retry behavior), so hosts where symlinks never succeed — e.g.
Windows without symlink privilege — do not re-run a doomed unlink/symlink
cycle on every debug line. A single success resets the streak.

## Non-goals

- Changing session management behavior beyond debug-log ownership.
- Making debug-log writes or alias updates durable.
- Replacing the single-session CLI fallback.
