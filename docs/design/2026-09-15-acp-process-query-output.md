# Preserve ACP process-query output after event-loop stalls

[English](2026-09-15-acp-process-query-output.md) |
[简体中文](2026-09-15-acp-process-query-output.zh-CN.md)

## Problem and evidence

Node 22's `execFile` timeout destroys stdout and stderr before signaling the
command. When the parent event loop stalls past the timeout, a command that
already exited 0 can therefore return a successful callback with lost output.
For a process-tree snapshot this either fails parsing or risks an incomplete
ownership table.

A real `/bin/ps` test reproduced empty successful output in all six blocked
samples, including the existing 2,000 ms timeout; all six unstalled controls
returned valid rows. Injecting a 2,250 ms parent stall immediately after the
first daemon process-query launch reproduced the product error: public session
behavior and both writer seals succeeded, ACP exited 0, but daemon exited 1
with no parseable process-table rows. Its trace confirms pipe destruction before
the successful empty callback. This establishes a controlled failure mechanism;
it does not retrospectively prove the cause of the uninstrumented `WecQ2w` run.

## Decision and scope

Only POSIX process-table queries replace the built-in `execFile` timeout with a
same-duration timer that sends SIGTERM without destroying output pipes. Keep
`execFile` for buffering, UTF-8 decoding, its 8 MiB limit and error handling.
Read the complete callback result before parsing. An already completed successful
command can now supply its buffered output; a command terminated by the timer
still fails. Timer callback exceptions reject the query. Clear the timer on
settlement, including synchronous launch errors.

Keep the existing 1–2,000 ms query signal-timer clamp, 5-second ACP TERM grace,
10-second teardown deadline, process ownership checks and failure reporting.
The query timer sends SIGTERM; it does not independently settle the query
promise. If the query child ignores SIGTERM and never closes, that await can
remain pending despite the surrounding teardown deadline. A forced query
settlement or escalation policy is deferred; the observed timeout samples exited
on SIGTERM and do not establish a hard bound for a signal-ignoring child.
Do not retry an empty table or treat one as success. Windows `taskkill` and
synchronous process queries keep their existing implementation. No new public
option, route, wire field or dependency is added.

## Consumers and boundaries

`queryProcessTable` serves the initial and escalation ownership snapshots, plus
terminal-group verification. All remain process-local and operate on the same
tracked child and known process groups. Query errors retain the existing initial
snapshot failure or conservative live-group handling; no primary-runtime fallback
is introduced.

The registry's callers are the ACP spawn-channel factory (including the default
bridge factory and the daemon's shared registry), the external ACP subagent
executor, and the external Codex subagent executor. They keep their reservation,
signal, drain and ownership contracts. This behavioral fix is separate from the
#11866 bridge extraction and the macOS watcher-exit change.

## Verification and limitations

- Require the unchanged stall-injection daemon scenario to exit 0 with complete
  process-table data, valid writer seals, and no persistent process or listener.
- Verify native-watching daemon shutdown without injection and direct ACP EOF.
- Cover timeout signaling at 2,000 ms, complete descendant discovery after a late
  callback, timer cleanup, timeout signal errors and synchronous kill errors.
- Preserve rejection of missing commands, empty/malformed tables, buffer overflow,
  nonzero exit and signal exit. Keep Windows taskkill assertions unchanged.
- Build, typecheck, bundle, targeted lint, registry/spawn-channel tests and external
  executor tests; then self-audit and independent review.

The unchanged microtask-injection scenario reproduces daemon exit 1 before the
fix and exit 0 after it. The replacement timer actually fires after the stall;
both pipes remain open and the callback receives all 16,560 captured bytes
(720 parseable rows). Public observations match, both writer seals are valid,
and independent process/group/port checks find no remaining resources. Real
subprocess timeout and exit-7 injections still reject the registry operation
while cleaning up the owned child.

Native-watching runs pass both the original 32-skill daemon flow and shutdown
with two active writer sessions. One direct EOF run captured a truncated late
notification and crashed the harness before recording the ACP exit code. A
single improved observer rerun records ACP exit 0 with complete JSON lines;
this does not explain or erase the first observation.

At the original query-output-fix stage on 2026-09-15, build, typecheck, bundle
and targeted lint passed. That stage's four affected test files passed 200 tests:
37 registry and 47 spawn-channel tests in
`query-fix-final-bridge-tests-after-build.log`, plus 116 external-executor tests
in `query-fix-cli-tests.log`, under the shutdown investigation directory.
These are historical run counts, not counts of the current suites after later
main integrations. An initial spawn-channel run could not collect while a
concurrent build removed its workspace dependency; the serial rerun after that
build passed. A mutation that removed timer cleanup failed the new
early-settlement regression test. Two final self-audit passes and independent
source review found no outstanding defect at that stage.

The controlled query-output defect is verified fixed on macOS with Node
v22.22.2. This does not make JavaScript timers preempt synchronous work or fix
that work's latency. The uninstrumented historical shutdown failure, EOF tail
observation and cron watcher's baseline timing limitation remain separate
unresolved observations. This is not completion of all #11866 work.

## Subsequent combined verification

The [EOF output fix](2026-09-15-acp-eof-output.md) separately reproduces and
repairs output truncation. It does not retrospectively explain the observer
crash or the uninstrumented query failure. The final combined bundle passed
native 32-skill and active-writer shutdown. Real subprocess negative cases still
reject: `/bin/sleep 10` received the bounded SIGTERM after 2,001 ms with pipes
open, and a real Node process exiting 7 retained its failure. Both owned target
children were cleaned up; independent checks found no remaining resources.
After restoring the installed Ink patch and rebuilding, both query negative
cases met the same acceptance conditions again. The timeout sent SIGTERM after
2,003 ms with both pipes open; exit 7 still rejected. Registry counts returned
to zero and independent checks found no remaining resources. The rebuilt
1,079-file artifact remained unchanged throughout all eight combined E2E checks.
Full combined acceptance is tracked in the
[completion design](2026-09-15-acp-bridge-completion.md).
