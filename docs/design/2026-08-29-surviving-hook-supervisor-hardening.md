# Surviving hook supervisor hardening

## Context

PR #10288 made command hooks for `MessageDisplay`, `StopFailure`, and
`SessionDelete` independent of the Qwen process by staging input and launching
a detached Node supervisor. Issue #10386 tracks the non-blocking hardening work
deferred from that PR.

The current `main` already preserves a real hook exit code 124 when only the
parent event loop is delayed, cleans staged input after an early supervisor
exit, and documents generic asynchronous hooks as process-scoped. The remaining
work is limited to the supervisor boundary, its timeout decision, Windows
termination parity, and missing regression coverage.

## Audited scope

| Issue item                                    | Current status                                                           | This change                                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit argv boundary and timeout validation | Still reproducible                                                       | Add `--` after the eval source and reject non-positive or non-finite hook timeouts before dispatch                                                   |
| Parent/supervisor teardown duplication        | Windows fallback behavior has drifted                                    | Keep the standalone eval boundary, share constants, and align success/error/throw fallback semantics                                                 |
| Windows supervisor coverage                   | Entire real-process suite is skipped on Windows                          | Add a Windows-only real supervisor test that verifies liveness and descendant cleanup through taskkill                                               |
| Near-deadline completion race                 | Still reproducible inside the supervisor                                 | Give child exit delivery the current event-loop turn before committing to timeout and let natural completion win when no termination signal was sent |
| Loader environment isolation                  | `LD_PRELOAD` and `DYLD_INSERT_LIBRARIES` reach the internal Node process | Remove loader variables from the supervisor environment and pass them as inert JSON for restoration only in the configured hook                      |
| Parent-side staged-input cleanup coverage     | Runtime behavior is already correct                                      | Add a regression test for a supervisor that closes before unlinking                                                                                  |
| Generic async lifecycle compatibility         | Runtime, docs, and the final merged PR statement are already correct     | Keep generic async hooks process-scoped; no runtime or documentation change is needed                                                                |

## Design

The supervisor remains an eval program. Moving it to a separate executable
asset would make the source easier to share but would add bundle and asset-copy
requirements for a small internal process. Instead, the parent and supervisor
continue to share termination constants, while tests pin the mirrored Windows
fallback behavior.

Hook timeout validation happens at `HookRunner.executeHook`, the common runtime
boundary used by sequential, parallel, synchronous, and asynchronous dispatch.
It does not change timeout units or defaults for any hook type.

The parent removes `NODE_OPTIONS`, `LD_PRELOAD`, and
`DYLD_INSERT_LIBRARIES` from the internal supervisor environment. Defined
values are serialized as one JSON argv value. The supervisor restores those
values only in the actual hook environment, so user-configured hook behavior is
preserved without allowing loader configuration to alter the internal Node
program.

At the deadline, timeout handling is deferred to the check phase of the same
event-loop turn. This lets a child exit already waiting for delivery update the
supervisor state first. If the process group disappeared before a termination
signal could be sent, the supervisor keeps the natural result rather than
inventing a timeout. A genuinely live group is still terminated at the same
configured deadline, apart from the bounded current-turn scheduling delay.

## Verification

- Unit tests reject invalid timeout values without spawning a hook, verify the
  explicit argv separator and loader environment transfer, align Windows
  fallback behavior, and prove parent cleanup after an early supervisor close.
- POSIX process tests distinguish a real timeout from natural exit 0 and exit
  124 within the supervisor's final poll interval.
- A Windows-only process test launches the real supervisor and a hook descendant,
  then verifies timeout cleanup through the real taskkill path.
- Existing parent-exit, timeout, abort, input integrity, and process-scoped async
  tests remain green.

## Compatibility and risk

Invalid configured timeouts now fail before hook dispatch instead of relying on
platform timer coercion. Generic `async: true` command hooks remain scoped to
the Qwen process as shipped by #10288; this is a compatibility clarification,
not a new lifecycle change in this patch. Windows runtime verification depends
on the repository's Windows test lane.
