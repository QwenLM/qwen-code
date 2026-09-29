# Web Shell Process Task Output

[English](web-shell-process-task-output.md) | [简体中文](web-shell-process-task-output.zh-CN.md)

## Goal

Show captured Shell and Monitor output directly in their Web Shell task detail
panels without relying on Monitor task notifications reaching the Web Shell.

## Design

- Capture a rolling tail of Monitor stdout and stderr in its existing reserved
  `outputFile`, bounded to 64 KiB plus one byte that preserves the task output
  API's truncation signal. Shell already writes both streams to its task output
  file.
- Use the same constant-state streaming log filter for Monitor capture and tail
  reads. Each Monitor stream owns its UTF-8 decoder and filter. Sequence payloads
  are discarded as they arrive, so incomplete or oversized sequences do not
  accumulate in memory. Newlines end incomplete sequences and preserve later
  log lines. This filter removes control sequences; it does not emulate terminal
  cursor movement or character sets.
- Tail reads parse up to 4096 preceding bytes to recover sequence state, but
  discard all text produced by that prefix. Only bytes from the requested window
  contribute to the response. UTF-8 decoding must not expand the response beyond
  the caller's byte budget. A sequence starting before the bounded lookback
  cannot always be reconstructed.
- Add a live-session-owner-scoped read route:
  `GET /session/:id/tasks/:taskId/output?kind=shell|monitor`.
- Resolve the request through the selected session runtime and look up the task
  in that runtime's registry. Never accept a filesystem path from the client or
  fall back to the primary runtime.
- Return at most the latest 64 KiB as sanitized UTF-8 text, together with a
  `truncated` flag. Refuse symlinks and non-regular files when opening the
  task-owned file. Collapsing carriage-return redraws also reports truncation
  when it discards non-blank frames.
- Advertise the route through a `session_task_output` capability. Older daemons
  keep the existing metadata-only detail view.
- Render the output below the existing metadata in `MonitorTaskDetail` and
  `ShellTaskDetail`. Refresh it when the existing task snapshot changes. Running
  restored cross-session tabs also refresh on the same task-poll cadence because
  their snapshots do not advance through the active session's polling.
- When an overflowing output box is already at the bottom, keep it pinned to
  the bottom as new output arrives. Preserve the user's scroll position after
  they scroll upward.
- Provide a copy action for the currently displayed output snapshot.
- Preserve the final output after the task reaches a terminal state. Empty and
  temporarily unavailable output use explicit, non-fatal UI states.
- When Monitor capture writes fail, both Web Shell and TUI task details display
  a localized warning while retaining previously captured output. Do not expose
  raw filesystem error paths in that warning or reuse the read-error channel,
  which replaces output. A successful flush clears the capture warning. Three
  consecutive failures stop further capture writes; terminal settlement waits
  for pending capture writes in both direct and sandbox execution. Terminal
  Monitor output reads also join pending capture writes, so cancellation cannot
  leave an already stopped output panel displaying the pre-flush tail.

## Non-goals

- Full log archival, search, download, or pagination.
- Changing ACP Monitor notification throttling or XML envelope defenses.
- Exposing `outputFile` as an arbitrary file-read capability.
- Full terminal emulation.

## Verification

- Core tests cover Monitor file creation, stdout/stderr capture, bounded
  rolling-tail behavior, write-failure recovery, and sandbox completion.
- Sanitizer tests cover every split point in representative escape sequences,
  adjacent escapes, embedded controls, C1 leaders and oversized payloads.
- Tail tests assert both the 8 KiB notification budget and the 64 KiB task-output
  cap, including printable lookback prefixes and UTF-8 boundaries.
- Core, ACP, and bridge tests collectively cover task ownership, kind
  validation, missing tasks, truncation, symlink refusal, and the new status
  method.
- SDK tests cover REST and ACP route mapping.
- Web Shell tests cover Shell and Monitor output, refresh, conditional
  auto-scroll, copying, truncation, empty output, read failure, and capability
  fallback. Web Shell and TUI tests require a capture-failure warning; Web Shell
  keeps captured output visible and removes the warning after recovery.
- E2E verifies running output appears in the task detail and remains after the
  task stops. Review regression verification first attempts the global CLI,
  then uses exact-source tests when the released CLI lacks this feature.
