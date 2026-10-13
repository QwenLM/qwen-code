# Runtime Broker Fault Gates

[English](2026-09-26-runtime-broker-fault-gates.md) | [简体中文](2026-09-26-runtime-broker-fault-gates.zh-CN.md)

Status: implemented as tests in `packages/sdk-java/runtime-broker`; no
production code changes

Related: #12748 (FG1–FG4), Stage F of #12380, and the designs the gates
exercise: [process adoption](2026-09-23-managed-runtime-process-adoption.md),
[binding reconciliation](2026-09-24-runtime-binding-reconciliation.md), the
[tool contract](2026-09-24-managed-runtime-tool-contract.md), and for FG5 the
[managed context envelope](2026-09-25-managed-context-envelope.md), the
[managed context worker](2026-09-26-managed-context-worker.md) and
[Workspace execution](2026-09-26-managed-workspace-execution.md).

## 1. Problem

Stage F of #12380 asks every enabled capability to pass ACK-loss,
process-crash, cancellation and storage-failure tests. The Broker ↔ Runtime
tool path (adoption and attestation, the v2 execute/status/cancel transport,
the worker handlers, lease fencing and `UNKNOWN` reconciliation) has been
tested only inside one process, against fake transports and in-memory
repositories. Nothing showed that its rules hold when real processes die or
real responses disappear.

W0c context installation had the same gap. The Broker's managed-context/1
path (boot v2, attestation v3, durable blocking of a startup it cannot prove,
and installation and activation with receipt checks; #12730 and #12754) was
tested against fake provisioners, an in-test peer and a mocked transport, and
the worker's installations only inside one process. #12748 deferred these
faults until #12730 merged; FG5 covers them.

## 2. Scope

In scope: gates FG1–FG4 from #12748 for the tool path, and FG5 for W0c
context installation, run against the real service, the real bundled worker,
real HTTP, a real database and real process deaths.

Out of scope: Hosted Harness session and SSE gates, output capture and
delivery gates (after O1b–O3), the managed agent server's W0c-3 storage
ownership row and grant rechecks (unit-tested in `WorkspaceRuntimeTest`),
Kubernetes provisioning, and Stage G failover. The three failover modes of
`scripts/run-managed-agent-server-e2e.ts` (`--session-failover`,
`--inflight-failover`, `--continuation-failover`) and the `--big-output`
long-answer/cold-restore mode run in the `hosted-harness-mysql` job (#13258);
only the real-model check stays outside CI (see [Hosted Turn failover E2E](2026-09-30-hosted-turn-failover-e2e.md)).

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
  subprocess (`BrokerProcess`) and drives `warm`, `acquire`, `create` (reserve
  and start), `createImmediate` (the immediate `POST /executions` route), `get`,
  `cancel`, `reconcile` and `release` over standard input. A Broker can be
  SIGKILLed alone, which leaves its worker running as a crashed JVM does, or
  frozen and thawed with SIGSTOP and SIGCONT. A command pending on a Broker
  that a gate kills fails as soon as the JVM exits.
- The Broker's `HttpRuntimeTransport` is built on an `HttpClient` whose proxy
  is a `FaultProxy`, so every request to a worker crosses it. The proxy forwards each request and applies the next fault
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

- `FaultGateTransport`. `HttpRuntimeTransport` implements the Session verbs
  (acquire answers Broker-local; release goes through the provider control
  route), so the adapter delegates both to the production transport. Under
  the `MANAGED` placement below its acquire additionally performs the
  W0c-3-style context installation and activation through
  `HttpRuntimeTransport`.
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

For FG5, a gate opens the rig with a `MANAGED` placement:

- The production provisioner gets a storage resolver, so every placement
  selects managed-context/1: the worker starts with boot v2, answers ready
  v2 and is attested with attestation v3. The scope is the Workspace
  execution profile's, with its capability digest and Session isolation. The
  Workspace directory is the mount root, and its child `project` is the
  Session's context directory.
- `FaultGateTransport.acquire` does what the managed agent server's Workspace
  transport (W0c-3) does after its authorization and storage-ownership
  checks: it installs the Session's context through the production
  `HttpRuntimeTransport.installContext`, under an operation ID derived from
  the Runtime Session ID, then activates the Session's gate through
  `activateWorkspace`. Release closes the gate. Both calls check the worker's
  receipt.
- `RecoverableProcessProvisioner` forwards `createRequest`, so a restarted
  Broker places and adopts the same managed binding.
- Tools append their working directory to a file outside every Workspace, so
  a gate sees whether a tool ran and where: in the context directory, the
  mount root or the worker's own directory.

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

FG5 adds, for W0c context installation:

- no tool runs before both the installation and the activation have been
  answered: a failed acquire leaves the Session unusable, the proxy sees no
  execute, and the worker itself refuses a Session it installed but never
  activated;
- a retried installation replays the operation the worker recorded: it
  succeeds while the context directory is moved away, where a new
  installation for another Runtime Session is refused;
- a tool runs only in the Session's context directory, never in the mount
  root or the worker's own directory;
- a managed startup the Broker cannot prove is blocked, never relaunched.

### 3.3 Gates

| Gate                                 | Fault                                                                                                                                                                                                   | Asserted outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FG1 control                          | none                                                                                                                                                                                                    | Warm attests twice (provisioner, then service), acquire re-attests once, the call settles `success`, the marker has one line, the proxy saw one execute, and `status` by reference returns the stored result.                                                                                                                                                                                                                                                          |
| FG2 execute lost                     | `DROP`, `RESET`, or `DELAY` past the 10 s request timeout, after the worker ran the call                                                                                                                | The row goes `UNKNOWN`. A same-key retry returns that row and dispatches nothing. An execute of the same reference sent straight to the worker joins the original call. `status` returns the settled result, and `reconcileExecution` resolves the row to it. One marker line, one execute. The deferred and the immediate route both run it.                                                                                                                          |
| FG2 status lost                      | `DROP`, then `RESET`, of the reconcile lookup                                                                                                                                                           | Each reconcile fails retryably with `managed_runtime_unavailable` and the row stays `UNKNOWN` without a result. The next lookup resolves it.                                                                                                                                                                                                                                                                                                                           |
| FG2 cancel lost                      | `DROP` of the cancel answer during a `sleep 5` command                                                                                                                                                  | The cancel call fails. The worker did abort the command, so the row settles `cancelled` from the execute answer. The command's tail never runs, and `status` returns the same result.                                                                                                                                                                                                                                                                                  |
| FG2 attestation lost                 | `DROP` of the provisioner's attestation, or of the service's                                                                                                                                            | Warm fails retryably. The binding stays `PROVISIONING` without a lease, and the unattested worker is reaped. The next warm reaches `READY` on the same binding.                                                                                                                                                                                                                                                                                                        |
| FG3 worker killed                    | SIGKILL of the worker tree during `sleep 3`                                                                                                                                                             | The row goes `UNKNOWN`, and reconcile answers `409 runtime_execution_evidence_unavailable`. The binding is `FAILED`, and a new generation serves the next warm without settling the old call. The command's tail never runs.                                                                                                                                                                                                                                           |
| FG3 Broker killed                    | SIGKILL of the Broker JVM after claim (execute held before the worker), after send (the worker is running), or before commit (the worker's answer held); then a new Broker with the recoverable adapter | The new Broker re-attests the worker twice, as the provisioner observes it and as the service adopts it, then adopts the same binding generation and lease and starts no worker. After the dispatch lease lapses, a same-key retry fences the row `UNKNOWN` without sending execute. After claim, reconcile stays `UNRESOLVED` (`unknown`) with no marker. After send or before commit, it resolves `success` from the worker's evidence, with one run of the command. |
| FG3 pin: production restart          | SIGKILL of a Broker using `LocalProcessRuntimeProvisioner` alone                                                                                                                                        | The new Broker's warm fails with `runtime_broker_reconcile_timeout`. The binding stays `READY` with the old lease, neither adopted nor retired. The orphaned worker finishes the call once. Reconcile answers `IN_FLIGHT`, and the row stays `EXECUTING`.                                                                                                                                                                                                              |
| FG3 pin: host crash (#12670)         | SIGKILL of the Broker and its worker                                                                                                                                                                    | The new Broker observes `NOT_FOUND` and marks the binding `LOST`. The unsettled call pins it: `acquire` and `warm` fail with `runtime_broker_runtime_lost`, `release` with `runtime_reconciliation_required`. Reconcile answers `IN_FLIGHT`, and the row stays `EXECUTING`.                                                                                                                                                                                            |
| FG4 takeover                         | Broker A frozen (SIGSTOP) between database calls, with the worker's answer held; Broker B shares the database                                                                                           | After A's dispatch lease lapses, B re-attests the worker twice, adopts it and fences the row `UNKNOWN`. A, whose request timeout outlasts the takeover, is thawed and handed its answer: the row stays `UNKNOWN` until B resolves it from evidence. Afterwards A answers a same-key retry, cancel, get and reconcile from the settled row, and sends zero requests to its Runtime after the thaw.                                                                      |
| FG4 storage lost                     | Database relay cut while the Broker commits the worker's answer                                                                                                                                         | The Broker makes at most a few connection attempts, then stops, and `get` fails instead of reporting a result. After the database returns, the row is still `EXECUTING` without a result. Once the claim lapses, a same-key retry fences it and reconcile resolves it from the worker. One marker line, one execute.                                                                                                                                                   |
| FG5 control                          | none                                                                                                                                                                                                    | Warm attests the worker twice and acquire once more with attestation v3. Acquire installs the context once and activates it once, and the call settles `success`, run once in the context directory.                                                                                                                                                                                                                                                                   |
| FG5 installation lost                | `DROP`, `RESET`, or `DELAY` past the request timeout, of the installation answer                                                                                                                        | Acquire fails retryably with `managed_runtime_unavailable` before any activation. The Session cannot run a tool, and the proxy sees no execute. With the context directory moved away, a retry still succeeds while a new installation for another Runtime Session is refused with `409 managed_context_unavailable`, so the retry replays the operation the worker recorded; the Session is then activated. With the directory back, the call runs once in it.        |
| FG5 activation lost                  | `DROP` of the activation answer                                                                                                                                                                         | Acquire fails retryably. A retry, also with the context directory moved away and a new installation refused there, replays the installation and repeats the idempotent activation; the call runs once in the context directory.                                                                                                                                                                                                                                        |
| FG5 managed attestation lost         | `DROP` of the provisioner's attestation, or of the service's                                                                                                                                            | Unlike FG2, warm is not retryable: it fails with `runtime_provision_failed` (provisioner) or `409 runtime_broker_recovery_blocked` (service). The binding is `RECOVERY_BLOCKED` without a lease and the worker is stopped. Later warms and acquires answer `409 runtime_broker_recovery_blocked` without attesting or installing anything.                                                                                                                             |
| FG5 Broker killed during startup     | SIGKILL of the Broker JVM while the provisioner's attestation answer is held; then a new Broker                                                                                                         | Once the dead Broker's startup claim has lapsed, the new Broker finds the resource handle persisted before the spawn and blocks the binding: every warm and acquire answers `409 runtime_broker_recovery_blocked`, with no attestation and no worker. The first worker is orphaned, as in the FG3 pin.                                                                                                                                                                 |
| FG5 worker killed after installation | SIGKILL of the worker after acquire                                                                                                                                                                     | The dead generation is retired, and the next warm starts a new worker, which holds no installation. A new Runtime Session installs its own context there and runs its call once. The old Session's call, sent straight to the new worker, is refused with `409 managed_context_unavailable` and runs nowhere.                                                                                                                                                          |
| FG5 Broker killed after installation | SIGKILL of the Broker JVM with the activation request held (installed) or its answer held (activated); then a new Broker with the recoverable adapter                                                   | In the installed window, the worker refuses a call of the Session it installed but never activated with `409 managed_context_unavailable`. The new Broker re-attests the worker twice and adopts the same generation and lease without starting a worker. With the context directory moved away, its acquire replays the recorded installation and activates once, while a new installation is refused; with the directory back, the call runs once in it.             |
| FG5 pin: context directory removed   | Deletion of the context directory after acquire                                                                                                                                                         | The worker refuses the call before it starts and never records it; a call sent straight to it gets `409 managed_context_unavailable`. The Broker records the row `UNKNOWN`, and reconcile answers `UNRESOLVED` (`unknown`); the tool runs nowhere. The Session stays open: once the directory is back, its next call runs.                                                                                                                                             |

### 3.4 Pinned behaviour

Three gates pin current behaviour instead of a target:

- **A restarted Broker cannot adopt a worker started by
  `LocalProcessRuntimeProvisioner`.** Its `reconcile` returns `UNKNOWN` for
  any process it does not own, so reconciliation retries until
  `runtime_broker_reconcile_timeout`. The worker becomes an orphan, since it
  has no parent watch. The recoverable adapter shows that the service adopts
  correctly once a provisioner can observe the worker. The pin flips to
  adoption when durable local-process provisioning lands.
- **#12670.** A generation proven `LOST` with an unsettled execution can be
  neither reclaimed nor released. The pin is updated when #12670 is decided.
- **A worker's context refusal is recorded as `UNKNOWN`, and the Session
  stays open.** When the context directory is gone, the worker answers
  execute with `409 managed_context_unavailable` before the call starts and
  never records it. The transport reports that code, but dispatch records
  every failed execute as `UNKNOWN`, so no evidence can settle the row,
  although the worker proves it never ran the call. Nor is the Session
  closed: once the directory is back, its next call runs. The
  [envelope](2026-09-25-managed-context-envelope.md) and
  [worker](2026-09-26-managed-context-worker.md) designs say this refusal
  keeps the Session's tool gate closed and marks its context
  `recovery_blocked`; the pin flips when the Broker does that, or settles the
  refusal as `not_started`. In production the managed agent server's
  Workspace transport refuses an unauthorized Session before dispatch, but it
  does not recheck the directory.

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
mvn -Pfault-gates test   # every fault gate (44 today), about 4 minutes
mvn test                 # the default suite, gates excluded
mvn checkstyle:check
```

The gates were checked against mutations of production code. Each mutation
below was applied alone, and the named gate failed. The last five rows
patched the bundled worker instead of the Java code:

| Mutation                                                                                       | Gate that failed                                                                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| A failed execute settles as `error` instead of `UNKNOWN`                                       | FG2 execute lost, FG3 worker killed                                                                                        |
| A failed execute is sent once more                                                             | FG2 execute lost                                                                                                           |
| A failed status lookup counts as `not_started`                                                 | FG2 status lost                                                                                                            |
| A failed cancel counts as `cancelled`                                                          | FG2 cancel lost                                                                                                            |
| The service ignores a failed attestation                                                       | FG2 attestation lost                                                                                                       |
| The provisioner ignores a failed attestation                                                   | FG2 attestation lost                                                                                                       |
| `claimDispatch` re-grants a lapsed `EXECUTING` claim                                           | FG3 Broker killed                                                                                                          |
| A Runtime `unknown` counts as `not_started`                                                    | FG3 Broker killed (after claim)                                                                                            |
| A fenced dispatcher commits its late answer                                                    | FG4 takeover                                                                                                               |
| A failed commit is retried in a loop                                                           | FG4 storage lost                                                                                                           |
| A dead worker's `UNKNOWN` call is settled as `error`                                           | FG3 worker killed                                                                                                          |
| Reconcile also looks up settled rows                                                           | FG4 takeover                                                                                                               |
| The service adopts a worker without re-attesting it                                            | FG3 Broker killed, FG4 takeover                                                                                            |
| A failed transport acquire still marks the Session `READY`                                     | FG5 installation lost, FG5 activation lost                                                                                 |
| `installContext` treats a lost answer as installed                                             | FG5 installation lost                                                                                                      |
| `activateWorkspace` ignores a failed exchange                                                  | FG5 activation lost                                                                                                        |
| A managed startup is not blocked on a retryable failure                                        | FG5 managed attestation lost (service)                                                                                     |
| A persisted managed resource handle no longer blocks a restart                                 | FG5 Broker killed during startup                                                                                           |
| The worker runs a tool of a Session without an installed, activated context, in the mount root | FG5 worker killed after installation, FG5 Broker killed after installation (installed), FG5 pin: context directory removed |
| The worker treats every Session as activated                                                   | FG5 Broker killed after installation (installed)                                                                           |
| The worker verifies every installation again instead of replaying a recorded operation         | FG5 installation lost, FG5 activation lost, FG5 Broker killed after installation                                           |
| The worker installs without verifying the context directory                                    | FG5 installation lost, FG5 activation lost, FG5 Broker killed after installation                                           |
| The worker refuses a tool with another 409 code                                                | FG5 worker killed after installation, FG5 Broker killed after installation (installed), FG5 pin: context directory removed |

## 5. Limitations and follow-up

- A signal cannot reliably stop a Broker between `claimDispatch` and the
  execute call, the window #12477 fixed; its unit test still covers that
  window. FG4 covers the process-level takeover around it.
- The gates need POSIX signals and run on Linux in CI.
- Loss of the attestation answer during adoption is not covered. The Session
  verbs run through the provider control route; FG5 covers only what a
  managed acquire does, installation and activation.
- FG5 exercises the Broker's W0c-2 path and the worker, not the managed agent
  server. `FaultGateTransport` mirrors only W0c-3's installation and
  activation calls; its storage ownership, grant rechecks and directory
  precheck stay covered by `WorkspaceRuntimeTest`.
- The Broker persists nothing for an installation, so FG5 has no
  storage-failure gate, and a two-Broker takeover around an installation is
  not covered. Nor are lost answers to release, which closes the gate.
- A replayed receipt is byte-identical to the original, so a receipt cannot
  tell a replay from a new installation; FG5 proves the replay by moving the
  context directory away, where a new installation is refused. The checks on
  installation and activation receipts are unit-tested
  (`HttpRuntimeTransportTest`); the gates never alter a receipt.
- A call waiting at the activation gate when the worker closes stays
  deferred, as the worker design records.
- Follow-up: run the crash and takeover gates on MySQL, flip the two pins
  when durable local adoption and #12670 land. `FaultGateTransport` now
  delegates both Session verbs to `HttpRuntimeTransport` (its remaining role
  is the MANAGED placement's install/activate), so the earlier "drop it once
  the transport implements the Session verbs" precondition is met; the
  adapter stays only for that placement. Flip the context-directory pin when
  the Broker closes the Session on a context refusal, or settles the refusal
  as `not_started`.
