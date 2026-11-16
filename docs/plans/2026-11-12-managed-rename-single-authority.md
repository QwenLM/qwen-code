# Implementation plan: Managed Session rename single display authority

Design: [2026-11-12-managed-rename-single-authority](../design/2026-11-12-managed-rename-single-authority.md)
([简体中文](../design/2026-11-12-managed-rename-single-authority.zh-CN.md)).

Status: implemented (Phases 1–5). Production compiles + checkstyle clean across
all 13 modules (net −800 production lines). Focused H2 regression independently
verified green (196 tests across rename/lifecycle/admission/replay/reconciler/
contract/surface/lock-order/store-decomposition/javadoc-pin). Real-MySQL and
fault-profile qualification remain CI-owned. Date: 2026-11-12.

Self-audit follow-up (2026-11-12): completed the missed Phase-4 migration idle
gate removal in `WorkspaceMigrationStore.requireIdle` (the plan had named
`WorkspaceMigrationAdmission`), rewrote its `WorkspaceMigrationStoreTest` cases
to assert a title delivery never holds a migration, dropped the orphaned
`sql-owners.txt` pin, removed the dead `SessionMutationCommand.renameRevision`
field, inlined the now single-use replay-actor probe, refreshed the stale
saga comments and the README rename section. Re-verified green: migration store
(31), lock-order/javadoc-pin/decomposition (8), and rename/replay/admission/
lifecycle (122); checkstyle clean across the reactor.

This plan enumerates the exact change surface mapped during research. The change
is confined to `packages/managed-agent-server` (Java); TypeScript, the Java SDK,
the Harness `/session/:id/title` route, the journal watermark, the OpenAPI spec,
and the WebShell contract are unchanged.

## Core idea

Replace the cross-store rename saga with a synchronous local SQL mutation that
reuses the existing shared command machinery, followed by a best-effort journal
notification. The new store method `settleRenameSync` composes the existing
`beginSessionMutation` + `completeSessionMutation` (which already handle the
idempotency receipt, the `ma_session.title` update, and the requested/completed
mutation events) and adds only the `title_revision` increment. It creates no
`ma_operation` delivery row, claim, or lease.

## Phase 1 — contracts (additive first)

- `model/StoreModels.java`: add `record SyncRename(SessionRecord session, long
revision)`. Keep `RenameDelivery` until Phase 4 removes its last user.
- `contracts/session/SessionAdmissionStore.java`: add
  `SyncRename settleRenameSync(tenantId, idempotencyKey, requestDigest,
sessionId, title, actorId)`.
- `contracts/session/SessionLifecycleStore.java`: leave `renameAcceptance` /
  `settleParkedRename` defaults until Phase 4.

## Phase 2 — persistence

- `AgentSessionCommands.java`: add `settleRenameSync` (lock tenant + session,
  replay-owner check via `requireRenameReplayOwner`, `beginSessionMutation`,
  early-return on COMPLETED, increment `title_revision`, `completeSessionMutation`
  with `bootId = null`, return `SyncRename`).
- `ManagedAgentStore.java`: add the `@Transactional @Override settleRenameSync`
  delegation.

## Phase 3 — control-plane switch-over

- `ManagedAgentService.renameSession`: keep admission (idempotency pre-read,
  actor/role, visibility, worktree readiness, `validRenameTitle`). Replace the
  `beginSessionRename` → claim → attach → `harness.rename` → `completeSessionRename`
  block with:
  1. `store.settleRenameSync(...)` (one transaction).
  2. If not replayed and `harness.supportsFencedTitles()`, best-effort
     `harness.rename(tenant, session, title, result.revision())` in a try/catch
     that logs at debug and never fails the request.
  3. Return `publicSession(asLastVisible(result.session()))`.
  - Remove the `supportsFencedTitles` admission refusal (now a notification
    precondition only). Remove `awaitRenameSettle` and `RENAME_CLAIM_SETTLE`.
- Delete `session/SessionRenameCoordinator.java` and `session/RenameEvidence.java`.
- `OperationReconciler` / evidence registration: drop the RENAME evidence arm
  (`RenameEvidence` bean and its `AcceptanceEvidence` registration).

## Phase 4 — remove the saga

- `AgentSessionCommands.java`: delete `beginSessionRename`, `completeSessionRename`
  (both), `settleRename`, `abandonSessionRename`, `deliverableRenames`,
  `claimRename`, `markRenameSubmitted`, `retryRename`, `renameDelivery`,
  `renameKey`, `PARK_RENAME`, `SESSION_TITLE_UNCONFIRMED` and rename-only helpers.
- `AgentExecutionOperations.java`: delete `renameAcceptance`, `settleParkedRename`,
  and the D7-2 RENAME settlement arm (the `UPDATE ma_session SET title` at ~880).
- `ManagedAgentStore.java`: delete the corresponding facade methods.
- `SessionAdmissionStore.java` / `SessionLifecycleStore.java`: delete the renamed
  delivery declarations and the parked-rename defaults.
- `StoreModels.java`: delete `RenameDelivery`.
- `AgentLifecycleOperations.java`: remove the pending-rename block from lifecycle
  admission (the "pending rename or unarchive command" gate at ~951 keeps the
  unarchive half).
- `WorkspaceMigrationStore.requireIdle`: remove the unfinished-title-delivery
  idle gate (the `RENAME` `ma_operation` count) and its `sql-owners.txt` pin.
- Schema: no column added or removed. `ma_session.title_revision` stays (journal
  ordering); shared `ma_operation.delivery_*` columns stay (other kinds). V1
  baseline unchanged.

## Phase 5 — tests

Inventory (from the verification sweep) drives this phase; categories:

- Rewrite rename CRUD/replay/conflict tests to assert synchronous settlement
  (no PENDING operation, no delivery row, COMPLETED receipt, confirmed title).
- Delete delivery/redelivery/claim/lease/parked-recovery (D7-2) rename tests and
  the `SessionRenameCoordinator` / `RenameEvidence` tests.
- Update lifecycle/migration tests that asserted a rename blocks close/delete or
  migration: they must now assert it does not.
- Keep journal-ordering tests: concurrent/late notifications ordered by
  `title_revision`; the TS watermark tests are unchanged.
- Contract/architecture: `ManagedAgentApiContractTest`, `SurfaceRegistryGateTest`
  (route unchanged) and ArchUnit gates after class deletion.

## Verification

- Local (within the module budget): focused H2 unit tests for the new
  `settleRenameSync` and `renameSession`; `checkstyle:check`; compile the reactor.
- CI (required, not substitutable by H2): `mysql-integration` for the settlement
  transaction and receipt replay under concurrency; the Hosted/fault profiles
  with rename-specific delivery assertions removed.
- TypeScript: unchanged `/session/:id/title` and watermark regressions.

## Landing

This is a durability/recovery refactor in a maintainer-gated module. Land as a
reviewed PR with the bilingual design doc, this plan, the production diff, and
the test rewrite together; CI owns the real-MySQL and fault qualification.
Development catalogs are recreated under the fresh-schema policy; a deployment
carrying live PENDING rename deliveries drains them with the old binary before
cutover (release note).

## Risk register

- Journal title lag on failed notification — accepted (auto-title divergence
  precedent); public SQL title always correct.
- In-flight deliveries at upgrade — drain before cutover; fresh-schema policy.
- Dual-store durability guarantee at HTTP 200 — explicitly downgraded for a
  display field; documented in design and README.
