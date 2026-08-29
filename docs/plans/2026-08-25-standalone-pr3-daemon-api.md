# Standalone daemon sessions PR3 implementation plan

**Status:** implementation-ready against merged QwenLM/qwen-code PR #9978.
The implementation branch starts from `origin/main` merge commit
`e5f14e33e0b7a0ad35b36acd3b91b3f117a27efb`; the final PR2B head was
`bd3b27f88fef7e0959b044113bf45d56b8b92b75`.

**Goal:** publish the complete daemon-only standalone-v1 contract: prompt-less
creation, list/get/load/resume/repair, rename/export, archive/unarchive/delete,
crash-safe deletion reconciliation, and conditional
`standalone_sessions_v1` advertisement. SDK, WebShell, and WebUI remain later
stages.

**Source of truth:** `docs/design/standalone-daemon-sessions.md`. This plan turns
that architecture into tasks against the actual PR2B implementation. Where this
plan tightens an ambiguous failure boundary, the architecture document is
updated in the same design change.

## Baseline and implementation gates

PR2B is merged, approved, and present in `origin/main`. Its final tree adds the
internal `StandaloneSessionService`, managed private directories, runtime
quarantine, lifecycle admission, exact lookup/list, load/resume,
prompt/continue guards, and projectless Live-task adoption. It does not
register standalone routes or advertise a capability. The final review delta
adds restore-failure cleanup, terminal-quarantine propagation, persisted/live
PR-summary merging, canonical Live-task entry IDs, structured unavailable
errors, and ACP compatibility-restorer wiring. These changes strengthen but do
not replace the PR3 seams below.

PR3 implementation and publication gates are:

1. **Satisfied:** PR #9978 is approved and merged, and its merge commit is the
   current `origin/main` baseline.
2. **Satisfied:** the final PR has no unresolved review threads. The final
   restore cleanup, quarantine state, directory replacement, compatibility
   restore, and rollback ownership changes preserve the declared fail-closed
   behavior.
3. **Satisfied for PR3:** issue #9490 remains open for mixed-case legacy and
   UUIDv7 populations, but PR3 accepts only canonicalizable UUID v1-v5 values.
   `normalizeSessionIdForLookup()` and the final Live-task/coordinator paths use
   the same lower-cased bridge key for that population. PR3 introduces no
   second normalization rule; the broader compatibility defect stays in
   #9490.
4. **Satisfied:** this inventory was rebuilt against merged `main`; no signature
   drift changes the implementation order or ownership boundaries below.
5. **Publication gate:** maintainers are told that PR3 touches
   cross-package/core lifecycle code. If production logic exceeds 1,000 added
   lines, the repository's advisory gate applies even though the change is a
   feature rather than a refactor.

## Locked scope

### Included

- The complete `/standalone/sessions` REST route family.
- Prompt-less top-level standalone creation with a caller-provided UUID.
- Active and archived list/exact lookup, load/resume, explicit directory repair,
  title rename, and transcript export.
- Standalone-only archive, unarchive, and delete batches.
- Durable deletion authorization, exact directory staging, restart recovery,
  and `fileCleanupPending`.
- Conditional capability advertisement only when the service, journal,
  lifecycle, routes, and managed-directory primitives are installed together.
- Daemon integration tests, fault injection, and the PR3 E2E plan.

### Excluded

- TypeScript SDK methods or public SDK types (PR4).
- WebUI/WebShell context selection or presentation (PR5/PR6).
- Attachments as a new product surface, quotas, expiration, or background
  garbage collection.
- Moving/forking a standalone session into a project.
- Durable standalone cron, workflows, native LSP, worktree isolation, or a
  stronger OS sandbox.
- Generic session routes learning how to discover cold standalone transcripts.
- A second runtime, ACP child, standalone service, lifecycle lock map, writer
  lease, or filesystem identity implementation.

## Actual PR2B seam inventory

PR3 extends these existing seams rather than replacing them:

- `StandaloneSessionService` already owns canonical request IDs, process-local
  creation state, runtime activity, source/lineage verification, pinned child
  identity, managed relocation, creation, load/resume, exact lookup/list, and
  prompt/continue admission. It lacks prompt-less create, repair, metadata,
  export, archive/unarchive/delete, and deletion reconciliation.
- `ConversationWorkspace` owns the secure Conversations root and deterministic
  direct-child identity. It can inspect/create/recreate and discard an empty
  child. It cannot stage, restore, or recursively clean a journal-authorized
  child.
- `SessionArchiveCoordinator` already provides shared admission,
  fail-fast exclusive mutation, and waiting exclusive-after-shared mutation.
  Every PR3 operation uses this instance.
- `SessionService` already owns writer leases, authoritative storage spelling,
  active/archived snapshots, archive/unarchive, rename, transcript reads, usage
  salvage, and all transcript sidecar paths. Its current `removeSession()`
  combines transcript unlink and sidecar cleanup and returns only a boolean;
  that is insufficient for a durable post-commit cleanup retry.
- `session-export.ts` already renders html/md/json/jsonl and remains the only
  export formatter.
- `createServeFeatures()` and `CONDITIONAL_SERVE_FEATURES` already provide the
  fail-closed capability mechanism. Bootstrap capabilities intentionally omit
  the new tag.
- `createServeApp()` constructs the Conversations ownership, runtime manager,
  workspace, service, route graph, and final capability handler. The new route
  is mounted only when the complete dependency object exists.

## Public REST contract

All body validators require a JSON object, reject arrays, reject unknown keys,
and validate every field before ownership acquisition or filesystem mutation.
Mutation routes use the existing daemon mutation middleware. A request can
never provide `cwd`, `workspaceCwd`, `workspaceId`, source, scope, branch, or
worktree state.

| Route                                            | Request                                         | Success                                                           |
| ------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------- |
| `POST /standalone/sessions`                      | `{ sessionId, modelServiceId?, approvalMode? }` | `200` standalone session; no prompt is sent                       |
| `GET /standalone/sessions`                       | `cursor?`, `size?`, `archiveState?`             | `200 { sessions, nextCursor?, liveMergeFailed?, truncated? }`     |
| `GET /standalone/sessions/:id`                   | none                                            | `202 { sessionId, state: "creating" }` or `200` summary           |
| `POST /standalone/sessions/:id/load`             | restore options without workspace fields        | `200` restored session                                            |
| `POST /standalone/sessions/:id/resume`           | restore options without workspace fields        | `200` restored session                                            |
| `POST /standalone/sessions/:id/repair-directory` | empty body                                      | `200 { sessionId, projectlessOutputDirectory, workingDirectory }` |
| `PATCH /standalone/sessions/:id/metadata`        | `{ displayName }`                               | `200 { sessionId, displayName }`                                  |
| `GET /standalone/sessions/:id/export`            | `format` is `html`, `md`, `json`, or `jsonl`    | existing export content type, filename, and body                  |
| `POST /standalone/sessions/archive`              | `{ sessionIds }`                                | `200 { archived, alreadyArchived, notFound, errors }`             |
| `POST /standalone/sessions/unarchive`            | `{ sessionIds }`                                | `200 { unarchived, alreadyActive, notFound, errors }`             |
| `POST /standalone/sessions/delete`               | `{ sessionIds }`                                | `200 { removed, notFound, errors, fileCleanupPending }`           |

Additional wire rules:

- `sessionId` is a canonicalized RFC UUID v1-v5. Batch inputs contain 1-100
  strings, are canonicalized and de-duplicated while preserving first-input
  order, and reject the entire body before work if any ID is invalid.
- `displayName` is non-empty after trimming, contains no control characters,
  and is capped at the existing 256-character daemon limit. The route does not
  expose PR bindings or organization metadata.
- List reuses the current cursor/page-size/archive-state implementation, returns
  top-level explicit and compatible legacy standalone sessions only, and does
  not stat private directories.
- Load/resume accept only the options already represented by
  `RestoreStandaloneSessionOptions`; client identity comes from the existing
  header parser, not the body.
- Archive/unarchive do not expose `resolveConflicts`. An active-plus-archived or
  case-ambiguous ID is a per-ID `standalone_session_conflict`; the daemon never
  deletes one copy to resolve it.
- Batch errors have exactly `{ sessionId, code, message }`. A failure for one ID
  does not roll back successful operations on other IDs.
- Creation continues after an HTTP disconnect. If the session commits but the
  response socket is gone, the route detaches only the response client's bridge
  registration; it does not delete the transcript or private directory. The
  caller recovers with exact GET and load/resume and never automatically retries
  create.

## Ownership and capability publication

Every route is process-global at the HTTP layer but resolves only the owned,
trusted, non-primary Conversations runtime through `StandaloneSessionService`.
It never accepts a workspace selector and never falls back to the primary
runtime. Current ownership failure remains a structured 503 even though the
capability describes support rather than current availability.

Add `standalone_sessions_v1` to `SERVE_CAPABILITY_REGISTRY` and to
`CONDITIONAL_SERVE_FEATURES` behind one
`standaloneSessionsAvailable: () => boolean` closure. `createServeFeatures()`
evaluates the closure for each capabilities response, after app construction;
it is true only after all of the following are constructed and the route
registrar has run:

- `ConversationRuntimeOwnership`
- `ConversationRuntimeManager`
- `ConversationWorkspace`
- `StandaloneDeletionJournal`
- `StandaloneSessionService`
- the shared `SessionArchiveCoordinator`
- the complete standalone route registrar

`currentServeFeaturesForRunQwenServe()` does not set the toggle, so the
bootstrap listener omits the feature. The final app handler evaluates the
runtime closure after route installation. Direct/embedded `createServeApp()`
calls without any dependency above omit both routes and capability. Availability
does not depend on Live Voice enablement and does not eagerly materialize the
Conversations root.

## Lifecycle admission

The route parses a UUID once. The canonical UUID is the coordinator/in-flight/
journal key. The durable storage spelling returned by `SessionService` remains
authoritative for transcript and ACP storage operations. No lifecycle method
re-normalizes a storage spelling into a second filename.

Lock order is fixed:

1. Conversations cross-daemon ownership/runtime activity.
2. Canonical session lifecycle lock; parent shared before child exclusive for
   the existing child-create path.
3. Close or check active bridge work inside the lifecycle boundary, before a
   writer lease is acquired.
4. Session writer or maintenance lease for transcript mutation.
5. Journal, managed-directory, transcript, or cold-metadata persistence.
6. Bridge detach and catalog notification after the durable mutation.

No PR3 operation holds a writer lease while waiting for another session lock or
for active bridge work to settle.
Batch operations acquire one ID at a time and may run independent IDs in
parallel. Rename, repair, archive, unarchive, and delete use exclusive
admission. Exact get/export use shared admission. List stays snapshot-based,
then takes shared admission for one returned page item at a time to revalidate
and journal-filter it; it never locks the whole catalog or holds multiple
session locks. Load/resume/create continue to use the existing
waiting-exclusive path.

## Journal design

Create `StandaloneDeletionJournal` under the stable ownership namespace:

```text
<stableBaseDir>/conversations/deletions/
  delete-<canonical-id>.prepared.json
  delete-<canonical-id>.staged.json
```

The directory is owner-only. Each file is owner-only, bounded to 8 KiB, written
through an exclusive temporary file in the same directory, fsynced, and renamed
to a previously absent final name. The two immutable phase files avoid the
unlink-then-rename replacement gap on Windows. `staged` supplements rather than
overwrites `prepared`; recovery accepts both only when their immutable fields
match. Clearing unlinks `staged` first and `prepared` last, then fsyncs the
directory. A crash during clear can only leave an earlier safe phase.

The version-1 record contains only bounded data:

```ts
interface StandaloneDeletionRecordV1 {
  version: 1;
  phase: 'prepared' | 'staged';
  sessionId: string;
  storageSessionId: string;
  transcriptLocation: 'active' | 'archived';
  root: {
    canonicalPath: string;
    device: number;
    inode: number;
    inodeVerifiable: boolean;
  };
  directory:
    | { kind: 'absent' }
    | {
        kind: 'present';
        normalName: string;
        stagedName: string;
        device: number;
        inode: number;
        inodeVerifiable: boolean;
      };
}
```

Readers validate exact keys, version, canonical request UUID,
`storageSessionId` pattern and case-folded equality, active/archive location,
filename/phase agreement, numeric and boolean identity fields, size,
ownership/mode, deterministic normal/staged names, direct-child paths, and the
current root identity. The storage spelling and pre-delete location are durable
cleanup inputs after transcript unlink, when they can no longer be rediscovered.
Recovery derives the two direct-child paths from the recorded canonical root and
validated deterministic names; it never follows a serialized arbitrary child
path. Temporary files and unrelated names are not treated as authorization.
Root and child `inodeVerifiable` use the existing identity model: nonzero inodes
must match; inode-zero filesystems fall back explicitly to device, canonical
path, direct-child shape, owner/mode where available, and link/reparse checks.

There is no second lockfile: the cross-daemon Conversations owner and the
existing in-process lifecycle coordinator are the writers' authority. Exact
lookup can read a journal while holding shared admission, but never mutates it.

The first mutating/load/repair operation after ownership acquisition starts one
generation-scoped singleflight for a bounded pass of at most 32 canonical IDs.
The caller awaits that pass before acquiring its requested session lifecycle
lock. The pass validates and sorts journal filenames, then holds only one
record's exclusive lifecycle lock and writer lease at a time; it never runs
while any caller-specific session lock is held. Read-only get/list/export do not
run reconciliation; they inspect the journal under their read-admission rules
and fail closed or omit a pending ID. Exact delete and create/load/resume/repair
then reconcile their requested UUID inside its exclusive admission even after
the bounded pass reaches its limit. Thus root creation stays lazy, exact GET
remains non-mutating, and first-use recovery cannot self-deadlock.

Before a journal authorizes directory or attachment cleanup, reconciliation
also rechecks every runtime/live owner for the canonical UUID. A newly observed
project, Live, child, conflicting transcript spelling, or foreign bridge entry
returns `deletion_recovery_compromised` and touches nothing. The journal proves
an earlier standalone delete request; it does not grant authority over a later
owner that failed to participate in the standalone lifecycle coordinator.

## Managed-directory operations

Extend `ConversationWorkspace`; do not perform path manipulation in routes or
the journal class.

- Derive the normal name with the existing SHA-256 helper and the staged name as
  its fixed `.deleting` sibling.
- `inspectStandaloneDeletionPaths()` validates root, normal, staged, expected
  device/inode, direct-child shape, owner/mode, and the impossible-both-present
  state.
- `stageStandaloneDirectory()` revalidates the pinned normal identity, proves
  the staged path absent, atomically renames normal to staged, then proves that
  the staged path carries the same identity under the recorded filesystem
  guarantee before the staged phase is written.
- `restoreStagedStandaloneDirectory()` requires normal absent and a matching
  staged identity, renames staged to normal, and revalidates the restored
  identity before journal clear.
- `removeStagedStandaloneDirectory()` accepts only a valid journal record and a
  matching staged identity, recursively removes that exact sibling, and
  revalidates the root afterward.

The lifecycle lock plus a valid journal prevents any cooperating daemon path
from creating or adopting the same UUID while cleanup is pending. The owner-only
root protects other OS users. A malicious process running as the same OS user is
outside the existing daemon filesystem threat model; Node has no portable
inode-bound recursive unlink, and inode-zero filesystems cannot detect same-path
replacement. The implementation must state this boundary rather than claiming
a stronger guarantee.

## Core transcript commit point

Define transcript unlink as the logical deletion commit point. This produces a
smaller and more recoverable contract than pretending the transcript and all
sidecars can change atomically.

Add narrow `SessionService` lifecycle primitives, reusing its private snapshot,
usage-salvage, and sidecar helpers:

1. `removeSessionTranscriptForLifecycle()` validates the maintainable snapshot,
   rechecks the writer lease callback, unlinks the one accepted active or
   archived transcript, and commits usage salvage immediately after that
   unlink. It does not remove sidecars.
2. `cleanupRemovedSessionState()` idempotently removes worktree, PR, prompt
   ledger, file-history, and organization sidecars even when the transcript is
   already absent. Existing `removeSession()` composes the same internal helpers
   so ordinary behavior remains unchanged.

Standalone delete rejects active/archived conflicts before calling the first
primitive. If transcript unlink throws, re-read only authoritative transcript
location under the same writer lease:

- The original transcript is still intact: restore staged to normal, clear the
  journal, and return retryable `transcript_deletion_failed`.
- The transcript is absent: the logical delete committed; continue cleanup.
- Location is conflicted, unreadable, or cannot be proven: retain journal and
  staged state and return `transcript_deletion_outcome_unknown`.

After commit, `cleanupRemovedSessionState()`, bridge attachment cleanup, and
exact staged-directory cleanup are idempotent post-commit work. Any failure
returns the ID in both `removed` and `fileCleanupPending`, retains the journal,
and is retried by exact delete or bounded reconciliation. It never resurrects
the transcript. The journal is cleared only after all post-commit cleanup is
confirmed.

## Per-operation implementation

### Prompt-less create

Refactor the existing create engine to make initial-prompt admission optional;
do not copy the source-persistence, durable reread, binding, or quarantine
transaction. The public route uses the no-prompt variant. Projectless Live task
and child creation keep their existing prompt-bearing variants. Both variants
reconcile the exact UUID before reservation and use the same create map.

The returned bridge client registration belongs to the HTTP response. If
`res.writable` is false after commit, invoke one narrow service detach method for
that client ID and return without writing. Detach failure is diagnostic only;
the durable session remains discoverable.

### Load, resume, and repair

Load/resume reconcile the exact journal before directory preparation, then keep
their existing source/live-entry/epoch/pin checks.

Repair has no hidden prompt replay. Under exclusive admission it:

1. Reconciles a matching journal.
2. Requires an active standalone transcript; archived returns `session_archived`.
3. Verifies any live entry's source, lineage, storage ID, and epoch.
4. Returns retryable `session_busy` if an active prompt or cwd-bound background
   work prevents relocation; it never cancels work automatically.
5. Reuses a valid child, restores a journaled child, or recreates only an absent
   child, then reapplies managed binding/release.
6. If a cold restore was required solely to perform repair, detaches the repair
   response client before returning the directory result.

Factor the directory/bind portion shared with restore. Do not implement repair
by calling the public load route or by replaying transcript history through
Express.

### Metadata and export

Rename validates the title before runtime work, reconciles/fails on a matching
journal, and runs under exclusive admission. For an active verified live entry,
use the existing bridge metadata mutation so listeners receive the event. For a
cold or archived entry, use `SessionService.renameSession()` with the
authoritative spelling/location. Mark the catalog and invalidate active and
archived list caches only after persistence succeeds. The deterministic child
name never changes.

Export runs under shared admission, rejects a pending journal, proves standalone
source/location, and calls the existing formatter with the authoritative
storage spelling and archive state. It never creates or repairs a child and does
not expose the internal workspace in the response.

### Archive and unarchive

Both operations reconcile/fail on a matching journal, prove standalone source
again inside the exclusive lifecycle and writer lease, and never call the
generic project scheduled-task maintenance helpers. Durable standalone cron is
unsupported, so touching the shared Conversations cron file would be a scope
leak.

Archive closes active ownership with agent-close confirmation, moves the
transcript through `SessionService.archiveSessions(resolveConflicts: false)`,
retains the private child and pin, clears `agentBound`, marks the catalog, and
invalidates both list states. Unarchive moves the transcript back but does not
restore or recreate the child; the next load/repair performs identity work.
Parent and child sessions never cascade.

### Delete and reconciliation

For each canonical ID under exclusive admission:

1. Reconcile an existing journal. A terminal committed deletion returns
   `removed`; a compromised record returns its structured error.
2. Prove the transcript is active/archived standalone and not a child of another
   product context. Close active ownership and confirm it is no longer live.
3. Acquire the writer/maintenance lease and re-read source/location.
4. Inspect the normal/staged child. Compromise or both-present fails before any
   mutation. Write `prepared`, recording the authoritative storage spelling,
   active/archive location, and either a matching child or absence.
5. If present, atomically stage the child and write immutable `staged` evidence.
6. Unlink the transcript through the core commit-point primitive and classify an
   error as intact, committed, or unknown.
7. After commit, idempotently clean core sidecars, bridge attachments, and the
   exact staged child. Return `fileCleanupPending` and retain the journal on any
   failure.
8. Clear journal phases only after cleanup succeeds, clear the service's pinned
   directory state, mark the catalog, and invalidate both list states.

Recovery uses physical state plus a valid journal, not the nominal phase alone:

| Recorded directory | Transcript                  | Normal child      | Staged child | Action                                                    |
| ------------------ | --------------------------- | ----------------- | ------------ | --------------------------------------------------------- |
| present            | intact                      | matching          | absent       | clear stale journal                                       |
| present            | intact                      | absent            | matching     | restore staged, then clear                                |
| absent             | intact                      | absent            | absent       | clear stale journal; keep transcript                      |
| present            | absent                      | absent            | matching     | finish post-commit cleanup, then clear                    |
| absent             | absent                      | absent            | absent       | finish sidecar cleanup, then clear                        |
| present            | absent                      | absent            | absent       | finish sidecar cleanup, record vanished child, then clear |
| present            | intact                      | absent            | absent       | compromised before commit; touch nothing                  |
| any                | any                         | present           | present      | compromised; touch nothing                                |
| any                | partial/conflict/unreadable | any               | any          | outcome unknown; touch nothing                            |
| any                | any                         | mismatched/unsafe | any          | compromised; touch nothing                                |

A valid `directory.kind: "absent"` record requires both child paths absent.
Creation cannot reserve/materialize the UUID while either phase file remains.
Read-only exact GET returns 404 when the transcript is absent; when it is intact
but journaled, it returns retryable conflict without reconciling. Listing omits
journaled IDs so a partially deleted session is never advertised as stable.

Recovery therefore has one simple commit rule: an intact transcript means roll
the incomplete deletion back to an intact session; an absent transcript means
logical deletion committed and cleanup must finish. An exact delete retry may
start a fresh transaction after rollback clears the stale record. Conflicted or
unreadable location proves neither state and remains outcome-unknown.

## Error mapping

Extend `StandaloneSessionServiceErrorCode` and the existing centralized daemon
error serializer; do not inspect message text.

| Code                                  | HTTP | Retryable                                             |
| ------------------------------------- | ---: | ----------------------------------------------------- |
| `invalid_request`                     |  400 | no                                                    |
| `standalone_session_not_found`        |  404 | no                                                    |
| `standalone_session_conflict`         |  409 | depends on pending/in-flight state                    |
| `standalone_session_operation_failed` |  500 | no; refresh state before deciding whether to retry    |
| `session_archived`                    |  409 | no                                                    |
| `session_busy`                        |  409 | yes                                                   |
| `working_directory_missing`           |  409 | yes through repair                                    |
| `working_directory_compromised`       |  409 | no                                                    |
| `deletion_recovery_compromised`       |  409 | no                                                    |
| `standalone_creation_rolled_back`     |  500 | yes, after exact GET confirms 404                     |
| `standalone_creation_outcome_unknown` |  500 | no automatic create retry                             |
| `transcript_deletion_failed`          |  500 | yes                                                   |
| `transcript_deletion_outcome_unknown` |  500 | no automatic retry except exact delete/reconciliation |
| `working_directory_recovery_failed`   |  500 | yes through exact delete/reconciliation               |

Existing `conversation_*` 503 mappings remain unchanged. Errors include the
session ID when known and never include managed filesystem paths.

## File-level implementation order

1. **Core commit-point primitives**
   - Modify `packages/core/src/services/sessionService.ts` and its tests.
   - Preserve existing remove/archive/unarchive behavior and usage salvage.
2. **Journal and directory staging**
   - Add
     `packages/cli/src/serve/conversations/standalone-deletion-journal.ts` and
     colocated tests.
   - Extend `conversation-workspace.ts` and identity tests with staged-path
     operations and platform-specific failures.
3. **Service lifecycle**
   - Extend `standalone-session-service.ts` and its tests with reconciliation,
     prompt-less create, detach, repair, metadata/export, lifecycle batches, and
     delete.
   - Keep all source, lineage, runtime-generation, and pin decisions here.
4. **Route adapters and errors**
   - Add `packages/cli/src/serve/routes/standalone-sessions.ts` and tests.
   - Register it from `server.ts`; extend `error-response.ts` without duplicating
     status logic.
5. **Capability and embed gates**
   - Update `capabilities.ts`, `server/serve-features.ts`, server tests, and
     bootstrap tests.
   - Prove partial/direct embeds omit both route and feature.
6. **Integration/E2E**
   - Add real-daemon integration coverage after build/bundle.
   - Execute `.qwen/e2e-tests/2026-08-25-standalone-pr3-daemon-api.md`.

Keep the implementation as one logical publication PR with ordered commits for
the layers above. Re-estimate after tasks 1-3 compile. If the production diff is
over 1,000 lines, request maintainer direction before publication: either keep
one atomic PR with explicit awareness, or use stacked review units whose first
unit exposes no routes/capability and whose final unit atomically publishes the
complete feature. Do not silently split the capability contract.

Current evidence suggests the old 500-850 production-line estimate is no longer
credible. A working estimate is 1,250-2,050 production lines and 2,500-4,000
test lines, dominated by durable deletion and fault injection. This is an
estimate, not permission to fill the budget.

## Verification matrix

### Focused unit tests

- Strict body/query validation, forbidden keys, malformed UUIDs, duplicate
  batch IDs, bounded arrays, and exact status/body schemas.
- Capability off for bootstrap, partial embeds, missing workspace/manager/
  journal/service/routes; on only for the complete app.
- Prompt-less create, response disconnect detach, exact GET 202/200/404, and no
  automatic create retry.
- Source/context/lineage conflicts for active, archived, child, Live, project,
  corrupt, mixed-case, and active-plus-archived transcripts.
- Read-only get/list/export do not write or reconcile journal state.
- Repair of ready/missing/replaced/staged directories, busy prompt/background
  work, live/cold sessions, and detach of repair-only restore.
- Rename/export for live, cold, and archived sessions; no child materialization.
- Archive/unarchive retain child, clear binding on archive, do not cascade, and
  never touch durable cron.
- Journal schema/path/mode/size/phase validation; immutable phase idempotency;
  verifiable and inode-zero identity modes; stale temp files; bounded scanning;
  unrelated compromised records do not block safe IDs.
- Fault injection before/after prepared write, directory rename, staged write,
  transcript unlink, usage commit, every sidecar cleanup, attachment cleanup,
  recursive removal, journal clear, and runtime restart.
- Every row of the recovery table, including normal-plus-staged, unsafe staged
  path, root replacement, child inode replacement, mixed-case legacy spelling,
  absent transcript with pending cleanup, a later foreign-context UUID owner,
  and exact retry.
- Writer lease loss, runtime generation closure, daemon drain, cross-daemon
  owner conflict, and release failure at every mutation boundary.
- Existing ordinary/Live create, restore, archive, unarchive, delete, metadata,
  export, capabilities, and scheduled-task tests remain unchanged.

### Integration and E2E

- Build and bundle before real-daemon tests.
- Complete REST lifecycle: create → exact get → prompt through existing owner
  route → close → load/resume → rename/export → archive → unarchive → delete.
- Kill/restart at each journal boundary and verify exact recovery.
- Disconnect create response after persistence and recover by UUID.
- Concurrent prompt versus repair/archive/delete admission.
- Two daemons contending for Conversations ownership; never primary fallback.
- Embedded app without Conversations dependencies has 404 routes and no feature.
- macOS and Linux identity/mode/rename/restart behavior.
- Windows canonical path, reparse/junction rejection, open-handle rename/delete
  failures, restart, immutable phase files, and cleanup-pending behavior.

Required local checks after implementation:

```bash
cd packages/core && npx vitest run src/services/sessionService.test.ts
cd packages/cli && npx vitest run \
  src/serve/conversations/conversation-workspace.test.ts \
  src/serve/conversations/standalone-deletion-journal.test.ts \
  src/serve/conversations/standalone-session-service.test.ts \
  src/serve/routes/standalone-sessions.test.ts \
  src/serve/server/error-response.test.ts \
  src/serve/server.test.ts
cd ../.. && npm run build && npm run bundle && npm run typecheck && npm run lint
npm run test:integration:cli:sandbox:none
```

Run serial Vitest commands if coverage output or shared temp state contends.
Then perform the repository-required open-ended full-diff audit until two
consecutive clean passes; any fix resets the count.

## Design audit log

### Finding round 1: architecture and failure paths

- Found a contradiction between non-mutating exact lookup and unconditional
  reconciliation on first ownership acquisition. Changed the plan so read-only
  routes inspect/fail closed while mutation/load paths reconcile.
- Found a Windows replacement gap in a single mutable phase file. Changed the
  journal to immutable prepared/staged files.
- Found that existing `removeSession()` cannot retry sidecar cleanup once the
  transcript is absent. Added narrow core commit-point and idempotent cleanup
  primitives.
- Found that generic archive/delete helpers mutate scheduled-task storage.
  Standalone lifecycle calls core storage primitives directly and does not reuse
  that project-scoped maintenance behavior.

### Finding round 2: compatibility, maintainability, and simpler alternatives

- Rejected a second lifecycle service/lock and route-level filesystem work.
- Rejected full transcript-plus-sidecar rollback as an unprovable multi-file
  transaction. Transcript unlink is the logical commit; cleanup is journaled.
- Rejected eager runtime initialization solely to reconcile journals; exact
  per-ID recovery plus a bounded first mutation keeps the root lazy.
- Rejected direct reuse of generic metadata and batch routes because they admit
  workspace/PR/conflict-resolution semantics outside standalone v1.
- Retained one export renderer, one writer lease, one directory identity model,
  and one capability registry.

### Finding round 3: lock and recovery-state precision

- Found that the initial lock order allowed active bridge settlement while a
  transcript writer lease was held. Moved bridge close/busy checks before writer
  acquisition and kept list snapshot-based rather than locking every UUID.
- Found that the initial recovery table conflated an intentionally absent child
  with a recorded child for which both paths vanished. Split the states so only
  proven pre-delete absence permits transcript commit; unexplained pre-commit
  disappearance fails closed.

### Finding round 4: first-use reconciliation concurrency

- Found that an underspecified first-use journal pass could be invoked after a
  caller acquired its requested UUID lock, then self-deadlock while scanning the
  same record. Made the bounded pass generation-singleflight, sorted, one-lock-
  at-a-time, and mandatory before any caller-specific lifecycle admission.
- Tightened list consistency without locking the catalog: it validates only the
  returned page, one shared UUID admission at a time, and omits journaled or
  no-longer-valid entries.

### Finding round 5: filesystem identity portability

- Found that the first journal schema implicitly required a verifiable child
  inode even though PR2B deliberately supports inode-zero filesystems using a
  reduced identity guarantee. Added explicit child/root verifiability evidence,
  matching rules, threat-boundary wording, and tests for both modes.

### Finding round 6: post-commit legacy spelling

- Found that canonical UUID alone cannot recover mixed-case legacy sidecar names
  after transcript unlink removes the only authoritative spelling. Added the
  validated storage spelling and pre-delete active/archive location to durable
  journal evidence and recovery tests.

### Finding round 7: incarnation isolation

- Required reconciliation to recheck every runtime/live owner before journal-
  authorized cleanup, so durable evidence for an old standalone incarnation can
  never mutate a later foreign owner of the same UUID.

### Finding round 8: capability construction timing

- Replaced an ambiguous capability boolean with a per-response availability
  closure, matching `createServeFeatures()` construction order and ensuring the
  tag cannot appear before route registration completes.

### Finding round 9: one deletion commit rule

- Simplified crash recovery so every intact transcript rolls back incomplete
  deletion, including sessions whose child was already absent. Only transcript
  absence commits deletion; an explicit retry can start a new transaction after
  stale evidence is cleared.

### Finding round 10: rendered wire schema

- Found that pipe characters in the export query cell split the Markdown route
  table into extra columns. Reworded the enum so the rendered request schema
  remains exact.

### Finding round 11: minimal journal evidence

- Removed duplicate serialized child canonical paths. Root identity plus
  validated deterministic normal/staged names uniquely derives the only allowed
  direct children, reducing record size and eliminating arbitrary child-path
  inputs without weakening recovery.

### Clean audit pass 1: security, compatibility, and testing

- Rechecked path authorization, crash points, transcript/sidecar commit
  boundaries, source/lineage isolation, capability gating, batch behavior,
  response disconnects, cold/archive behavior, and platform coverage. No new
  actionable issue was found.

### Clean audit pass 2: simplicity, maintainability, and scope

- Rechecked existing seam reuse, lock ownership, error mappings, file-level
  sequencing, estimates, exclusions, verification breadth, and simpler
  alternatives. No new actionable issue was found.

### Merged-head reconciliation

- Rebuilt the seam inventory against merged PR2B commit `e5f14e33e0` and final
  PR head `bd3b27f88f`. The final review fixes strengthen cleanup, quarantine,
  summary merging, Live-task canonicalization, unavailable errors, and ACP
  compatibility restore without changing PR3's route, journal, or commit-point
  ownership.
- Verified that PR #9978 is approved with no unresolved review threads and that
  its merge requirements completed successfully.
- Classified issue #9490's remaining mixed-case legacy/UUIDv7 lock-key defect as
  out of scope for PR3's UUID v1-v5 public contract. The final PR2B Live paths
  already use `normalizeSessionIdForLookup()` for every PR3-valid ID.

After these changes, no additional clear scope, compatibility, failure-path,
testing, or simpler-design issue was found against merged PR2B. The remaining
publication gate is maintainer awareness, not upstream interface drift or an
unresolved PR3 product decision.
