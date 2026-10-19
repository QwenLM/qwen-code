# Workspace-resident Managed Tool Runtime

[English](2026-10-15-managed-workspace-resident-runtime.md) | [简体中文](2026-10-15-managed-workspace-resident-runtime.zh-CN.md)

Status: Section 4.1 is implemented by PR1
([#14254](https://github.com/QwenLM/qwen-code/pull/14254)), Section 4.2 by PR2
([#14339](https://github.com/QwenLM/qwen-code/pull/14339)) and Section 4.3 by
PR3 ([#14435](https://github.com/QwenLM/qwen-code/pull/14435)). Section 4.4
(Session-create warm) and Section 4.5 remain proposals.
Tracking issue:
[#14211](https://github.com/QwenLM/qwen-code/issues/14211). Part of the Managed
Agent proposal [#12380](https://github.com/QwenLM/qwen-code/issues/12380). Code
references are to `main` @ `c3012a523f`, before PR2.

Revision history:

- Revision 1 landed as PR0 ([#14214](https://github.com/QwenLM/qwen-code/pull/14214)).
- Revision 2 (review on #14214) reused the existing provisioner capabilities in
  PR1, listed the Harness-ownership paths keyed by the isolation key, made the
  generation budget an admission-time bound and deferred keep-warm.
- Revision 3 (maintainer decision, 2026-10-16):
  - the Workspace-isolated close evidence (former open question 1) is accepted;
  - idle retirement and the generation budget are deferred (Section 4.5);
  - the slices are reordered: PR2 re-keys Harness ownership, PR3 enables
    Workspace residency, PR4 adds Session-create warm.
- Revision 4 (PR3, [#14435](https://github.com/QwenLM/qwen-code/pull/14435)):
  - close/recovery side: a closing Session releases only its own Runtime
    Sessions on a shared binding (the worker and the binding stay `READY`) on
    both close protocols; v2 cleanup authority is fenced by the Runtime
    Session's own Harness Session claim; a lost shared worker fails the close
    closed instead of retiring the binding; storage retirement still stops
    the shared worker; recovery maintenance and retention admit shared
    bindings;
  - new finding: the old close fails open on a shared binding — protocols v0
    and v1 enumerate only Session-isolated bindings, so a Session with active
    shared Runtime Sessions could reach `CLOSED` without releasing them (v2
    refused). It was unreachable until the policy admitted Workspace
    isolation; the v2 never-initialized receipt now additionally requires
    that no Runtime Session of the Session was ever placed on a shared
    binding;
  - enablement: `bound-session-isolation-class` (`session` default,
    `workspace` opt-in) switches bound-Session placement to Workspace-isolated
    bindings, and lifecycle authority on a shared binding is fenced by the
    Runtime Session's own Harness Session claim, so the closing Session's
    lifecycle Hook places and runs on the resident worker;
  - correction: the enumeration index is the `V9` migration, a single-column
    `harness_session_id` index — both columns are VARBINARY(2048), so the
    `(tenant_id, harness_session_id)` pair sketched in Section 4.3 exceeds
    InnoDB's 3072-byte key length (the PR's `V7` was renumbered after `main`
    took `V7` and `V8` during review);
  - relation to #14340: the resident Workspace close for private Kubernetes
    CSI shipped separately; its semantics are unchanged;
  - validation scope: this slice carries unit/H2 and mutation evidence; the
    real-process Linux scenarios of Section 9 remain a follow-up.

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
long-lived worker per `(tenant, storage)`, shared by every bound Session on
that storage and started ahead of demand. Sharing alone bounds the number of
live workers by the number of storages instead of the number of Sessions.
Retiring idle workers is deferred (Section 4.5).

## 2. Current state

Verified on `main` @ `c3012a523f`:

| Area                              | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                           | Reference                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation for bound Sessions      | Workspace files require a `local-process` Broker with Workspace mounts whose isolation the Workspace execution policy admits, which is `session` only. Child Workspaces additionally require durable local workers. The default `isolation-class` is `session`, and the Workspace resolver builds Session-isolated scopes.                                                                                                                          | `ManagedAgentProperties.java:157`, `:203`, `:895`; `WorkspaceRuntimeResolver.java:36`, `:95`                                                                                        |
| Isolation of unbound Sessions     | Unbound Sessions take the same global `isolation-class`.                                                                                                                                                                                                                                                                                                                                                                                            | `EmbeddedRuntimeBroker.java:196`                                                                                                                                                    |
| Placement identity                | Workspace isolation has no isolation key, so one binding serves the full scope (tenant, Workspace, generation, mount root, capability digest, kind, storage). Session isolation keys the binding by Harness Session ID. `cwdRelative` is not part of placement identity.                                                                                                                                                                            | `managed-runtime-broker-service-core.md`; `JdbcRepositorySupport` request key                                                                                                       |
| Harness ownership                 | Several paths derive "which Harness Session owns this" from the binding's isolation key, and therefore only work for Session isolation: <br>• Harness admission fencing skips non-Session scopes. <br>• Close enumerates executions only on bindings whose isolation key is the closing Session. <br>• Hook, MCP and background original-owner recovery and release require it. <br>• Recovery maintenance checks the close fence by isolation key. | `JdbcRuntimeBindingRepository.java:909`; `JdbcToolExecutionRepository.java:109`; `RuntimeBrokerService.java:680`, `:2001`, `:3812`, `:3846`                                         |
| One worker, many Runtime Sessions | A boot v2 worker installs one context per Runtime Session and runs each Session in its own effective directory. A later tool turn uses a new Runtime Session ID.                                                                                                                                                                                                                                                                                    | `2026-09-26-managed-context-worker.md`; `2026-09-26-managed-workspace-execution.md`                                                                                                 |
| Warm                              | Warm is on demand only. Java warms the Session's Runtime when a Turn is dispatched, concurrently with model inference. The Harness calls the Broker's `/runtimes:warm` right before it acquires a Runtime Session for a tool turn, Hook execution or file rewind. Nothing warms ahead of demand.                                                                                                                                                    | `HarnessCoordinator.java:359`, `:873`; `RuntimeBrokerHttpServer.java:158`; `hosted-workspace-tool-turn.ts:1625`                                                                     |
| Session close                     | `SessionLifecycleCoordinator` calls `closeWorkspace`, which runs `drainHarnessSession`. That enumerates only bindings with `isolation_class = 'session' AND isolation_key = <harness session>`, drains them, and requires `stopDrained` proof before `RELEASED`.                                                                                                                                                                                    | `SessionLifecycleCoordinator.java:415`, `:446`; `EmbeddedRuntimeBroker.java:297`; `RuntimeBrokerService.java:303`, `:379`, `:416`, `:438`; `JdbcRuntimeBindingRepository.java:1110` |
| Worker stop                       | `LocalProcessRuntimeProvisioner.stopDrained` stops only drained, managed-context bindings of the Workspace profile whose isolation the policy admits. `release` does nothing in durable mode.                                                                                                                                                                                                                                                       | `LocalProcessRuntimeProvisioner.java:292`, `:309`                                                                                                                                   |
| Stop admission                    | `WorkspaceExecutionStore.canStopDrained` and `RuntimeAdmission.requireStoppedRelease` require `local-process` and an admitted isolation, and match storage holders against the binding's isolation key.                                                                                                                                                                                                                                             | `WorkspaceExecutionStore.java:441`; `RuntimeAdmission.java:42`                                                                                                                      |
| Placement while draining          | `requireRecoverablePlacement` treats a `DRAINING` binding on the same tenant and storage, directory or Workspace as blocking. It refuses a new generation with non-retryable `409 runtime_placement_recovery_required`.                                                                                                                                                                                                                             | `JdbcRuntimeBindingRepository.java:1957`; `RuntimeBindingRecord.java:368`                                                                                                           |
| Binding-level drain               | `retireStorageBinding` drains one exact binding generation under a storage fence (used by Workspace migration).                                                                                                                                                                                                                                                                                                                                     | `RuntimeBrokerService.java:393`                                                                                                                                                     |
| Idle reclamation                  | None for live bindings. Retention only prunes old `FAILED`/`RELEASED` rows.                                                                                                                                                                                                                                                                                                                                                                         | `runtime-broker-jdbc-retention.md`                                                                                                                                                  |
| Worker retention                  | Context installations are kept for the worker's lifetime. The executor's `closedSessions` set and the provider's released-Session tombstones grow by one small entry per Runtime Session; the provider keeps eight released Sessions live.                                                                                                                                                                                                          | `managed-context-envelope.ts:353`; `managed-runtime-tool-executor.ts:354`; `managed-runtime-provider-worker.ts:124`                                                                 |
| Close evidence                    | Reliable close is complete only when admission is fenced and the original writers, Sessions, worker and holder are settled. Today that means the original worker process stopped.                                                                                                                                                                                                                                                                   | `workspace-session-reliable-close.md`                                                                                                                                               |
| Java CI                           | `sdk-java.yml` runs on schedule and manual dispatch only, so a pull request touching `packages/managed-agent-server` does not run the Java matrix.                                                                                                                                                                                                                                                                                                  | `.github/workflows/sdk-java.yml`                                                                                                                                                    |

## 3. Goals and non-goals

Goals:

- A bound Session can be placed on a Workspace-isolated binding, so all bound
  Sessions on one storage share one worker generation.
- Closing one Session never stops a worker that other Sessions use, and still
  leaves reliable-close evidence.
- A worker can be started before the first tool call needs it.
- Every change is behind configuration whose default keeps today's behaviour.

Non-goals:

- Changing the invariant that one worker process is one binding generation.
  The attestation, seed, incarnation, in-memory journal and `UNKNOWN` rules
  stay as they are.
- Idle retirement and the generation budget in this delivery (Section 4.5).
- Remote placement (SSH, reverse-connected workers) or a registered resident
  worker that replaces `static`. Both need worker-side lease registration and
  their own design.
- Changing the default isolation class or Session-isolated close semantics.
- Concurrent tool turns on one storage. `ma_storage_owner` keeps serializing
  them.

## 4. Design

"Resident" is a property of the binding lifecycle, not of process identity.
A Workspace-isolated binding generation is created once, shared, and outlives
any one Session. The worker it names is still exactly one process with one
seed, one lease and one in-memory journal.

### 4.1 Kind identity and isolation policy (PR1, implemented)

PR1 changed no behaviour. It added no provisioner capability, because the
existing `kind()`, `supportsDrainedStop()` and
`supportsStartupRecovery(handle)` already answer the capability questions.

- **Kind identity.** `LocalProcessRuntimeProvisioner.KIND` is public and
  replaces the 14 production comparisons of the `"local-process"` literal.
  Those checks ask which provisioner placed a binding or which one is
  configured, so they stay identity checks.
- **Isolation policy.** The five checks that encode "Workspace execution uses
  Session isolation" ask `WorkspaceExecutionProfile.admitsIsolationClass`,
  which still admits only `session`. Child Workspaces keep their own explicit
  Session requirement.

### 4.2 Harness ownership on shared bindings (PR2)

PR2 changes no behaviour reachable today. It prepares the Broker so that a
binding shared by several Harness Sessions fences and recovers each Runtime
Session for its own Harness Session.

**One predicate.** `HarnessOwnership.sharesRuntimeSessions(request)` is true
only for a Workspace-isolated, managed-context `local-process` binding of the
Workspace execution profile.

**Additive branches.** Every changed site has the form
`shared ? <Runtime-Session-level check> : <today's expression, unchanged>`.
For every binding that is not shared, the original code runs exactly as
written, so Session-isolated and legacy behaviour is equivalent by
construction.

**Why no binding is shared today:**

- Managed-context `local-process` requests come only from the Workspace
  provisioner, whose resolver builds Session-isolated scopes, and configuration
  refuses any isolation the policy does not admit.
- `legacy` and `static` requests cannot be managed-context.
- Private Kubernetes Workspace bindings also use Workspace isolation with the
  Workspace profile digest; the `local-process` kind check excludes them.

**Re-keyed in PR2:**

| Site                                                                            | Shared-binding behaviour                                                                                                                                                                |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness admission core (`JdbcRuntimeBindingRepository`)                         | A new owner flag fences by the given Runtime Session's Harness Session instead of skipping non-Session scopes. Lifecycle authority on a shared binding stays refused.                   |
| `admitSession`, Session tombstone, `admitExecution`                             | Fenced by the Runtime Session's or execution's own Harness Session; storage fences and physical storage admission unchanged.                                                            |
| Repository overloads taking the binding request                                 | `requireHarnessAdmission`, `requireHookAdmission`, `requireHarnessRecovery`; the interface defaults delegate to the scope-only methods, so other repositories behave as before.         |
| Broker call sites (acquire, control, dispatch, lifecycle release)               | Pass the binding request to those overloads.                                                                                                                                            |
| `acquireRecovery`, `releaseOriginal` (Hook, MCP and background original owners) | The saved Runtime Session record proves the owner. `releaseOriginal` refuses to tombstone an unknown Runtime Session id on a shared binding, because nothing proves the caller owns it. |
| `releaseSavedSession`, `HttpRuntimeTransport.activateWorkspace`                 | Match the Runtime Session record instead of the isolation key.                                                                                                                          |
| In-memory repository                                                            | Same fencing, for tests that run against both repositories.                                                                                                                             |
| `WorkspaceRuntimeTransport` context check (server)                              | Matches the Runtime Session record's Harness Session.                                                                                                                                   |
| Operator recovery (server)                                                      | Records the held Runtime Session's Harness Session as the owner.                                                                                                                        |

**Kept unchanged:** CSI-only code and warm placement (a shared binding has no
single owner and warm admits no work). Lifecycle-authority paths were refused
on shared bindings in PR2; PR3 admits them fenced by the Runtime Session's own
Harness Session claim (Section 4.3).

**Delivered in PR3** (reachable once the policy admits Workspace isolation):
close and lifecycle evidence (`findHarnessExecutions`,
`verifyHarnessResources`, `verifyHarnessStopped`), stopped release and
`canStopDrained`, recovery-maintenance fences, retention of shared bindings,
and provisioning scope resolution.

### 4.3 Workspace isolation (PR3)

#### Configuration

Bound Sessions get their own isolation setting, because unbound Sessions take
the global `isolation-class` and would otherwise all share one legacy worker
per tenant. Workspace isolation for bound Sessions is valid when:

- the provisioner is `local-process` with `durable-local-process=true` and
  `supportsDrainedStop()`;
- `child-workspaces-enabled=false`. Child Workspace merge depends on a closed
  child stopping its own worker, and the child relay finds a child's binding by
  its Harness Session, which a shared binding does not record.

The default stays `session`. The setting applies to new placements only.
Existing Session-isolated bindings keep their saved request and retire at
their Session's close. A Session whose next Turn resolves the new scope gets a
new Runtime Session on the shared binding. The resolver contract already
allows this, because a scope change requires a new Runtime Session identity.

#### Placement, provisioning and storage ownership

- **Placement converges.** The resolved scope holds the tenant, Workspace,
  Workspace generation, mount root, digest and isolation, but not
  `cwdRelative`. So every bound Session on one storage and Workspace
  generation builds an identical request, and `findOrCreate` converges them on
  one binding generation.
- **Provisioning.** It needs the Harness id threaded into
  `RuntimeProvisioner.createRequest`, because a Workspace-isolated request has
  no isolation key to resolve by. Readiness checks resolve the storage mount by
  `(tenant, storageId)`.
- **Storage ownership is unchanged.** The `ma_storage_owner` holder is still
  per Runtime Session, so a second Session on the same storage receives
  retryable `workspace_busy` until the first Runtime Session releases. That is
  today's serialization; only the worker is now shared.

#### Session close splits into release and retirement

Closing one Session must not stop a worker that other Sessions use. PR3
splits today's close into two operations:

1. **Session release.** This runs under the existing permanent tenant/Harness
   Session drain fence, enforced on shared bindings by PR2's re-keyed
   admission. It enumerates the closing Session's Runtime Sessions on
   Workspace-isolated bindings, and for each active one:
   1. sends provider release;
   2. sends activation release and waits for the original worker's
      acknowledgement. The worker drains that Session's background runs and
      reports that no admitted invocation remains;
   3. conditionally clears the original storage holder;
   4. records `RELEASED`.

   Enumerating by Harness Session needs a new index on `ma_runtime_session`,
   added as the `V9` migration. It is a single-column `harness_session_id`
   index: both columns are VARBINARY(2048), so the `(tenant_id,
harness_session_id)` pair originally sketched here exceeds InnoDB's
   3072-byte key length, and the tenant is filtered in the query instead. An
   unsettled or `UNKNOWN` execution of this Session blocks completion exactly
   as today. The binding stays `READY` for other Sessions.

2. **Binding retirement.** This is the existing `drainBinding` path: drain,
   release the remaining Sessions, `stopDrained`, persist the drain receipt,
   then `RELEASED`. In this delivery it is reached only through an explicit
   storage retirement (`retireStorageBinding`, used by Workspace migration).
   PR3 extends `canStopDrained` and stopped release to match holders and
   Runtime Sessions by `(binding, generation, runtimeSessionId)`.

Session-isolated bindings keep today's close unchanged.

**Close evidence (decided by the maintainer, 2026-10-16).** For a
Workspace-isolated Session, reliable close completes on the original worker's
activation-release acknowledgement plus holder release, not on worker process
death. Rationale:

- W0c-3 already accepts this same acknowledgement as the condition for
  releasing the storage holder.
- Worker death does not prove that escaped descendants stopped either
  (W0e-2/W0e-3).

If the original worker cannot acknowledge (binding `LOST`, unusable lease),
Session close falls back to today's rule: it waits for binding-level stop or
loss evidence and otherwise stays `recovery_blocked`. Deployments that require
process-stop evidence per Session keep `session` isolation. Archive, delete and
unarchive inherit whatever close evidence the Session's isolation provides.

#### Worker-side growth

A resident worker accumulates per-Runtime-Session state: installations,
closed-Session tombstones and `closedSessions` grow by one small entry per tool
turn. Without the deferred generation budget this growth is not bounded by
time. The first delivery accepts it and documents it. Today only Workspace
migration's storage retirement path retires a storage's binding, after which
the next placement starts a fresh generation; PR3 decides whether to expose
that as an operator action. The budget in Section 4.5 bounds it later.

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

### 4.5 Deferred: idle retirement and generation budget

Both are deferred until residency ships and measurements show they are
needed. Research for revision 2 found what they will have to handle:

- **Idle clock.** `ma_runtime_binding.last_active_at` is not an idle clock:
  recovery refreshes it on every scan and Runtime Session release does not
  update it. The last release time on `ma_runtime_session.last_active_at` and
  execution settlement times are usable.
- **Recovery.** Recovery maintenance would treat a stopped, retiring binding
  as journal loss unless it skips bindings that are retiring.
- **Turn races.** Retiring a generation while a Session stays open opens
  several races:
  - the Harness warms generation G, owes cleanup against G and only then
    acquires;
  - an owed cleanup against a retired G fails permanently;
  - re-acquiring a released Runtime Session id provisions a cold G + 1 before
    refusing;
  - the child relay only finds `READY` bindings.
- **Retryable answers.** Retirement-time refusals use four different codes
  today, and neither the Java nor the TypeScript callers retry on the
  `retryable` flag.
- **Admission-time budget.** A budget enforced only at idle points is not a
  bound under continuous use. A generation that reaches its budget must stop
  admitting new Runtime Sessions, let admitted work finish, then retire.
- **Eligible Sessions.** Hooks, MCP and background runs hold Runtime Sessions
  between Turns, so only plain Sessions would be idle-eligible.

### 4.6 Configuration summary

All keys are proposed. Every behaviour change defaults off.

| Key (`qwen.managed-agent.runtime-broker.`)                                                       | Default   | Slice |
| ------------------------------------------------------------------------------------------------ | --------- | ----- |
| `bound-session-isolation-class` (bound Sessions only; the global `isolation-class` is unchanged) | `session` | PR3   |
| `session-create-warm`                                                                            | `false`   | PR4   |

Durations follow the existing unit rules and must be written with a suffix.

## 5. Decisions and rationale

| Decision                                                                          | Rationale                                                                                                                           | Rejected alternative                                                                                                                                       |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make the binding resident, not the process                                        | Keeps the seed, attestation, incarnation and `UNKNOWN` rules, which W0e physically validated.                                       | A long-lived process that accepts multiple leases and persists its journal: it rewrites the recovery model and needs a durable receipt store.              |
| Reuse existing capabilities; keep kind checks as identity                         | `supportsDrainedStop()` and `supportsStartupRecovery()` already exist; the remaining checks ask which provisioner placed a binding. | New parallel capability methods: they duplicate existing ones and add no behaviour.                                                                        |
| Residency before reclamation                                                      | Sharing bounds workers by storage count, and avoids every race that comes from switching generations under an open Session.         | Idle retirement first: its races are harder than the problem it solves.                                                                                    |
| Re-key ownership with additive branches                                           | Equivalence under Session isolation holds by construction; the shared branch is testable before it is reachable.                    | Rewrite every site to read the Runtime Session record: correct, but the equivalence argument then depends on an invariant the repository does not enforce. |
| Share per `(tenant, storage)` through Workspace isolation                         | Reuses the existing isolation class and placement key; storage holders already serialize turns.                                     | A pool of pre-started Session-isolated workers: the isolation key is unknown before a Session exists.                                                      |
| Separate isolation setting for bound Sessions                                     | Unbound Sessions would otherwise share one legacy worker per tenant.                                                                | Reuse the global `isolation-class`: it changes unbound placement too.                                                                                      |
| Session close releases; only retirement stops                                     | Closing one Session must not stop a worker other Sessions use.                                                                      | Stop the worker when its last Session closes: it removes residency exactly when it matters, and races with the next Session.                               |
| Activation-release acknowledgement as Workspace-isolated close evidence (decided) | Already trusted for holder release; process death is not stronger evidence for escaped descendants.                                 | Require process death per Session: it is incompatible with sharing.                                                                                        |
| Accept per-turn worker growth in the first delivery                               | Each entry is small, and retiring the storage's binding resets it.                                                                  | Ship the budget first: it needs the deferred retirement mechanics.                                                                                         |
| Exclude child Workspaces                                                          | Their merge needs a closed child to stop its own worker, and the relay locates a child by its own binding.                          | Generalize child close in this work: it is a separate design.                                                                                              |
| Defer keep-warm                                                                   | Session-create warm fixes the user-visible cold start; keep-warm needs measurements.                                                | Ship keep-warm now: it adds standing cost before measurements exist.                                                                                       |

## 6. Delivery slices

| PR    | Scope                                                                                                  | Depends on   | Behaviour change |
| ----- | ------------------------------------------------------------------------------------------------------ | ------------ | ---------------- |
| PR0   | Bilingual design (#14214)                                                                              | —            | none             |
| PR1   | Kind identity and isolation policy (4.1, #14254)                                                       | —            | none             |
| PR2   | Harness ownership on shared bindings (4.2)                                                             | PR1          | none             |
| PR3   | Workspace isolation for bound Sessions (4.3, [#14435](https://github.com/QwenLM/qwen-code/pull/14435)) | PR2          | opt-in           |
| PR4   | Session-create warm (4.4)                                                                              | —            | opt-in           |
| Later | Idle retirement and generation budget (4.5), keep-warm                                                 | measurements | opt-in           |

If PR3 exceeds roughly 1000 production lines, split it into
"provisioning and placement" and "close split and evidence". Each slice updates
this document in both languages. Because `sdk-java.yml` does not run on pull
requests, each Java slice dispatches the `SDK Java` workflow on its head commit
and links the run in the pull request body.

## 7. Failure semantics

| Event                                                                  | Behaviour                                                                                                                     |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Session A closes while B uses the shared worker                        | A's Runtime Sessions release through the original worker; the binding stays `READY`; B is unaffected.                         |
| A's close meets an `UNKNOWN` execution of A                            | A's close stays `recovery_blocked`; the binding and B are unaffected.                                                         |
| Original worker cannot acknowledge A's release                         | A's close waits for binding-level stop or loss evidence (today's rule).                                                       |
| A closing Session tries new work on the shared binding                 | PR2's re-keyed admission refuses it with `runtime_admission_closed`; other Sessions are admitted.                             |
| Another Harness Session asks to recover or release A's Runtime Session | Refused: the saved Runtime Session record names A.                                                                            |
| Shared worker dies                                                     | Existing loss path; the `LOST` binding blocks new placement on the storage until recovery, as any managed binding does today. |
| Broker restarts with a resident worker                                 | Existing durable adoption re-attests the original worker.                                                                     |

## 8. Risks and constraints

- **Weaker close evidence.** Workspace-isolated Session close relies on a
  worker-attested release. The maintainer accepted it; it is opt-in and Session
  isolation remains the default.
- **Blast radius.** A shared worker crash affects every Session on that
  storage. The storage-level effect matches today's:
  - a `LOST` managed-context binding already blocks new placement on the same
    storage until recovery (`RuntimeBindingRecord.java:368`), whichever
    Session's worker crashed;
  - the storage holder already admits only one active Runtime Session per
    storage, so a crash interrupts at most that one Session's work.

  What changes is that Sessions which were idle on that storage now lose a
  warm worker as well.

- **Unbounded per-turn growth.** A resident worker grows by one small entry per
  tool turn until its storage is retired (Section 4.3).
- **PR3 breadth.** Close evidence, provisioning, retention and recovery all
  need the deferred sites from Section 4.2; missing one fails closed, never
  open.
- **Linux only.** Durable local workers and drained stop require Linux, so
  this feature does too.
- **CI coverage.** Java checks run only when dispatched; a slice without a
  linked dispatched run has no Java evidence.

## 9. Validation plan

- **PR1 (done):**
  - existing suites stayed green;
  - unit tests pin the isolation policy and the persisted kind value.
- **PR2:**
  - `HarnessOwnershipTest` pins the predicate's truth table;
  - `SharedHarnessOwnershipTest` covers JDBC Session and execution admission
    fenced per Harness Session, tombstones under a drain, lifecycle authority
    refused, legacy and private Kubernetes Workspace bindings unchanged,
    in-memory parity, and original-owner recovery and release;
  - server tests cover the transport context check and operator recovery on a
    shared binding;
  - disabling the predicate makes every new test fail;
  - existing suites stay green.
- **PR3 (landed):** unit/H2 suites pin the close split on shared bindings
  (both close protocols), the cleanup-claim fence, the lost-shared-worker
  fail-closed branch, the never-initialized fail-open fix, the configuration
  gate and the resolver switch; each new branch fails under a targeted
  mutation. The real-process scenarios below (Linux, durable local workers,
  MySQL) remain a follow-up tracked in #14211:
  - two Sessions share one binding ID, generation and worker PID;
  - same-storage turns serialize with `workspace_busy`;
  - closing A leaves B's next Turn on the same worker;
  - A's background Shell run is stopped by A's close while B's continues;
  - a Broker `SIGKILL` adopts the shared worker;
  - storage retirement stops the shared worker with a drain receipt;
  - Session-isolated close is unchanged;
  - unbound Sessions keep their isolation.
- **PR4:** Session-create warm reaches `READY` before the first tool call, and
  is a no-op for an already `READY` Workspace binding.
- **All:** build, typecheck, bundle, a dispatched `SDK Java` run, and two clean
  full-diff self-audits.

## 10. Acceptance criteria

- With defaults, behaviour and SQL state are identical to today.
- No Harness Session can be admitted, recovered or released through another
  Harness Session's Runtime Session on a shared binding.
- With Workspace isolation:
  - every bound Session on one storage uses one live generation at a time;
  - closing one Session never stops that generation;
  - Session close completes on the decided activation-release evidence.
- Every `RELEASED` resident binding carries a drain receipt or loss and
  stopped-writer evidence.
- No path replays an `UNKNOWN` execution or starts a replacement while the
  original generation is unsettled.
- Both language versions of this document reflect each landed slice.

## 11. Out of scope and follow-up

- Idle retirement and the generation budget (Section 4.5).
- Keep-warm: operator-pinned resident workers per storage.
- A durable, attested registered resident worker that replaces `static`. It
  needs worker-side lease registration and rotation and its own design.
- Remote placement over SSH and reverse-connected workers.
- Generalizing child Workspace close and the child relay to shared workers.
- Pruning durable registration and lock files.

## 12. Open questions

1. Which measurements decide when per-turn worker growth needs the generation
   budget?

Resolved:

- Bound-Session isolation setting: `bound-session-isolation-class` (PR3); no
  per-Workspace override in this delivery.

- Workspace-isolated close evidence: the original worker's activation-release
  acknowledgement plus holder release (maintainer, 2026-10-16).
- Idle retirement and the generation budget: deferred (maintainer,
  2026-10-16).
- Prewarm: Session-create warm only; keep-warm deferred.
