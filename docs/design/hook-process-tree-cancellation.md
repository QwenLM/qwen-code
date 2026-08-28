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

While a POSIX command hook is running, HookRunner keeps its owned process group registered with a synchronous process-exit fallback. If the parent reaches Node's exit event before normal cancellation completes, the fallback sends SIGKILL to every process-scoped hook group instead of leaving the detached tree behind. Temporary SIGHUP, SIGINT, SIGQUIT, and SIGTERM handlers reclaim those groups before either re-raising an otherwise unhandled signal or leaving graceful parent shutdown to an application handler.

Command hooks for `MessageDisplay`, `StopFailure`, and `SessionDelete` are exceptions because those events are dispatched fire-and-forget and their output has no control effect. Qwen synchronously writes their input to a mode-0600 temporary file, then starts an unreferenced, detached supervisor whose stdin, stdout, and stderr do not depend on Qwen. The supervisor opens the input file as the hook's stdin and removes its directory entry after spawning the hook where the platform permits, otherwise retrying when the hook completes, so queued pipe writes cannot be lost when Qwen exits and sensitive input is not retained longer than necessary. The internal Node supervisor does not inherit user `NODE_OPTIONS`; it passes the original value separately and restores it only for the actual hook command.

Graceful supervisor exit and handled termination signals remove staged input and terminate an owned hook group. An untrappable SIGKILL in the short interval between staging input and the supervisor unlinking it can leave the mode-0600 file behind. An untrappable SIGKILL after the hook starts can also leave the independently owned hook group running. Closing those host-failure gaps requires an external reaper or a separate process-group identity channel and is outside this change.

On POSIX, the supervisor starts the command in a separate owned process group and retains the configured deadline after Qwen exits. Root-process close records the exit status but is not completion while another process remains in the group. Normal completion ends the supervisor as soon as the group is empty; timeout sends TERM and then KILL to the group. While Qwen is still alive, AbortSignal cancellation terminates the supervisor, which forwards the same tree cleanup to the command group. Generic `async: true` hooks remain process-scoped: their captured output belongs to AsyncHookRegistry and, on POSIX, they are reclaimed when the Qwen process exits.

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

- Unit-test process-group ownership, parent-independent supervisor selection, TERM-to-KILL timing, root-close races, timeout/abort races, parent-exit fallback, normal completion, spawn errors, and Windows taskkill fallback.
- Run a POSIX process test whose descendant confirms receipt of SIGTERM, ignores it, and is then made non-running by group SIGKILL.
- Run POSIX process tests proving process-scoped async hooks are reaped on parent exit while `MessageDisplay`, `StopFailure`, and `SessionDelete` hooks let Qwen exit naturally and still finish afterward.
- Run POSIX process tests proving surviving hooks keep their timeout after Qwen exits, retain supervision when the root exits before a descendant, preserve explicit abort, and receive input larger than the OS pipe buffer in full.
