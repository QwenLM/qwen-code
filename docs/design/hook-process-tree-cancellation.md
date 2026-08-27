# Hook Process Tree Cancellation

## Problem

Command hooks run through a shell and can create nested processes. HookRunner currently signals only the direct shell process and uses `ChildProcess.killed` to decide whether to escalate from SIGTERM to SIGKILL. That property records that a signal was sent, not that the process exited, so an unresponsive shell can prevent escalation and descendants can survive as orphans.

## Design

On POSIX, HookRunner starts each command hook as a detached child so the shell leads an owned process group. Normal completion is unchanged. When the hook times out or receives an AbortSignal, HookRunner starts one idempotent termination operation:

1. Send SIGTERM to the owned process group.
2. Poll for group existence for up to two seconds.
3. If the group still exists, send SIGKILL to the group.
4. Return the existing timeout or cancellation result only after termination reaches one of those terminal actions.

The root child closing does not cancel escalation because descendants can remain in the group after the root exits. After SIGKILL is accepted, HookRunner does not wait for process IDs to disappear: terminated processes may remain briefly visible as zombies until their new parent reaps them.

While a POSIX command hook is running, HookRunner keeps its owned process group registered with a synchronous process-exit fallback. If the parent reaches Node's exit event before normal cancellation completes, the fallback sends SIGKILL to every active hook group instead of leaving the detached tree behind. Temporary SIGHUP, SIGINT, SIGQUIT, and SIGTERM handlers reclaim active groups before either re-raising an otherwise unhandled signal or leaving graceful parent shutdown to an application handler.

Windows does not expose POSIX process-group signals. HookRunner instead invokes the absolute System32 `taskkill.exe` path asynchronously with `/f /t /pid` and a bounded execution time. A failed taskkill falls back to force-killing the direct child and emits a diagnostic warning. If the root process has already exited, taskkill cannot reconstruct descendants from that former PID; reclaiming that case requires a Windows Job Object or descendant tracking and remains outside this change.

Timeout and AbortSignal races share the same termination promise. Abort retains its existing result precedence, and normal hook success, output parsing, exit-code handling, and timeout defaults remain unchanged.

After tree termination, HookRunner waits up to one second for the root child to close so its stdout and stderr streams can drain. If the close event never arrives, it destroys the streams and returns the cancellation result, keeping the cancellation path bounded.

## Non-goals

- Propagating the ACP session initialization deadline into SessionStart.
- Managing the ACP child process tree.
- Reaping processes that deliberately leave the owned group through daemonization or a new session.
- Preserving controlling-terminal access for POSIX command hooks. Creating the owned process group uses a detached session, so commands that open `/dev/tty` directly are unsupported.
- Reclaiming a detached group after an untrappable parent SIGKILL or host failure, because those failures prevent all JavaScript exit handling from running.
- Changing extension configuration, hook timeout defaults, or AsyncHookRegistry's unused process field.

## Test plan

- Unit-test process-group ownership, TERM-to-KILL timing, root-close races, timeout/abort races, parent-exit fallback, normal completion, spawn errors, and Windows taskkill fallback.
- Run a POSIX process test whose descendant confirms receipt of SIGTERM, ignores it, and is then made non-running by group SIGKILL.
