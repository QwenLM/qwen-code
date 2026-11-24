# Runtime execution dispatcher ownership

[English](2026-11-01-runtime-execution-dispatcher.md) | [简体中文](2026-11-01-runtime-execution-dispatcher.zh-CN.md)

- Status: implemented locally; focused verification passed; full CI acceptance pending.
- Date: 2026-11-01
- Baseline: `2aa908dc70785e38299a43964e064dbafaf7b878`, after #16029.

## Problem and current state

The execution workflows have explicit owners, but `RuntimeBrokerService` still owns dispatch reservations, physical invocations, dispatch-lease renewal and completion. Cancellation receives the invocation set and a per-call service callback. Moving just the transport call would leave the state and cleanup decisions split between owners.

This increment extracts one package-private `RuntimeExecutionDispatcher` inside the existing runtime-broker module. It preserves the current algorithms, admission boundaries, synchronous exceptions, asynchronous completion and shutdown order. It introduces no public API, HTTP route, SQL/schema, configuration, dependency or product behavior change.

The earlier full-tier run for #16029 contains an unresolved `WorkspaceCsiHostedFilesTest` cold-recovery failure before its MySQL integration phase. Preserve that evidence separately. Developing this extraction does not establish that the baseline failure is fixed or that the merged refactor has complete integration acceptance.

## Ownership and consumers

| Owner                          | Responsibility                                                                                                                                                                    | Direct consumers                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `RuntimeExecutionDispatcher`   | Dispatch reservations, physical invocation membership, claim-to-EXECUTING transition, dispatch renewal, transport invocation, v3 result waiting and persisted SSH acknowledgement | Service execution/start and drain paths; cancellation |
| `RuntimeExecutionState`        | Existing durable execution ownership, fenced settlement, UNKNOWN conversion and background-sibling settlement                                                                     | Dispatcher and existing execution workflows           |
| `RuntimeExecutionCancellation` | Durable cancellation intent, physical cancellation and prepared-provider confirmation                                                                                             | Service cancellation facade                           |
| `RuntimeBindingRegistry`       | Existing local Session contexts, route identity and Binding invalidation                                                                                                          | Service and execution collaborators                   |
| `RuntimeBrokerSupport`         | Existing shared rules plus unchanged detached/no-start receipt projections and renewal-delay calculation                                                                          | Service and dispatcher                                |
| `RuntimeBrokerService`         | Public admission and payload/grant validation, provisioning, Session/drain/stop orchestration, shared close flag, both executors and provisioner lifecycle                        | Existing adapters and assembly                        |

The dispatcher borrows the existing repositories, Registry, execution state, provisioner, transport, publication verifier, clock, lease/window settings, executors and close flag. Dependencies remain explicit constructor arguments; no general context container, interface or Spring bean is added.

The complete direct-consumer audit is the service's creation and two start families, its drain acknowledgement sweep and close sequence, cancellation's two invocation checks and unsent-dispatch branch, and `BrokerServiceTestAccess.pollDelay`. Other service receipt paths retain the shared `sshNoStartReceipt` and `isDetachedCapture` projections through Support. Repository and transport contracts remain unchanged.

## Dispatch admission and execution

Move all three `beginDispatch` overloads, `dispatch`, `enterExecuting`, reference/capture projection and `DispatchRenewal` together. Private CSI restrictions, Harness admission and deferred-payload refusal stay in their original order before reservation acquisition. Existing Session-context lock regions remain at callers; the dispatcher adds no lock around admission or dispatch.

The reservation map uses `putIfAbsent` and conditional `remove(executionId, exactFuture)` on synchronous failure and asynchronous completion. It covers claim/fencing work as well as physical invocation. The distinct invocation set starts only immediately before calling transport, after renewal starts. Cancellation observes that set through `isInvoking(executionId)` rather than receiving mutable state.

Preserve claim, fenced EXECUTING transition, owner/generation checks, usable-lease validation, renewal start and transport invocation in that order. A cancelled unsent execution still settles through the existing dispatcher path. Do not replace it with a new cancellation settlement algorithm or replay UNKNOWN work.

On completion, remove the physical invocation marker before persisting either the settled result or UNKNOWN outcome. Preserve background-sibling settlement and best-effort SSH acknowledgement after the durable write. A transport/null-result or ordinary settlement failure retains the existing UNKNOWN mapping. Synchronous `RuntimeBrokerException` values remain unchanged; other synchronous runtime/JVM failures retain `runtime_execution_dispatch_failed` wrapping and reservation cleanup.

## V3 results and SSH acknowledgement

V3 result waiting is part of the dispatch call closure and moves unchanged. Keep publication-first evidence reads, dispatch/Binding identity checks, lease/deadline refusal, explicit `not_started`, detached results, non-retryable error handling and 100 ms doubling backoff capped at 2 s. The test-only backoff accessor points to the new owner.

Move `acknowledgePersistedTools` into the dispatcher because dispatch completion and the service's drain sweep both consume it. Drain and physical Runtime stop remain service orchestration. Move the shared stateless `sshNoStartReceipt`, `isDetachedCapture` and `renewalDelayMillis` helpers to existing Support; do not duplicate their policies or introduce another collaborator.

## Cancellation and shutdown

Cancellation receives the concrete dispatcher. Replace the raw invocation-set reads with `isInvoking` and the `BiConsumer` callback with `beginDispatch(context, requested)`. Keep ownership reads, durable intent, admission refusals, control guards and physical cancellation order unchanged.

The service remains the sole writer of `closed` and the owner of both executors and the provisioner. Its shutdown sequence stays: set the close fence; cancel Registry operations; cancel dispatcher reservation futures; cancel reconciler operations; shut down coordination and renewal executors; close the provisioner.

`cancelPendingOperations` cancels only the existing reservation-wrapper futures. It does not cancel underlying transport stages, clear physical invocation markers or shut down borrowed resources. Do not add a new close check inside `beginDispatch`; changing the handling of already-admitted operations is outside this extraction.

## Files and migration

Add `RuntimeExecutionDispatcher`; update service construction/delegation, cancellation, shared Support and the test-only backoff accessor. Add focused dispatcher tests and retain the existing service, HTTP, SSH and protocol regressions. Link this design from both execution-workflow documents and update their current ownership description together.

Implement after the baseline dry-run: move state and the complete dispatch closure; wire the dispatcher before cancellation; replace all direct consumers; update tests and both design languages. Keep migration mechanical and review the complete diff for accidental algorithm or exception-boundary changes.

## Verification and acceptance

Follow `packages/managed-agent-server/AGENTS.md`, including the shared 10-minute local verification budget, JDK 21, matching source-built SDK and isolated Maven repository. An internal Java extraction has no meaningful global-CLI behavioral probe: record the installed `qwen --version` as environment evidence only, and establish the baseline through the existing Java fixtures. No model call or JavaScript build is needed for those selected fixtures.

The focused plan is recorded under `.qwen/e2e-tests/runtime-execution-dispatcher.md`. Pin reservation deduplication, synchronous-failure cleanup, invocation removal before settlement/UNKNOWN and shutdown that preserves the underlying invocation and borrowed resources. Reuse `RuntimeBrokerServiceTest`, `RuntimeSshAcknowledgementTest`, `Issue13183RegressionTest` and `RuntimeBrokerHttpServerTest` for cancellation/fencing, v3/private CSI, receipt and HTTP integration behavior. Run compilation, both Checkstyle goals and the selected tests; check actual report counts and skips.

The baseline passed 280 selected tests. After extraction, the same suites plus five dispatcher cases passed 285 tests with no failures, errors or skips; both Checkstyle goals passed. Verification used JDK 21 on macOS with the source-matching SDK and isolated Maven repository. Setup, the initial unused-import Checkstyle failure and the corrected run used 252.587 seconds of the shared local budget. The cancellation witness proves preservation of the physical invocation and borrowed resources; exact wrapper cancellation is checked by source equivalence rather than a private-state test accessor.

Acceptance requires one dispatch-state owner; no cancellation callback or raw invocation-set injection; unchanged public contracts/schema and dispatch algorithms; preserved close/completion order; focused regressions passing; synchronized bilingual docs; and two clean self-audit passes. Full MySQL 8.4, bundled Hosted/fault, cross-platform and full SpotBugs gates remain CI work. Local fixtures do not establish those results, and an isolated pass does not clear the earlier wider failure.

## Risks and open questions

The material risks are moving the invocation marker relative to settlement, changing reservation cleanup, losing original-generation routing, changing v3 deadline/receipt precedence, or taking over executor/transport cancellation. Preserve method bodies and caller lock envelopes, then exercise the existing witnesses and the new owner-focused tests.

There is no open product decision. Further provisioning, Session lifecycle or persistence extraction is outside this increment. The unresolved baseline cold-recovery failure remains a separate investigation and acceptance gap.
