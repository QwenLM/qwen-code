# Managed Workspace Recovery and Reclamation (W0e)

[English](2026-09-27-managed-workspace-recovery.md) | [简体中文](2026-09-27-managed-workspace-recovery.zh-CN.md)

Status: W0e-1/2/3 source implementation, 2026-09-28.
Dedicated Linux physical reboot acceptance remains pending. Baseline: `e0b8bea9e0ba369a0661bc51cbbb9a27555aff48`.

Related: [roadmap #12380](https://github.com/QwenLM/qwen-code/issues/12380),
[lost executions #12670](https://github.com/QwenLM/qwen-code/issues/12670),
[local workers #12766](https://github.com/QwenLM/qwen-code/issues/12766),
[W0c-3](2026-09-26-managed-workspace-execution.md), and
[W0d](managed-workspace-w0d-web-shell-binding.md).

## 1. Problem and verified baseline

W0d lets a user create and inspect a fixed Workspace binding. Recovery must
preserve that binding while releasing physical resources safely. Changing a
default Workspace or selecting a new directory is never a recovery operation.

The production local-process provisioner reports the durable kind
`local-process`, but its worker ownership lives in memory. After Broker restart
it observes the previous worker as `UNKNOWN`, even if that worker has exited.
The default reconciliation deadline is four 30-second operation leases. A
timeout releases the reconciliation claim and leaves the binding `READY`.
Normal shutdown sends termination to owned workers without retiring their
durable bindings. A Broker crash can leave a worker alive.

The test-only recoverable provisioner records worker PID and start time. It
can drive the merged Broker reconciliation path, but it is not a production
identity store or proof that every writer has stopped. If it reports
`NOT_FOUND`, the Broker persists `LOST`. An unsettled execution then pins that
generation indefinitely. `reconcileExecution` answers `IN_FLIGHT` for an
orphaned `EXECUTING` record; it only queries evidence for `UNKNOWN` records.

On this baseline, the existing
`ProcessCrashFaultGateTest#aHostCrashPinsTheLostGenerationBehindTheUnsettledCall`
was run with real Broker JVMs, the global qwen 0.24.6 worker and durable H2. It
passed its assertions of the defect: `warm`/`acquire` returned
`runtime_broker_runtime_lost`, `release` returned
`runtime_reconciliation_required`, the execution remained `EXECUTING`, and
there was no replay or replacement worker. This is baseline evidence, not a
passing recovery implementation. The test kills selected processes; it does
not certify an actual host reboot or an isolation domain with escaped children.

The baseline also has unsafe reuse without a Broker restart. A live Broker
observing a dead worker calls `invalidateBinding`/`failBinding`, changes the
binding to `FAILED`, and provisions a replacement despite unresolved calls or
escaped writers. A stale Broker can also admit a new execution after another
Broker commits `LOST`, then retire that pinned generation through the same
failure path. W0e-1 closes both paths. Consequently, worker-only failure
(including OOM or SIGKILL) keeps the placement unavailable until independent
writer-stop proof exists; W0e-1 does not supply that production proof source.
The previous `aWorkerKilledMidExecutionLeavesItUnknownWithoutEvidence` and
`aReplacementWorkerRunsNothingUntilItsOwnContextIsInstalled` fault gates must
assert blocked replacement instead of automatic recovery.

## 2. Recommended decision for #12670

Introduce a distinct execution state `ABANDONED`: the original Runtime journal
is permanently unavailable, the outcome remains unknown, and polling for a
result can stop. It carries no `executionStatus`, result or `settledAt`.
Persist `abandonedAt`, reason `runtime_lost`, and a reference to the exact
generation's loss evidence. Keep the execution identity, idempotency key,
request digest, reference, cancellation intent, sequence and last dispatch
claim. `SETTLED` continues to mean a result supported by existing evidence.

After durable, authoritative loss of the original Runtime is established,
`PREPARED`, `DISPATCHING`, `EXECUTING`, `CANCEL_REQUESTED` and `UNKNOWN` may
transition to `ABANDONED`. One conservative rule covers all five states; no
success, failure, cancellation or `not_started` result is synthesized. A
previously `SETTLED` result wins if it committed first and remains unchanged.
Late completion, cancellation, renewal, dispatch takeover and manual UNKNOWN
resolution cannot mutate an abandoned record. The same idempotency key never
starts another physical execution, including after a fresh generation exists.

**Ending result lookup does not authorize resource reuse.** A `LOST` binding
and its Runtime Sessions remain pinned until there is independent, durable
evidence that the old execution domain cannot write again. This gate applies
to legacy boot v1 as well as managed boot v2. Legacy placements have no
Workspace holder to provide a second safety boundary.

Keep `isSettled()` for result-bearing records. Add an explicit terminal-state
predicate for control flow, and distinguish active-result accounting from the
generation's physical reuse gate. Do not globally replace every
`!isSettled()` check and thereby make `ABANDONED` an implicit unlock.

The recommendation is to resolve this rule before enabling durable production
adoption in #12766. It does not require Stage G to resume a Hosted Turn: W0e
records uncertainty and recovers resources; Stage G decides the logical Turn's
continuation, history and user resolution.

## 3. Evidence and authorization

Store loss and writer-stop evidence against the exact binding ID/generation,
Runtime identity/incarnation, resource identity and host identity. Evidence is
versioned, records its source and observation time, and is retained after
reclamation. The source is a trusted provisioner or host supervisor, never a
browser request, client path, guessed PID or caller-supplied `force` flag.
Monotonic evidence updates must not overwrite a conflicting identity or
downgrade an already recorded stop proof.

| Observation                                                                                    | Result lookup                                | Physical reuse                                                                 |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| Network failure, timeout, expired claim, missing/corrupt process record                        | Keep unresolved                              | Block                                                                          |
| Exact worker identity proved permanently absent                                                | May record `ABANDONED` after persisting loss | Block until writer-stop proof                                                  |
| Same-host boot identity changed, from a trusted OS source and a durable pre-crash record       | Record permanent loss                        | Eligible after proving the old domain belonged to that host boot               |
| Trusted isolation supervisor proves the exact old execution domain is empty and cannot restart | Record permanent loss if its journal is gone | Eligible                                                                       |
| Worker PID gone, PID reused, SIGTERM sent, or one descendant snapshot is empty                 | At most worker-loss evidence                 | Block                                                                          |
| Original worker closes the Session activation gate and reports no invocation active            | Keep actual journal outcomes                 | Existing normal-release semantics only; not proof about escaped Shell children |

The first successful crash-reclamation path should target the existing
single-host local-storage deployment and a verified host reboot. Platforms
without a trusted boot identity stay blocked. Broker-only restart can adopt a
live worker for original status/cancel/release after full identity checks.
Trusted recovery/cleanup uses saved ownership and service authentication; a new
execution separately requires the current actor grant. It does not restart or
replay a Hosted Turn.

The current tool profile includes Shell and permits detached descendants. A
root PID/start-time check, process-group kill or SQL epoch alone does not prove
those descendants stopped. General worker-crash reclamation needs a killable
isolation domain or a separately versioned restricted tool profile. W0e does
not silently reinterpret the existing frozen profile as file-tools-only.
Remote filesystems and external side effects need their own fencing contract;
the host-reboot proof here is limited to administrator-managed local storage.
It also requires a trusted workload that cannot arrange writers outside the
recorded domain, including cron, launchd or systemd jobs that restart after a
reboot. A changed boot identity proves old processes exited, not that an
external scheduler cannot recreate them. If that prerequisite is not
established, keep the storage blocked even after reboot.

## 4. Durable recovery sequence and races

Recovery is bounded, idempotent and restartable at each durable step:

1. Claim reconciliation for the exact binding generation. Observe outside SQL
   transactions; recheck ownership, generation and identity before committing
   the observation. `UNKNOWN` retries within the existing deadline;
   conflicting identity remains blocked.
2. Commit loss evidence and `LOST`, fencing new Runtime Session and execution
   admissions to that generation. A stale Broker cannot insert `ACQUIRING` or
   `PREPARED` after this fence.
3. Mark remaining nonterminal executions `ABANDONED` in bounded batches using
   state/version checks. Concurrent valid settlement may win; a later
   settlement cannot revive an abandoned record. Keep all physical pins while
   writer-stop evidence is absent.
4. Once writer-stop proof is persisted, release the exact generation's Runtime
   Sessions locally. No transport call to a replacement Runtime may answer for
   the old generation. A logical Managed Agent Session and its Workspace
   binding remain intact.
5. For managed storage, conditionally clear only the matching holder after
   checking the evidence and original holder identity. A crash before or after
   this write resumes safely; an old retry cannot clear a new holder. Revoked
   product access can prevent new work without preventing trusted physical
   cleanup of the saved identity.
6. Under the binding claim, recheck absence of active references and the
   writer-stop proof, retire the old binding, then allow normal provisioning.
   A new tool turn receives a new Runtime Session ID. Reclamation never chooses
   a different Workspace, storage mapping or configuration for the existing
   logical Session.

The SQL concurrency boundary must be implemented, not inferred from Java
`synchronized`. Today Session validation and execution insertion use separate
transactions. A late insertion can land after an abandonment scan. New
admissions and the loss fence must lock the same binding-generation row and
validate its state in the insertion transaction. Use one lock order:
binding, Runtime Session, execution; order batch execution rows by stable key.
Reject new admissions after the fence while permitting identity-checked reads
of existing idempotent receipts. Binding reuse performs its final reference
check under that same fence. The in-memory test store must provide an
equivalent shared coordination boundary.

The server's storage cleanup is a separate conditional transaction after
durable stop evidence. No SQL transaction spans HTTP, process termination or
host observation. Any database failure preserves or rechecks the pin; it does
not imply successful cleanup. Neither a `FAILED` binding nor a generic
`releaseUnusableSession` path may bypass the physical reuse gate, including
ordinary live-Broker failure handling. `LOST` can leave only through the
evidence-checked atomic recovery path.

The placement mapping must remain stable while an old domain is pinned.
Current placement keys include directory, capability, isolation and provisioner;
changing those can create a different slot that does not see the old binding.
Before admitting a replacement, compare the saved original placement with the
trusted deployment mapping and reject changes that would bypass an unreclaimed
domain, including legacy placements without a storage holder. An empty slot
under a new request key is not clearance. This slice requires a quiescent,
verified cleanup before changing physical mapping/profile; online migration
across placement keys needs a separate physical-resource fence.

## 5. Production local-worker identity for #12766

Persist a versioned per-generation resource record in an administrator-owned
directory outside Workspace roots. Bind it to the existing provision seed,
binding generation, host/boot identity, worker PID/start identity and validated
loopback endpoint. Keep tokens in the existing encrypted SQL seed; never put
them in filenames, resource handles or diagnostic output. Reject symlink,
permission, corruption and identity conflicts rather than treating them as
resource absence. A missing record proves nothing. This directory is not a
security boundary against a malicious same-UID worker: the current deployment
assumes trusted tools. Protect recovery authority with OS isolation before
admitting untrusted workloads; a path outside the Workspace alone is not enough.

The identity protocol must cover the interval between process creation and
the Broker persisting `READY`. Merely copying the test helper's post-start
`Files.writeString` leaves an unrecorded-worker window. Reuse the existing
stdin boot barrier: the worker parses a complete boot document at EOF before
opening any listener. Persist a launch intent before spawn, then atomically
publish and sync the actual `Process` PID/start identity before writing the
first boot byte. A Broker killed before that write leaves an empty/incomplete
boot, so the worker cannot admit tools. After validated ready, publish the
endpoint before reporting successful provisioning. A missing endpoint after
crash remains unresolved; it does not justify another launch.

Hold one cross-process per-seed file lock across spawn, identity persistence,
boot and ready. An observer that cannot take the lock returns `UNKNOWN`; it
cannot certify absence while a delayed launcher can still start. Retirement
takes the same lock and leaves a durable tombstone that forbids relaunch of
that seed. Failures terminate the testable owned process and retain the
identity/intent until its disposition is proved. Do not delete an unresolved
record. Old generic resource handles without the new versioned identity remain
unrecoverable. The configured command must directly run a trusted worker that
obeys this boot protocol; wrappers that execute tools before boot or retain its
stdin are unsupported. This approach needs no new boot wire version or worker
self-registration route.

An alive process is adopted only after PID/start/host identity checks and full
placement attestation of Runtime identity, lease, incarnation, scope and
storage identity. Verify each Session's frozen context separately through the
existing context-install and activation receipts; it is not part of the
placement attestation envelope. Reading a record does not grant execution
authority. Current grants for new execution, storage holder, directory identity
and activation receipts still apply.
Concurrent Brokers must converge on the existing binding claim. Adoption does
not mint a fresh token/epoch or give a stale Broker authority to admit a new
execution after the loss fence.

Do not combine unconditional parent-death exit with transparent adoption of a
surviving worker. For this design, a registered worker may survive Broker
failure for later reconciliation, with each attempt bounded; an incompletely
registered startup must fail closed. Shutdown detaches from recoverable workers.
Explicit retirement must first persistently fence the exact generation and
claim retirement authority, then request termination and verify stop evidence.
An adoption map entry and the short reconciliation claim are not lifetime
ownership: multiple Brokers may observe the same worker, so closing one cannot
unconditionally kill it. Include both spawned and adopted workers in resource
accounting. Sending SIGTERM, returning from `close`, or dropping an in-memory
entry is not successful retirement. Automatic reclamation is enabled only for
the proof sources validated by the next slice.

## 6. Interface, storage and consumer changes

| Layer / existing consumer                                                                | Planned change                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ToolExecutionRecord`, in-memory/JDBC repositories                                       | `ABANDONED` invariants, abandonment time/reason, immutable terminal mutations, scoped accounting and admission fence                 |
| `RuntimeBindingRecord`, repositories, `RuntimeBrokerService`                             | Durable evidence, bounded abandonment/release, final physical reuse gate, fenced late callbacks                                      |
| `RuntimeSessionRepository` implementations                                               | Atomic generation-scoped admission and release; no late insertion behind loss                                                        |
| `ExecutionReconciliation`                                                                | Return an explicit `ABANDONED` outcome from the ledger, without consulting a new worker                                              |
| `RuntimeBrokerHttpServer`                                                                | Read original terminal records after process loss/release; validate saved ownership and scope without requiring a live local Session |
| `broker-managed-runtime-provider.ts` and `managed-runtime-provider.ts`                   | Preserve terminal uncertainty; stop polling/replay without presenting a synthetic Tool result                                        |
| `WorkspaceExecutionStore`, `WorkspaceRuntimeTransport`, `WorkspaceRuntimeProvisioner`    | Conditional holder cleanup from exact stop evidence; current authorization for new execution; cleanup from saved identity            |
| `LocalProcessRuntimeProvisioner`, worker boot/ready entry, embedded Broker configuration | Versioned durable launch identity, adoption and verified retirement                                                                  |
| Standalone Broker schema and server Flyway schema                                        | Add evidence and abandonment fields with compatible defaults; share JDBC contract tests                                              |

Keep the current private HTTP error `runtime_broker_execution_unknown` for an
abandoned result, with explicit terminal/reason metadata, so existing callers
already stop their success-result polling. Java reconciliation gets the new
outcome. Audit the TypeScript adapter's inspect/reconcile/cancel paths together;
an unknown result must not become `settled`, successful, or eligible for
automatic retry. `:resolve` must not turn abandonment into a fabricated result.
New runtime-status enum values are not added to the worker tool protocol merely
to describe Broker resource recovery.

The session busy check currently uses only `runtimeSessionId`. Recovery queries
must include binding ID and runtime generation as well, with exact identifier
comparison; two tenants using the same ID must not block or clear one another.
Existing execution rows already carry this tuple. Prefer it to introducing an
unrelated tenant-schema redesign; keep a broader busy-check cleanup separately
scoped if needed.

The JDBC `hasActiveByBinding` and `hasActiveByRuntimeSession` predicates must
exclude both `SETTLED` and `ABANDONED`; their in-memory equivalents use
`isTerminal()`. These accounting changes never replace the physical stop gate.
Old Brokers may report abandoned rows as invalid requests, identity conflicts
or reconciliation failures instead of terminal uncertainty.

Migrations preserve existing `UNKNOWN`, settled results and immutable keys.
Old rows without trustworthy loss/stop evidence remain blocked. Unknown enum
values are not readable by old Java binaries, so new abandonment writes require
a coordinated server rollout; mixed old/new Brokers against these rows are not
supported. Do not edit an applied Flyway migration. Keep physical paths and
process metadata out of public Session/Workspace responses.

## 6a. W0e-1 implementation

W0e-1 implements the first slice. The evidence SPI uses two nullable JSON
fields on the original binding: `lossEvidence` and `stopEvidence`. Each contains
a version, fact, source, observation time, host/writer domain and the original
seed identities and resource handle, without credentials. The first loss proof
is retained; a later stop proof must match that same domain. Execution rows add
`abandonedAt` and `lossEvidenceId`; `runtime_lost` is the only abandonment reason.
A result that committed before abandonment wins. No worker Tool protocol state
is added.

The binding repository owns admission and recovery transactions. Production
JDBC repositories must share the same `DataSource`; unsupported repository
combinations fail explicitly. Custom embedding repositories must implement the
new atomic methods. Session and execution insertion lock the original binding
before inspecting the Session. Recovery locks the tenant placement guard, slot,
binding, Session batch and execution batch in that order. Each transaction
handles at most 100 executions and 100 Sessions, retains the original receipts,
and checks the operation lease and remaining references before retirement.
Further calls resume incomplete batches.

A small tenant guard table serializes new placement creation with loss fences.
A managed Workspace with an unreclaimed lost or blocked generation cannot
create another placement under changed mapping/profile keys. Its stable domain
is `(tenantId, workspaceId)`, excluding physical/profile fields. Legacy Workspace
IDs can be derived from paths, so unresolved legacy loss conservatively blocks
new placements for the tenant until cleanup. Existing placement reads remain
available. This restriction also recognizes historical failed durable rows;
old `FAILED` records are not stop proof. Online configuration migration while
an unobserved old runtime is still READY remains unsupported: deployments must
keep their mapping stable until verified cleanup.

A local-process managed startup blocked before any lease or attested generation
was persisted still blocks its own placement. It does not block other placements
in that Workspace: no Session context or tool writer could have been admitted
through the unready binding. A `RECOVERY_BLOCKED` binding with either persisted
fact still guards the Workspace; other provisioner kinds remain fail-closed.

Before upgrading an installation that has enabled the Broker, quiesce new
admission and inventory seeded `FAILED` bindings. A past crash can leave such a
row even when a later generation is `READY`; the new guard will reject new
placements for that tenant. If any exist, keep affected traffic stopped until
the original writer domain has been physically stopped and an
evidence-preserving operator migration is available. A later `READY` binding,
row deletion or a synthetic stop receipt is not clearance. Deployments with
these rows cannot safely resume admission through this slice alone.

The W0e-1 local provisioner can certify journal loss for a process it still owns and
has observed exit, using the exact seed, lease and handle. This proves neither
that descendants stopped nor that a restarted Broker can adopt the worker.
A transient attestation transport error against a still-live owned process
fails that request but leaves the binding `READY` for a fresh attestation on
the next call. Process death or an identity conflict still fences the binding;
a network timeout alone never becomes permanent physical-loss evidence. The
local process provisioner explicitly opts into this retry using its owned
process liveness check; other provisioners retain the fail-closed default.
Missing ownership after restart still provides no evidence. There is no
production `WRITERS_STOPPED` producer in this slice; deterministic supervisor
fixtures exercise its consumption. Workspace storage-holder cleanup remains
W0e-3. Loss-only recovery never calls transport release or clears a holder. Cached
Session release consults durable state before liveness, so a recovered release
is idempotent and a LOST generation cannot use the ordinary transport path.
Final Session release checks the parent and changes the Session under the same
generation lock. Normal holder release locks and checks the original live
binding in its SQL transaction; a late deactivation response cannot clear a holder after the loss
fence. This protects ordinary cleanup without enabling W0e-3 reclamation.

Private terminal read, cancel and same-key create retry validate the original
saved binding and Session identity and require service authentication. They do
not depend on a live Session or current actor/mapping resolution. HTTP retains
`runtime_broker_execution_unknown` with `details.terminal: true` and
`details.reason: runtime_lost`; the TypeScript adapter preserves that information
for inspect, reconcile and cancel. No physical evidence is projected publicly.

Flyway V16 and the standalone initializer add nullable evidence/abandonment
columns and the placement guard. Upgrade tests write pre-change SQL rows before
migration and verify PREPARED, UNKNOWN and SETTLED receipts afterwards. A
coordinated rollout remains required before writing ABANDONED rows.

## 6b. W0e-2 implementation

The [durable local adoption implementation](2026-09-27-local-runtime-adoption.md)
adds an opt-in Linux identity store, a boot barrier with durable PID/start-tick
registration, permanent launch locks, and adoption after Broker restart. The
default ephemeral mode retains the W0e-1 behavior. Neither mode proves stopped
writers after worker-only death; W0e-3 physical reclamation remains separate.

## 6c. W0e-3 implementation

The [trusted local reboot implementation](2026-09-28-local-reboot-recovery.md)
adds separately enabled same-host boot evidence, original-holder cleanup,
late-acquisition fencing and an independent bounded maintenance scan. Cleanup
uses saved physical ownership even after grants, product Session or Registry
change. Loss receipts remain terminal uncertainty. Tests with real workers and
SQL plus synthetic boot identity exercise the chain; a dedicated Linux reboot
is still required before physical acceptance can be claimed.

## 7. Delivery order and boundaries

| Slice          | Deliverable                                                                                                                                                               | Exit condition                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| W0e-1 / #12670 | Execution terminal uncertainty, durable evidence contract, admission and stale-Broker fences, safe live-Broker failure handling, conditional cleanup, private projections | Repository/HTTP/race tests pass; missing stop proof still blocks reuse                                                          |
| W0e-2 / #12766 | Production durable launch identity and live-worker reconciliation                                                                                                         | Real process restart/adoption tests pass; incomplete identity never duplicates a worker; unsupported stop proof remains blocked |
| W0e-3          | Same-host reboot recovery and Workspace holder cleanup, stale-writer fault gates                                                                                          | Real SQL + worker + host/isolation evidence establishes safe progress or explicit blocking in every acceptance case             |

These are implementation slices, not three already completed features. Land
W0e-1 before enabling W0e-2 adoption. W0e is complete only after W0e-3; a
passing helper-based test does not qualify a production provisioner.

[Hosted file-tool PR #12831](https://github.com/QwenLM/qwen-code/pull/12831)
already covers private gated Read/Write/Edit orchestration and excludes process
loss recovery. Coordinate its saved execution-identity and unknown-result
consumers before integration. Public bound-message execution, Stage G Turn
takeover/history settlement, arbitrary Shell containment, Kubernetes and
product identity propagation remain separate. `workspace_context` stays false;
W0d's narrow `workspace_binding` capability remains unchanged.

## 8. Acceptance and evidence

| Gate                                 | Required observation                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lost execution states                | Each of the five nonterminal states terminates as outcome-unknown; committed `SETTLED` evidence is unchanged                                                                            |
| Delayed callback / claim             | Completion, cancel, renewal and resolution after abandonment cannot mutate or re-execute the record                                                                                     |
| Admission race                       | Park before Session/execution insertion, commit loss on a second Broker, resume: insertion is refused; existing receipts remain readable                                                |
| Stale Broker                         | A cached Session cannot admit into or retire a LOST generation; late release cannot clear its Session or storage pin without stop proof                                                 |
| Response loss / retry                | Crash after each recovery commit; repeat with original identities; one terminal record and no duplicate worker or execution                                                             |
| Worker alive after Broker restart    | Exact same identity is re-attested; original status/cancel/release works; no automatic Hosted replay                                                                                    |
| Shared observer shutdown             | Closing one Broker detaches; another can continue using the original worker; explicit retirement requires its own durable authority                                                     |
| Worker absent, descendants uncertain | Record uncertainty if justified; binding, Runtime Session and storage remain unavailable for reuse                                                                                      |
| Verified host reboot                 | Persist correct boot/domain evidence, abandon unknown outcomes, release exact old holders, then run new work in the original Workspace                                                  |
| Untrusted evidence                   | Timeout, missing record, PID reuse, wrong host, mismatched incarnation and changed directory never unlock or kill another process                                                       |
| Tenant / storage isolation           | Reused Runtime Session IDs and stale cleanup cannot affect another binding/tenant; same-storage serialization survives recovery                                                         |
| Old writer                           | With or without Broker restart, escaped/delayed writers remain capable of writes: replacement stays blocked; after verified domain death, no old marker appears after new holder starts |
| Configuration / authorization drift  | Original binding stays fixed; revoked actors cannot execute; trusted cleanup does not require restoring their grant                                                                     |
| Placement-key drift                  | Changing path/profile/isolation/provisioner cannot bypass an unreclaimed domain by provisioning under a new slot                                                                        |
| Local managed startup                | A failure before lease and attestation keeps its placement blocked; another Session may start because no tool writer was admitted                                                       |
| Legacy / schema / HTTP               | Boot v1 obeys the same reuse gate; migration preserves receipts; terminal read works after release and does not expose physical identities                                              |

Run the existing Stage F process gates, new repository contracts on H2 and real
MySQL/MariaDB, Spring-to-worker holder recovery, and supported host reboot or
isolation-domain tests. Use real escaped descendants for the negative gate;
mock observations alone cannot prove physical safety. Run repository build,
typecheck, bundle, focused TypeScript tests, Java verification/Checkstyle and
two consecutive clean full-diff audits for implementation. The detailed local
test plan lives in `.qwen/e2e-tests/managed-workspace-w0e.md`.

## 9. Review decisions and remaining prerequisites

Recommend accepting `ABANDONED` as terminal uncertainty, preserving independent
physical pins, and implementing W0e-1 before production local recovery. The
issues still need this decision recorded and reviewed; this document is not a
claim of maintainer acceptance.

W0e-2 selects Linux machine/boot/PID/time namespace identity and durable startup
registration. Its real-process tests use native identity on Linux and a test-only
identity on macOS. W0e-3 still needs physical reboot verification on a supported
host. If the
deployment requires automatic recovery after worker-only death with arbitrary
Shell descendants, select a killable isolation domain before enabling that
path. Until then, its correct acceptance result is explicit blocking. These
requirements do not prevent designing and implementing W0e-1 with deterministic
trusted evidence fixtures, but those fixtures do not satisfy W0e completion.
