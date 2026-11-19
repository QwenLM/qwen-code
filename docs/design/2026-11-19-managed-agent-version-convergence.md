# Managed Agent Version Convergence (storage ladder, action options, pack reader, CSI handles)

[English](2026-11-19-managed-agent-version-convergence.md) | [简体中文](2026-11-19-managed-agent-version-convergence.zh-CN.md)

Status: proposed. The service is pre-production, so version machinery that only
exists to protect existing deployments or to negotiate rolling upgrades can be
removed. This design covers the four items flagged as "A class" in the
2026-11-19 version-compatibility inventory: the Session storage-version ladder
and reader-version header (A1), the `managed-action-options` format family (A5),
the journal pack `minimumReader` declaration (A2), and the CSI resource-handle
version ladder (A4). Source-level verification corrected several first-pass
classifications; the corrected scope is recorded below so the change set stays
bounded and honest.

## Problem

The managed server carries several independent "version" mechanisms. They look
alike but do different jobs, and only some of them are backward-compatibility
artifacts. Removing all of them blindly would delete live feature invariants.
This design separates, for each mechanism, (a) the rolling-upgrade / old-reader
restriction that has no protected object pre-production, from (b) the live
feature encoding or capability invariant that must survive (or be deliberately
re-expressed). The goal is to delete (a) and to unify or preserve (b) with the
smallest defensible change set, following the precedent of
`2026-11-12-managed-agent-tier1-convergence.md`.

## Current state (verified)

### A1 — Session storage version is four mechanisms in one column

`ma_session_head.storage_version` (`V1__managed_schema.sql:192`, nullable INT
UNSIGNED; the `ck_ma_head_journal` CHECK at `:224` ties it to `head_kind`) is
read and written by code that does four distinct jobs:

1. **Rolling-upgrade reader fence (pure compatibility).**
   - `ManagedStorageVersions.SUPPORTED = 5` (contracts) is the ceiling.
   - `ManagedSessionReaderVersion` (server config) reads the
     `X-Qwen-Managed-Max-Readable-Storage-Version` request header on
     `/internal/managed-session-store/` and `/internal/managed-tool-publications/`,
     validates it against `[12345]`, and **defaults the ceiling to 1 when the
     header is absent**. It is wired as the `StorageReadPolicy` bean in
     `ManagedAgentConfiguration:101`.
   - `StorageReadPolicy.requireReadable(floor)` rejects a commit whose floor
     exceeds the reader ceiling (`JournalCommit:96`, `JournalStoreRows:587`,
     `JournalWriterLifecycle:210`). `StorageReadPolicy.inProcess()` (ceiling 5)
     is used by the embedded/maintenance paths: `JdbcManagedSessionStore:67`,
     `ManagedSideQueryStore:57`, `WorkspaceCsiRuntimeMain:163`,
     `WorkspaceCsiWorkerAckMain:63`.
   - Range readers accept any version in 1..5: `ToolPublicationStore:244`,
     `ToolPublicationAdmissionStore:147`, `WorkspaceRecoveryStore:616`
     (`List.of(1,2,3,4,5)`), `ManagedSideQueryStore:576`, `JournalStoreRows:583`.
   - The worker declares its reader ceiling by sending the header:
     `http-managed-session-store.ts:2457,3301` send `'5'`;
     `hosted-side-query.ts:186` sends `'4'`.

2. **Writer capability negotiation (rolling-upgrade guard).**
   - The server returns `supportedStorageVersion` in the writer grant:
     `JournalWriterLifecycle.supportedStorage()` (`:654`) returns 5 for non-CSI
     Sessions, and for CSI Sessions derives it from the profile
     (`csi-files-retirement/1`→1, `/2`→3, `/3`→4).
   - The worker gates diagnostics production on that grant:
     `http-managed-session-store.ts:936-940`
     (`supportsExecutionDiagnostics() = grant >= 4`,
     `supportsModelDiagnostics() = grant >= 3`), and refuses CSI admission when
     the assigned profile needs a tier the server does not support
     (`hosted-csi-session.ts:273-284`, `csi_activity_storage_unavailable` /
     `csi_diagnostics_storage_unavailable`).
   - The worker pre-checks each commit against the grant
     (`http-managed-session-store.ts:2149-2177`, needsVersionTwo/Three/Four/Five)
     and refuses to take over a head newer than the grant
     (`:3087-3088`, `head.storageVersion > grant.supportedStorageVersion`;
     head validation `[1,2,3,4,5]` at `:356`).

3. **CSI profile capability fence (live invariant).**
   - `CsiFilesRetirementProfile.supportsStorage(scope, version)` (`:96`) admits
     version 1, or 3 with diagnostics, or 4 with activity diagnostics. It is
     checked at commit (`JournalCommit:104-105` against
     `max(csiHead.storageVersion(), storageFloor)`), at writer takeover
     (`JournalWriterLifecycle:305-306`), and at CSI activation
     (`JdbcCsiActivationAdmission:506`). It prevents a `/1` (no-diagnostics)
     Session from accumulating storage its pinned worker cannot read.

4. **Activity-projection rebuild marker (live invariant).**
   - `JournalCommit:168` blocks writer admission with
     `managed_activity_rebuilding` when `head.storageVersion() >= 4` and the
     activity statistics summary is not `ready`.
   - `ManagedActivityDiagnosticProjection.rebuildBatch(storageVersion, ...)`
     (`:362-364`) skips rebuild when `storageVersion < 4`; otherwise it
     recreates a `clearing` summary when none exists and rebuilds from journal
     pages. Called from `JournalWriterLifecycle:282,300`. Here the version is a
     durable "this Session has activity diagnostics whose projection may need
     rebuilding" flag — including the case where the summary row is absent.

The floor itself is computed per commit by
`ManagedModelDiagnosticProjection.storageFloor()` (`:42-72`): `tool.measured`
records→5, activity diagnostics resource→4, model diagnostics resource (or
`managed-history_maintenance` schemaVersion 2)→3, Hosted recovery records /
`managed-action-options` v3/v4→2, else 1. The head stores
`max(existing, floor)` (`JournalCommit:415`); new heads start at
`JournalStoreRows.STORAGE_VERSION = 1` (`JournalWriterLifecycle:227,249`).
Native journal snapshots bind the version into the descriptor and require
`descriptor.storageVersion <= frozen.storageVersion`
(`ManagedNativeJournalSnapshots:80,188,253`); the worker re-validates feature
presence against the version on restore and snapshot inspection
(`http-managed-session-store.ts:519-553,1600-1736`).

**Consequence.** Jobs 1 and 2 are the rolling-upgrade restrictions with no
protected object pre-production. Jobs 3 and 4 are live invariants that happen
to be expressed through the version number. Deleting the column outright must
re-express jobs 3 and 4; deleting only the negotiation (jobs 1+2) leaves them
working unchanged.

### A5 — `managed-action-options` v1/v2/v3/v4 are live writer shapes

The current worker still emits all four shapes, selected by feature context
(`hosted-workspace-tool-turn.ts:10021-10040`):

- question → `v:4` (questions + inputRef + continuationRef);
- `continuationRef` present → `v:3` (+inputRef for preview tools);
- no `continuationRef`, preview tool → `v:2` (inputRef only);
- no `continuationRef`, other tool → `v:1` (bare).

`continuationRef` is undefined when the call is outside the native batch
(`ordinal < 0`, `:10001-10005`) or capture fails, so v1/v2 are live fallback
paths, not dead legacy. Command approval always writes `v:3`
(`:9886`). The Java reader branches on `v` to build the per-version closed field
set and the command cross-check (`JdbcManagedActionStore:216-285`), the public
input preview accepts v2/v3 (`ManagedActionService.inputPreview:383,389`),
`ManagedUserQuestions.isQuestion` is `v == 4` (`:29`), Hosted recovery closure
validation only walks v3/v4 (`ManagedHostedRecoveryRecords:66`), and v3/v4
promote the storage floor to 2 (`ManagedModelDiagnosticProjection:51`). The
companion `managed-action-decision` body uses `v == (question ? 2 : 1)`
(`JdbcManagedActionStore:302-303`) — that is a kind discriminator, not a ladder.

**Consequence.** A5 is format unification (writer + reader), not legacy-reader
deletion. The four shapes differ only in which of `inputRef`, `continuationRef`,
`questions` are present; a single superset schema with optional fields and a
kind discriminator can replace the version ladder.

### A2 — pack `minimumReader` has a server and a local dialect

The journal header carries `formatVersion` and `minimumReader`. The shared TS
parser `parseManagedSessionHeader` (`managed-session-records.ts:1788-1822`)
rejects a header whose `minimumReader` exceeds the reader's own capability:
`MANAGED_SESSION_FORMAT_VERSION = 1` (`:31`),
`MANAGED_SESSION_MINIMUM_READER = 'managed-session/1'` (`:38`, what the server
authority writes, `managed-session-authority.ts:721`),
`MANAGED_SESSION_READER_CAPABILITY = 'managed-session/3'` (`:39`). The Java
server accepts only `managed-session/1`: `CsiNativeActivationProof:235-238`
(header closed set, `formatVersion == 1`, `minimumReader == "managed-session/1"`)
and `JournalHistoryQueries:311-312` (pack value), with the event envelope `"v"`
and head version checked against `JournalStoreRows.STORAGE_VERSION` at
`:333` and `:268`.

A separate **local** (standalone daemon) journal path writes and requires
`managed-session/2`: `local-managed-journal-snapshot.ts:232,266,273,541` and
`sessionStorageUtils.ts:1190`. This is the same record-format family but a
different deployment surface.

**Consequence.** `formatVersion == 1` and event `"v" == 1` are single-version
integrity gates (keep). `minimumReader` is a forward-compatibility declaration;
the server-bound value is always `/1`, so the server-side negotiation is
removable. The shared parser must keep tolerating the local `/2` dialect (or the
local path must be in scope too); making `minimumReader` optional in the shared
parser and omitting it from the server authority is the bounded server-side
change.

### A4 — CSI handle versions 1/4 are live shapes; 2 and 3 are dead write paths

`WorkspaceCsiRuntimeIdentity` defines `VERSION=1`, `FILES_VERSION=2`,
`FILES_AUTHORITY_VERSION=3`, `FILES_FINALIZATION_VERSION=4` (`:22-25`), each with
its own handle-value key set (`KEYS`, `FILES_KEYS`, `FILES_AUTHORITY_KEYS`,
`FILES_FINALIZATION_KEYS`). `validate()` (`:88-92`) requires the version to match
the boot shape, and `boot(request, seed, handle)` (`:71-79`) reconstructs the boot
from the handle version. The provisioner selects the version by boot content
(`WorkspaceCsiRuntimeProvisioner:228`):

- non-files CSI (`ManagedCsiProtocol`, isolation `workspace`,
  `isolationKey == null`) → **v1**, live (the resident-workspace path);
- files CSI without authority → **v2**, **no production write path** (see below);
- files CSI with authority → `finalizationBoot` → **v4**, the production files
  path (`:182-183`, `selects(request) && authority != null`).

`selects()` is `CsiFilesRetirementProfile.isProfile(scope)`
(`ManagedCsiFilesProtocol:47-53`); the boot payload itself carries `version`
4/5/6 (`:73,:88`). There are exactly two production provisioner construction
sites. The maintenance entry point `WorkspaceCsiRuntimeMain` builds the spec
with a **required** `K2_RUNTIME_BROKER_ORIGIN` (`:92`, via
`KubernetesRuntimeProviderFactory:80`), so its files runtimes always carry
authority → v4. `ResidentWorkspaceProvisioner:49` uses the no-authority
constructor overload (`WorkspaceCsiRuntimeProvisioner:96-114`, authority
defaults to null) but serves **only non-files** requests: it requires
`isolationClass == "workspace"` and rejects `isolationKey != null`
(`ResidentWorkspaceProvisioner:33,64-69`), while a files request carries
`isolationKey = sessionId`. The authority-null provisioner therefore never sees
a files request. **Neither v2 (files without authority) nor v3 (files +
authority, no finalization) has a production write path**: v2 would need a files
request on the authority-null resident provisioner (rejected), and v3 would need
authority present without finalization (the provisioner always adds finalization
when authority is present). Both survive only as tolerated read shapes
(`fileHistoryBoot` accepts 3 or 4 at `WorkspaceCsiRuntimeIdentity:59-60`;
`JdbcCsiExecutionAdmission:464-465` requires 3 or 4;
`JdbcCsiActivationAdmission:283` and `CsiFileFinalizeProtocol:31` require 4).
v2/v3 handles can still be constructed by tests via the package-private
`(transport, authority)` constructor.

**Consequence.** v1 (non-files resident) and v4 (files maintenance) are the only
live shapes; v2 and v3 are dead write paths whose read tolerance is pure
compatibility. The bounded pre-production win is to retire both v2 and v3 read
tolerance, keeping v1 + v4 — no `authorityOrigin` configuration decision is
needed, because every production files provisioner already requires it.
Collapsing v1 and v4 into a single shape (retiring non-files CSI or giving it the
files shape) remains a separate architecture decision, out of scope.

## Goals

- Delete the rolling-upgrade reader fence and writer capability negotiation
  around Session storage (A1 jobs 1+2), Java and TS together.
- Unify `managed-action-options` to a single superset shape emitted by the
  worker and validated by field presence on the server (A5).
- Remove the server-side `minimumReader` negotiation while keeping the local
  journal dialect working (A2).
- Retire the dead CSI handle v2 and v3 read tolerance, keeping v1 + v4 (A4,
  bounded).
- Preserve the CSI profile capability fence and the activity-projection rebuild
  invariant (A1 jobs 3+4) unchanged in this batch.

## Non-goals

- Dropping the `storage_version` column entirely. That requires re-expressing
  the CSI fence (job 3) and the activity rebuild marker (job 4) without a
  version number; the latter has an open question (below). Deferred to a
  follow-up (A1 Layer 2).
- Unifying CSI boot shapes / retiring non-files CSI (A4 full collapse). This is
  a product/architecture decision (B class in the inventory).
- Touching the local standalone journal `managed-session/2` dialect beyond
  keeping the shared parser tolerant of it.
- Removing single-version integrity gates: resource `schema_version == 1`,
  event `EventIdentity.SCHEMA_VERSION/PROJECTION_VERSION`, pack `formatVersion`,
  event `"v"`, manifest/bundle `formatVersion`, the `managed-action-decision`
  kind discriminator, and the `qwenCodeVersion` / `expectedQwenVersion`
  consistency pins. These are not compatibility artifacts.
- The tool execution protocol v2/v3/v4 coexistence (A3). It needs encoding
  unification first and is a separate, larger batch.

## Proposed solution

### Phase 1 — A1: strip storage-version negotiation (recommended first)

Keep `storage_version`, `storageFloor()`, the CSI fence, the activity rebuild
marker, and the snapshot descriptor binding exactly as they are. Delete only the
negotiation/restriction layer:

Server (Java):

- Delete `ManagedSessionReaderVersion` and its bean
  (`ManagedAgentConfiguration:101`); delete the `StorageReadPolicy` interface and
  `inProcess()`. Remove the `readerVersion` parameter and field from
  `JournalStoreRows`, `JournalWriterLifecycle`, `JournalCommit`, and the
  `JdbcManagedSessionStore` constructors; drop the `requireReadable(...)` calls
  (`JournalCommit:96`, `JournalStoreRows:587`, `JournalWriterLifecycle:210`).
  Remove the `StorageReadPolicy.inProcess()` arguments at the four embedded /
  maintenance call sites.
- Replace the 1..5 range readers with a single-version integrity check
  (`== JournalStoreRows.STORAGE_VERSION` is wrong — heads legitimately carry
  2..5; instead drop the upper-bound rejection and keep only the
  `head_kind`/nullability CHECK already in the schema). Concretely: remove the
  `<= SUPPORTED` / `List.of(1..5)` rejections in `ToolPublicationStore`,
  `ToolPublicationAdmissionStore`, `WorkspaceRecoveryStore`,
  `ManagedSideQueryStore`, `JournalStoreRows:583`; the column remains a valid
  feature-tier marker written by `storageFloor()`.
- Remove `supportedStorageVersion` from `WriterGrant`
  (`ManagedSessionStoreModels:153-163`) and `JournalWriterLifecycle.grant()` /
  `supportedStorage()`; the grant no longer carries a storage ceiling.

Worker (TS):

- Stop sending `X-Qwen-Managed-Max-Readable-Storage-Version`
  (`http-managed-session-store.ts:2457,3301`, `hosted-side-query.ts:186`).
- Remove `supportedStorageVersion` from the grant type and parser
  (`:875,:3637-3642`); make `supportsModelDiagnostics()` /
  `supportsExecutionDiagnostics()` return true (the server is always current
  pre-production), and delete the profile-vs-grant admission refusals
  (`hosted-csi-session.ts:273-284`). The server-side CSI fence
  (`supportsStorage`) remains as defense-in-depth.
- Delete the commit pre-checks against the grant (`:2149-2177`) and the
  `head.storageVersion > grant.supportedStorageVersion` rejection (`:3088`).
  Keep the feature-presence integrity checks on restore/snapshot
  (`:519-553,1600-1736`) but drop the `[1,2,3,4,5]` enumeration in favor of the
  presence checks alone (a head carrying measurements must have the
  measurements resource, etc.); the version number stays as the marker those
  checks already use.

This phase removes every rolling-upgrade restriction while leaving the two live
invariants intact. It is mostly deletion and is the lowest-risk way to satisfy
"no version restrictions pre-production".

### Phase 2 — A5: unify action options to one shape

- Worker: emit a single options shape for permission and question alike, with
  optional `inputRef`, optional `continuationRef`, and optional `questions`;
  keep a kind discriminator (`permission` / `question`) and a constant `v` (or
  drop `v` and validate by kind). Preserve the semantic invariants: a question
  requires `continuationRef`; a `managed-extension-command-input` inputRef
  requires `continuationRef` and the existing command cross-check.
- Server: collapse the per-version closed set in `JdbcManagedActionStore`
  (`:216-285`) into one field-presence-based validation; update
  `ManagedActionService.inputPreview` (`:383,389`), `ManagedUserQuestions`
  (`:29`), and `ManagedHostedRecoveryRecords` (`:66`) to key on kind/field
  presence rather than `v`. Update the floor promotion
  (`ManagedModelDiagnosticProjection:51`) to key on the same discriminator.
- Keep `managed-action-decision`'s `v == (question ? 2 : 1)` as a kind gate.

### Phase 3 — A2: remove server-side minimumReader negotiation

- Make `minimumReader` optional in the shared parser
  (`parseManagedSessionHeader`): absent → accept; present → still validate
  against the reader capability so the local `/2` dialect keeps working.
- Server authority stops writing `minimumReader`
  (`managed-session-authority.ts:721`); Java drops the `minimumReader` member
  from the header closed set and the `== "managed-session/1"` check
  (`CsiNativeActivationProof:235-238`, `JournalHistoryQueries:311-312`).
- Keep `formatVersion == 1` and event `"v" == 1` integrity gates.

### Phase 4 — A4: retire dead CSI handle variants (bounded)

- Remove the v2 (`FILES_VERSION`) and v3 (`FILES_AUTHORITY_VERSION`) read
  tolerance: `fileHistoryBoot` and `JdbcCsiExecutionAdmission` require v4 only;
  delete the v2/v3 key sets and boot-reconstruction branches in
  `WorkspaceCsiRuntimeIdentity`. Both are dead write paths (verified above), so
  this is pure compatibility removal — no `authorityOrigin` configuration change
  is required.
- Keep v1 (non-files resident CSI) and v4 (files + finalization). Unifying v1 and
  v4 into one shape is out of scope (architecture decision).
- Update tests that construct v2/v3 handles via the package-private
  `(transport, authority)` constructor to use v1 or v4.

## Design decisions and rationale

- **Strip negotiation before dropping the column (A1).** The version number is
  load-bearing for the CSI capability fence and the activity rebuild marker.
  Removing the negotiation deletes the actual rolling-upgrade restrictions with
  bounded, mostly-deletion changes and zero invariant risk; dropping the column
  is a deeper refactor that must first re-express those invariants.
- **Open question for A1 Layer 2 (column removal).** The activity rebuild marker
  must survive the case where the activity summary row is absent but activity
  data exists in the journal (post-restore projection wipe). Today
  `storage_version >= 4` is the durable signal that drives `rebuildBatch` to
  recreate a `clearing` summary. A version-free replacement needs an equivalent
  durable signal — e.g. a boolean head column set on the first activity commit,
  or a bounded EXISTS probe over activity resource references — and must be
  proven against the restore paths before the column can go. The CSI fence can
  be re-expressed as a per-commit resource-kind-vs-profile check (sufficient
  because every commit is checked), which is simpler than the persisted tier.
- **A5 is unification, not deletion.** v1/v2 are live fallbacks; the design
  changes the writer to one superset shape and the reader to field-presence
  validation, preserving the question/command invariants.
- **A2 keeps the local dialect.** The shared record parser feeds both the server
  and the standalone local journal; making `minimumReader` optional removes the
  server negotiation without breaking local `/2`.
- **A4 only retires dead variants.** v1 (non-files resident) and v4 (files
  maintenance) are the live shape discriminators; v2 and v3 are provably never
  written in production (the authority-null provisioner is resident/non-files
  only; authority present always adds finalization). Collapsing v1 and v4 is
  architecture work, out of scope.

## Constraints

- Module AGENTS.md: any schema touch edits the V1 baseline in place; no V2+
  migrations. Phase 1 adds no schema change (the column stays). A1 Layer 2, if
  pursued, edits V1 in place.
- Preserve tenant isolation, writer-lease/generation fencing, the dual SQL
  fencer parameterization, and the CSI lock order
  (`lockSessionFirst → lockCsiContinuation → requireHeadAfterCsiCheck`).
- Keep the CSI profile capability fence and the activity rebuild invariant
  behaviorally identical in Phase 1.
- Java + TS wire changes (grant field, header, options shape, pack header) must
  land together; the worker and server are deployed as one unit pre-production.
- Documentation changes keep both language versions complete and synchronized.

## Risks

- Phase 1 touches the writer-grant wire shape and the store request headers;
  Java and TS must change in lockstep or admission breaks. The focused store
  tests and the CSI activation gate tests are the regression net.
- Removing the grant ceiling means a mismatched worker could attempt a commit
  the CSI fence then rejects; the fence already fails closed, so the failure
  mode shifts from "worker refuses admission" to "server rejects commit" — both
  are 409-class and safe, but the error surface changes and tests asserting the
  worker-side refusal codes must move to the server-side fence.
- A5 writer/reader unification must keep the command cross-check and question
  continuation requirement; a dropped invariant would let an unresumable
  approval commit. The action store tests pin these.
- A2 parser change must not reject local `/2` headers; the local snapshot tests
  are the guard.
- A4 v2/v3 removal is pure read-tolerance deletion (both are dead write paths);
  the only risk is a test or out-of-tree provisioner constructing v2/v3 handles.
  The production construction sites are verified (resident non-files → v1;
  maintenance files → v4); tests using the package-private constructor must move
  to v1/v4.

## Validation plan

Per module AGENTS.md, run focused regressions within the shared 10-minute budget
(JDK 21, Maven 3.8.9+, sibling SDK installed from the checkout); full gates in CI.

- A1: `ManagedSessionReaderVersionTest` (deleted/repurposed),
  `ManagedSessionStoreIntegrationTest` (header/ceiling cases at `:387,424,440,486`),
  `ManagedActivityDiagnosticsTest` (`:98,143` floor assertions stay),
  `ManagedSideQueryStoreTest` (`:83` version-999 rejection repurposed),
  `HostedSideQueryProcessIT:196`, `HostedCleanupRetentionMySqlIT:53`,
  `WorkspaceCsiNativeActivationGateTest` (`:933,958`), and the wiring tests that
  inject `StorageReadPolicy` (`VerificationFixtures:73`,
  `ToolPublicationStorageConfigurationTest:51`,
  `ManagedSessionStoreWiringTest:54`, `ToolPublicationAsyncVerificationTest:320`).
  TS: `http-managed-session-store.test.ts` grant/header/restore cases
  (`:2528,2558,2623,2771,7083,9166`), `hosted-csi-session` admission tests.
- A5: `ManagedActionsTest` (`:171`), `JdbcManagedActionStore` action validation
  tests, `hosted-workspace-tool-turn.test.ts` (`:6160,6176`) and
  `hosted-approval-fallback.test.ts` (`:320`).
- A2: `CsiPackRecordsTest`, `JournalPackTransactionRegressionTest`,
  `managed-session-records.test.ts` header cases (`:1003-1067`),
  `local-managed-journal-snapshot` tests (local `/2` stays green).
- A4: `WorkspaceCsiNativeActivationGateTest`, CSI execution/activation admission
  tests, `WorkspaceCsiRuntimeProvisioner` tests.
- MySQL integration: `ManagedSessionStoreIntegrationTest`,
  `HostedHarnessMySqlIT:240`, `ManagedSchemaMySqlIT` for the head column.
- TS typecheck/build for `packages/core` and `packages/cli` after the wire changes.

## Phasing and follow-ups

1. Phase 1 (A1 negotiation strip) — recommended first, lowest risk.
2. Phase 2 (A5 unification) and Phase 3 (A2 minimumReader) — independent, can
   land in either order after Phase 1.
3. Phase 4 (A4 v2 + v3 read-tolerance removal) — independent.
4. Follow-up A1 Layer 2: drop `storage_version` after re-expressing the CSI fence
   and the activity rebuild marker (resolve the open question first).
5. Follow-up A4 full collapse and A3 tool-protocol unification: separate
   architecture batches (B class / A3 in the inventory).
