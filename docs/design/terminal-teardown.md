# Coordinated terminal teardown

## Problem

Interactive terminal state is restored through a mix of React unmount effects,
process signal handlers, and the general exit cleanup queue. This creates two
failure modes:

- Kitty keyboard flags can be popped while the alternate screen is still
  active, leaving the push on the main screen unbalanced.
- Terminal restoration can sit behind slow asynchronous cleanup and be skipped
  when the overall cleanup timeout expires. Signal-driven exits, including
  `SIGHUP`, need the terminal restored synchronously before that cleanup begins.

## Design

The interactive signal handler owns graceful handling for `SIGHUP`, `SIGINT`,
and `SIGTERM`. It invokes the current terminal teardown synchronously before
starting asynchronous resource cleanup. Once shutdown starts, it keeps no-op
listeners installed for all three signals until the process exits so a repeated
signal cannot interrupt cleanup. Its disposer runs in the priority cleanup
phase, so non-signal shutdown paths install those guards before asynchronous
resource cleanup begins.

The cleanup registry supports an explicit priority queue. Existing cleanup
continues to run FIFO. The TUI registers one synchronous priority cleanup that
shares the same idempotent teardown with the signal handler and a central
`process.exit()` fallback. Before rendering, it places that fallback ahead of
Ink in the same exit dispatcher so direct exits preserve the terminal ordering.
Component and protocol utilities no longer compete with the coordinated signal
path.

Kitty pushes are tracked per screen. Teardown pops the alternate-screen flags,
unmounts Ink to return to the main screen, and then pops the main-screen flags.
Before unmounting, it performs the existing best-effort memory-pressure check
so React teardown cannot exhaust a near-limit heap. The same path restores stdin
raw mode. If Ink enters the alternate screen but throws before returning an
unmount handle, startup defers the main-screen pop to the `alwaysLast` phase of
the same signal-exit dispatcher Ink uses.

## Alternatives

- Reversing the whole cleanup queue would break existing ordering requirements,
  such as persisting usage before configuration shutdown.
- Writing a fixed set of escape sequences from the signal handler would
  duplicate component state and could disable modes that the CLI did not
  enable.
- Keeping protocol-specific signal handlers would preserve the ordering race.

## Verification

Unit tests cover priority ordering, signal exit codes and duplicate-signal
handling, startup failure restoration, and Kitty listener ownership. Manual
real PTY checks cover direct `process.exit()`, `SIGTERM`, and `SIGHUP`, with and
without the virtualized terminal buffer and with Kitty protocol detection
enabled.
