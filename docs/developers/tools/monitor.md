---
description: "Use the Qwen Code monitor tool to run long-lived background commands and stream output notifications back to the agent."
---

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
  Must be a positive integer. Defaults to `1000`; maximum `10000` (values
  outside this range are rejected, not silently clamped).
- `idle_timeout_ms` (number, optional): Stop if the command produces no output
  for this many milliseconds. Must be a positive integer. Defaults to `300000`
  (5 minutes); maximum `600000` (10 minutes), and values outside this range are
  rejected.
- `directory` (string, optional): An absolute path to run the command in. Must
  resolve (after symlink canonicalization) inside one of the registered
  workspace directories, and must not be inside the user-skills directory. If
  omitted, Qwen Code uses the project root.

## How to use `monitor` with Qwen Code

The model chooses the `monitor` tool when it needs to observe a process over
time instead of collecting a single command result. A successful invocation
returns a monitor ID, the command, the event limit, and the idle timeout.

Usage:

```
monitor(command="tail -f logs/app.log", description="app log stream")
```

Monitor output is visible in the conversation as task notifications. You can
also inspect running and completed monitors with `/tasks` or the interactive
Background tasks dialog.

To stop a running monitor, use the `task_stop` tool with the monitor ID:

```
task_stop(task_id="mon_abc123def4567890")
```

## `monitor` examples

Watch an application log:

```
monitor(
  command="tail -f logs/app.log",
  description="application log stream",
  max_events=200
)
```

Monitor a dev server or build watcher:

```
monitor(
  command="npm run build -- --watch",
  description="watch build output",
  idle_timeout_ms=600000
)
```

Poll a local health endpoint:

```
monitor(
  command="while true; do curl -s http://localhost:8080/health; sleep 5; done",
  description="local health check",
  max_events=120
)
```

Run from a specific workspace directory:

```
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

Do not add `&` to monitor commands. A trailing `&`, such as
`tail -f log &`, is stripped because the monitor manages backgrounding itself.
A non-final `&`, such as `cmd1 & cmd2`, is rejected outright; restructure such
commands without backgrounding instead.

## Important notes

- **Auto-stop behavior:** Monitors stop automatically when they reach
  `max_events`, when `idle_timeout_ms` elapses without output, or when the
  underlying command exits on its own. A monitor's status reflects the
  command's outcome, not a tool error: a clean exit (`code 0`) becomes
  `completed`, a non-zero exit code becomes `failed` with message
  `Exit code N`, and termination by signal becomes `failed` with message
  `Killed by signal SIG`. Commands cannot be interactive because stdin is
  closed. When a monitor stops, Qwen Code sends `SIGTERM` to the command's
  process group and escalates to `SIGKILL` after about 200 ms. On Windows, it
  uses `taskkill /f /t`. If the Qwen Code process itself is hard-killed,
  crashes, or runs out of memory, the detached process group is not cleaned up
  automatically; recover by stopping the monitor with `task_stop` before exit
  or by terminating the process group manually.
- **Concurrency limit:** Qwen Code allows up to 16 running monitors per CLI
  session as a single shared pool. Monitors started by subagents count against
  the same cap as monitors started by the main agent. Stop an existing monitor
  before starting another if the limit is reached.
- **Output handling:** Stdout and stderr are merged into a single notification
  stream with no stream prefix. Empty lines are ignored, ANSI color and control
  characters are stripped, and individual lines longer than 2000 characters are
  truncated. High-volume output is rate-limited with a burst of 5 events and
  about 1 event per second after that; lines beyond the rate limit are dropped,
  not buffered. Monitor output flows into the agent context as
  `<task-notification>` content. Structural notification tags are defanged, but
  the model still reads each line's text, so avoid monitoring streams that
  external parties can write to unless you trust the model to ignore embedded
  instructions.
- **Permissions:** `monitor` has its own permission boundary and permission
  rules, such as `Monitor(git status)`. Read-only commands are automatically
  allowed; commands that modify state require user approval; commands containing
  command substitution (`$(...)`, backticks, `<(...)`, or `>(...)`) are rejected
  outright. The `tools.core` and `tools.exclude` settings for
  `run_shell_command` do not apply to `monitor`.
- **Workspace restriction:** The optional `directory` must be an absolute path
  that resolves inside a registered workspace directory and outside the
  user-skills directory. Symlinks that point outside the workspace are rejected.
