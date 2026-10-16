# Workspace-resident Managed Tool Runtime

[English](2026-10-15-managed-workspace-resident-runtime.md) | [简体中文](2026-10-15-managed-workspace-resident-runtime.zh-CN.md)

Status: Section 4.1 is implemented by PR1; the remaining sections are
proposals. Revision 1 landed as PR0. Tracking issue:
[#14211](https://github.com/QwenLM/qwen-code/issues/14211). Part of the
Managed Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380).
Code references are to `main` @ `f87698b8c6`. Line numbers were re-checked
there after the Java formatting change on `main`.

Revision 2 (after review on [#14214](https://github.com/QwenLM/qwen-code/pull/14214)):

- PR1 reuses the existing provisioner capabilities and keeps kind-identity
  checks.
- Idle retirement moves ahead of Workspace isolation.
- Workspace isolation now ships with a hard generation budget.
- Harness ownership keyed by the isolation key is listed as PR3 scope.
- Keep-warm is deferred.

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

Verified on `main` @ `f87698b8c6`:

| Area                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                           | Reference                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation for bound Sessions      | Workspace files require a Session-isolated `local-process` Broker with Workspace mounts. Child Workspaces additionally require durable local workers. The default `isolation-class` is `session`.                                                                                                                                                                                                                                                   | `ManagedAgentProperties.java:154-169`, `:200-210`, `:892`; `WorkspaceRuntimeResolver.java:35-38`                                                                                    |
| Placement identity                | Workspace isolation has no isolation key, so one binding serves the full scope (tenant, Workspace, generation, mount root, capability digest, kind, storage). Session isolation keys the binding by Harness Session ID. `cwdRelative` is not part of placement identity.                                                                                                                                                                            | `managed-runtime-broker-service-core.md`; `JdbcRepositorySupport` request key                                                                                                       |
| Harness ownership                 | Several paths derive "which Harness Session owns this" from the binding's isolation key, and therefore only work for Session isolation: <br>• Harness admission fencing skips non-Session scopes. <br>• Close enumerates executions only on bindings whose isolation key is the closing Session. <br>• Hook, MCP and background original-owner recovery and release require it. <br>• Recovery maintenance checks the close fence by isolation key. | `JdbcRuntimeBindingRepository.java:912`; `JdbcToolExecutionRepository.java:110`; `RuntimeBrokerService.java:681`, `:1989`, `:3754`, `:3785`                                         |
| One worker, many Runtime Sessions | A boot v2 worker installs one context per Runtime Session and runs each Session in its own effective directory. A later tool turn uses a new Runtime Session ID.                                                                                                                                                                                                                                                                                    | `2026-09-26-managed-context-worker.md`; `2026-09-26-managed-workspace-execution.md`                                                                                                 |
| Warm                              | Warm is on demand only. Java warms the Session's Runtime when a Turn is dispatched, concurrently with model inference. The Harness calls the Broker's `/runtimes:warm` right before it acquires a Runtime Session for a tool turn, Hook execution or file rewind. Nothing warms ahead of demand.                                                                                                                                                    | `HarnessCoordinator.java:349`, `:863`; `RuntimeBrokerHttpServer.java:158`; `hosted-workspace-tool-turn.ts:1599`                                                                     |
| Session close                     | `SessionLifecycleCoordinator` calls `closeWorkspace`, which runs `drainHarnessSession`. That enumerates only bindings with `isolation_class = 'session' AND isolation_key = <harness session>`, drains them, and requires `stopDrained` proof before `RELEASED`.                                                                                                                                                                                    | `SessionLifecycleCoordinator.java:410`, `:441`; `EmbeddedRuntimeBroker.java:298`; `RuntimeBrokerService.java:303`, `:379`, `:416`, `:438`; `JdbcRuntimeBindingRepository.java:1117` |
| Worker stop                       | `LocalProcessRuntimeProvisioner.stopDrained` stops only drained, managed-context, Session-isolated bindings of the Workspace profile. `release` does nothing in durable mode.                                                                                                                                                                                                                                                                       | `LocalProcessRuntimeProvisioner.java:292`, `:309`                                                                                                                                   |
| Stop admission                    | `WorkspaceExecutionStore.canStopDrained` and `RuntimeAdmission.requireStoppedRelease` require `local-process` and Session isolation, and match storage holders against the binding's isolation key.                                                                                                                                                                                                                                                 | `WorkspaceExecutionStore.java:442`; `RuntimeAdmission.java:42-48`                                                                                                                   |
| Placement while draining          | `requireRecoverablePlacement` treats a `DRAINING` binding on the same tenant and storage, directory or Workspace as blocking. It refuses a new generation with non-retryable `409 runtime_placement_recovery_required`.                                                                                                                                                                                                                             | `JdbcRuntimeBindingRepository.java:1964`; `RuntimeBindingRecord.java:368`                                                                                                           |
| Binding-level drain               | `retireStorageBinding` drains one exact binding generation under a storage fence (used by Workspace migration).                                                                                                                                                                                                                                                                                                                                     | `RuntimeBrokerService.java:393`                                                                                                                                                     |
| Idle reclamation                  | None for live bindings. Retention only prunes old `FAILED`/`RELEASED` rows.                                                                                                                                                                                                                                                                                                                                                                         | `runtime-broker-jdbc-retention.md`                                                                                                                                                  |
| Worker retention                  | Context installations are kept for the worker's lifetime. The executor's `closedSessions` set and the provider's released-Session tombstones grow by one small entry per Runtime Session; the provider keeps eight released Sessions live.                                                                                                                                                                                                          | `managed-context-envelope.ts:353`; `managed-runtime-tool-executor.ts:354`; `managed-runtime-provider-worker.ts:124`                                                                 |
| Close evidence                    | Reliable close is complete only when admission is fenced and the original writers, Sessions, worker and holder are settled. Today that means the original worker process stopped.                                                                                                                                                                                                                                                                   | `workspace-session-reliable-close.md`                                                                                                                                               |
| Provisioner capabilities          | `kind()`, `supportsDrainedStop()` and `supportsStartupRecovery(handle)` already exist on `RuntimeProvisioner`. The kind also appears as the string literal `"local-process"` at 14 production sites. 13 of them are in `managed-agent-server`, which cannot see the package-private `LocalProcessRuntimeProvisioner.KIND`.                                                                                                                          | `RuntimeProvisioner.java:16`, `:90`, `:100`; `LocalProcessRuntimeProvisioner.java:37`                                                                                               |
| Java CI                           | `sdk-java.yml` runs on schedule and manual dispatch only, so a pull request touching `packages/sdk-java` does not run the Java matrix.                                                                                                                                                                                                                                                                                                              | `.github/workflows/sdk-java.yml`                                                                                                                                                    |

## 3. Goals and non-goals

Goals:

- An idle worker is retired with the same stop evidence as today's reliable
  close.
- A bound Session can be placed on a Workspace-isolated binding, so all bound
  Sessions on one storage share one worker generation, and a generation admits
  a bounded number of Runtime Sessions.
- A worker can be started before the first tool call needs it.
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
  retirement (4.2).
- Concurrent tool turns on one storage. `ma_storage_owner` keeps serializing
  them.

## 4. Design

"Resident" is a property of the binding lifecycle, not of process identity.
A Workspace-isolated binding generation is created once, shared, outlives any
one Session, and ends only through an explicit, evidenced retirement. The
worker it names is still exactly one process with one seed, one lease and one
in-memory journal.

### 4.1 Kind identity and isolation policy (PR1)

PR1 is a refactor with no behaviour change. It adds no provisioner capability:
the existing `kind()`, `supportsDrainedStop()` and
`supportsStartupRecovery(handle)` already answer the capability questions this
work needs, and adding parallel ones would duplicate them.

**Kind identity.** Checks that ask "which provisioner placed this binding" or
"which provisioner is configured" stay identity checks. PR1 makes
`LocalProcessRuntimeProvisioner.KIND` public and uses it in place of the
`"local-process"` literal at:

- `ManagedAgentProperties` (`:158`, `:204`, `:885`);
- `EmbeddedRuntimeBroker` (`:391`, `:405`, `:485`, `:501`);
- `RuntimeRecoveryCoordinator:31`, `WorkspaceRecoveryCommand:53`,
  `WorkspaceRuntimeResolver:36`, `WorkspaceRuntimeTransport:295`,
  `WorkspaceExecutionStore:445`, `WorkspaceOperatorRecoveryStore:254`;
- `RuntimeAdmission:46`.

Already-constant comparisons (`RuntimeBindingRecord.java:375`,
`JdbcRuntimeBindingRepository.java:1987`, `LocalRuntimeStore`) are unchanged.

**Isolation policy.** The rule "Workspace execution uses Session isolation"
is written independently in five places:

| Site                                      | What it decides                         |
| ----------------------------------------- | --------------------------------------- |
| `ManagedAgentProperties.java:159`         | Workspace files configuration admission |
| `WorkspaceRuntimeResolver.java:37`        | Workspace mount resolution              |
| `WorkspaceExecutionStore.java:446`        | drained-stop admission                  |
| `RuntimeAdmission.java:47`                | stopped release                         |
| `LocalProcessRuntimeProvisioner.java:311` | `stopDrained`                           |

PR1 routes them through one policy,
`WorkspaceExecutionProfile.admitsIsolationClass`, that still admits only
`session`, so PR3
changes the rule in one place. Child Workspaces (`ManagedAgentProperties.java:205`)
keep their own explicit Session requirement (4.3). The Harness-ownership
checks keyed by the isolation key are not this policy; PR1 leaves them
untouched, and PR3 re-keys them.

### 4.2 Idle retirement (PR2)

`RuntimeIdleReaper` retires idle managed-context bindings whose provisioner
supports drained stop. On delivery that means Session-isolated Workspace
bindings; Workspace-isolated bindings join when PR3 lands. It does not depend
on PR3 or on open question 1, and it fixes today's unbounded growth of idle
per-Session workers. It is off by default (`idle-retirement.enabled=false`),
so the default configuration keeps today's behaviour.

The reaper scans bounded pages of `READY` bindings with a rotating cursor, in
the same shape as `RuntimeRecoveryCoordinator`, and takes the same binding
operation claim, so it never runs concurrently with recovery on one binding.

**Eligibility.** All of the following, decided by database time:

- no active Runtime Session;
- no unsettled execution, including `:process` rows of background runs;
- no storage holder of this generation;
- no drain request;
- no Harness-side pin that a later recovery may need. PR2 first enumerates
  the records that pin a binding generation (Hook original-owner pins, MCP
  connection records, background `child_run` and Monitor records, publication
  references) and treats any unsettled pin as ineligibility;
- idle for at least `idle-ttl`. PR2 first verifies whether
  `ma_runtime_binding.last_active_at` is maintained on Runtime Session release
  and execution settlement; if not, it maintains that column on those
  transitions instead of adding a second clock.

**Race with admission.** Checking "no active Runtime Session" and setting the
retirement fence must happen in one transaction, under the binding row lock
that Runtime Session admission already takes. After that, admission on the
binding refuses with a retryable code. The reaper therefore never releases a
Runtime Session that a Turn is using, and it has no abort path.

**Retirement fence and retryable answer.** PR2 records why a binding is
retiring (`idle`, and in PR3 `budget`), separately from the existing close,
loss and operator-recovery paths. That needs a schema change, made under the
managed schema consolidation rules. While the fence is set, and while the
binding is `DRAINING` for one of these reasons:

- acquisition on the binding and new placement on the same storage answer
  retryable `503 runtime_placement_retiring`, instead of today's non-retryable
  `409 runtime_placement_recovery_required`;
- the Java and Harness warm and acquire callers retry this code with backoff
  within their existing deadlines;
- once the drain receipt commits `RELEASED`, the next warm creates
  generation + 1.

Close, loss, operator recovery and failed-stop drains keep the non-retryable
answer.

**Stop.** Retirement reuses `drainBinding` → `stopDrained` → drain receipt →
`RELEASED`. A failed or unconfirmed stop leaves the binding `DRAINING` and
retried with backoff, as reliable close does. A worker found absent
transitions to the existing loss path. Retirement never creates loss
evidence by itself and never starts a replacement while the original is
unsettled.

**Session isolation.** Retiring the idle worker of a Session that is still
open is safe under the existing rules:

- the Session's next Turn creates generation + 1 through the ordinary warm
  path;
- its later close enumerates both generations, and the retired one already
  carries its drain receipt.

### 4.3 Workspace isolation with a generation budget (PR3)

PR3 starts only after open question 1 has maintainer sign-off.

#### Configuration

`qwen.managed-agent.runtime-broker.isolation-class=workspace`
(`QWEN_MANAGED_AGENT_RUNTIME_ISOLATION`) becomes valid together with Workspace
files when all of the following hold:

- the provisioner is `local-process` with `durable-local-process=true` and
  `supportsDrainedStop()`;
- idle retirement is enabled and a generation budget is configured.
  Configuration validation rejects Workspace isolation without them, so no
  deployment can run shared workers with unbounded worker-side growth.
- `child-workspaces-enabled=false`. Child Workspace merge depends on a closed
  child stopping its own worker, so the two remain mutually exclusive.

The default stays `session`. The setting applies to new placements only.
Existing Session-isolated bindings keep their saved request and retire at
their Session's close or through idle retirement. A Session whose next Turn
resolves the new scope gets a new Runtime Session on the shared binding. The
resolver contract already allows this, because a scope change requires a new
Runtime Session identity.

#### Placement and storage ownership

The resolver builds the same request for every bound Session on one storage,
so `findOrCreate` converges them on one binding generation. Storage ownership
is unchanged: the `ma_storage_owner` holder is still per Runtime Session, so a
second Session on the same storage receives retryable `workspace_busy` until
the first Runtime Session releases. That is today's serialization. Only the
worker is now shared.

#### Harness ownership without an isolation key

A Workspace-isolated binding has no isolation key, so every path that derives
the owning Harness Session from it must derive it from the Runtime Session or
execution record instead:

| Path                                                                                                | Change                                                                                                |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Harness admission fencing (`JdbcRuntimeBindingRepository.java:912`)                                 | check the close fence of the Runtime Session's Harness Session instead of skipping non-Session scopes |
| Close execution enumeration (`JdbcToolExecutionRepository.java:110`)                                | enumerate by `harness_session_id` on Workspace-isolated bindings instead of rejecting them            |
| Hook/MCP/background original-owner recovery and release (`RuntimeBrokerService.java:681`, `:1989`)  | match the owner through the Runtime Session record, not the binding's isolation key                   |
| Recovery maintenance close fences (`RuntimeBrokerService.java:3754`, `:3785`)                       | apply per Runtime Session                                                                             |
| Stop admission (`WorkspaceExecutionStore.canStopDrained`, `RuntimeAdmission.requireStoppedRelease`) | match holders and Runtime Sessions by `(binding, generation, runtimeSessionId)`                       |

PR3 also routes the 4.1 isolation policy to admit `workspace` for this
configuration.

#### Session close splits into release and retirement

Closing one Session must not stop a worker that other Sessions use. PR3
splits today's close into two operations:

1. **Session release.** This runs under the existing permanent tenant/Harness
   Session drain fence, enforced through the re-keyed admission above. It
   enumerates the closing Session's Runtime Sessions on Workspace-isolated
   bindings (a new query by Harness Session over `ma_runtime_session`), and for
   each active one:
   1. sends provider release;
   2. sends activation release and waits for the original worker's
      acknowledgement. The worker drains that Session's background runs and
      reports that no admitted invocation remains;
   3. conditionally clears the original storage holder;
   4. records `RELEASED`.

   An unsettled or `UNKNOWN` execution of this Session blocks completion
   exactly as today. The binding stays `READY` for other Sessions.

2. **Binding retirement.** This is PR2's retirement path. It is reached only
   through idle retirement, the generation budget or an explicit storage
   retirement, never through one Session's close.

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

#### Generation budget

A shared worker accumulates per-Runtime-Session state: installations,
closed-Session tombstones and `closedSessions` grow by one entry per tool turn.
Retiring only at idle points would not bound this under continuous use,
because an eager successor admission can keep the generation from ever being
idle.

The budget is therefore enforced at admission. A generation reaches its
budget when either holds:

- it has admitted `generation-budget.max-runtime-sessions` Runtime Sessions;
- it is older than `generation-budget.max-age`.

At that point, PR2's retirement fence is set immediately with reason
`budget`, even while Runtime Sessions are active. Then:

- no new Runtime Session is admitted on that generation, and callers get
  retryable `runtime_placement_retiring`;
- admitted work finishes under the existing no-abort and `UNKNOWN` rules;
- when the last active Runtime Session releases, retirement drains, stops with
  a receipt and commits `RELEASED`;
- the next admission creates generation + 1.

Worker-side growth is thus bounded by the admission budget per generation.

The age bound is not a process-lifetime cap. A Runtime Session that never
releases, such as a permanently live background run, keeps its generation
alive past `max-age`. That case needs an explicit operator or
resource-pressure policy (open question 2) rather than a claimed memory cap.
Because storage holders already serialize Sessions on one storage, waiting
for retirement adds at most one cold start to the wait for `workspace_busy`.

### 4.4 Session-create warm (PR4)

After a bound Session's creation commits, the control plane calls the
existing `warm(sessionId)` asynchronously through the existing resolver. It is
placement-only: it never acquires a Runtime Session, installs a context or
executes anything, so actor grants are still checked at acquisition as today.

- Under Session isolation it starts the Session's worker before the first
  Turn.
- Under Workspace isolation it is a no-op when the storage's binding is
  already `READY`.

It emits no public event because there is no Turn yet. Turn-time warm and its
`environment.*` events stay unchanged.

Keep-warm (operator-pinned resident workers per storage) is deferred to
follow-up (Section 11). Without measurements it turns the README's budgeting
burden into a knob instead of removing it.

### 4.5 Configuration summary

All keys are proposed. Every behaviour change defaults off.

| Key (`qwen.managed-agent.runtime-broker.`)                 | Default                                                    | Slice |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ----- |
| `idle-retirement.enabled`                                  | `false`                                                    | PR2   |
| `idle-retirement.idle-ttl`                                 | to be measured                                             | PR2   |
| `idle-retirement.scan-delay`, `idle-retirement.batch-size` | bounded like recovery (5 s, 8)                             | PR2   |
| `isolation-class` (existing)                               | `session`; `workspace` newly admitted with Workspace files | PR3   |
| `generation-budget.max-runtime-sessions`                   | unset; required with Workspace isolation                   | PR3   |
| `generation-budget.max-age`                                | unset; required with Workspace isolation                   | PR3   |
| `session-create-warm`                                      | `false`                                                    | PR4   |

Durations follow the existing unit rules and must be written with a suffix.

## 5. Decisions and rationale

| Decision                                                                | Rationale                                                                                                                           | Rejected alternative                                                                                                                          |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Make the binding resident, not the process                              | Keeps the seed, attestation, incarnation and `UNKNOWN` rules, which W0e physically validated.                                       | A long-lived process that accepts multiple leases and persists its journal: it rewrites the recovery model and needs a durable receipt store. |
| Reuse existing capabilities; keep kind checks as identity               | `supportsDrainedStop()` and `supportsStartupRecovery()` already exist; the remaining checks ask which provisioner placed a binding. | New parallel capability methods: they duplicate existing ones and add no behaviour.                                                           |
| Ship idle retirement before Workspace isolation                         | It fixes today's default-mode growth without waiting for the contentious close-evidence decision.                                   | Retirement only after Workspace isolation: the uncontroversial fix waits on open question 1.                                                  |
| Share per `(tenant, storage)` through Workspace isolation               | Reuses the existing isolation class and placement key; storage holders already serialize turns.                                     | A pool of pre-started Session-isolated workers: the isolation key is unknown before a Session exists.                                         |
| Enforce the generation budget at admission                              | An idle-only recycle is not a bound under continuous use.                                                                           | Recycle only at idle points: an eager successor admission defeats it.                                                                         |
| Require the budget and retirement with Workspace isolation              | No deployment can run a shared worker without a bound.                                                                              | Ship Workspace isolation before the budget: it opens an uncapped window.                                                                      |
| Session close releases; only retirement stops                           | Closing one Session must not stop a worker other Sessions use.                                                                      | Stop the worker when its last Session closes: it removes residency exactly when it matters, and races with the next Session.                  |
| Activation-release acknowledgement as Workspace-isolated close evidence | Already trusted for holder release; process death is not stronger evidence for escaped descendants.                                 | Require process death per Session: it is incompatible with sharing.                                                                           |
| Retryable answer only for idle and budget retirement                    | A Turn must not fail because the platform retired a worker. Loss and close keep failing closed.                                     | Make every `DRAINING` retryable: it hides real recovery conditions.                                                                           |
| Exclude child Workspaces                                                | Their merge depends on a closed child stopping its own worker.                                                                      | Generalize child close in this work: it is a separate design.                                                                                 |
| Defer keep-warm                                                         | Session-create warm fixes the user-visible cold start; keep-warm needs measurements.                                                | Ship keep-warm now: it adds standing cost before retirement and measurements exist.                                                           |

## 6. Delivery slices

| PR  | Scope                                              | Depends on           | Behaviour change |
| --- | -------------------------------------------------- | -------------------- | ---------------- |
| PR0 | This bilingual design                              | —                    | none             |
| PR1 | Kind identity and isolation policy (4.1)           | —                    | none             |
| PR2 | Idle retirement (4.2)                              | PR1                  | opt-in           |
| PR3 | Workspace isolation with a generation budget (4.3) | PR2, open question 1 | opt-in           |
| PR4 | Session-create warm (4.4)                          | —                    | opt-in           |

PR4 can proceed in parallel with PR2 and PR3. If PR3 exceeds roughly 1000
production lines, split it into Harness-ownership re-keying and the
close/budget/configuration part. Each slice updates this document in both
languages.

Because `sdk-java.yml` does not run on pull requests, each Java slice
dispatches the `SDK Java` workflow on its head commit and links the run in the
pull request body.

## 7. Failure semantics

| Event                                                     | Behaviour                                                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Turn arrives during idle retirement                       | Retryable `runtime_placement_retiring`; succeeds on generation + 1 after the drain receipt.                                 |
| Idle stop fails or is unconfirmed                         | Binding stays `DRAINING`; stop retried with backoff; no replacement starts.                                                 |
| Worker dies while idle                                    | Existing loss path. A same-boot death leaves holders pinned for recovery.                                                   |
| Reaper and admission race                                 | Serialized under the binding row lock; admission either wins (reaper skips) or sees the fence and gets a retryable refusal. |
| Session-isolated worker retired while its Session is open | Next Turn creates generation + 1; the later close finds the retired generation's drain receipt.                             |
| Budget reached while Runtime Sessions are active          | New admissions get retryable refusals; active work finishes; retirement follows the last release.                           |
| Session A closes while B uses the shared worker           | A's Runtime Sessions release through the original worker; the binding stays `READY`; B is unaffected.                       |
| A's close meets an `UNKNOWN` execution of A               | A's close stays `recovery_blocked`; the binding and B are unaffected.                                                       |
| Original worker cannot acknowledge A's release            | A's close waits for binding-level stop or loss evidence (today's rule).                                                     |
| Broker restarts with a resident worker                    | Existing durable adoption re-attests the original worker.                                                                   |

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

- **PR3 breadth.** Harness ownership is derived from the isolation key in
  several independent paths (4.3). Missing one would let a closing Session's
  fence or recovery act on the wrong owner, so PR3 enumerates them as
  acceptance items.
- **Retention.** Durable mode still never prunes registration and lock files.
  Retirement reduces live processes, not state-directory entries.
- **Unmeasured defaults.** TTL and budget values need measurement on the
  target deployment before any default is proposed.
- **Linux only.** Durable local workers and drained stop require Linux, so
  this feature does too.
- **CI coverage.** Java checks run only when dispatched; a slice without a
  linked dispatched run has no Java evidence.

## 9. Validation plan

- **PR1:**
  - existing Java and TypeScript suites stay green;
  - unit tests pin that the isolation policy admits exactly `session`;
  - no literal `"local-process"` comparison remains outside the provisioner.
- **PR2:** real-process tests on Linux with durable local workers and MySQL:
  - an idle Session-isolated worker is retired with a drain receipt and
    `RELEASED`;
  - the open Session's next Turn runs on generation + 1, and its close
    succeeds;
  - a Turn arriving during retirement is retried and succeeds;
  - SQL concurrency tests cover reaper versus admission;
  - a pinned Hook, MCP or background record blocks retirement;
  - stop failure and worker death during idle follow their paths.
- **PR3:**
  - two Sessions share one binding ID, generation and worker PID;
  - same-storage turns serialize with `workspace_busy`;
  - closing A leaves B's next Turn on the same worker;
  - A's background Shell run is stopped by A's close while B's continues;
  - each re-keyed Harness-ownership path from 4.3 has a test refusing a foreign
    Session;
  - an eager successor admission across the budget threshold cannot be
    admitted on the old generation, and lands on generation + 1 after
    retirement;
  - a Broker `SIGKILL` adopts the shared worker;
  - Session-isolated close is unchanged.
- **PR4:** Session-create warm reaches `READY` before the first tool call, and
  is a no-op for an already `READY` Workspace binding.
- **All:** build, typecheck, bundle, a dispatched `SDK Java` run, and two clean
  full-diff self-audits.

## 10. Acceptance criteria

- With defaults, behaviour and SQL state are identical to today.
- No idle or budget retirement releases an active Runtime Session, and no Turn
  fails non-retryably because of one.
- With Workspace isolation:
  - every bound Session on one storage uses one live generation at a time;
  - closing one Session never stops that generation;
  - no generation admits more Runtime Sessions than its budget.
- Every `RELEASED` resident binding carries a drain receipt or loss and
  stopped-writer evidence.
- No path replays an `UNKNOWN` execution or starts a replacement while the
  original generation is unsettled.
- Both language versions of this document reflect each landed slice.

## 11. Out of scope and follow-up

- Keep-warm: operator-pinned resident workers per storage, after retirement
  ships and measurements justify it.
- A durable, attested registered resident worker that replaces `static`. It
  needs worker-side lease registration and rotation and its own design.
- Remote placement over SSH and reverse-connected workers.
- Generalizing child Workspace close to shared workers.
- Pruning durable registration and lock files.

## 12. Open questions

1. Is the original worker's activation-release acknowledgement acceptable as
   reliable-close evidence for Workspace-isolated Sessions (4.3)? This gates
   PR3.
2. What operator or resource-pressure policy applies to a generation kept past
   its budget by a Runtime Session that never releases (4.3)?
3. Which deployment measurements set the idle TTL and generation budget
   defaults?

Resolved in revision 2:

- Idle retirement covers Session-isolated bindings first, off by default.
- Prewarm is Session-create warm only; keep-warm is deferred.
