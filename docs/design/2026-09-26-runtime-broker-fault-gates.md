# Runtime Broker Fault Gates

[English](2026-09-26-runtime-broker-fault-gates.md) | [简体中文](2026-09-26-runtime-broker-fault-gates.zh-CN.md)

Status: implemented as tests in `packages/sdk-java/runtime-broker`. On the
managed agent branch the gates run against its own Broker service, worker and
local-process provisioner, and they found two dispatcher faults, fixed in
`RuntimeBrokerService` (§3.4).

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
   │   HttpRuntimeTransport and the provisioner's health probes, on an
   │   HttpClient proxied to ──────────────────────────► FaultProxy (test JVM)
   │   LocalProcessRuntimeProvisioner (shared state dir)   │ forwards, then drops,
   │     └─ node dist/managed-runtime-worker.js ◄──────────┘ resets or holds
   │                                                         the answer
   └─ JDBC ─► [TcpRelay, cut on demand] ─► H2 TCP server, file-backed (test JVM)
```

- `FaultGateBroker` runs the production `RuntimeBrokerService` with
  `JdbcRuntimeBindingRepository`, `JdbcRuntimeSessionRepository` and
  `JdbcToolExecutionRepository` in its own JVM. A gate starts it as a
  subprocess (`BrokerProcess`) and drives `warm`, `acquire`, `prepare`,
  `create`, `get`, `cancel`, `reconcile`, `resolve` and `release` over
  standard input. A Broker can be SIGKILLed alone, which leaves its worker
  running as a crashed JVM does, or frozen and thawed with SIGSTOP and
  SIGCONT.
- The Broker's `HttpRuntimeTransport` and its provisioner share an
  `HttpClient` whose proxy is a `FaultProxy`, so every health probe, attest,
  Session verb, Tool v2 control verb, execute, status and cancel request
  crosses it. The proxy forwards each request and applies the next fault
  scheduled for that operation: `DROP` closes silently, `RESET` resets the
  socket, `HOLD_REQUEST` never forwards until released, `HOLD_RESPONSE` holds
  the worker's answer until released. It logs every request on arrival, so a
  gate can count the transport calls a Broker made.
- The worker is `node dist/managed-runtime-worker.js`, started by the
  production `LocalProcessRuntimeProvisioner`. Every Broker of a rig shares
  one state directory, as the Brokers of one host would, so a restarted or
  second Broker finds a running worker through its process record and adopts
  it. The scope's workspace ID is the one the daemon derives from the
  canonical workspace path, which the worker checks.
- A gate prepares each tool call the way the Hosted Harness does: through the
  Broker's control verbs it reads the manifest, begins the turn, prepares a
  foreground `run_shell_command` call and runs its pre-tool hook. The
  invocation reference that comes back is what it executes. The command
  appends to a marker file in the workspace, so the side effect is counted by
  what the tool itself wrote.
- Every Broker uses one file-backed H2 database behind a TCP server in the
  test JVM, so a restarted or second Broker sees the same rows, and the gate
  reads them directly. A `TcpRelay` in front of it can be cut, which resets
  open connections and refuses new ones.
- No production class gains a fault hook. The fault lives in the network,
  the database link or the process table.

The gates need no test adapters: the transport implements the Session verbs,
and the provisioner adopts workers across Broker processes. The worker's
standard error goes to `workers.log` in the rig directory, which a failing
gate reports with the Brokers' logs.

The rig's operation lease is 10 s: the worker is a full serve runtime, and
recovery gives up after four operation leases. The dispatch lease is 2 s. A
tool request waits as long as the tool runs, up to ten minutes, so only the
attestation has a short timeout.

The gates run only in the Maven profile `fault-gates` (JUnit tag
`fault-gate`), which the default `mvn test` excludes. Missing prerequisites
fail explicitly: the bundle (`-Dqwen.cli.entry`, default
`<repository>/dist/cli.js`, with `managed-runtime-worker.js` next to it),
Node.js on `PATH`, and a POSIX system. The rig kills every worker, including
orphans of killed Brokers, when a gate ends.

### 3.2 Invariants

Each gate asserts, where it applies:

- the side effect ran at most once, counted by the marker the tool wrote, and
  the proxy saw at most one execute for the call;
- nothing reported a completion that did not happen: no reply and no row
  says settled or cancelled without the Runtime's answer;
- a lost answer is recovered only from the Runtime's own record of the call,
  looked up by its reference; an `UNKNOWN` execution stays `UNKNOWN` until
  the original Runtime gives terminal evidence or an operator decides it;
- a query by the original identity returns the original result: the row's
  result equals what the worker answers to `status` by reference.

### 3.3 Gates

| Gate                         | Fault                                                                                                                                                                                        | Asserted outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FG1 control                  | none                                                                                                                                                                                         | The provisioner sees the worker healthy and the service attests it once before the binding is `READY`. Acquire's Session verb carries the lease's token, ID and epoch, which the worker checks on every request, so reuse needs no new attestation. The call settles `success`, the marker has one line, the proxy saw one execute, and `status` by reference returns the stored result.                                                                                             |
| FG2 execute lost             | `DROP` or `RESET` of the execute answer, after the worker ran the call                                                                                                                       | The dispatcher looks the call up again and settles it `success` from the Runtime's record, never `UNKNOWN`. A same-key retry answers from the settled row and dispatches nothing. An execute of the same reference sent straight to the worker joins the original call, and `status` returns the stored result. One marker line, one execute.                                                                                                                                        |
| FG2 status lost              | The execute answer dropped, then the recovering lookup's answer held, dropped and reset                                                                                                      | While the answer is held, the row is `EXECUTING` without a result. The dropped and reset lookups settle nothing; the next answered lookup settles `success`. One marker line, one execute.                                                                                                                                                                                                                                                                                           |
| FG2 cancel lost              | `DROP` of the cancel answer during a `sleep 5` command                                                                                                                                       | The cancel call fails. The worker did abort the command, so the row settles `cancelled` from the execute answer. The command's tail never runs, and `status` returns the same result.                                                                                                                                                                                                                                                                                                |
| FG2 attestation lost         | `DROP` of one attestation, or of every attestation until the recovery deadline (3 s operation lease)                                                                                         | One lost answer is proven again: `READY` follows a second attestation of the same worker. With every answer lost, warm fails retryably and the binding never gets a lease; once an answer arrives, the next warm proves the same worker and binding instead of starting another.                                                                                                                                                                                                     |
| FG3 worker killed            | SIGKILL of the worker tree during `sleep 3`                                                                                                                                                  | The dispatcher's liveness check finds the worker gone: the generation is `LOST`, the row `UNKNOWN`, and reconcile answers `409 runtime_broker_execution_evidence_unavailable`. The unknown call pins the placement (#12670), so warm fails with `runtime_broker_runtime_lost`. Once an operator resolves the call and the Session is released, a new generation serves the next warm. The command's tail never runs, and one execute was sent.                                       |
| FG3 Broker killed            | SIGKILL of the Broker JVM after claim (execute held before the worker), after send (the worker is running), or before commit (the worker's answer held); then a new Broker on the same state | The new Broker finds the worker through the state directory, attests it once and adopts the same binding generation and lease without starting a worker. After the dispatch lease lapses, a same-key retry fences the row `UNKNOWN` (`runtime_broker_execution_unknown`) without sending execute. After claim, reconcile stays `UNRESOLVED` (`prepared`) with no marker. After send or before commit, it resolves `success` from the worker's evidence, with one run of the command. |
| FG3 pin: host crash (#12670) | SIGKILL of the Broker and its worker                                                                                                                                                         | The new Broker observes `NOT_FOUND` and marks the binding `LOST`. The unsettled call pins it: `warm` and `acquire` fail with `runtime_broker_runtime_lost`, `release` with `runtime_broker_execution_active`. Reconcile answers `IN_FLIGHT`, and the row stays `EXECUTING`.                                                                                                                                                                                                          |
| FG4 takeover                 | Broker A frozen (SIGSTOP) between database calls, with the worker's answer held; Broker B shares the database and state                                                                      | After A's dispatch lease lapses, B attests the worker once, adopts it and fences the row `UNKNOWN`. A is thawed and handed its answer: the row stays `UNKNOWN` until B resolves it from evidence. Afterwards A answers a same-key retry, cancel, get and reconcile from the settled row, and sends zero requests to its Runtime after the thaw.                                                                                                                                      |
| FG4 storage lost             | Database relay cut while the Broker commits the worker's answer                                                                                                                              | The Broker makes at most a few connection attempts, then stops, and `get` fails instead of reporting a result. After the database returns, the row is still `EXECUTING` without a result. Once the claim lapses, a same-key retry fences it and reconcile resolves it from the worker. One marker line, one execute.                                                                                                                                                                 |

### 3.4 Faults found, and pinned behaviour

The first run on the branch failed FG3 worker killed and FG4 storage lost.
Both were dispatcher faults, now fixed in `RuntimeBrokerService`:

- **A dead worker kept its call executing.** The dispatcher answered every
  failed lookup by looking up again every 25 ms and renewed its claim
  forever, so a worker that died mid-call left the row `EXECUTING` and the
  Broker polling a dead endpoint. After a failed execute or lookup the
  dispatcher now checks the binding's liveness at once, whatever the last
  check found, and backs off to one second while answers keep failing. The
  check asks the provisioner, which finds the worker process gone, so the
  generation is marked `LOST`, and the dispatcher then leaves the call
  `UNKNOWN`: only a `READY` or draining generation can answer for a call,
  while a `LOST` one still counts as active for its Sessions.
- **A failed write stranded the dispatch.** When the store refused a write,
  the dispatcher's callback died silently and so did its claim renewal, but
  the call stayed started in the process, so a retry or a later start did
  nothing and the row stayed `EXECUTING`. Worse, when the write of a
  Runtime's answer failed once, the fallback wrote an `error` result, so a
  store blip could record a successful call as failed. A dispatcher that
  hits a store failure now stops renewing and lets the next start claim the
  call: a live claim resumes it and a lapsed one is fenced `UNKNOWN`. Nothing
  retries the failed write in the background.

One pinned behaviour remains:

- **#12670.** A generation proven `LOST` with an unsettled execution can be
  neither reclaimed nor released until the execution is resolved. The host
  crash gate pins it, and FG3 worker killed shows the way out: an operator's
  resolution, then a new generation. The pin is updated when #12670 is
  decided.

The production restart pin of the first version of these gates is gone: the
branch's provisioner records each worker in the state directory, and a
restarted Broker adopts it, as FG3 Broker killed shows.

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
mvn -Pfault-gates test   # the 14 gates, about 1.5 minutes
mvn test                 # the default suite, gates excluded
mvn checkstyle:check
```

The gates were checked against mutations of production code on the branch.
Each mutation below was applied alone, and the named test failed:

| Mutation                                                            | Test that failed                                               |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| A lost execute answer settles as `error` instead of being looked up | FG2 execute lost                                               |
| After a failed lookup the dispatcher skips the liveness check       | FG3 worker killed                                              |
| A `LOST` generation still counts as able to answer                  | FG3 worker killed                                              |
| `claimDispatch` re-grants a lapsed `EXECUTING` claim                | FG3 Broker killed                                              |
| A failed write of the Runtime's answer is retried as `error`        | `aFailedResultWriteIsNeverRecordedAsAnError` (unit test)       |
| A failed claim renewal leaves the dispatch started                  | `aFailedDispatchRenewalHandsTheCallToTheNextStart` (unit test) |
| Both of the last two together (the code before the fix)             | FG4 storage lost                                               |

## 5. Limitations and follow-up

- A signal cannot reliably stop a Broker between `claimDispatch` and the
  execute call, the window #12477 fixed; its unit test still covers that
  window. FG4 covers the process-level takeover around it.
- The gates need POSIX signals and run on Linux in CI.
- A slow answer is not a lost one: a tool request waits up to ten minutes,
  so the gates do not delay answers past a timeout.
- Loss of the attestation answer during adoption, and lost responses on the
  Session and control verbs, are not covered.
- Follow-up: run the crash and takeover gates on MySQL, and update the pins
  when #12670 is decided.
