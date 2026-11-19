# Managed Agent A1 Layer 2 — remove the Session storage_version column

[English](2026-11-19-managed-a1-layer2-storage-version-removal.md) | [简体中文](2026-11-19-managed-a1-layer2-storage-version-removal.zh-CN.md)

Status: proposed; the durable-signal decision is locked (boolean head column).
This is the A1 Layer 2 follow-up to the
[version convergence design](2026-11-19-managed-agent-version-convergence.md).
A1 Phase 1 already stripped the rolling-upgrade negotiation (reader ceiling,
writer-grant `supportedStorageVersion`); the `storage_version` column itself was
kept because it still expresses live invariants. This design removes the column
and re-expresses those invariants without a version number. The service is
pre-production, so no deployed data needs migrating and the worker and server
deploy as one unit.

## Resolved open question — the durable activity signal

The convergence design left one open question: after a restore wipes the
activity projection, what durable signal tells the server "this Session has
activity diagnostics, so rebuild the projection and gate writer admission on its
readiness"? Today that signal is `head.storageVersion() >= 4`.

**Decision: a boolean head column `has_activity_diagnostics`.** Set it on the
first commit whose content carries activity diagnostics (an activity evidence
resource, or a `tool.measured` event — exactly the conditions that promote the
floor to `>= 4` today). It lives on the `ma_session_head` row, which survives the
projection wipe, so it remains a durable marker after restore.

Rationale:

- The head row is already loaded everywhere `storageVersion()` is read, so the
  gate and the rebuild skip become O(1) field checks with no extra query.
- Dropping the column already requires editing the V1 baseline and its
  `ck_ma_head_journal` CHECK; adding a boolean is the same schema-edit effort.
- The rejected alternative — a bounded `EXISTS` probe over
  `ma_resource kind = 'managed-execution-diagnostics'` — is also durable (the
  evidence resources are journal-owned and survive the wipe), but `ma_resource`
  has no `(session_scope_key, kind)` index, so the probe would scan the Session's
  resources or require a new index, and it adds a query to every commit and
  writer acquisition.

The flag is monotonic: once set it is never cleared (activity evidence is never
un-committed), matching the old `Math.max` promotion semantics.

## Current state (verified)

`storage_version` / `storageVersion()` has five classes of live consumer. Line
numbers are current as of writing; re-grep before editing.

1. **Activity rebuild gate / skip (the invariant).** `JournalCommit:105`
   (`head.storageVersion() >= 4` → require the activity summary `ready`, else
   `managed_activity_rebuilding`); `ManagedActivityDiagnosticProjection.rebuildBatch:362,364`
   (`storageVersion < 4` → skip); `JournalWriterLifecycle:259,277` pass
   `head.storageVersion()` into `rebuildActivityBatch`. The rebuild replays the
   durable journal (`ma_session_journal_tx`); the wipe only removes
   `managed-activity-projection` resources and their `DOMAIN` records, never the
   journal or the journal-owned `managed-execution-diagnostics` evidence.
2. **Head record and reads/writes.** `JournalStoreRows.HeadRow` mapper (`:46`),
   `RestoreHead` (`ManagedSessionStoreModels:289`, `JournalStoreRows:142,723`);
   the `session.create` / harness-conversion INSERT/UPDATE
   (`JournalWriterLifecycle:203,218`, initial `JournalStoreRows.STORAGE_VERSION`);
   the commit UPDATE promotion `Math.max(head.storageVersion(), storageFloor)`
   (`JournalCommit:266,282`). `ManagedModelDiagnosticProjection.storageFloor():42`
   has exactly one live caller (`JournalCommit:82`) and only feeds this promotion.
3. **Snapshot manifest binding.** `ManagedNativeJournalSnapshots.Manifest`
   carries `int storageVersion` (`:77`), built from `head.storageVersion()`
   (`:188`); `select` requires `descriptor.snapshot().storageVersion() <= frozen.storageVersion()`
   (`:253`). The TS worker parses the manifest
   `storageVersion` (`http-managed-session-store.ts:1833-1845`) and rejects
   `storageVersion > head.storageVersion`.
4. **TS feature-presence integrity checks.** The worker keys feature presence on
   the version in three places: snapshot inspection
   (`http-managed-session-store.ts:651-690`), restore (`:1603-1615`), and snapshot
   descriptor inspection (`:1958-1968`); plus the head type/parse (`:1019,3860`)
   and `workspace-recovery-session.ts:121,361,414,1097` (`[1,2,3,4,5]`
   enumeration and a `>= 5` measurement check). The `:679-690` block also checks
   `csi-files-retirement/1|2|3` profile floors — a CSI remnant (the server no
   longer admits CSI sessions after the #17415 archive) that references the
   version and is removed here.
5. **Pristine-initial predicate.** `JournalHistoryQueries.hasPristineInitialJournal:268`
   uses `head.storageVersion() != STORAGE_VERSION` as one predicate proving an
   untouched initial journal (recovery fast path, `SessionRecoveryService:123`).

Read-only SELECT projections also carry the column to the schema/head views:
`ToolPublicationAdmissionStore:145`, `ManagedSideQueryStore:568`,
`ToolPublicationStore:227`, `ManagedSchemaProjection:144`,
`WorkspaceRecoveryStore:621`.

**Kept unchanged.** `JournalStoreRows.STORAGE_VERSION = 1` (`:92`) also serves as
the pack/event format-integrity constant (`JournalHistoryQueries:311,332`:
`formatVersion == 1`, event `"v" == 1`) — a single-version integrity gate (C
class), not a compatibility artifact. `/transactions:commit` and
`/transactions:commit-v2` are aliases of one handler
(`ManagedSessionStoreController:202`); routing is decided per transaction by
`ManagedHostedRecoveryRecords.requiresVersionTwo` (`:30`), independent of the head
version, so removing the column does not affect it.

## Goals

- Remove the `ma_session_head.storage_version` column and every live
  `storageVersion` field/parameter, re-expressing the five consumer classes
  without a version number.
- Preserve the activity rebuild invariant exactly: a Session that has activity
  diagnostics still gates writer admission on summary readiness and still
  rebuilds the projection from the journal after a wipe.
- Preserve snapshot/restore feature integrity using resource presence rather
  than a version floor.

## Non-goals

- Removing the pack/event `formatVersion == 1` / event `"v" == 1` integrity gates
  (C class) or the `STORAGE_VERSION` constant that names them.
- Changing the `commit-v2` routing (content-based, unaffected).
- Removing the rest of the worker-side CSI session code beyond the version-keyed
  profile-floor checks; that is a separate CSI TypeScript cleanup.
- Any V2+ migration. The V1 baseline is edited in place (module AGENTS.md).

## Proposed solution

### Schema (V1 in place)

- Drop `storage_version` from `ma_session_head` (`V1__managed_schema.sql:188`).
- Add `has_activity_diagnostics TINYINT UNSIGNED NOT NULL DEFAULT 0` (the
  `is_wake_pending` boolean convention). `NOT NULL DEFAULT 0` keeps it out of the
  head-kind CHECK: HARNESS heads carry `0` (meaningless, never gated);
  MANAGED_SESSION heads start `0` and flip to `1` on the first activity commit.
- Edit `ck_ma_head_journal` (`:220`) to remove the `storage_version IS NULL` /
  `IS NOT NULL` clauses; the remaining journal columns stay bound to head kind.

### Java

- `HeadRow` / `RestoreHead`: replace `int storageVersion` with
  `boolean activityDiagnostics`; update the mapper (`JournalStoreRows:46`), the
  restore mapping (`:142`), and the record (`:723`,
  `ManagedSessionStoreModels:289`).
- Head INSERT/UPDATE (`JournalWriterLifecycle:203,218`): write
  `has_activity_diagnostics = 0` instead of `storage_version`. Commit UPDATE
  (`JournalCommit:266,282`): `has_activity_diagnostics = has_activity_diagnostics OR ?`
  where the parameter is the commit's activity detection (below); drop the
  `Math.max` promotion.
- Replace `ManagedModelDiagnosticProjection.storageFloor()` with a boolean
  activity detector `hasActivityDiagnostics(records, requested, validated)`
  returning `activity || measured` (the `>= 4` conditions). The `promotes → 2`
  and `diagnostics → 3` tiers become dead and are removed; routing still uses
  `requiresVersionTwo` directly.
- Gate (`JournalCommit:105`): `if (head.activityDiagnostics())`.
- `rebuildBatch` / `rebuildActivityBatch`: take a boolean instead of
  `storageVersion`; skip when false. `JournalWriterLifecycle:259,277` pass
  `head.activityDiagnostics()`.
- SELECT projections (`ToolPublicationAdmissionStore:145`,
  `ManagedSideQueryStore:568`, `ToolPublicationStore:227`,
  `ManagedSchemaProjection:144`, `WorkspaceRecoveryStore:621`): drop the column
  from the SELECT lists and the row/view mappings that carry it.
- `hasPristineInitialJournal` (`JournalHistoryQueries:268`): drop the version
  predicate. The journal-content checks already reject any non-`activation.changed`
  event after `session.create`, so a feature commit cannot pass as pristine; the
  version check is redundant. Verify against the recovery fast-path tests.
- Snapshot `Manifest`: drop `storageVersion` (`:77,188`); in `select` (`:253`)
  drop the `storageVersion <= frozen.storageVersion()` clause. The snapshot is a
  prefix of the frozen head's journal (`coveredJournalRevision`,
  `committedSequence <= frozen`, resource-enumeration checks), so its feature
  resources are necessarily present in the frozen head; the version floor is
  subsumed by those prefix/resource integrity checks.

### TypeScript worker

- Head type/parse (`http-managed-session-store.ts:1019,3860`,
  `workspace-recovery-session.ts:121`): drop `storageVersion`.
- Feature-presence checks (`:651-690`, `:1603-1615`, `:1958-1968`): remove the
  version floors (`< 5` / `< 4` / `< 3`) and the exact-version CSI profile-floor
  block (`:679-690`). Keep the resource-presence integrity checks (a snapshot
  that enumerates a resource must carry it; reference revisions must agree);
  pre-production the server always supports every feature, so the version-floor
  direction is vacuous once the marker is gone.
- Manifest parse (`:1833-1845`): drop `storageVersion` and the
  `storageVersion > head.storageVersion` rejection.
- `workspace-recovery-session.ts:361,414,1097`: drop the `[1,2,3,4,5]`
  enumeration and the `>= 5` measurement gate; key on resource presence.

### Tests

- Update Java tests that seed/assert `storageVersion` (head fixtures, snapshot
  manifests, `ManagedActivityDiagnosticsTest` floor assertions,
  `ManagedSideQueryStoreTest` version-999 case, pristine-journal tests) to the
  boolean signal and presence checks.
- Update TS tests that set `head.storageVersion` / `headOverrides['storageVersion']`
  (`http-managed-session-store.test.ts`, `workspace-recovery-session.test.ts`,
  `workspace-recovery-worker.test.ts`, `original-receipt-checkpoint.test.ts`).

## Design decisions and rationale

- **Boolean head column over EXISTS probe.** O(1) read from an already-loaded
  row, no per-commit query, no new index; the schema edit is required anyway.
- **`storageFloor()` collapses to a boolean.** Its only live consumer was the
  version promotion; the lower tiers fed nothing else once negotiation is gone.
- **Snapshot version floor is redundant.** Prefix + resource-enumeration
  integrity already guarantees the snapshot's features exist in the frozen head.
- **Pristine predicate version check is redundant.** Content checks already
  exclude feature commits.
- **Wire format break is acceptable pre-production.** The manifest loses a field;
  worker and server deploy as one unit and no deployed data needs migrating.

## Constraints

- Module AGENTS.md: edit the V1 baseline in place; no V2+ migration.
- Java + TS wire changes (head view, manifest) land together.
- Preserve tenant isolation, writer-lease/generation fencing, and the dual SQL
  fencer parameterization.
- Keep the pack/event `formatVersion == 1` and event `"v" == 1` integrity gates.
- Documentation stays complete and synchronized in both languages.

## Risks

- The activity flag must be set on the first activity commit and survive restore;
  a missed set would silently disable the rebuild gate. The activity diagnostics
  tests (gate refusal + rebuild-to-ready) pin this.
- Feature-presence re-expression must not drop a real integrity check; the
  snapshot/restore corruption tests are the guard.
- Manifest format change breaks decode of pre-existing snapshots; acceptable
  pre-production, but tests must create snapshots fresh.
- Many test fixtures seed `storageVersion`; missing one shows up as a compile or
  parse failure, caught by the focused suites and typecheck.

## Validation plan

Per module AGENTS.md, focused regressions within the shared 10-minute budget
(JDK 21, Maven `~/apache-maven-3.9.12`, isolated repo `/tmp/verconv-m2`,
`-pl verification -am`, `env -u QWEN_RUNTIME_DIR -u QWEN_CODE_MANAGED_NPM_PIN
-u QWEN_CODE_NO_RELAUNCH`); full gates (Checkstyle, SpotBugs, MySQL, full suite)
in CI.

- Java: `ManagedSessionStoreIntegrationTest`, `ManagedActivityDiagnosticsTest`,
  `ManagedSessionStoreWiringTest`, `ManagedSideQueryStoreTest`, `ManagedActionsTest`,
  the native snapshot tests, and the pristine-journal / recovery fast-path tests.
- TS: `http-managed-session-store.test.ts`, `workspace-recovery-session.test.ts`,
  `workspace-recovery-worker.test.ts`, `local-managed-journal-snapshot` tests
  (local `/2` dialect stays green); `tsc --noEmit` / build for `packages/core`
  and `packages/cli` (`NODE_OPTIONS=--max-old-space-size=8192` for CLI).
- MySQL integration: `ManagedSessionStoreIntegrationTest`, `ManagedSchemaMySqlIT`
  (head column), snapshot ITs.

## Acceptance criteria

- `ma_session_head.storage_version` is gone; no live `storageVersion`
  field/parameter remains (the `STORAGE_VERSION` format constant stays).
- A Session with activity diagnostics still refuses writer admission while the
  projection rebuilds and still rebuilds to `ready` from the journal after a
  wipe; a Session without activity diagnostics is unaffected.
- Snapshot/restore feature integrity is preserved by resource presence.
- Focused Java + TS suites green; core/cli typecheck/build clean.

## Phasing

1. L2-1: schema + Java (head, gate, rebuild, projections, snapshot, pristine).
2. L2-2: TS worker (head type, feature-presence, manifest, recovery).
3. L2-3: Java + TS test fixtures; verify the coordinated change together.

## Open questions

None remaining. The durable-signal question is resolved (boolean head column).
