# Hosted process crash fault gates (FG6c)

[English](hosted-process-crash-fault-gates.md) | [简体中文](hosted-process-crash-fault-gates.zh-CN.md)

## Problem and current state

Issue #12872 requires process-crash evidence across the packaged Hosted Harness,
Spring Session Store and Runtime Broker, and the real managed worker. FG6a and
FG6b cover lost replies and failed Store commits, but their Spring fixture runs
inside the test JVM. Graceful teardown cannot establish SIGKILL behavior.

The actual tool order is prepare, durable intent, `await_runtime`, start, result
message, and `results_ready`. A crash immediately after prepare can therefore
leave a reservation and an accepted input without a durable tool intent.

## Proposed tests

Add a separate Java integration test and child Spring fixture, plus a TypeScript
driver using the packaged CLI, deterministic model, and real file Edit tool.
Each case uses its own tenant, saved workspace, Session, and runtime directory.
The database must identify itself as MySQL or MariaDB; H2 is not sufficient.

| Case              | Boundary                                                     | Expected durable state                                     |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `harness-prepare` | Successful prepare reply, before delivery to Harness         | One reservation, no dispatch, no intent                    |
| `harness-start`   | Successful start while real tool is in flight                | One dispatch, `await_runtime`, no result commit            |
| `harness-result`  | Tool result message commit request, before Store receives it | One completed effect, `await_runtime`, no result commit    |
| `spring-kill`     | Real worker is executing a tool                              | Spring is killed and restarted against the same database   |
| `worker-kill`     | Real worker is executing a tool                              | Worker receives SIGKILL; uncertain outcome remains blocked |
| `worker-stop`     | Real worker is executing a tool                              | Worker receives SIGSTOP; uncertain outcome remains blocked |

An OS-level tool barrier must prove execution has begun before injecting a
signal. No timing guess, mock worker, fake result, or production debug endpoint
may substitute for that proof. The test controller owns process signals and
cleanup; the HTTP proxy forwards real Store/Broker bytes except at the selected
Harness crash boundary. Spring is a separate JVM, using normal application
wiring. Test-only startup code seeds the saved Session and publishes listener
addresses; it adds no production route or recovery behavior.

For the in-flight cases, the saved child directory contains a POSIX FIFO named
`proof.txt`. A nonblocking writer can open it only after the real Edit has opened
its reader. Holding the writer without data prevents completion. The
`harness-start` case supplies `x` after killing Harness, allowing Edit to replace
the FIFO atomically with `xx`. Spring/worker cases withhold data throughout the
assertions, so the FIFO remains and there is no effect. `harness-prepare` and
`harness-result` use a regular file. No tool implementation is substituted.

Spring loss leaves the durable execution `EXECUTING` without a result; the
restarted local provisioner cannot adopt the orphan. Worker loss or suspension
leaves it `UNKNOWN` after the real transport failure or timeout. Both states
retain the original owner and refuse continuation. The SIGSTOP case exercises
the real 30-second transport timeout.

## Assertions and recovery boundary

Record process identities and actual signal termination. Restart Harness with a
new boot identity and allow its short writer lease to expire. Cold load must
read the original SQL journal and return `409 hosted_turn_recovery_required`,
without another model request, prepare, or start. A refused load need not expose
live Session status. Activation bookkeeping may change during attempted load.

Independent JDBC checks verify original prompt/runtime/execution/idempotency
identities, dispatch generation, accepted input, checkpoint phase, and absence
of terminal events. Tool-result commit attempts at the selected boundary must
be absent from SQL. Physical workspace evidence must show at most one effect;
an Edit from `x` to `xx` would become `xxxx` on replay. The Harness home contains
a decoy file, and the saved workspace parent must remain untouched.

The original storage owner must remain held throughout crash and reload. The
fixture must never reclaim or adopt it. SIGSTOP cleanup resumes or kills and
reaps the exact worker; all owned child processes and listeners are cleaned up
on failures as well as success.

## Scope, files, and risks

Changes are confined to test fixtures, the Java integration-test profile and CI
budget, and this bilingual design. Existing reply-loss and Store-failure gates
remain enabled. POSIX signals and the tool barrier require Linux or macOS; this
Hosted database gate runs on Linux CI. Windows process-crash coverage is outside
this increment. Cancellation semantics, SSE reconnect, Shell/provider effects,
automatic continuation, orphan adoption, and W0e reclamation are not exercised
by this gate.

A test barrier must be validated against the real tool before its evidence is
accepted. Process loss can leave an execution unknown even when no filesystem
effect occurred; tests must not convert observation of no effect into permission
to replay. Process deadlines must leave enough room for the real transport's
uncertainty timeout while still bounding CI execution.

## Validation and acceptance

Build, typecheck, and bundle the repository; run focused Hosted tests and all six
selected crash cases on real SQL. Independently verify each injection and its
persisted evidence. Remove the production unsettled-input admission guard and
require every case to fail behaviorally with fault injection unchanged. Add
other targeted guard mutations where needed to establish the checkpoint and
unknown-outcome assertions. Restore sources and rerun the normal gate.

Read the complete diff in open-ended and reverse audit passes until two
consecutive passes are clean. After the fifth round, only Critical fixes enter
this change. No known design question remains; implementation observations and
verified limitations must be synchronized in both language versions.
