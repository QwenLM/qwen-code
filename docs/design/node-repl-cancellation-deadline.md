# Node REPL cancellation deadline

[English](node-repl-cancellation-deadline.md) | [简体中文](node-repl-cancellation-deadline.zh-CN.md)

## Problem

The execution timeout currently sends a cancellation request without bounding
the wait for its terminal result. Native operations registered through
`nodeRepl.signal.waitUntil` can remain pending forever. A blocked kernel event
loop can also prevent cancellation from being processed. In either case, the
active cell prevents subsequent execution and reset.

The archived AP job `ap-osworld-v2-61451340fa4a463c-s1` stopped advancing after a
cell containing four CUA actions. Its archive lacks the final tool response and
kernel diagnostics, so it does not prove which operation or layer hung. This
change addresses the independently reproducible unbounded cancellation path.

## Behavior

Keep cooperative cancellation and its binding preservation. After timeout or
explicit cancellation, the host allows five seconds for the kernel to produce
a terminal result. If it remains unresponsive, revoke its generation and
terminate its process tree using the existing bounded termination mechanism.
Return the original `timeout` or `cancelled` status, report that bindings were
lost, and tell the caller to verify external state before retrying actions.

Clear the cancellation timer on every execution exit. Its callback must only
revoke the kernel associated with that execution. Subsequent calls can start a
fresh kernel; registered module roots remain available.

## Decisions and constraints

The deadline belongs to the host, whose event loop is separate from the code
being executed. Timing out only the kernel's promise would not recover from a
blocked event loop. Five seconds allows cooperative native cleanup without
extending a cell timeout indefinitely. No new configuration or public tool is
needed.

Process termination discards bindings and module state. It cannot roll back
actions already dispatched to applications or remote services. The result must
state this uncertainty rather than imply that cancellation undid the action.

## Validation and acceptance

- A never-settling cancellation barrier returns a terminal timeout; explicit
  cancellation returns a terminal cancellation. Queued work can proceed.
- A kernel blocked after an asynchronous boundary is terminated by the host.
- Cooperative cancellation still waits for native terminal results and retains
  the kernel and earlier bindings. No expired timer can kill a later cell.
- MCP callers receive the state-loss notice and can execute a fresh cell.
- Package tests, build, typecheck, and the independent reproduction pass.
