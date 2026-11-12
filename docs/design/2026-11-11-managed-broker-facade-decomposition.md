# Managed Broker facade decomposition completion

[English](2026-11-11-managed-broker-facade-decomposition.md) | [简体中文](2026-11-11-managed-broker-facade-decomposition.zh-CN.md)

## Status and scope

- Status: implemented; behavior-preserving extraction and naming only.
- Date: 2026-11-11
- Scope: `packages/managed-agent-server` — `contracts`, `runtime-broker`, and the verification ratchet pin.
- Lineage: completes the broker half of the [structure review](2026-10-31-managed-agent-structure-review.md) P1, under the [class-size ratchet](2026-11-04-managed-agent-class-size-ratchet.md) discipline. Follows the [binding registry](2026-10-31-runtime-binding-registry.md) and [execution workflow](2026-11-01-runtime-execution-workflows.md) extraction style: verbatim moves, explicit constructor injection, no service callbacks.

## Problem

After the P1 extraction cluster, `RuntimeBrokerService` is still a 2,894-line facade pinned at 2,895. Three structural residues remain:

1. The drain/close cascade (~566 lines, 20 methods) and the session-release machinery (~250 lines) still live in the facade, although each is a self-contained concern with its own protocol, error-code family, and state.
2. `BindingRenewal` is an inner class of the facade, yet the already-extracted `RuntimeBindingProvisioning` imports it and receives a `BindingRenewal::new` factory. The dependency graph cycles: service → provisioning → service's inner class → service fields and methods.
3. Two byte-level protocol rules are written out repeatedly: the five-field observation↔lease identity comparison (three verbatim copies in the facade) and the two mutually exclusive Tool v3 encodings (`runtimeProtocol=3` vs `dispatchMode=deferred_v3`, 15 check sites across five classes with no named predicate).

## Design

### Named protocol rules (contracts + support)

- `RuntimeObservation.matchesRuntime(handle, lease)` names the five-field identity comparison, following the existing `RuntimeRecoveryEvidence.matches` precedent. It is identity only: callers still judge the outcome and attest separately. The null guards mirror the evidence precedent; every call site already guarantees non-null handle and lease.
- `RuntimeBrokerSupport.isPublicationV3`, `isProtocolV3`, and `isV3Family` name the two encodings and their union. `prepareExecutionReference` keeps defining the encodings; every check site switches to the predicates. The two single-encoding checks in `startExecution` are deliberately kept separate: they cover mutually exclusive references, and merging them into the family predicate would widen the refusal.

### Session-release seam (`RuntimeSessionRelease`)

A module-internal collaborator owns the session-release CAS transitions (`transitionSessionToReleasing`, `finishSessionRelease`) and the release machinery (`releaseSession`, `releaseSessionAfterSweep`, `completeSessionRelease`, `releaseUnusableSession`), moved verbatim. It takes the repositories, provisioner, transport, registry, execution recovery, and clock by constructor. The facade's `release` path and the drain cascade both consume it; `BindingRenewal.releaseStoppedSession` uses its transitions.

### `BindingRenewal` promotion

`BindingRenewal` becomes a top-level package-private class with explicit constructor dependencies, breaking the provisioning→facade cycle. `RuntimeBindingProvisioning` drops the nested-class import (same package) and keeps its `Function<RuntimeBindingRecord, BindingRenewal>` factory parameter. The facade supplies one private factory method shared by provisioning and the drain coordinator. Method bodies, the monitor discipline, and the staged stopped-flag comments move unchanged.

### Drain seam (`RuntimeDrainCoordinator`)

The drain/close cascade moves verbatim into a module-internal collaborator: harness drain, resident close, storage retirement, stop-proof observation, receipt persistence, and the paginated session/tool sweeps. It consumes `RuntimeSessionRelease` for the one release call the cascade makes (`releaseSession(context, true)`), the provisioning collaborator for the operation deadline and timeout mapping, and the renewal factory. The facade keeps thin delegations for the public drain API and for `releasedSession`'s saved-session release. No new service callback is introduced; collaborator-to-collaborator dependencies match the existing extraction style.

### Ratchet tightening

The facade pin lowers from 2895 to 1930 and the provisioning pin from 1310 to 1309; the new collaborators are each below the 800-line pin threshold. `GLOBAL_MAX_LINES` lowers from 2894 to 2662, the size of the largest remaining class (`JdbcRuntimeBindingRepository`). Ceilings only go down. The pin baseline is reconciled against upstream, which already decomposed the CSI application inventory; the local checkout predates that, so the lowered global ceiling is verified by CI on the upstream-based tree.

## Considered and rejected

- **Reusing the resolved context in local acknowledgement.** `acknowledgeExecution` resolves the ready session twice on the local path. Passing the first context down is not behavior-preserving: `requireSession` reads the in-memory registry, and a concurrent release that removes the entry between the two resolutions answers 404 today; a passed-down context would reach the locked re-validation and answer 409 instead. The double resolution is a cheap map lookup that keeps the fresh 404 check. Left unchanged.
- **Constructor parameter record.** The facade's four telescoping constructors repeat the session-creation overload disease, but they are the embedding public API (server wiring plus 35 test construction sites). That is an API-shape change with a different risk class, kept as a separate pre-release slice.
- **A shared pagination helper.** The eight cursor-pagination loops differ in batch source, page size, and error semantics. Folding them is only worthwhile inside the drain move, and the verbatim-move discipline keeps them intact for review.

## Invariants

- No public or WebShell route, OpenAPI, or schema change.
- Error codes, retryable flags, lease/generation fencing, and byte-level protocol rules are unchanged; every move is verbatim modulo the named predicates and the shared release seam.
- The `contracts` module stays Spring-free, SQL-free, and HTTP-client-free; ArchUnit passes unchanged.

## Verification

- Focused local: `RuntimeBrokerServiceTest`, `RuntimeExecutionDispatcherTest`, `RuntimeExecutionReconcilerTest`, `RuntimeBrokerServiceBindingReadTest`, `ClassSizeRatchetTest`, Checkstyle.
- CI owns the full unit/H2 suite, SpotBugs, and the Hosted/fault-gate profiles; the drain cascade's physical stop and receipt semantics are qualified by the fault gates, not by unit tests alone.
- Acceptance is pending until the required CI gates pass on the accepted revision.

## Follow-up

- Split the mirrored facade test file along the new seams (the ratchet does not cover test size).
- The constructor parameter record remains a separate pre-release slice.
- Lower `GLOBAL_MAX_LINES` further as the remaining persistence giants are decomposed.
