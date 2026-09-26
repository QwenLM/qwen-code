# Runtime Broker Fault Gates

[English](2026-09-26-runtime-broker-fault-gates.md) | [简体中文](2026-09-26-runtime-broker-fault-gates.zh-CN.md)

Status: implemented as tests in `packages/sdk-java/runtime-broker`; no
production code changes

Related: #12748 (this work), Stage F of #12380, and the designs it exercises:
[process adoption](2026-09-23-managed-runtime-process-adoption.md),
[binding reconciliation](2026-09-24-runtime-binding-reconciliation.md) and the
[tool contract](2026-09-24-managed-runtime-tool-contract.md).

## 1. Problem

Stage F of #12380 asks every enabled capability to pass ACK-loss,
process-crash, cancellation and storage-failure tests. The Broker ↔ Runtime
tool path (adoption and attestation, the v2 execute/status/cancel transport,
the worker handlers, lease fencing and `UNKNOWN` reconciliation) has been
tested only inside one process, against fake transports and in-memory
repositories. Nothing showed that its rules hold when real processes die or
real responses disappear.

## 2. Scope

In scope: gates FG1–FG4 from #12748 for the tool path, run against the real
service, the real bundled worker, real HTTP, a real database and real process
deaths.

Out of scope: Hosted Harness session and SSE gates, output capture and
delivery gates (after O1b–O3), W0c context-installation faults, Kubernetes
provisioning, and Stage G failover. The failover modes of
`scripts/run-managed-agent-server-e2e.ts` stay outside CI.

## 3. Design

### 3.1 Rig (FG1)

```
 gate (JUnit, test JVM)
   │  one JSON command per stdin line
   ▼
 Broker JVM ── FaultGateBroker: RuntimeBrokerService + JDBC repositories
   │   HttpRuntimeTransport, HttpClient proxied to ──► FaultProxy (test JVM)
   │   LocalProcessRuntimeProvisioner                     │ forwards, then drops,
   │     └─ node dist/cli.js managed-runtime-worker ◄─────┘ resets, delays or holds
   │                                                        the answer
   └─ JDBC ─► [TcpRelay, cut on demand] ─► H2 TCP server, file-backed (test JVM)
```

- `FaultGateBroker` runs the production `RuntimeBrokerService` with
  `JdbcRuntimeBindingRepository`, `JdbcRuntimeSessionRepository` and
  `JdbcToolExecutionRepository` in its own JVM. A gate starts it as a
  subprocess (`BrokerProcess`) and drives `warm`, `acquire`, `create`, `get`,
  `cancel`, `reconcile` and `release` over standard input. A Broker can be
  SIGKILLed alone, which leaves its worker running as a crashed JVM does, or
  frozen and thawed with SIGSTOP and SIGCONT.
- The Broker's `HttpRuntimeTransport` is built on an `HttpClient` whose proxy
  is a `FaultProxy`, so every attest, execute, status and cancel request
  crosses it. The proxy forwards each request and applies the next fault
  scheduled for that operation: `DROP` closes silently, `RESET` resets the
  socket, `DELAY` answers late, `HOLD_REQUEST` never forwards until released,
  `HOLD_RESPONSE` holds the worker's answer until released. It logs every
  request on arrival, so a gate can count the transport calls a Broker made.
- The worker is the production `LocalProcessRuntimeProvisioner` running
  `node dist/cli.js managed-runtime-worker`. Tools are `run_shell_command`
  calls that append to a marker file in the workspace, so the side effect is
  counted by what the tool itself wrote.
- Every Broker uses one file-backed H2 database behind a TCP server in the
  test JVM, so a restarted or second Broker sees the same rows, and the gate
  reads them directly. A `TcpRelay` in front of it can be cut, which resets
  open connections and refuses new ones.
- No production class gains a fault hook. The fault lives in the network,
  the database link or the process table.

Two test adapters close gaps in production code:

- `FaultGateTransport`. The v2 worker contract has no Session verbs, and
  `HttpRuntimeTransport` fails `acquire` and `release` with 501
  (`runtime_session_verb_unsupported`), so the service cannot reach dispatch
  with the production transport alone. The adapter answers those two verbs
  locally and passes attest, execute, status and cancel to
  `HttpRuntimeTransport`. The tool contract design lists the Session verbs as
  follow-up work.
- `RecoverableProcessProvisioner`. `LocalProcessRuntimeProvisioner` keeps
  worker ownership in memory, so a Broker in another process can never
  observe a worker. The adapter wraps the production provisioner, which still
  starts, attests and owns every worker, and adds only a record of each
  worker's pid, start time and endpoint. For a lease it does not own, a
  recorded process that is alive and re-attests is `READY`, a recorded
  process that is gone is `NOT_FOUND`, and a missing record is `UNKNOWN`.
  This stands in for the recoverable local-process provisioning that the
  reconciliation design lists as follow-up work, so the gates can drive the
  service's adoption (#12627) and takeover (#12477) paths against real
  workers.

The gates run only in the Maven profile `fault-gates` (JUnit tag
`fault-gate`), which the default `mvn test` excludes. Missing prerequisites
fail explicitly: the bundle (`-Dqwen.cli.entry`, default
`<repository>/dist/cli.js`), Node.js on `PATH`, and a POSIX system. The rig
kills every worker, including orphans of killed Brokers, when a gate ends.

### 3.2 Invariants

Each gate asserts, where it applies:

- the side effect ran at most once, counted by the marker the tool wrote, and
  the proxy saw at most one execute for the call;
- nothing reported a completion that did not happen: no reply and no row
  says settled or cancelled without the Runtime's answer;
- an `UNKNOWN` execution stays `UNKNOWN` until the original Runtime gives
  terminal evidence;
- a query by the original identity returns the original result: the row's
  result equals what the worker answers to `status` by reference.

### 3.3 Gates

| Gate                         | Fault                                                                                                                                                                                                   | Asserted outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FG1 control                  | none                                                                                                                                                                                                    | Warm attests twice (provisioner, then service), acquire re-attests once, the call settles `success`, the marker has one line, the proxy saw one execute, and `status` by reference returns the stored result.                                                                                                                                                                                                                                                          |
| FG2 execute lost             | `DROP`, `RESET`, or `DELAY` past the 10 s request timeout, after the worker ran the call                                                                                                                | The row goes `UNKNOWN`. A same-key retry returns that row and dispatches nothing. An execute of the same reference sent straight to the worker joins the original call. `status` returns the settled result, and `reconcileExecution` resolves the row to it. One marker line, one execute.                                                                                                                                                                            |
| FG2 status lost              | `DROP`, then `RESET`, of the reconcile lookup                                                                                                                                                           | Each reconcile fails retryably with `managed_runtime_unavailable` and the row stays `UNKNOWN` without a result. The next lookup resolves it.                                                                                                                                                                                                                                                                                                                           |
| FG2 cancel lost              | `DROP` of the cancel answer during a `sleep 5` command                                                                                                                                                  | The cancel call fails. The worker did abort the command, so the row settles `cancelled` from the execute answer. The command's tail never runs, and `status` returns the same result.                                                                                                                                                                                                                                                                                  |
| FG2 attestation lost         | `DROP` of the provisioner's attestation, or of the service's                                                                                                                                            | Warm fails retryably. The binding stays `PROVISIONING` without a lease, and the unattested worker is reaped. The next warm reaches `READY` on the same binding.                                                                                                                                                                                                                                                                                                        |
| FG3 worker killed            | SIGKILL of the worker tree during `sleep 3`                                                                                                                                                             | The row goes `UNKNOWN`, and reconcile answers `409 runtime_execution_evidence_unavailable`. The binding is `FAILED`, and a new generation serves the next warm without settling the old call. The command's tail never runs.                                                                                                                                                                                                                                           |
| FG3 Broker killed            | SIGKILL of the Broker JVM after claim (execute held before the worker), after send (the worker is running), or before commit (the worker's answer held); then a new Broker with the recoverable adapter | The new Broker re-attests the worker twice, as the provisioner observes it and as the service adopts it, then adopts the same binding generation and lease and starts no worker. After the dispatch lease lapses, a same-key retry fences the row `UNKNOWN` without sending execute. After claim, reconcile stays `UNRESOLVED` (`unknown`) with no marker. After send or before commit, it resolves `success` from the worker's evidence, with one run of the command. |
| FG3 pin: production restart  | SIGKILL of a Broker using `LocalProcessRuntimeProvisioner` alone                                                                                                                                        | The new Broker's warm fails with `runtime_broker_reconcile_timeout`. The binding stays `READY` with the old lease, neither adopted nor retired. The orphaned worker finishes the call once. Reconcile answers `IN_FLIGHT`, and the row stays `EXECUTING`.                                                                                                                                                                                                              |
| FG3 pin: host crash (#12670) | SIGKILL of the Broker and its worker                                                                                                                                                                    | The new Broker observes `NOT_FOUND` and marks the binding `LOST`. The unsettled call pins it: `acquire` and `warm` fail with `runtime_broker_runtime_lost`, `release` with `runtime_reconciliation_required`. Reconcile answers `IN_FLIGHT`, and the row stays `EXECUTING`.                                                                                                                                                                                            |
| FG4 takeover                 | Broker A frozen (SIGSTOP) between database calls, with the worker's answer held; Broker B shares the database                                                                                           | After A's dispatch lease lapses, B re-attests the worker twice, adopts it and fences the row `UNKNOWN`. A, whose request timeout outlasts the takeover, is thawed and handed its answer: the row stays `UNKNOWN` until B resolves it from evidence. Afterwards A answers a same-key retry, cancel, get and reconcile from the settled row, and sends zero requests to its Runtime after the thaw.                                                                      |
| FG4 storage lost             | Database relay cut while the Broker commits the worker's answer                                                                                                                                         | The Broker makes at most a few connection attempts, then stops, and `get` fails instead of reporting a result. After the database returns, the row is still `EXECUTING` without a result. Once the claim lapses, a same-key retry fences it and reconcile resolves it from the worker. One marker line, one execute.                                                                                                                                                   |

### 3.4 Pinned behaviour

Two gates pin current behaviour instead of a target:

- **A restarted Broker cannot adopt a worker started by
  `LocalProcessRuntimeProvisioner`.** Its `reconcile` returns `UNKNOWN` for
  any process it does not own, so reconciliation retries until
  `runtime_broker_reconcile_timeout`. The worker becomes an orphan, since it
  has no parent watch. The recoverable adapter shows that the service adopts
  correctly once a provisioner can observe the worker. The pin flips to
  adoption when durable local-process provisioning lands.
- **#12670.** A generation proven `LOST` with an unsettled execution can be
  neither reclaimed nor released. The pin is updated when #12670 is decided.

The FG4 storage gate also pins that nothing retries the failed commit after
the database returns. A bounded retry would satisfy #12748; if one is added,
that assertion changes from `EXECUTING` to the committed result.

### 3.5 Decisions on the open questions

1. **CI placement.** The gates run in the `Hosted no-tool processes / MySQL
8.4 / Java 21` job of `sdk-java.yml` (#12733), the Java 21 lane that
   already installs, builds and bundles the CLI for the Hosted process gates.
   A step after those gates runs `mvn -Pfault-gates test` in
   `packages/sdk-java/runtime-broker` with
   `-Dqwen.cli.entry=$GITHUB_WORKSPACE/dist/cli.js`, bounded at 10 minutes.
2. **Database.** H2 in file mode behind its TCP server, shared by every
   Broker process. The gates do not run on MySQL or MariaDB yet; the lane
   they run in already has a MySQL 8.4 service, which keeps that follow-up
   small.
3. **Harness language.** Java, around the Broker service, so each fault has a
   deterministic injection point. The TypeScript failover script stays
   separate.
4. **#12670.** Pinned, as described in §3.4.

## 4. Validation

With the bundle built at the repository root (`npm run build && npm run
bundle`), run in `packages/sdk-java/runtime-broker`:

```bash
mvn -Pfault-gates test   # the 16 gates, about 1.5 minutes
mvn test                 # the default suite, gates excluded
mvn checkstyle:check
```

The gates were checked against mutations of production code. Each mutation
below was applied alone, and the named gate failed:

| Mutation                                                 | Gate that failed                    |
| -------------------------------------------------------- | ----------------------------------- |
| A failed execute settles as `error` instead of `UNKNOWN` | FG2 execute lost, FG3 worker killed |
| A failed execute is sent once more                       | FG2 execute lost                    |
| A failed status lookup counts as `not_started`           | FG2 status lost                     |
| A failed cancel counts as `cancelled`                    | FG2 cancel lost                     |
| The service ignores a failed attestation                 | FG2 attestation lost                |
| The provisioner ignores a failed attestation             | FG2 attestation lost                |
| `claimDispatch` re-grants a lapsed `EXECUTING` claim     | FG3 Broker killed                   |
| A Runtime `unknown` counts as `not_started`              | FG3 Broker killed (after claim)     |
| A fenced dispatcher commits its late answer              | FG4 takeover                        |
| A failed commit is retried in a loop                     | FG4 storage lost                    |
| A dead worker's `UNKNOWN` call is settled as `error`     | FG3 worker killed                   |
| Reconcile also looks up settled rows                     | FG4 takeover                        |
| The service adopts a worker without re-attesting it      | FG3 Broker killed, FG4 takeover     |

## 5. Limitations and follow-up

- A signal cannot reliably stop a Broker between `claimDispatch` and the
  execute call, the window #12477 fixed; its unit test still covers that
  window. FG4 covers the process-level takeover around it.
- The gates need POSIX signals and run on Linux in CI.
- Loss of the attestation answer during adoption, and lost responses on the
  Session verbs, are not covered; the Session verbs do not exist yet.
- Follow-up: run the crash and takeover gates on MySQL, flip the two pins
  when durable local adoption and #12670 land, and drop
  `FaultGateTransport` once `HttpRuntimeTransport` implements the Session
  verbs.
