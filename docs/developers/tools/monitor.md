# Monitor Tool (`monitor`)

This document describes the `monitor` tool for Qwen Code.

## Description

Use `monitor` to start a long-running shell command that streams stdout and
stderr lines back to the agent as background task notifications. It is intended
for watch-style commands where new output matters over time, such as tailing
logs, watching build output, polling a health endpoint, or observing file
changes.

The monitor runs in the background, so the agent can continue working while
events arrive. Each non-empty output line becomes a notification event, subject
to throttling.

### Arguments

`monitor` takes the following arguments:

- `command` (string, required): The shell command to run and monitor.
- `description` (string, optional): A brief description of what the monitor is
  watching. The display text is truncated to 80 characters.
- `max_events` (number, optional): Stop after this many notification events.
  Defaults to `1000`; maximum `10000`.
- `idle_timeout_ms` (number, optional): Stop if the command produces no output
  for this many milliseconds. Defaults to `300000` (5 minutes); maximum
  `600000` (10 minutes).
- `directory` (string, optional): Absolute workspace path to run the command in.
  If omitted, Qwen Code uses the project root.

## How to use `monitor` with Qwen Code

The model chooses the `monitor` tool when it needs to observe a process over
time instead of collecting a single command result. A successful invocation
returns a monitor ID, the command, the event limit, and the idle timeout.

Usage:

```bash
monitor(command="tail -f logs/app.log", description="app log stream")
```

Monitor output is visible in the conversation as task notifications. You can
also inspect running and completed monitors with `/tasks` or the interactive
Background tasks dialog.

To stop a running monitor, use the `task_stop` tool with the monitor ID:

```bash
task_stop(task_id="mon_abc123def4567890")
```

## `monitor` examples

Watch an application log:

```bash
monitor(
  command="tail -f logs/app.log",
  description="application log stream",
  max_events=200
)
```

Monitor a dev server or build watcher:

```bash
monitor(
  command="npm run build -- --watch",
  description="watch build output",
  idle_timeout_ms=600000
)
```

Poll a local health endpoint:

```bash
monitor(
  command="while true; do curl -s http://localhost:8080/health; sleep 5; done",
  description="local health check",
  max_events=120
)
```

Run from a specific workspace directory:

```bash
monitor(
  command="npm run dev",
  description="frontend dev server",
  directory="/absolute/path/to/workspace/packages/web"
)
```

## Monitor vs. background shell commands

Use `monitor` when the agent needs to react to streaming output while the
command keeps running. Use `run_shell_command` instead when you need a one-shot
result or the complete command output.

| Need                                                   | Use                                      |
| :----------------------------------------------------- | :--------------------------------------- |
| Watch logs, build output, or periodic status updates   | `monitor`                                |
| Run a one-time command and read the full output        | `run_shell_command(is_background=false)` |
| Start a daemon that does not produce meaningful output | `run_shell_command(is_background=true)`  |
| Keep a long-running process alive without event stream | `run_shell_command(is_background=true)`  |

Do not add `&` to monitor commands. The monitor manages the background process
lifecycle itself.

## Important notes

- **Auto-stop behavior:** Monitors stop automatically when they reach
  `max_events` or when `idle_timeout_ms` elapses without output. The underlying
  process is killed when the monitor stops.
- **Concurrency limit:** Qwen Code allows up to 16 running monitors at once.
  Stop an existing monitor before starting another if the limit is reached.
- **Output handling:** Stdout and stderr are both converted into notification
  events. Empty lines are ignored, ANSI color is stripped, and high-volume
  output may be throttled.
- **Permissions:** `monitor` has its own permission boundary and permission
  rules, such as `Monitor(git status)`. Read-only commands may run without
  confirmation; other commands can require approval.
- **Workspace restriction:** The optional `directory` must be an absolute path
  inside the current workspace.
