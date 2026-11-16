# Runtime Binding Registry

[English](2026-10-31-runtime-binding-registry.md) | [简体中文](2026-10-31-runtime-binding-registry.zh-CN.md)

- Status: First implementation slice; verification results are recorded separately. Subsequent workflow extraction is described in the [execution workflow design](2026-11-01-runtime-execution-workflows.md).
- Date: 2026-10-31
- Source baseline: `cf7e77810efa776f29b52a3dc4bf24f17d5e80f8`.
- Scope: module-internal extraction in `packages/managed-agent-server/runtime-broker`.

## Problem and current state

`RuntimeBrokerService` combines placement, acquire, execution, reconciliation, cancellation, recovery and shutdown in approximately 6,300 lines. Extracting reconciliation alone would require passing its mutable maps and numerous lifecycle callbacks into another class. The [structure review](2026-10-31-managed-agent-structure-review.md) therefore requires a state owner first.

The source audit refines that proposal: `bindingOperations` belongs with Binding state because provisioning, recovery, reclamation and drain all reserve the same Binding ID. `reconciliations` belongs with execution reconciliation because its execution-ID reservation must be released only after stamping `ExecutionObservationCooldown`. Moving these two maps in the opposite direction would retain the coupling we want to remove.

## Goals and boundaries

Establish one module-internal owner for local Binding and Runtime Session state, migrate all production consumers, and preserve observable behavior. This slice changes no public interface, HTTP route, schema, dependency, authentication rule or protocol byte. It does not change when `warm` runs; the separate on-demand Runtime proposal is outside this change.

Provisioning, attestation, drain, Session acquisition/release, execution settlement, recovery scans and renewal scheduling remain orchestrated by the service. They may use Registry operations, but the Registry never calls back into the service. Do not introduce an interface, generic operation runner, event bus or configurable lifecycle framework for this one owner.

## Ownership

| State or responsibility                                                      | Owner after this slice                             | Authority and consumers                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liveBindings`                                                               | `RuntimeBindingRegistry`                           | Local attested generation/lease only; provisioning/adoption registers it; warm, recovery, reconciliation and extension controls consult it; drain, loss and invalidation remove it.                                                                |
| `bindingOperations`                                                          | Registry                                           | One local reservation per Binding ID, shared by provisioning, reconciliation of a Binding, lost-generation reclamation, maintenance recovery and drain. It never replaces a repository operation claim.                                            |
| `sessions` and `SessionContext`                                              | Registry                                           | Local Runtime Session acquisition/adoption futures and per-context lock, mount claim, active controls, background-process IDs and release futures. Acquire, execution/control, reconciliation, cancellation, release and drain use these contexts. |
| `reconciliations` and `ExecutionObservationCooldown`                         | Service, then a future reconciliation collaborator | Execution-ID deduplication and the existing stamp-before-reservation-removal ordering move together in a later slice.                                                                                                                              |
| `dispatches`, `invocations`, execution CAS and background-process settlement | Service                                            | Dispatch and physical invocation tracking are not Binding ownership.                                                                                                                                                                               |
| Operation/dispatch renewal, schedulers, `closed`, provisioner lifecycle      | Service                                            | The same close fence and renewal tasks remain in force.                                                                                                                                                                                            |
| Persisted Binding, Session, execution, admission and writer fencing          | Repositories                                       | Durable authority across Broker processes and restarts; Registry membership is never authorization or proof of stopped writers.                                                                                                                    |

`BindingContext` is an immutable record and lease pair used between orchestration steps. `SessionContext` retains its `ReentrantLock`: callers' compound decisions and the context's accessors use the same guard, including when repository calls block on JDK 21 virtual threads. The first slice preserves the background-process set's existing guarded use rather than changing settlement ownership at the same time.

## Registry operations

The Registry is package-private in the existing service package. It receives the Binding repository, provisioner, Broker owner ID, operation lease duration and clock directly. These are its concrete dependencies for the existing validation/invalidation operations; it has no scheduler and no service reference.

- Look up, reserve and conditionally remove Binding-operation futures. A caller keeps the future it installed; cleanup removes that exact reservation, so an old completion cannot drop a replacement.
- Look up, register and remove Session futures. Failed acquire/adoption removes its exact future. Successful release retains the existing removal points after durable release or an already-`RELEASED` read.
- Register or forget a locally attested Binding, match its generation and complete lease identity, and require that local route before use.
- Validate that an execution's original persisted generation remains `READY` or `DRAINING`. This read remains separate from local lease validation and from tenant, Harness and admission checks at their existing call sites.
- Invalidate an unusable Binding and reject unusable Session leases with the existing error codes.
- Cancel pending Binding and Session futures during service shutdown. The service continues to cancel dispatch and execution-reconciliation futures, stop both schedulers and close the provisioner.

Raw maps never escape. Futures and contexts are operation handles, not new durable state. The Registry does not start work, refresh authorization, acquire a replacement generation or manufacture a Session on a read path.

## Concurrency, leases and cleanup

Preserve these source-order contracts:

1. Provisioning/adoption persists readiness under the repository claim before registering the attested lease locally. Cached readiness must match generation, Runtime instance ID, endpoint, token, lease ID and epoch; a stale endpoint never becomes a fallback route.
2. Reserve a Binding ID with `putIfAbsent` before starting the corresponding local operation. Existing callers either join or receive the same operation-specific refusal as before. Conditional reservation removal precedes completion of its owned future, preserving synchronous continuation behavior.
3. Reserve a Session future before acquire. On failure, remove that future before completing it exceptionally. Existing Session identity/admission checks, mount-claim replacement, control counters and release guards retain their locations and lock boundaries.
4. Invalidation first revokes the local route, then attempts a repository operation claim and the existing `READY` to `LOST` CAS. A failed claim or write must not restore the route. Release the claim in `finally`, using the exact Broker owner and operation generation; a failed best-effort release expires naturally. Invalidation alone proves neither loss evidence nor stopped writers and does not release Sessions or physical resources.
5. Physical Session release still follows durable `RELEASING` admission, worker acknowledgement and durable release completion. Failed/negative release resets the existing latch for retry. No local cache move bypasses active-execution or background-hold checks.
6. Service close sets the existing atomic fence before canceling Registry futures, then cancels the other operation futures, shuts down schedulers and closes the provisioner. Registry cancellation introduces no separate closed flag, teardown order or physical cleanup policy.

Binding IDs name durable physical generations; repository operation generations independently fence successive owners of a claim. The extraction preserves both identities and all repository checks. Process-local futures only coalesce work inside one Broker and cannot establish cross-process exclusivity.

## Implementation and follow-up sequence

The first slice adds `RuntimeBindingRegistry`, moves its maps, local context types and Binding validation/invalidation helpers, and migrates every service call site. Test-only context installation follows the new owner through `BrokerServiceTestAccess`; production gains no test hook. Update both versions of the structure review to reference the corrected ownership boundary.

The [subsequent workflow design and implementation](2026-11-01-runtime-execution-workflows.md) follows this sequence:

1. Execution reconciliation, taking its execution-ID reservations and cooldown ordering together. Pin stamp-before-reservation-removal at that seam; this Registry slice does not claim to close the existing coverage gap; the subsequent extraction adds the blocked-stamp regression.
2. Recovery scanning and its background-process settlement dependencies, after the reconciliation seam exists.
3. Cancellation and its original-generation routing and durable intent handling.

Each follow-up has its own diff and acceptance evidence. Moving all workflows into this Registry would merely recreate the large service under a new name.

## Validation and acceptance

The change is an internal refactor, so use the existing Java service and HTTP regressions instead of inventing a global CLI baseline or a new behavior E2E plan. Run focused Registry tests for full lease matching, persistent-generation eligibility, invalidation order and claim cleanup, reservation replacement and shutdown. Existing service tests cover concurrent warm/acquire/release, changed leases, stale provisioning completion, claim renewal, reconciliation routing and close fencing. Include the affected HTTP tests whose context fixtures move, durable recovery tests, the virtual-thread guard regression and module architecture checks within the module's shared local verification budget.

Preflight JDK 21, Maven >= 3.8.9 and a source-matching SDK in the task's isolated Maven repository. Use the module's focused Maven test/Checkstyle command and record the exact selected classes, source state, results and omissions. Full Java/SpotBugs, MySQL and Hosted/fault gates remain CI work. Selected in-memory or H2 cases do not establish MySQL, real-process recovery or production acceptance. If the relevant real-process path cannot run locally within budget, record it as pending rather than replacing it with a fixture claim.

Acceptance requires no raw Registry maps or context definitions in the service, no service dependency or injected callbacks in the Registry, unchanged external contracts and repository algorithms, meaningful focused regression evidence, two clean self-audit passes, synchronized bilingual documents and the required CI gates on the accepted revision. Local completion of the extraction alone does not mean CI acceptance.

## Risks and resolved questions

The main risks are changed completion order, accidental weakening of local lease checks, altered exception classification and loss of the shared context guard. Mitigate them with mechanical moves, caller-by-caller comparison and the focused tests above. Keep existing unconditional Session removal and Binding retirement points; changing their policy would be a separate behavior change.

Resolved: Registry owns Binding-operation reservations, not execution reconciliation reservations. The service owns renewal and shutdown. Durable admission remains at the original repository call sites. No open product decision is required for this slice; the subsequent collaborator APIs and validation are specified in the linked workflow design.
