# Workspace-resident Managed Tool Runtime

[English](2026-10-15-managed-workspace-resident-runtime.md) | [简体中文](2026-10-15-managed-workspace-resident-runtime.zh-CN.md)

Status: proposal (PR0). Nothing below is implemented. Tracking issue:
[#14211](https://github.com/QwenLM/qwen-code/issues/14211). Part of the
Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
Code references are to `main` @ `355ac8032d`.

## 1. Problem

A Managed Tool Runtime (`qwen managed-runtime-worker`) is placed by the
Runtime Broker per binding generation. For Workspace-bound Sessions the
deployment must use the `local-process` provisioner with `session` isolation,
so every Hosted Session gets its own worker. That worker survives across the
Session's Turns and a Broker restart, but:

- no second Session on the same storage can reuse it, so every new Session
  starts its own worker, and its first tool call waits for whatever part of
  that cold start concurrent model inference did not hide;
- nothing starts a worker before a Turn needs it;
- nothing stops an idle worker. A Session that is never closed keeps its
  worker indefinitely, and the server README asks operators to budget the
  resulting process, memory and state-directory growth.

This design makes the Tool Runtime **resident per Workspace storage**: one
long-lived worker per `(tenant, storage)` shared by every bound Session on that
storage, started ahead of demand, and retired with stop evidence when idle.

## 2. Current state

Verified on `main` @ `355ac8032d`:

| Area                              | Behaviour                                                                                                                                                                                                                                                                                        | Reference                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation for bound Sessions      | Workspace files require a Session-isolated `local-process` Broker with Workspace mounts. Child Workspaces additionally require durable local workers. The default `isolation-class` is `session`.                                                                                                | `ManagedAgentProperties.java:153-168`, `:199-209`, `:891`; `WorkspaceRuntimeResolver.java:34-38`                                                                                    |
| Placement identity                | Workspace isolation has no isolation key, so one binding serves the full scope (tenant, Workspace, generation, mount root, capability digest, kind, storage). Session isolation keys the binding by Harness Session ID. `cwdRelative` is not part of placement identity.                         | `managed-runtime-broker-service-core.md`; `JdbcRepositorySupport` request key                                                                                                       |
| One worker, many Runtime Sessions | A boot v2 worker installs one context per Runtime Session and runs each Session in its own effective directory. A later tool turn uses a new Runtime Session ID.                                                                                                                                 | `2026-09-26-managed-context-worker.md`; `2026-09-26-managed-workspace-execution.md`                                                                                                 |
| Warm                              | Warm is on demand only. Java warms the Session's Runtime when a Turn is dispatched, concurrently with model inference. The Harness calls the Broker's `/runtimes:warm` right before it acquires a Runtime Session for a tool turn, Hook execution or file rewind. Nothing warms ahead of demand. | `HarnessCoordinator.java:348`, `:862`; `RuntimeBrokerHttpServer.java:158`; `hosted-workspace-tool-turn.ts:1599`                                                                     |
| Session close                     | `SessionLifecycleCoordinator` calls `closeWorkspace`, which runs `drainHarnessSession`. That enumerates only bindings with `isolation_class = 'session' AND isolation_key = <harness session>`, drains them, and requires `stopDrained` proof before `RELEASED`.                                 | `SessionLifecycleCoordinator.java:409`, `:440`; `EmbeddedRuntimeBroker.java:297`; `RuntimeBrokerService.java:303`, `:379`, `:416`, `:438`; `JdbcRuntimeBindingRepository.java:1117` |
| Worker stop                       | `LocalProcessRuntimeProvisioner.stopDrained` stops only drained, managed-context, Session-isolated bindings of the Workspace profile. `release` does nothing in durable mode.                                                                                                                    | `LocalProcessRuntimeProvisioner.java:292`, `:309`                                                                                                                                   |
| Stop admission                    | `WorkspaceExecutionStore.canStopDrained` and `RuntimeAdmission.requireStoppedRelease` require `local-process` and Session isolation, and match storage holders against the binding's isolation key.                                                                                              | `WorkspaceExecutionStore.java:441`; `RuntimeAdmission.java:42-46`                                                                                                                   |
| Placement while draining          | `requireRecoverablePlacement` treats a `DRAINING` binding on the same tenant and storage, directory or Workspace as blocking. It refuses a new generation with non-retryable `409 runtime_placement_recovery_required`.                                                                          | `JdbcRuntimeBindingRepository.java:1964`; `RuntimeBindingRecord.java:368`                                                                                                           |
| Binding-level drain               | `retireStorageBinding` drains one exact binding generation under a storage fence (used by Workspace migration).                                                                                                                                                                                  | `RuntimeBrokerService.java:393`                                                                                                                                                     |
| Idle reclamation                  | None for live bindings. Retention only prunes old `FAILED`/`RELEASED` rows.                                                                                                                                                                                                                      | `runtime-broker-jdbc-retention.md`                                                                                                                                                  |
| Worker retention                  | Context installations are kept for the worker's lifetime. The executor's `closedSessions` set and the provider's released-Session tombstones grow by one small entry per Runtime Session; the provider keeps eight released Sessions live.                                                       | `managed-context-envelope.ts:353`; `managed-runtime-tool-executor.ts:354`; `managed-runtime-provider-worker.ts:124`                                                                 |
| Close evidence                    | Reliable close is complete only when admission is fenced and the original writers, Sessions, worker and holder are settled. Today that means the original worker process stopped.                                                                                                                | `workspace-session-reliable-close.md`                                                                                                                                               |
| Kind literals                     | Capability decisions compare the provisioner kind with `"local-process"` in several places (Section 4.1).                                                                                                                                                                                        | Section 4.1                                                                                                                                                                         |

## 3. Goals and non-goals

Goals:

- A bound Session can be placed on a Workspace-isolated binding, so all bound
  Sessions on one storage share one worker generation.
- A worker can be started before the first tool call needs it.
- An idle worker is retired with the same stop evidence as today's reliable
  close. A long-lived worker is replaced at a bounded size.
- Capability decisions no longer depend on the `"local-process"` literal.
- Every change is behind configuration whose default keeps today's behaviour.

Non-goals:

- Changing the invariant that one worker process is one binding generation.
  The attestation, seed, incarnation, in-memory journal and `UNKNOWN` rules
  stay as they are.
- Remote placement (SSH, reverse-connected workers) or a registered resident
  worker that replaces `static`. Both need worker-side lease registration and
  their own design.
- Changing the default isolation class or Session-isolated close semantics.
  Session isolation stays the default. Its only change is opt-in idle
  retirement (4.4).
- Concurrent tool turns on one storage. `ma_storage_owner` keeps serializing
  them.

## 4. Design

"Resident" is a property of the binding lifecycle, not of process identity.
A Workspace-isolated binding generation is created once, shared, outlives any
one Session, and ends only through an explicit, evidenced retirement. The
worker it names is still exactly one process with one seed, one lease and one
in-memory journal.

### 4.1 Provisioner capabilities (PR1)

PR1 introduces capability methods on `RuntimeProvisioner` (or a small policy
object next to it) and converts the capability-type kind checks. It changes no
behaviour: every capability returns, for `local-process`, exactly what the
literal check returns today.

| Site                                                                                               | Check today                                                                     | Classification                                | PR1 action                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `WorkspaceRuntimeTransport.java:293-297`                                                           | v3 capture/publisher only on `local-process`                                    | capability: same-host capture                 | `supportsLocalCapture()`                                                         |
| `WorkspaceExecutionStore.java:441-445`                                                             | stop admission only for `local-process` + Session                               | capability + isolation policy                 | `supportsDrainedStop()` plus a `drainedStopIsolation()` policy that PR2 widens   |
| `RuntimeAdmission.java:42-46`                                                                      | stopped release only for `local-process` + Session                              | capability + isolation policy                 | same policy as above                                                             |
| `RuntimeBindingRecord.java:368-376`, `JdbcRuntimeBindingRepository.java:1964-1987`                 | an unleased `RECOVERY_BLOCKED` `local-process` binding does not block placement | capability: failed startup leaves no resource | `unattestedFailureLeavesNoResource()`; the SQL keeps a kind list derived from it |
| `RuntimeRecoveryCoordinator.java:30`, `JdbcRuntimeBindingRepository.java:1461`                     | recovery scan for `local-process` handle v2                                     | capability: startup recovery                  | scan by the configured provisioner's kind and handle version                     |
| `ManagedAgentProperties.java:157`, `:203`; `WorkspaceRuntimeResolver.java:35`                      | Workspace execution only on `local-process`                                     | capability: Workspace execution               | `supportsWorkspaceExecution()`; isolation stays `session` until PR2              |
| `EmbeddedRuntimeBroker.java:390`, `:404`, `:484`, `:500`                                           | provisioner selection, local path and ID derivation                             | identity                                      | unchanged                                                                        |
| `WorkspaceRecoveryCommand.java:51`, `WorkspaceOperatorRecoveryStore.java:253`, `LocalRuntimeStore` | operator recovery over local registrations                                      | identity                                      | unchanged                                                                        |

### 4.2 Workspace isolation for bound Sessions (PR2)

#### Configuration

`qwen.managed-agent.runtime-broker.isolation-class=workspace`
(`QWEN_MANAGED_AGENT_RUNTIME_ISOLATION`) becomes valid together with Workspace
files when all of the following hold:

- the provisioner reports `supportsWorkspaceExecution()` and durable drained
  stop;
- `durable-local-process=true`;
- `child-workspaces-enabled=false`. Child Workspace merge depends on a closed
  child stopping its own worker, so the two remain mutually exclusive.

The default stays `session`. The setting applies to new placements only.
Existing Session-isolated bindings keep their saved request and retire at
their Session's close (or through PR4). A Session whose next Turn resolves the
new scope gets a new Runtime Session on the shared binding, which the resolver
contract already allows because a scope change requires a new Runtime Session
identity.

#### Placement and storage ownership

The resolver builds the same request for every bound Session on one storage,
so `findOrCreate` converges them on one binding generation. Storage ownership
is unchanged: the `ma_storage_owner` holder is still per Runtime Session, so a
second Session on the same storage receives retryable `workspace_busy` until
the first Runtime Session releases. That is today's serialization. Only the
worker is now shared.

`canStopDrained` and `requireStoppedRelease` match holders and Runtime
Sessions to the binding by `(binding, generation, runtimeSessionId)` instead
of requiring the holder's Harness Session to equal the binding's isolation
key. Workspace isolation has no isolation key.

#### Session close splits into release and retirement

Closing one Session must not stop a worker that other Sessions use. PR2
splits today's close into two operations:

1. **Session release.** This runs under the existing permanent tenant/Harness
   Session drain fence. It enumerates the closing Session's Runtime Sessions on
   Workspace-isolated bindings (a new query by Harness Session over
   `ma_runtime_session`), and for each active one:
   1. sends provider release;
   2. sends activation release and waits for the original worker's
      acknowledgement. The worker drains that Session's background runs and
      reports that no admitted invocation remains;
   3. conditionally clears the original storage holder;
   4. records `RELEASED`.

   An unsettled or `UNKNOWN` execution of this Session blocks completion
   exactly as today. The binding stays `READY` for other Sessions.

2. **Binding retirement.** This is the existing `drainBinding` path: drain,
   release the remaining Sessions, `stopDrained`, persist the drain receipt,
   then `RELEASED`. It is reached only through PR4's idle retirement or an
   explicit storage retirement, never through one Session's close.

Session-isolated bindings keep today's close unchanged.

**Close evidence (decision, open question 1).** For a Workspace-isolated
Session, reliable close completes on the original worker's activation-release
acknowledgement plus holder release, not on worker process death. Rationale:

- W0c-3 already accepts this same acknowledgement as the condition for
  releasing the storage holder.
- Worker death does not prove that escaped descendants stopped either
  (W0e-2/W0e-3).

If the original worker cannot acknowledge (binding `LOST`, unusable lease),
Session close falls back to today's rule: it waits for binding-level stop or
loss evidence and otherwise stays `recovery_blocked`. Deployments that require
process-stop evidence per Session keep `session` isolation. Archive, delete
and unarchive inherit whatever close evidence the Session's isolation class
provides.

#### Worker-side bounds

Workspace isolation turns per-Runtime-Session growth into growth of one
long-lived process: installations, closed-Session tombstones and
`closedSessions` grow by one entry per tool turn. PR2 does not change the
worker. PR4's generation recycle bounds a generation's lifetime, so these
structures stay bounded without changing their retention rules.

### 4.3 Prewarm (PR3)

Two triggers, both placement-only. They never acquire a Runtime Session,
install a context or execute anything, so actor grants are still checked at
acquisition as today.

- **Session-create warm.** After a bound Session's creation commits, call the
  existing `warm(sessionId)` asynchronously through the existing resolver.
  Under Workspace isolation this is a no-op when the storage's binding is
  already `READY`. It emits no public event because there is no Turn yet.
  Turn-time warm and its `environment.*` events stay unchanged.
- **Keep-warm.** `qwen.managed-agent.runtime-broker.keep-warm` lists
  `{tenant-id, storage-id}` entries that must also appear in `workspace-mounts`.
  A scheduled coordinator calls a new Broker `warmPlacement` entry with a
  request built by the same function the Workspace resolver uses. A test pins
  that a keep-warm request and a bound Session's request for the same storage
  are byte-identical; otherwise the warm worker would land in an unused slot.
  The entry respects storage fences, drain fences and placement blocking, and
  skips a storage whose Registry Workspace is not `ACTIVE`. Keep-warm requires
  Workspace isolation, because a Session isolation key is unknown before a
  Session exists.

### 4.4 Idle retirement and generation recycle (PR4)

`RuntimeIdleReaper` scans bounded pages of `READY` managed-context bindings
whose provisioner supports drained stop, with a rotating cursor, in the same
shape as `RuntimeRecoveryCoordinator`.

**Eligibility.** All of the following, decided by database time:

- no active Runtime Session;
- no unsettled execution, including `:process` rows of background runs;
- no storage holder of this generation;
- no drain request;
- idle for at least `idle-ttl`. PR4 first verifies whether
  `ma_runtime_binding.last_active_at` is maintained on Runtime Session release
  and execution settlement; if not, it maintains that column on those
  transitions instead of adding a second clock.

Keep-warm bindings are exempt from `idle-ttl`.

**Recycle.** A generation that has served at least
`max-sessions-per-generation` Runtime Sessions, or is older than
`max-generation-age`, becomes eligible at its next idle point regardless of
`idle-ttl` or keep-warm. This bounds the worker-side growth in 4.2.

**Race with admission.** Checking "no active Runtime Session" and setting the
drain request must happen in one transaction, under the binding row lock that
Runtime Session admission already takes. After that, admission on the
binding refuses with a retryable code. The reaper therefore never releases a
Runtime Session that a Turn is using, and it has no abort path.

**Placement during retirement.** Today a `DRAINING` binding makes a new
placement on the same storage fail with non-retryable
`runtime_placement_recovery_required`. A Turn arriving during an idle
retirement would therefore fail. PR4 records why a binding is draining
(`idle` or `recycle`, in addition to the existing close/loss paths) and, for
those reasons only, answers retryable `503 runtime_placement_retiring`. PR4
makes the Java and Harness warm and acquire callers retry this code with
backoff within their existing deadlines. Once the
drain receipt commits `RELEASED`, the next warm creates generation + 1. Close,
loss, operator recovery and failed-stop drains keep the non-retryable answer.
Recording the reason needs a schema change, made under the managed schema
consolidation rules.

**Stop.** Retirement reuses `drainBinding` → `stopDrained` → drain receipt →
`RELEASED`. A failed or unconfirmed stop leaves the binding `DRAINING` and
retried with backoff, as reliable close does. A worker found absent
transitions to the existing loss path. Retirement never creates loss
evidence by itself and never starts a replacement while the original is
unsettled.

**Session isolation (open question 2).** When
`idle-retirement.include-session-isolated=true`, the reaper also retires idle
Session-isolated bindings of Sessions that are still open. The Session's next
Turn creates generation + 1 through the ordinary warm path. This removes
today's unbounded growth of idle per-Session workers.

### 4.5 Configuration summary

All keys are proposed. Every behaviour change defaults off.

| Key (`qwen.managed-agent.runtime-broker.`)                 | Default                                                    | Slice |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ----- |
| `isolation-class` (existing)                               | `session`; `workspace` newly admitted with Workspace files | PR2   |
| `keep-warm`                                                | empty list                                                 | PR3   |
| `session-create-warm`                                      | `false`                                                    | PR3   |
| `idle-retirement.enabled`                                  | `false`                                                    | PR4   |
| `idle-retirement.idle-ttl`                                 | to be measured                                             | PR4   |
| `idle-retirement.max-sessions-per-generation`              | to be measured                                             | PR4   |
| `idle-retirement.max-generation-age`                       | to be measured                                             | PR4   |
| `idle-retirement.include-session-isolated`                 | `false`                                                    | PR4   |
| `idle-retirement.scan-delay`, `idle-retirement.batch-size` | bounded like recovery (5 s, 8)                             | PR4   |

Durations follow the existing unit rules and must be written with a suffix.

## 5. Decisions and rationale

| Decision                                                                | Rationale                                                                                               | Rejected alternative                                                                                                                          |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Make the binding resident, not the process                              | Keeps the seed, attestation, incarnation and `UNKNOWN` rules, which W0e physically validated.           | A long-lived process that accepts multiple leases and persists its journal: it rewrites the recovery model and needs a durable receipt store. |
| Share per `(tenant, storage)` through Workspace isolation               | Reuses the existing isolation class and placement key; storage holders already serialize turns.         | A pool of pre-started Session-isolated workers: the isolation key is unknown before a Session exists.                                         |
| Session close releases; only retirement stops                           | Closing one Session must not stop a worker other Sessions use.                                          | Stop the worker when its last Session closes: it removes residency exactly when it matters, and races with the next Session.                  |
| Activation-release acknowledgement as Workspace-isolated close evidence | Already trusted for holder release; process death is not stronger evidence for escaped descendants.     | Require process death per Session: it is incompatible with sharing.                                                                           |
| Retryable answer only for idle/recycle drains                           | A Turn must not fail because the platform reclaimed an idle worker. Loss and close keep failing closed. | Make every `DRAINING` retryable: it hides real recovery conditions.                                                                           |
| Exclude child Workspaces                                                | Their merge depends on a closed child stopping its own worker.                                          | Generalize child close in this work: it is a separate design.                                                                                 |

## 6. Delivery slices

| PR  | Scope                                        | Depends on | Behaviour change |
| --- | -------------------------------------------- | ---------- | ---------------- |
| PR0 | This bilingual design                        | —          | none             |
| PR1 | Provisioner capabilities (4.1)               | —          | none             |
| PR2 | Workspace isolation for bound Sessions (4.2) | PR1        | opt-in           |
| PR3 | Prewarm (4.3)                                | PR2        | opt-in           |
| PR4 | Idle retirement and recycle (4.4)            | PR2        | opt-in           |

PR3 and PR4 can proceed in parallel. If PR2 exceeds roughly 1000 production
lines, split it into the Broker release/retirement split and the control-plane
configuration plus end-to-end tests. Each slice updates this document in both
languages.

## 7. Failure semantics

| Event                                           | Behaviour                                                                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Session A closes while B uses the shared worker | A's Runtime Sessions release through the original worker; the binding stays `READY`; B is unaffected.                               |
| A's close meets an `UNKNOWN` execution of A     | A's close stays `recovery_blocked`; the binding and B are unaffected.                                                               |
| Original worker cannot acknowledge A's release  | A's close waits for binding-level stop or loss evidence (today's rule).                                                             |
| Turn arrives during idle retirement             | Retryable `runtime_placement_retiring`; succeeds on generation + 1 after the drain receipt.                                         |
| Idle stop fails or is unconfirmed               | Binding stays `DRAINING`; stop retried with backoff; no replacement starts.                                                         |
| Worker dies while idle                          | Existing loss path. A same-boot death leaves holders pinned for recovery.                                                           |
| Broker restarts with a resident worker          | Existing durable adoption re-attests the original worker.                                                                           |
| Reaper and admission race                       | Serialized under the binding row lock; admission either wins (reaper skips) or sees the drain request and gets a retryable refusal. |

## 8. Risks and constraints

- **Weaker close evidence.** Workspace-isolated Session close relies on a
  worker-attested release. This is opt-in, documented, and Session isolation
  remains the default.
- **Blast radius.** A shared worker crash affects every Session on that
  storage. The storage-level effect matches today's:
  - a `LOST` managed-context binding already blocks new placement on the same
    storage until recovery (`RuntimeBindingRecord.java:368`), whichever
    Session's worker crashed;
  - the storage holder already admits only one active Runtime Session per
    storage, so a crash interrupts at most that one Session's work.

  What changes is that Sessions which were idle on that storage now lose a
  warm worker as well.

- **Retention.** Durable mode still never prunes registration and lock files.
  Retirement reduces live processes, not state-directory entries.
- **Unmeasured defaults.** TTL, recycle thresholds and keep-warm cost need
  measurement on the target deployment before any default is proposed.
- **Linux only.** Durable local workers and drained stop require Linux, so
  this feature does too.

## 9. Validation plan

- **PR1:** Existing Java and TypeScript suites stay green. Add unit tests
  pinning each new capability for every provisioner kind to the old literal
  outcome.
- **PR2:** Real-process E2E on Linux with durable local workers and MySQL:
  - two Sessions share one binding ID, generation and worker PID;
  - same-storage turns serialize with `workspace_busy`;
  - closing A leaves B's next Turn on the same worker;
  - A's background Shell run is stopped by A's close while B's continues;
  - a Broker `SIGKILL` adopts the shared worker;
  - a lost acknowledgement retries against the same closed gate;
  - Session-isolated close is unchanged.
- **PR3:** Keep-warm and Session-create warm reach `READY` before the first
  tool call. A pinned test shows request byte-equality with the resolver. A
  fenced or inactive storage is skipped.
- **PR4:**
  - an idle retirement yields a drain receipt and `RELEASED`;
  - a Turn during retirement is retried and succeeds on generation + 1;
  - recycle happens after N Sessions;
  - SQL concurrency tests cover reaper versus admission;
  - stop failure and worker death during idle follow their paths;
  - with Session isolation included, an open Session continues on a new
    generation.
- **All:** build, typecheck, bundle, Java tests and Checkstyle, and two clean
  full-diff self-audits.

## 10. Acceptance criteria

- With defaults, behaviour and SQL state are identical to today.
- With Workspace isolation, every bound Session on one storage uses one live
  generation at a time, and closing one Session never stops it.
- No idle retirement releases an active Runtime Session, and no Turn fails
  non-retryably because of an idle or recycle drain.
- Every `RELEASED` resident binding carries a drain receipt or loss and
  stopped-writer evidence.
- No path replays an `UNKNOWN` execution or starts a replacement while the
  original generation is unsettled.
- Both language versions of this document reflect each landed slice.

## 11. Out of scope and follow-up

- A durable, attested registered resident worker that replaces `static`. It
  needs worker-side lease registration and rotation and its own design.
- Remote placement over SSH and reverse-connected workers.
- Generalizing child Workspace close to shared workers.
- Pruning durable registration and lock files.

## 12. Open questions

1. Is the original worker's activation-release acknowledgement acceptable as
   reliable-close evidence for Workspace-isolated Sessions (4.2)?
2. Should idle retirement also cover idle Session-isolated bindings of open
   Sessions (4.4)?
3. Is keep-warm needed in the first delivery, or is Session-create warm
   enough (4.3)?
4. Which deployment measurements set the TTL, recycle and keep-warm
   defaults?
