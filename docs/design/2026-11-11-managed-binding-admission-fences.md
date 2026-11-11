# Managed binding admission and fence extraction

[English](2026-11-11-managed-binding-admission-fences.md) | [简体中文](2026-11-11-managed-binding-admission-fences.zh-CN.md)

## Status and scope

- Status: implemented; behavior-preserving extraction and call-site sweep only. Landed on top of the merged broker facade decomposition ([#16922](https://github.com/QwenLM/qwen-code/pull/16922)), whose lowered global ceiling this slice ratchets down again.
- Date: 2026-11-11
- Scope: `packages/managed-agent-server` — the `persistence` module (`runtimebroker.persistence`), with a mechanical call-site sweep across the other persistence packages that share the fence vocabulary.
- Lineage: continues the [structure review](2026-10-31-managed-agent-structure-review.md) P1 and the [class-size ratchet](2026-11-04-managed-agent-class-size-ratchet.md) discipline, using the [store decomposition](2026-11-02-managed-store-decomposition.md) pattern (a facade plus connection-sharing collaborators) most recently applied by the [broker facade decomposition](2026-11-11-managed-broker-facade-decomposition.md).

## Problem

`JdbcRuntimeBindingRepository` is 2,662 lines and, after the broker facade decomposition lowers the global ceiling to 2,662, becomes the class that seeds `GLOBAL_MAX_LINES`. The ratchet can only lower again once this class shrinks below the next largest pin (`ToolPublicationDataStore`, 2,574).

The repository accumulated two concerns beyond binding CRUD, CAS and lease operations:

1. A Harness admission/fence **engine**: the `Connection`-taking SQL that decides whether new work, recovery, cleanup, hook control or lifecycle may proceed against a Harness Session head, including the `HarnessFence` enum, the dialect-specific lock clause, and the storage-admission checks.
2. A shared fence **vocabulary**: the public static key and lifecycle helpers (`harnessDrainKey`, `storageFenceKey`, `storageAliasKey`, `beginHarnessLifecycle`, `hasSharedRuntimeSessions`) that the rest of the persistence module already calls as a common SQL vocabulary.

Both are static, connection-taking, and cohesive; neither needs the repository's binding state.

## Current state

The admission/fence methods follow one shape: a public interface method on the repository owns a transaction through `JdbcRepositorySupport.transaction(dataSource, ...)` and delegates to a static `Connection`-taking core. The core carries the SQL, the `HarnessFence` set, the H2 `FOR UPDATE` / MySQL `FOR SHARE` claim lock, and the database-time lease comparison. The private `requireHarnessRecovery` opens its own transaction and runs two head/operation SELECTs before delegating to the same core.

The shared vocabulary is already public static and used well beyond this repository:

- `harnessDrainKey`: `JdbcCsiApplicationRetirement`, `JdbcCsiActivationAdmission`, `JdbcHarnessPlacementStore`, `AgentLifecycleOperations`, `JdbcWorkspaceLifecycleStore`, `JournalFencing`, `WorkspaceCsiApplicationHistoryImage`, and others.
- `storageFenceKey`: `JdbcSshWorkspaceStore`, `WorkspaceStorageGuard`, `ExternalStorageRegistrationStore`, `WorkspaceMigrationStore`, `WorkspaceCsiReservationStore`, `WorkspaceCsiApplicationInventory`, and others.
- `storageAliasKey`: `ExecutionAdmissionPlacement`, `JdbcCsiReadyAdmission`, `JdbcCsiRetirementSeal`, `AgentSessionPolicies`, `JdbcCsiApplicationProgress`, `WorkspaceMigrationAdmission`, `LocalStorageOwners`, and others.
- `beginHarnessLifecycle`: `AgentLifecycleOperations`.
- `hasSharedRuntimeSessions`: `JdbcWorkspaceLifecycleStore`.
- The static `requireHarnessAdmission(Connection, ...)`: `WorkspaceCsiRuntimeAccess`.

The interface methods (`requireHarnessAdmission`, `requireHarnessRecovery`, `requireHarnessCleanup`, `requireHookAdmission`, `requestHarnessDrain`, `isHarnessDraining`, `requestStorageFence`, `isStorageFenced`) are declared on `RuntimeBindingRepository` in `contracts` and implemented by both the JDBC and in-memory repositories; callers in `runtime-broker` consume them through the interface.

## Proposed solution

Extract a `RuntimeAdmissionFences` collaborator in `runtimebroker.persistence` that owns the static `Connection`-taking engine and the shared fence vocabulary. The repository keeps transaction ownership, the interface wrappers, and the binding CRUD/CAS/lease core.

The class is `public final` with a private constructor, not package-private: roughly thirty-five callers live in `managedagent.persistence` and in verification test packages outside `runtimebroker.persistence`, and a package-private class cannot be imported cross-package. Only the six already-public vocabulary members are public; the entire engine surface stays package-private. This matches the existing public collaborators in the same package (`JdbcCsiReadyAdmission`, `JdbcCsiActivationAdmission`); ArchUnit enforces no visibility rule.

### What moves

- The `HarnessFence` enum and `fence(...)`.
- The static `requireHarnessAdmission(Connection, ...)` core and its public overload, `requireStorageAdmission`, `requireResidentWorkspaceAdmission`, `requirePhysicalStorageAdmission`, `hasHarnessDrain`, `storageFence`, `localStorageOwnerKey` (both overloads), `unverifiedWorkspaceHolder`, `admissionClosed`, and the SQL body of `requireHarnessRecovery` as a `Connection`-taking method.
- The shared vocabulary: `harnessDrainKey`, `storageFenceKey`, `storageAliasKey`, `beginHarnessLifecycle`, `hasSharedRuntimeSessions`.

Every method body moves verbatim, including the dialect lock clause, the `JdbcRepositorySupport` calls, the database-time comparison, and the SQL strings.

### What stays

- The interface wrappers, which keep owning the transaction via `JdbcRepositorySupport.transaction(dataSource, ...)` and delegate to the collaborator. `requireHarnessRecovery` keeps its transaction wrapper and delegates its SQL body.
- Binding CRUD, `findOrCreate`, `compareAndSet`, claim/renew/release operations, the session-release operations (`beginSessionRelease`, `completeSessionRelease`, `completeStoppedSessionRelease`), admission of sessions/executions, and the query methods.
- The in-memory repository, which implements the interface without SQL and is unchanged.

### Call-site sweep

The shared vocabulary's callers switch their import and qualifier to `RuntimeAdmissionFences` in the same change. This is a mechanical sweep of 81 caller files (38 production, 43 verification test), one to three lines each; no call changes its arguments, transaction, or order. Pre-release, this is a hard cut with no deprecated bridge on the repository, matching the P0 decision.

Inside the repository, the moved members are reached through static imports so the roughly forty intra-repository call sites stay textually unchanged. The one exception is `requireHarnessAdmission`: a member method shadows a same-name single-static-import entirely (JLS 15.12.1), and the interface wrappers must keep that name, so the thirteen `Connection`-taking call sites are qualified `RuntimeAdmissionFences.requireHarnessAdmission(...)` instead. Two pinned callers (`JournalCommit`, `WorkspaceRecoveryStore`) use fully-qualified references rather than a new import, because an import would grow each exactly one line past its ratchet pin; the reference change keeps them at their pinned sizes. The sweep also removes one pre-existing unused import (`CsiFilesRetirementProfile` in `JdbcCsiExecutionAdmission`, orphaned upstream) that the broker Checkstyle ruleset flags; the removal is behavior-neutral.

## Design decisions and rationale

- **The collaborator owns no transactions.** Its methods take a `Connection` and run inside the caller's transaction, exactly as the static cores do today. Transaction and lock ownership stay with the repository wrappers and the existing callers, so lock order and admission atomicity are unchanged.
- **One collaborator, not two.** The key vocabulary and the SQL engine are cohesive (the engine consumes the keys); splitting them would add a class without a seam. Simplicity first.
- **The vocabulary moves with the engine.** Leaving the widely shared keys on the repository would keep a static utility surface on a class meant to be a binding repository, and would force a second sweep later. Moving them now places the common SQL vocabulary in one named home.
- **Hard cut over a bridge.** Pre-release, the module gate makes every caller enumerable; a bridge would keep the old surface alive and double it during migration.
- **Public class, package-private engine.** Cross-package callers force public class visibility; only the shared vocabulary is public, so the engine surface stays internal to the persistence package.
- **Qualify the shadowed name.** `requireHarnessAdmission` cannot be static-imported alongside the same-name interface wrapper (JLS 15.12.1); qualifying its `Connection`-taking call sites is the minimal correct choice, while every other moved member uses static imports.

## Constraints

- SQL, transaction, concurrency and recovery semantics are invariant: the dialect lock clause, the database-time lease comparison, the fence set logic and every SQL string move byte-identical. A stale owner must still be unable to commit durable state or release a newer owner's resources.
- The `contracts` interface and the in-memory repository are untouched; ArchUnit module boundaries pass unchanged.
- The class-size ratchet only lowers: the repository pin drops to its post-extraction size, the new collaborator is pinned if it reaches 800 lines, and `GLOBAL_MAX_LINES` lowers from 2,662 to 2,574 once the repository is below the `ToolPublicationDataStore` pin.
- Both Checkstyle executions apply (`checkstyle:check` and `checkstyle:check@runtime-broker-checkstyle`); the latter uses a different ruleset and requires trailing newlines and no blank line before a closing brace.

## Risks

- **Breadth.** The sweep touches roughly twenty files. Mitigation: each call site changes only its import and qualifier; the change is maintainer-initiated and reviewed as a mechanical move, not a behavior change.
- **Security-relevant SQL.** The admission core gates tenant isolation and lifecycle fencing. Mitigation: verbatim move, the existing fence/admission MySQL integration cases, and the Hosted/fault profiles in CI.
- **Baseline drift.** The ratchet numbers assume #16922 has merged and upstream's current pin baseline. Mitigation: reconcile the pin and the global ceiling against upstream at implementation time, as the broker slice did.

## Validation plan

- Local (within the module budget): the broker service and binding H2 suites, plus selected `mysql-integration` binding/fence cases against a disposable MySQL 8.4; both Checkstyle executions; the class-size ratchet on the upstream-based tree.
- CI owns the full unit/H2 suite, SpotBugs, ArchUnit, the complete MySQL profile, and the Hosted/fault-gate profiles. SQL-touching extraction is not accepted on H2 evidence alone.
- Acceptance is pending until the required CI gates pass on the accepted revision.

## Acceptance criteria

- `JdbcRuntimeBindingRepository` drops from 2,662 to 2,319 lines (below 2,574); its pin lowers from 2,670 to 2,319 and `GLOBAL_MAX_LINES` from 2,662 to 2,574 in the same change. `RuntimeAdmissionFences` is 389 lines, below the 800-line pin threshold, so it is not pinned.
- Every moved body is verbatim; the interface, the in-memory repository, and all SQL/transaction/lock semantics are unchanged.
- Zero OpenAPI and schema diff; ArchUnit, both Checkstyle executions, and SpotBugs green; the full MySQL and Hosted/fault CI profiles green on the accepted revision.

## Follow-up

- The remaining binding-repository clusters (session-release operations, binding CRUD/CAS/lease) are later slices if further ratchet lowering is wanted.
- `ToolPublicationDataStore` (2,574) becomes the next global-ceiling seed after this slice.
- The `QwenHostedHarnessConnector` decomposition named by the structure review remains a separate adapters slice, outside this ratchet scope.
