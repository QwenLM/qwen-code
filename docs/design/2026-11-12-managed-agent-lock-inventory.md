# Managed Agent lock inventory: lifecycle claim mirror and tenant guards

[English](2026-11-12-managed-agent-lock-inventory.md) | [简体中文](2026-11-12-managed-agent-lock-inventory.zh-CN.md)

## Status and scope

- Status: investigation record and proposal. This document changes no code; every follow-up below needs its own change, baseline reproduction and MySQL evidence.
- Date: 2026-11-12; revised 2026-11-13 after merging `main`. Source baseline: `main` at `6fb21a87f3`.
- Scope: `packages/managed-agent-server`, mainly the `persistence` module. It answers two questions left open by a review of the module's lock design:
  1. Is the lifecycle claim copy on `ma_session_head` (the "claim mirror") still needed?
  2. Which `ma_tenant_guard` acquisitions still protect a tenant-wide invariant, and which only serialize work that row locks already order?
- Related work: the lock simplification series ([lock simplification](2026-11-02-managed-agent-lock-simplification.md), [lock scope](2026-11-04-managed-lock-scope.md), [remaining lock optimization](2026-11-05-managed-remaining-lock-optimization.md)) and the tenant guard series, from the [tenant guard wedge](2026-10-11-managed-tenant-guard-wedge.md) to [binding control tenant guards](2026-11-06-managed-binding-control-tenant-guards.md). The same review produced the gap-lock fix in #17069 and the binding-control read reduction in #17072, both merged. The [rename single-authority redesign](2026-11-12-managed-rename-single-authority.md) removed the rename tenant guard in #17074.

## Problem

The module now layers row locks, leases with generations, and two tenant-wide guard rows. Earlier designs removed many guard acquisitions one path at a time, but there is no single list of what remains and why. Two specific doubts came out of the review:

- Lifecycle claim state is stored twice, on the `ma_operation` row and on the Session head, and every claim, renewal and settlement writes both in one transaction.
- Roughly a hundred guard call lines remain (106 at the baseline, including wrapper bodies), with three different wait-bound policies and a name (`WorkspaceMigrationAdmission.lockTenant`) that hides which guard row it takes.

## Part 1: lifecycle claim mirror

### Current state

The authoritative claim lives on `ma_operation` (`claim_owner`, `claim_generation`, `claim_until`). The head row `ma_session_head` carries `phase`, `operation_id` and a copy of the claim in `claim_generation` and `claim_lease_until`. The copy is maintained only for lifecycle protocols 1 and 2 (`WorkspaceToolProfiles.lifecycleProtocol(int)`).

| Writer                                                                                      | Effect on the head copy                                                   | Lock order                                                    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `AgentLifecycleOperations.claimOperation`, `renewLifecycleOperation` → `syncLifecycleClaim` | Reads the operation row it just updated, then writes generation and lease | Session root (`lockOperationSession`) → `ma_operation` → head |
| `blockLifecycleOperation`, `retryOperation`                                                 | Clears the lease only; the operation stays admission-closed               | Session root → `ma_operation` → head                          |
| `failOperation`                                                                             | Clears `operation_id` and the lease; phase stays `LIFECYCLE_ONLY`         | Session root → `ma_operation` → head                          |
| `JdbcWorkspaceLifecycleStore.saveEffects`                                                   | Sets `DRAINING`; keeps the lease only for protocol 2                      | Placement and publication guards → `ma_operation` → head      |
| `JdbcRuntimeBindingRepository.requestHarnessDrain`                                          | Upserts `DRAINING` and clears the lease                                   | Placement → drain root → head                                 |

| Reader                                                                                                                                                                                                                                                                                           | Source of the claim                                                                                                                                     | Lock                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Broker admission with a lifecycle authority: `RuntimeAdmissionFences.requireHarnessAdmission`, reached from `completeStoppedSessionRelease`, `admitSession`, `compareAndSet` with a drain receipt, and the `requireHarnessAdmission` / `requireHarnessCleanup` / `requireHookAdmission` wrappers | The head copy: phase, `operation_id`, `claim_generation`, `claim_lease_until` compared with database time                                               | Head `FOR SHARE` (`FOR UPDATE` on H2), after the caller has locked its binding row and, on some paths, storage rows or placement |
| Managed-agent lifecycle writers: `JdbcWorkspaceLifecycleStore.requireClaim`, used by `JournalFencing.checkLifecycleWriter` and lifecycle effects                                                                                                                                                 | `ma_operation` directly, joined with `ma_session` and the head                                                                                          | One `FOR UPDATE` statement over operation, Session and head                                                                      |
| `JdbcRuntimeBindingRepository.requestHarnessDrain`                                                                                                                                                                                                                                               | The upsert's `ON DUPLICATE KEY UPDATE` reads `phase` and `claim_lease_until` in the `gmt_modified` CASE while setting `DRAINING` and clearing the lease | Placement → drain root → head; no `ma_operation` lock                                                                            |

The broker admission check is therefore the only reader that validates the copy for an admission decision. The drain upsert also reads `claim_lease_until` inside its `gmt_modified` CASE, and the managed-agent side already validates the claim against `ma_operation`.

### Analysis

The copy gives the broker one current read that returns the phase, the operation identity and the claim together, on a row it locks anyway for the phase.

The alternative is for the broker to share-lock the authority's `ma_operation` row (generation, lease and delivery state) and then the head (phase and `operation_id`). Lock order decides whether that is safe:

- Every writer that locks `ma_operation` locks it before the head. `requestHarnessDrain` is the one head writer that never takes the operation row (Placement → drain root → head), so it cannot close an operation↔head cycle. The broker must use the same operation-before-head order. Reading the head first and the operation second would close a cycle with a claim, renewal or failure that holds the operation row and waits for the head.
- With operation-then-head, a writer that holds the operation row makes the broker wait before the broker touches the head, and a broker that holds the operation share lock makes the writer wait before the writer touches the head. Neither side holds the second row while waiting for the first.
- Transactions that hold the head exclusively and then lock a binding row already conflict with the broker today, because the broker share-locks the head after its binding row. The alternative adds the operation row at the same position, so it adds no new cycle through bindings. This conclusion comes from reading the source and must be confirmed by MySQL races.

What the copy costs today:

- An extra `SELECT` on `ma_operation` and `UPDATE` on the head for every claim and renewal of a protocol 1 or 2 lifecycle operation, plus head updates on block, retry and failure.
- Seven writer sites in the managed-agent and Runtime Broker persistence packages must keep two copies consistent. A missed update would make the broker admit or refuse against a stale lease.
- For a managed Session, the head row is also the journal head, so each renewal takes an exclusive lock on the row that journal commits lock.

The cost per call is small, because renewals are periodic and the head update is short.

### Decision

The copy is not required by lock order, so it is removable. Keep it for now. Remove it only when there is a concrete trigger, such as measured renewal contention on the head or a defect traced to the copy drifting, and only together with the prerequisites under [Follow-ups](#follow-ups).

## Part 2: tenant guard inventory

### Guard rows and entry points

`ma_tenant_guard` holds one row per `(tenant_key, guard_domain)`. It is acquired with `INSERT … ON DUPLICATE KEY UPDATE` followed by `SELECT … FOR UPDATE`. There are two domains:

- `runtime_placement` (placement). The primitive is `JdbcRuntimeBindingRepository.lockPlacementDomain`. It is wrapped by `JdbcWorkspaceLifecycleStore.lockPlacement`, `JournalFencing.lockPlacementBounded`, `WorkspaceMigrationAdmission.lockTenant` and `WorkspaceStorageKindGuard.lockDomain`. The `lockTenant` name says "tenant" but the method takes the placement row. Operator storage registration also uses this domain under a sentinel key (`external-storage-registration/1`) as a deliberate cross-tenant lock, and `LocalStorageOwners` locks under a per-host sentinel (`local-storage-host/<hostId>`).
- `output_publication` (publication). The primitive is `ToolPublicationRetentionStore.lockTenant`, with local bounded wrappers in `ToolPublicationStore` and `ToolPublicationAdmissionStore`. The CSI retention root (`JdbcCsiFilesRetirementGuard.lockRetentionRoot` and `initializeRetentionRoot`) locks the same row.

At the baseline, the regeneration command below matches 121 lines in the production sources: 15 method declarations and 106 call lines. The call lines include wrapper bodies and overload delegations, so the table groups entry operations rather than raw lines. The `WorkspaceStorageKindGuard.lockDomain` family (23 call sites across nine storage and worktree stores) is folded into G4.

### Inventory

| Group                                                   | Entry operations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Guard                                                  | What the guard protects                                                                                                                                                                                                                                                                                        | Classification                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| G1 Runtime placement and binding lifecycle (broker)     | `findOrCreate`, `admitSession`, `recoverLost`, `compareAndSet`, `requestHarnessDrain`, `requestStorageFence`, `verifyHarnessStopped`, `completeStoppedSessionRelease`, `createSessionTombstone`, `lockActiveForRetirement`, `JdbcRuntimeRetention.visit`, `ExecutionAdmissionPlacement.lockEntry` (no Session root), `WorkspaceOperatorRecoveryStore.prepare`                                                                                                                                                                                                                                                             | Placement                                              | Placement scans recovery obstacles across a tenant's bindings and slots. Retention reads references at READ COMMITTED under placement. Admission and drain are ordered against binding transitions.                                                                                                            | Keep: tenant-wide invariant                                                  |
| G2 Resident Workspace conditionals                      | `JdbcRuntimeBindingRepository.claimOperation` and `authorizeDispatch` (resident profile only), `ResidentWorkspaceRetirementStore.authorize` and `lockedPlan`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Placement; retirement also takes publication           | Harness admission rows and resident retirement, read only by Resident Workspaces                                                                                                                                                                                                                               | Keep: already narrowed to the profile that needs it                          |
| G3 Lifecycle protocol and writer ownership              | `AgentLifecycleOperations.beginLifecycle` and `completeOperation`, `JdbcWorkspaceLifecycleStore.lock`, `JdbcHarnessPlacementStore.lockEligible`, `JournalLifecycleAuthorization.authorizeLifecycle`, `JournalFencing.checkLifecycleWriter` (only with a lifecycle authority), `JournalWriterLifecycle.acquireWriter` and `releaseOwnership`                                                                                                                                                                                                                                                                               | Placement then publication                             | Lifecycle begin, settle, takeover and quiesce take the guards, then the Session, then the head (role R1 of the journal commit design). Writer ownership changes stay ordered against them and against retirement.                                                                                              | Keep: ordering contract                                                      |
| G4 Admission against fences, and tenant-scoped creation | `AgentLifecycleOperations.beginOperation`, `unarchiveWorkspaceSession`, `beginChildClose`; `AgentSessionAdmissions.insertWorkspaceSessionCommand` (selections that may resolve to a Resident Workspace), `insertInternalTeamLeadSessionCommand`, `insertChildSession`; `WorkspaceMigrationStore.lockAuthority`; `WorkspaceStorageKindGuard.lockDomain` (`WorkspaceStorageGuard`, `JdbcSessionWorktreeStore`, `JdbcWorkspaceExecutionStore`, `JdbcSshWorkspaceStore`, `JdbcChildWorkspaceStore`, `ExternalStorageRegistrationStore`, `WorkspaceMaintenanceRecovery`, `WorkspaceCsiReservationStore`, `LocalStorageOwners`) | Placement (migration authority also takes publication) | Fence installation and admission share this lock before any Session lock. Selections that may resolve to a Resident Workspace keep the tenant guard; default selections keep the tenant scan to stay ordered with default switches. Storage-kind transitions take the same placement row through `lockDomain`. | Mostly keep. One candidate, one audit gap, and one resolved candidate below. |
| G5 Conditional per-turn placement                       | `JournalCommit.commit` (only for records with hosted-cleanup references), `ToolPublicationPlacement.lockEntry` and `JournalWriterLifecycle.lockPublicationWriter` (only when the original binding is not placement-free; otherwise the lane takes the Session root instead)                                                                                                                                                                                                                                                                                                                                               | Placement                                              | Hosted cleanup references stay visible to Runtime retention. A lane that took placement keeps placement before the root; a lane that took the root never takes placement after it.                                                                                                                             | Keep: already narrowed                                                       |
| G6 Publication collection and retention order           | `SessionResourceCollectionCollector.claim` and `page`, `ManagedProjectionResourceCollector.collect`, `ToolPublicationRetentionStore.lockSessionHead` (when asked for the guard)                                                                                                                                                                                                                                                                                                                                                                                                                                           | Publication                                            | Collection takes the guard, then the Session root and head, then publication and operation rows                                                                                                                                                                                                                | Keep: ordering contract                                                      |
| G7 CSI originals and lifecycle-authority receipts       | `ToolPublicationStore.require` (CSI original and CSI settlement) and `applyLocked`, `ToolPublicationAdmissionStore.require` (CSI or lifecycle authority), `JournalWriterLifecycle.lockPublicationWriter` (CSI publication guard)                                                                                                                                                                                                                                                                                                                                                                                          | Publication                                            | CSI retirement and continuation expect the guard before the root. Ordinary producers no longer take it ([publication tenant guards](2026-11-04-managed-publication-tenant-guards.md), C2).                                                                                                                     | Keep: already narrowed                                                       |
| G8 Private CSI files profile                            | `JdbcCsiFilesRetirementGuard.requireProvisionPin`, `lockBindingControl` / `lockExecutionControl` (profile bindings, or the non-execution / missing-root paths), `lockManagedSession`; `WorkspaceCsiRuntimeAccess.resolve`, `admission`, `readNative`; `WorkspaceCsiSessionCommands.create`; the CSI continuation lane in `JournalFencing`                                                                                                                                                                                                                                                                                 | Both guards and the retention root                     | The pinned original binding, its retention root and single-Session admission                                                                                                                                                                                                                                   | Keep while the profile exists                                                |

The tenant byte quota was the other historical reason for the publication guard. It no longer needs the guard: C1 of the publication tenant guards design is implemented.

### Candidates and gaps

1. **Rename gap hazard (resolved in #17074).** The former `AgentSessionCommands.beginSessionRename` guard existed because "empty operation ranges can share an InnoDB gap even across Session scopes" — a hidden gap-lock hazard (role R3 in the journal commit design), not a tenant invariant. The [rename single-authority redesign](2026-11-12-managed-rename-single-authority.md) replaced it with `settleRenameSync`, which takes no tenant guard: the replay probe does not lock, and a racing Session reusing the key loses on the receipt's unique key. This entry is kept as a record of the hazard and its resolution.
2. **Default Workspace selection in `insertWorkspaceSessionCommand`**. The tenant scan keeps creation ordered with default switches. It can only be narrowed together with a default-switch protocol that locks a single per-tenant pointer row. Leave it alone until default switching changes for another reason.
3. **Audit gap: `beginOperation`, `unarchiveWorkspaceSession` and `beginChildClose`**. They take the placement guard through `WorkspaceMigrationAdmission.lockTenant`, but the source does not say whether they rely on it for fence admission or only for lifecycle order. Apply the criteria of the [Session commands audit](2026-11-03-managed-session-commands-tenant-guard.md) to each before classifying them as keep or candidate.

### Wait bounds and naming

Three wait policies coexist for the same rows:

- Unbounded: the InnoDB default wait, as in `lockPlacementDomain(connection, tenant)`.
- The named five-second bound `JournalFencing.GUARD_ACQUIRE_TIMEOUT_SECONDS`, wrapped by `lockBounded` so that a wait fails as `tenant_guard_contended`.
- A literal ten-second bound, passed directly on CSI, retention, resident and storage registration paths.

The choice follows each path's history rather than a stated rule. The method name `WorkspaceMigrationAdmission.lockTenant` adds to the confusion, because the publication wrappers also use the name `lockTenant` for the other row.

## Design decisions and rationale

- **Record, don't remove.** Most remaining acquisitions match a contract an earlier design already accepted. Removing any of them is a protocol change and needs its own reproduction and races. This document only fixes the map.
- **Classify by entry operation, not by call line.** The same guard is taken through several wrappers, and one operation can take both guards. Line counts mix wrapper bodies with real entry points.
- **Keep the claim mirror for now.** It is redundant, but removing it touches seven writers in both persistence packages, and the broker reader, for a small gain. Its main justification would be removing the dual-write invariant, which deserves its own change.

## Constraints

- Admitted operations and recovery decisions stay durable in SQL. A stale owner must never commit durable state or release a newer owner's resources.
- Lock order is fixed per resource: guards before the Session root, root before head, and binding control as defined in the binding control design. A follow-up must not take a guard after a root on any path that other paths lock in the opposite order.
- Until the first formal release, schema changes edit the V1 baseline in place.

## Risks

- The classification is based on reading the source at the baseline. Branches that no test covers may rely on a guard in ways the comments do not state. Each follow-up must reproduce its assumption on MySQL with independent connections before it removes anything.
- The inventory goes stale as soon as code moves. The regeneration command below keeps it checkable.

## Follow-ups

Ordered from cheapest to most involved. Each is a separate change.

1. **Naming and bounds (behavior-preserving).** Rename `WorkspaceMigrationAdmission.lockTenant` to say it takes placement, and replace literal ten-second bounds with a named constant. No lock changes.
2. **Rename gap hazard — done (#17074).** `settleRenameSync` settles rename without a tenant guard and without a locking replay probe; unique-key insert arbitration replaced the missing-range locking read. No further work; see Candidate #1 and the [rename single-authority design](2026-11-12-managed-rename-single-authority.md).
3. **G4 audit gap.** Classify `beginOperation`, `unarchiveWorkspaceSession` and `beginChildClose` against the Session commands audit criteria.
4. **Claim mirror removal (conditional).** Only after a trigger from Part 1. Broker admission reads the operation row `FOR SHARE` before the head; this amends the [lock scope](2026-11-04-managed-lock-scope.md) requirement that broker admission with a lifecycle authority reads and share-locks the current head claim. Drop `claim_generation` and `claim_lease_until` from the head in the V1 baseline, and from `ManagedSchemaProjection.SESSION_HEAD`, which `JdbcCsiActivationAdmission.activeNativeHead` selects without consuming the two columns. Remove `syncLifecycleClaim` and the head lease updates in block, retry, fail and `saveEffects`. Rewrite the drain upsert's `gmt_modified` CASE rather than only deleting `claim_lease_until = NULL`: the CASE reads `claim_lease_until IS NOT NULL`, so dropping the column without rewriting it leaves a statement that no longer prepares, and deleting the CASE outright loses the rule that bumps `gmt_modified` only for a new, non-draining or still-leased row. Acceptance: MySQL races for claim versus broker admission, terminal settlement versus admission, and drain versus renewal, plus the existing lifecycle and broker suites.
5. **Private CSI files profile.** If the profile is retired, remove G8 and the CSI branches of G7 together with it.

## Validation and acceptance

This change is documentation only. It needs Markdown formatting and link checks for both language versions.

Reviewers can regenerate the raw call list from `packages/managed-agent-server`:

```bash
grep -rn -E '(lockPlacementDomain|lockPlacement|lockPlacementBounded|lockTenant|lockRetentionRoot|initializeRetentionRoot|lockDomain)\(' \
  persistence/src/main/java control-plane/src/main/java runtime-broker/src/main/java
```

The command matches 121 lines at the baseline: 15 method declarations and 106 call lines (see Part 2). Declaration lines are the signatures with a typed first parameter; isolate them by piping the output through:

```bash
grep -E '(lockPlacementDomain|lockPlacement|lockPlacementBounded|lockTenant|lockRetentionRoot|initializeRetentionRoot|lockDomain)\((Connection|JdbcTemplate|String|JsonNode) '
```

The document is accepted when:

- both language versions are complete and cross-linked;
- every group in the inventory maps to the call sites at the stated baseline;
- each follow-up states its own acceptance evidence before implementation starts.
