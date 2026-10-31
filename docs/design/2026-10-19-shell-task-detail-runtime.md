# Shell Task Detail Runtime

[English](2026-10-19-shell-task-detail-runtime.md) | [简体中文](2026-10-19-shell-task-detail-runtime.zh-CN.md)

Status: implemented on `feat/web-shell-shell-task-detail-info`, pending review.

## Problem

The web-shell shell-task panel shows the command, status, elapsed time, pid,
working directory, and output-file path. For a long-running task that is not
enough: the user cannot see any output, cannot tell whether the process is
still producing anything, and does not know when it started. The output file
lives under the session temp directory, so the existing workspace file routes
cannot read it.

## Goals

- Show the tail of the captured stdout/stderr inside the panel.
- Show the output file's size and last-write time, so "empty" and "still
  producing" are distinguishable.
- Show resident memory for the shell's process tree.
- Show start/end wall-clock times, and make command/path fields copyable.
- Give the panel tab a readable title derived from the command, still
  recognizable after truncation.

## Non-goals

- CPU utilization. The two platforms report it with different meanings
  (lifetime average on Linux, a decaying one-minute average on macOS), so a
  single number would be misleading without extra sampling state.
- Separating stdout from stderr. The captured file is one merged stream today.
- A general process monitor (child tree browsing, port probing, sampling
  history).

## Data flow

The tasks list stays a cheap snapshot. A new read-only endpoint fetches the
detail on demand:

1. The web-shell panel calls `GET /session/:id/tasks/:taskId/runtime`.
2. The daemon forwards to the session process through a dedicated status
   method.
3. The session looks up its own `BackgroundShellRegistry` entry by id, so the
   caller never supplies a path. It then reads the output file's stat and tail,
   and samples the process tree rooted at the registered pid.
4. The response carries only: `memoryBytes`, `outputBytes`,
   `outputModifiedAt`, `outputTail`, `outputTailTruncated`, and `outputError`.

The panel polls every 3 seconds while the task is running and fetches again
when it becomes terminal. Each effect lifetime bounds its own concurrent reads,
so an old request cannot block the final read or StrictMode replay. Failed
requests offer a retry button; terminal tasks do not poll continuously. After
the user presses Stop, the panel stays running with Stop disabled and polls
the source session task status. Only a terminal status reported by the backend
changes the panel to the corresponding outcome and triggers a final output
read; acceptance of a Stop request alone does not indicate completion. Transient status-read failures are retried. Unknown or
evicted tasks return `runtime: null`.

ACP exposes the same capability as `_qwen/session/task_runtime`, with
`sessionId` and `taskId` parameters and connection ownership checks. Both REST
and ACP use the live session owner runtime. Restored cross-session tabs bind
all task reads to the original session.

## Decisions

- **On-demand, not part of the task list.** Output reads and `ps` sampling are
  more expensive than a snapshot, and only an open panel needs them.
- **Server resolves the path.** The route accepts a task id, not a file path,
  and the session resolves it from its own registry.
- **RSS, not "memory usage".** The value is the resident set of the process
  tree. Shared pages are counted once per process, swapped-out pages are not
  counted, and a container sandbox can make the host-visible pid an outer
  wrapper. The label therefore says "resident memory", not "memory usage".
- **Tail is capped at the existing 8 KiB notification limit.** The panel and
  the completion notification read the same bytes through the same helper.
- **Memory is sampled only while running.** A finished task has no live pid to
  read; showing a stale number would be worse than showing none.
- **Partial failure preserves successful output.** A metadata read failure
  leaves a successful tail visible with a hint. Unavailable tasks, read errors,
  running empty output and terminal empty output have distinct labels. Clock
  formatting follows the app language in the browser local time zone.
- **Copy is local.** Copy buttons write to the browser clipboard and do not
  touch the daemon.

## Limits and risks

- On a sandboxed (container) shell the pid may describe a wrapper process, so
  the memory figure can be much lower than the real workload. The value is
  hidden when the registry has no pid.
- The output tail is a snapshot. Bytes written between polls are not shown
  until the next tick.
- The pid can be reused between the status read and the OS probe. The window is
  small, and the number is informational only.

## Validation

- Unit tests cover the `ps` table parser, tree summation, cycle handling, and
  the SDK client call.
- Regression tests cover terminal transitions and StrictMode async loading,
  failure retry, polling cleanup, partial failures, empty output, app language
  and copy feedback. Short tab titles survive refresh and reopening.
- Route tests cover REST owner-runtime dispatch with no unknown-session
  fallback, ACP parameter and connection ownership checks, and telemetry
  catalog parity.
- Cross-session restoration tests confirm runtime reads use the source session.
  Stop regression tests click the actual button, covering panels whose task
  prop stays running, transient status-read failures and late stale responses.
  The final output and terminal state must match the backend.
- Manual verification: run a background shell, open its panel, confirm output,
  size/mtime, resident memory, start time, and copy actions; stop the shell and
  confirm the final tail and exit code remain visible.

## Acceptance

- A running shell shows its output tail, output size and last-write time, and
  resident memory without opening the output file manually.
- A finished shell shows the final tail, exit code, and end time.
- An unknown or non-shell task returns no runtime detail rather than an error.
