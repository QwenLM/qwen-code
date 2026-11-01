# Runtime Execution Workflow Decomposition

[English](2026-11-01-runtime-execution-workflows.md) | [简体中文](2026-11-01-runtime-execution-workflows.zh-CN.md)

- Status: Implemented locally with focused validation passing; full CI qualification remains pending.
- Date: 2026-11-01
- Prerequisite: the local [Runtime Binding Registry](2026-10-31-runtime-binding-registry.md) slice on baseline `cf7e77810efa776f29b52a3dc4bf24f17d5e80f8`.

## Problem, goals and scope

The Registry gives Binding and Session state an owner, but execution reconciliation, takeover scans and cancellation still live in `RuntimeBrokerService`. Their shared execution reads, fenced settlement and background-hold settlement make a three-way copy of private helpers unsafe. Extract the three workflows with direct module-internal collaborators and one shared execution-state boundary. Preserve current observable behavior, including failure timing, async continuations, writer fencing and cleanup order.

No public interface, HTTP route, schema, protocol, dependency or Runtime launch policy changes. Provisioning, Binding recovery/drain, dispatch, renewal scheduling and physical Session release stay in the service. This is structural work; full integration acceptance remains separate from implementation completion.

## Ownership and dependencies

| Component                      | Owns                                                                                                                                   | Consumers                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `RuntimeBindingRegistry`       | Existing local Binding/Session maps and contexts; READY/historical Session validation                                                  | Service and all three execution workflows                                                   |
| `RuntimeExecutionState`        | Existing execution ownership reads, fenced dispatch settlement/UNKNOWN transitions, lapsed-claim fencing and background-row settlement | Dispatch, reconciliation, recovery, cancellation and existing acknowledgement/control paths |
| `RuntimeExecutionReconciler`   | Execution-ID lookup reservations, `ExecutionObservationCooldown`, evidence validation and reconciliation CAS                           | Service observation endpoints and takeover scanner                                          |
| `RuntimeExecutionRecovery`     | Bounded takeover scan and background-hold observation/sweep workflows                                                                  | Acquire/adoption, routine/drain release, background observation and task stop               |
| `RuntimeExecutionCancellation` | Durable cancellation intent and physical cancellation/confirmation workflow                                                            | Service cancellation endpoint                                                               |
| `RuntimeBrokerSupport`         | Unchanged stateless future/error mapping, payload/reference validation and status projection                                           | The extracted collaborators and service                                                     |
| Service                        | Public facade, `closed`, dispatch reservations/invocations, schedulers, provisioner lifetime, Binding/Session lifecycle orchestration  | Existing adapters and assembly                                                              |

All classes remain package-private in the existing runtime-broker service package; no new interface or Spring wiring is needed. Repositories remain the sole durable authority. Context locks still belong to the Registry, and every compound read/admit/release decision retains its current lock region. The support class shares existing rules across several real callers; it is not a configurable workflow framework.

## Reconciliation design

Move `reconcileExecution`, automatic `observeExecution`, the context-based lookup, its execution-ID future map, the cooldown and result absorption into `RuntimeExecutionReconciler`. The service keeps the public signatures and delegates. The reconciler receives the Registry, execution-state collaborator, execution repository, provisioner, transport, publication verifier, clock, lookup duration, shared close fence and existing cooldown instance. It owns no executor and never calls the service.

Keep this sequence: validate caller IDs; read owned execution; return non-UNKNOWN/terminal answers before requiring a live Session; consult a finished v3 publication if available; otherwise require the original persisted generation and locally attested route; perform a bounded status lookup. Only validated settled evidence resolves UNKNOWN, and a racing cancellation is reread before CAS. UNKNOWN or unreachable is never proof of `not_started`, never dispatches work and never provisions a Runtime.

Explicit reconciliation remains fresh. Automatic observation consults cooldown first. Concurrent requests join the existing execution-ID reservation. On completion, stamp cooldown before removing that exact reservation, then complete its future; JVM Errors do not become cached UNRESOLVED answers. This order prevents a sequential caller between removal and stamping from issuing another worker request. Service close cancels the reconciler's pending reservations at the same point in the original shutdown order.

Takeover lookup retains its extra close checks, original-generation routing, unresolved handling of ordinary failures/invalid status and refusal to swallow an Error. Background `not_started` settlement goes through the shared execution-state collaborator, avoiding a dependency cycle with the scanner.

## Recovery scan and hold design

Move `scanExecutions` into `RuntimeExecutionRecovery`, together with durable background-row pagination, fire-and-forget scan observations, routine/drain sweeps, physical hold control and the existing background observation/task-stop entry points. The dependency set is Registry, execution state, execution/session repositories, transport, reconciler and the shared close fence. It has no service callback or scheduler.

The scan still reads 100-row pages scoped to the saved Session and generation, rereads each candidate before observation and yields through `thenComposeAsync` between candidates/pages. It does not claim dispatch, resend tools or isolate a record merely because it is old. Acquire waits for the execution scan but never for background maintenance observations. Listing/control failures in the background scan remain isolated from acquire.

Both scan and release use the same durable background-row reader. A scan observes without `activeControls`; ordinary controls/sweeps keep their original guard accounting. The routine release sweep only observes, whereas drain alone follows status → stop → status. Only proven exit or no-start evidence settles the hold. Unknown evidence and per-row errors preserve the hold. Backfill/snapshot/removal of the context's background index retain the same lock regions. Physical Session release and its durable transitions remain in the service and call the recovery collaborator before their existing busy check.

Task stop keeps tenant/Harness ownership validation and the original Session route. It may stop only the invocation's own `:process` row. No recovery path creates a replacement Binding or Session.

## Cancellation design

Move cancellation admission, prepared-provider confirmation, physical cancel and cancellation-result validation into `RuntimeExecutionCancellation`. It uses Registry, execution state, execution repository, transport, the existing invocation set, coordination scheduler, cancellation duration and close fence. The service facade supplies its existing two-argument dispatch action for the one DISPATCHING branch; this per-call `BiConsumer` is the only service action passed to an extracted workflow. Do not store a service reference or pass maps/private lifecycle helpers as callbacks.

Preserve terminal-receipt ownership reads before requiring a live Session. A prepared provider's cancelled receipt still requires original-worker confirmation when that worker may retain the preparation. Nonterminal cancellation persists intent before sending a worker request. Hold rows and authorized private CSI calls retain their existing refusals. An invocation still running here may receive cancellation after lease lapse; an invocation absent here first follows the repository-clock dispatch fence. UNKNOWN remains UNKNOWN until reconciliation evidence resolves it.

An unsent DISPATCHING record still goes through the existing dispatcher, which reads its durable cancellation intent before deciding whether to execute; replacing that branch with a new direct settlement algorithm would change behavior. Physical cancellation status is validated and settled with the original dispatch owner/generation. A late result after claim lapse is fenced, and live-claim conflicts remain errors. Prepared-provider cancellation retains its bounded result future, 25 ms observation schedule, control accounting and refusal to treat forgotten state as confirmation.

## Shared state, files and migration order

`RuntimeExecutionState` moves the existing owned-execution checks, `settleExecution`, `markUnknown`, `fenceLapsedClaim`, UNKNOWN-on-closed-admission mapping and background settlement CAS loops without changing their algorithms. It receives the three repositories, Broker owner, dispatch lease and clock. `RuntimeBindingRegistry` additionally receives the existing Session repository and resolver for the READY/historical checks used across workflows; non-managed historical reads still revalidate the resolved scope, while managed history uses its saved parent identity. No resolver/admission check is dropped or moved to a cache-only path.

Implement in order: shared unchanged helpers/state and Registry queries; reconciler; recovery and hold maintenance; cancellation; facade wiring and shutdown. The five new implementation files above, the existing service/Registry/cooldown documentation, test constructors and focused reconciliation regression are the affected code surfaces. Update both Registry and structure-review design pairs to link this design and distinguish the earlier slice from the new implementation. The existing contract/schema/adapters remain unchanged.

## Validation and acceptance

Add a deterministic reconciler-level regression for stamp-before-reservation-removal: block cooldown stamping, submit another observation during that interval and assert that it joins without a second worker lookup. Cover both an ordinary status and an ordinary lookup failure, then release the stamp and verify completion/cooldown. The witness must fail if reservation removal is moved before stamping.

Reuse the existing service regressions for explicit versus automatic lookup, timeouts, malformed status, JVM Errors, publication results, concurrent cancellation and shutdown. Recovery regressions must cover multi-page takeover, generation/Session isolation, asynchronous background observations, durable-only holds and routine versus drain release. Cancellation regressions cover terminal ownership, prepared confirmation, unsent dispatch, lapsed claims, sticky intent, cross-Harness refusal and hold/CSI refusals. Keep their assertions and original ordering expectations when moving code.

Within the module's shared 10-minute local verification budget, reuse the source-matching SDK and JDK 21/Maven environment, run affected Java suites with Checkstyle and the minimum subprocess path, and inspect the actual selected reports. Full MySQL 8.4, bundled Hosted/fault recovery and SpotBugs remain required CI qualification; fixture/H2 or test-worker subprocess passes do not establish those results. No JavaScript build is required because this change has no TypeScript/shared-contract change.

Acceptance: all three facade entry families delegate to their named collaborators; lookup reservations and cooldown share one owner; no collaborator reaches back into service internals; the sole cancellation dispatch action is explicit; no SQL/schema/public-contract diff; moved algorithms retain their semantics; the ordering witness and focused regressions pass; bilingual documents and two clean self-audit passes are complete. CI acceptance is pending until its required gates run on the accepted revision.

## Risks and open questions

The main risks are altered synchronous exception mapping, completion ordering, guard accounting and cross-generation routing. Mechanical moves and unchanged call-site envelopes reduce these risks, while the existing integration tests exercise them through the public service facade. Shared immutable dependencies are passed directly rather than hidden in a generic context object.

The callback exception is deliberately limited to cancellation's unsent-dispatch branch; extracting the entire dispatcher would widen this task. No product decisions remain open. A later dispatcher extraction may replace that action with a concrete collaborator without changing cancellation semantics.
