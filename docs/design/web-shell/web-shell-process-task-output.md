# Web Shell Process Task Output

## Goal

Show captured Shell and Monitor output directly in their Web Shell task detail
panels without relying on Monitor task notifications reaching the Web Shell.

## Design

- Capture Monitor stdout and stderr in its existing reserved `outputFile`.
  Shell already writes both streams to its task output file.
- Add a live-session-owner-scoped read route:
  `GET /session/:id/tasks/:taskId/output?kind=shell|monitor`.
- Resolve the request through the selected session runtime and look up the task
  in that runtime's registry. Never accept a filesystem path from the client or
  fall back to the primary runtime.
- Return at most the latest 64 KiB as sanitized UTF-8 text, together with a
  `truncated` flag. Refuse symlinks when opening the task-owned file.
- Advertise the route through a `session_task_output` capability. Older daemons
  keep the existing metadata-only detail view.
- Render the output below the existing metadata in `MonitorTaskDetail` and
  `ShellTaskDetail`. Refresh it when the existing task snapshot changes, so no
  additional polling loop is introduced.
- When an overflowing output box is already at the bottom, keep it pinned to
  the bottom as new output arrives. Preserve the user's scroll position after
  they scroll upward.
- Provide a copy action for the currently displayed output snapshot.
- Preserve the final output after the task reaches a terminal state. Empty and
  temporarily unavailable output use explicit, non-fatal UI states.

## Non-goals

- Full log archival, search, download, or pagination.
- Changing ACP Monitor notification filtering.
- Exposing `outputFile` as an arbitrary file-read capability.

## Verification

- Core tests cover Monitor file creation and stdout/stderr capture.
- Core, ACP, and bridge tests collectively cover task ownership, kind
  validation, missing tasks, truncation, symlink refusal, and the new status
  method.
- SDK tests cover REST and ACP route mapping.
- Web Shell tests cover Shell and Monitor output, refresh, conditional
  auto-scroll, copying, truncation, empty output, read failure, and capability
  fallback.
- E2E verifies running output appears in the task detail and remains after the
  task stops.
