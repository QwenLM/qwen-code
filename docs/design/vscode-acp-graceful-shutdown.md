# VS Code ACP graceful shutdown

[中文版](./vscode-acp-graceful-shutdown.zh-CN.md)

## Problem

The VS Code companion terminated its ACP child immediately when the panel disconnected. On Windows this bypassed the CLI shutdown path and could leave shells and ConPTY descendants alive. A graceful child can also overlap a replacement connection, so an old exit or response must not clear state owned by the replacement.

## Decision

The companion closes the ACP child's stdin first. The CLI treats the closed transport as a normal shutdown, fires SessionEnd hooks, drains MCP clients, disposes sessions, and runs process cleanup.

Shutdown is bounded:

- On POSIX, the ACP child leads a process group. After 75 seconds the companion sends SIGTERM to that group, then SIGKILL after another 75 seconds.
- On Windows, after 75 seconds the companion invokes the absolute System32 `taskkill.exe` path with `/f /t`.
- Exit handlers and asynchronous responses are tied to the child and connection that created them, so a retired process cannot mutate a replacement connection.
- Overlapping EOF and signal shutdown paths share the same SessionEnd, MCP drain, session-disposal, and registered process-cleanup work. SessionEnd hooks start concurrently and share a 30-second abort budget.

## Scope

This change covers ACP process teardown and the connection races introduced by graceful teardown. It does not close sessions when the user switches conversations and does not change hook process-tree ownership, which is handled separately.

## Verification

- Disconnect closes stdin before any forced termination.
- POSIX escalation targets the ACP child's process group; Windows escalation targets the process tree via `taskkill /f /t`, degrading to the direct child if taskkill fails.
- A normal child exit cancels escalation.
- A retired child or response cannot clear or update its replacement.
- EOF and signal shutdown execute each cleanup phase once, and all SessionEnd hooks begin within the shared deadline.
