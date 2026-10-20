# Bounded tenant-guard coupling for Managed Session traffic

[English](2026-10-11-managed-tenant-guard-wedge.md) | [简体中文](2026-10-11-managed-tenant-guard-wedge.zh-CN.md)

- Status: implemented in this change (witness: `ManagedSessionGuardConvoyIT`);
  the lanes listed under Follow-ups keep unbounded acquisitions
- Issue: [#13800](https://github.com/QwenLM/qwen-code/issues/13800) — a
  `recovery_blocked` Session wedges later turns of other Sessions on the same
  daemon. This change does not implement that issue's W1 or W2; see Scope.
- Related: acceptance report `docs/verification/13532-linux-h3/README.md`
  (finding A2), reproduction report `.qwen/issues/issue-13800.md` (not
  committed).

## Problem

On the managed-agent chain (MariaDB → managed-agent-server → hosted-harness
daemon → runtime workers), the presence of one Session marked
`recovery_blocked` correlates with unrelated Sessions freezing: their journal
stops after `hostedModelAttempt`, the model endpoint receives no further
request, and the turn never finishes. Clearing the store rows restored normal
behavior on the physical rig. The acceptance report recorded the correlation
but not the mechanism.

### Scope

#13800's W1 was settled on a different mechanism: the Workspace execution
mount lease, one row per `(tenantId, storageId)`, held by the parked blocked
turn. During that wedge `innodb_trx` and the lock-wait tables were empty and
the broker threads idle, which rules out tenant-wide row locks
([issue comment](https://github.com/QwenLM/qwen-code/issues/13800#issuecomment-6094220681)).
W2 is [#13816](https://github.com/QwenLM/qwen-code/pull/13816). This change
neither implements W1 nor discharges W2's exit check.

What it fixes is a separate coupling that the investigation demonstrated
independently (the guard-hold variant below): every Session's per-turn store
traffic queued on two tenant-wide guard rows, so any long holder of either
row froze unrelated Sessions past the client's budget.

## Mechanism

The Managed Session store takes two per-tenant InnoDB record locks on the hot
write path of **every** Session, unconditionally:

1. `qwen_runtime_placement_guard` (one row per tenant), acquired in
   `JdbcRuntimeBindingRepository.lockPlacementDomain` via
   `WorkspaceLifecycleStore.lockPlacement` and
   `WorkspaceMigrationAdmission.lockTenant`.
2. `qwen_tool_publication_tenant` (one row per tenant), acquired in
   `ToolPublicationRetentionStore.lockTenant`.

The call matrix in `ManagedSessionStore` before this change:

| Operation            | placement guard                                                                  | publication tenant row                                | per-session locks (head row / drain / session row) |
| -------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `acquireWriter`      | yes — `checkLifecycleWriter`, and `WorkspaceMigrationAdmission.sessionAdmission` | yes — `checkLifecycleWriter` and an explicit call     | yes                                                |
| `renewWriter`        | yes — `checkLifecycleWriter`                                                     | yes — `checkLifecycleWriter` + `requireHeadForUpdate` | yes                                                |
| `sealWriter`         | yes — `checkLifecycleWriter`                                                     | yes                                                   | yes                                                |
| `commit`             | yes — `checkLifecycleWriter`                                                     | yes                                                   | yes                                                |
| `blockRecovery`      | no                                                                               | yes — `requireHeadForUpdate`                          | yes                                                |
| `authorizeOrdinary`  | yes — explicit                                                                   | yes — explicit                                        | yes (drain + head)                                 |
| `authorizeLifecycle` | yes                                                                              | yes                                                   | yes (claim + session + head)                       |

For `authority == null` (ordinary, non-lifecycle traffic)
`checkLifecycleWriter` takes the two locks and runs one v2 probe
(`ma_operation` joined to the drain row on `operation_id`, kinds
`CLOSE`/`ARCHIVE`/`DELETE`, `lifecycle_protocol_version = 2`); with a v2
claim present it throws `workspace_lifecycle_claim_fenced`. D1 moves that
fence rather than dropping it. Any transaction that holds either row longer
than the harness client's 30-second request timeout freezes every Session of
the tenant whose next store call arrives meanwhile, because:

- InnoDB lock wait (default 50 s) exceeds the client timeout (30 s);
- each timed-out call is retried, and the server-side statement may still be
  queued when the next retry arrives, so client wait and server wait
  accumulate;
- a failed `acquireWriter` can leave a head row inserted but unclaimed, so
  later creates of the same session id answer `409
managed_session_writer_conflict` until the dead writer lease expires.

### Reproduction (guard-hold evidence)

The full reproduction report with environment, commands, and raw logs lives in
`.qwen/issues/issue-13800.md`. Summary of the decisive variants, run against a
local MariaDB 10.11 + managed-agent-server + packaged hosted harness + fake
model endpoint:

- **Guard-hold variant (positive).** An external transaction holds both guard
  rows (`UPDATE ... WHERE tenant_id = ?`). Outcomes:
  - Session create for an unrelated id stalls in `POST
/writers:acquire`; the daemon reports `Managed Session Store POST
/writers:acquire failed ... aborted due to timeout` after 30002 ms and the
    route answers 503 `managed_session_open_failed`; `sys.innodb_lock_waits`
    shows 29 waiter rows; a follow-up create fails with 409
    `managed_session_writer_conflict` on the half-inserted head row.
  - A pre-created victim Session's `POST /session/:id/prompt` stalls for
    30009 ms and answers 503 `hosted_execution_authorization_unavailable`; the
    model endpoint records zero requests for the turn; releasing the guard
    restores normal completion.
- **Bare `recovery_blocked` marker (negative).** Setting
  `qwen_managed_session_journal_head.recovery_status = 'BLOCKED_RESOURCE'`
  alone does not wedge a fresh Session's turn (both at the acceptance pinned
  commit and at the investigation head).
- **Materializer gap poison (negative as sole factor).** An injected sequence
  gap in a blocked Session's event stream produces the 10 Hz
  `Message projection event sequence has a gap` tripwire (confirmed present,
  `ManagedAgentStore.materializeNextBatch`), yet the victim turn completes on
  this hardware. It is a real amplifier tracked by the 2026-10-02 audit
  (§B1/B2) but not a sole wedge mechanism here.

The guard-hold variant does not explain the physical rig's wedge (see
Scope). The demonstrated defect is the coupling itself: **on the lanes this
change covers, no tenant-wide lock may gate the per-turn store traffic of
Sessions it does not belong to.** Any long hold, whatever produces it, must
leave other Sessions' turns on those lanes either completing or failing fast
with a named reason. The lanes covered are the `ManagedSessionStore`
operations in the matrix above, the publication lanes (F2) and the Turn
submit admission (`ManagedAgentStore.insertTurnCommand`). The remaining
`ManagedAgentStore` acquisitions of the placement row are listed under
Follow-ups.

## Why the guards exist (and must not simply be deleted)

The two guard rows implement cross-domain fences; removing them wholesale
would break real contracts:

- `WorkspaceMigrationAdmission.lockTenant` (placement guard) — "Fence
  installation and admission share this lock before any Session lock": a
  storage-migration fence (`qwen_runtime_storage_fence`) must exclude new
  Session writers. The admission-time TOCTOU window makes the guard
  load-bearing for W1c offline workspace migration.
- `WorkspaceLifecycleStore.lockPlacement` + claim checks (placement guard) —
  the L3 lifecycle protocol (close/delete) claims operations and serializes
  lifecycle settlement against ordinary writers.
- `ToolPublicationRetentionStore.lockTenant` (publication tenant row) — the
  CAS root of the tool-output publication domain (publish / receipts /
  session-owned retirement / retention sweep). Publication-lane paths retain
  per-tenant serialization by design.

The defect is therefore not the fences but their **placement and window**:

1. Every hot-path operation (renew, plain commit, seal, blockRecovery, and
   ordinary authorization) acquires both guards even when the operation is
   not an admission and not a lifecycle or publication effect.
2. Hold time is unconstrained on both sides: acquisitions wait without a
   statement timeout (the hot paths use `setQueryTimeout(0)`), and known fat
   holders (lifecycle recovery transactions; the `requireIdleJournal`
   `FOR UPDATE` full-journal scan with Java-side JSON parsing) hold them
   across O(journal)/O(records) work.
3. The failure asymmetry (30 s client timeout < 50 s InnoDB lock-wait
   timeout) converts transient contention into client-visible freezes.

## Goals

- G1: Ordinary traffic no longer queues behind tenant-wide guard rows it
  does not need: renew, ordinary authorization and recovery state of a
  Session complete while another transaction holds the tenant's guard
  rows. A turn also needs lanes that keep a guard (the ordinary record
  commit's bounded placement, F4; Turn submit; writer acquisition), so it
  **completes** only while the hold is shorter than the client's request
  budget; for a longer hold those lanes fail fast and bounded with the
  named 503 `tenant_guard_contended`, never a freeze.
- G2: When a guard a covered hot path genuinely needs is contended beyond a
  short budget, the call fails **fast with a named reason** instead of a
  30 s client timeout. The name reaches the store client, which retries it
  for the rest of its request budget and keeps it on the terminal error. A
  turn whose contention outlasts that budget settles under the generic
  `error` stop reason rather than as a silent freeze: the harness names
  only transport and 5xx store failures (`managed_session_store_unavailable`)
  in the settled turn result, and does not call a bounded tenant-guard
  refusal a store outage.
- G3: The journal-wide `FOR UPDATE` scan in `requireIdleJournal` first runs
  unlocked and is trusted only when it reaches the locked head's revision;
  otherwise it is repeated as a locking read (D3). The lifecycle
  recovery/verify transactions keep their unbounded acquisitions and their
  journal-side work under the tenant row in this change; bounding them is
  a Follow-up.
- G4: A witness integration test pins the geometry: red when the coupling
  is restored, green after the change.

## Non-goals

- Identifying and retracing the physical rig's exact 2026-10-09 holder (no
  evidence persisted; the fix removes the wedge class rather than one
  historical instance).
- Changing lifecycle-claim protocol semantics, publication-domain
  serialization, or migration-fence exclusion outcomes.
- Enabling `monitor_run` or the `child_run` `shell` kind, and the stuck
  `dispatch_started` `child_run` record (filed separately per the issue).
- The materializer gap tripwire quarantine and other audit §B hygiene
  (separate tracking; noted as follow-up).
- The renewal-scheduler starvation candidate (reproduction hypothesis H2) —
  unresolved; no change is made against it in this design.

## Design

### D1. Stop acquiring tenant guards on non-admission hot paths

In `ManagedSessionStore`:

1. `checkLifecycleWriter` takes the placement guard and the publication
   tenant row **only when `authority != null`** (a lifecycle-stamped writer).
   Ordinary (`authority == null`) `commit`, `sealWriter`, `renewWriter`, and
   `acquireWriter` no longer take either guard there. Per-session fencing
   stays: the Session root and head row `FOR UPDATE` serialize writers of
   one Session; the drain-row fence (`requireOrdinaryAdmission`,
   `lifecycleFenced`) keeps the ordinary-vs-lifecycle barrier. The v2 claim
   fence moves from `checkLifecycleWriter` to `requireNoLifecycleClaim`,
   which `requireOrdinaryAdmission` calls and which renew, seal, commit
   (both the first attempt and a duplicate's replay) and tool-result
   publication call after their own guard or head lock.
2. `authorizeOrdinary` drops its explicit guard acquisitions; admission
   remains governed by `requireOrdinaryAdmission` (drain row) plus the head
   row.
3. `findHeadForUpdate`/`requireHeadForUpdate` no longer route through
   `lockSessionHead` (which drags `lockTenant`); they lock the head row
   directly and keep `requireLive`. `lockSessionHead`/`lockTenant` remain for
   publication-domain owners (publish, receipts, retirement, retention).
4. `blockRecovery` keeps its current shape minus the inherited tenant row.

What admission paths keep: `authorizeLifecycle` (claim protocol),
`acquireWriter`'s migration admission (`WorkspaceMigrationAdmission.requireSessionOpen`;
this change removed its own `lockTenant`, and the placement guard is now
taken explicitly and bounded by the caller) **and its publication tenant CAS
row** — while a Session has no head row, that row is
the only ordering point against an in-flight delete/retire of the same
Session (the `writerAcquisitionAndRetirementSerializeEvenWithoutAnExistingHead`
contract), so `acquireWriter` keeps both, bounded per D2 — and every
publication-lane writer operation (`publishToolResult`, publication receipt
commits, retirement).

### D2. Bound every remaining hot-path guard acquisition

Admission paths that legitimately fence (`acquireWriter` migration
admission, `authorizeLifecycle`, lifecycle-stamped commits/seals via
`checkLifecycleWriter` with an authority) acquire the guards with a short
statement timeout — using the existing
`JdbcRuntimeBindingRepository.lockPlacementDomain(connection, tenant,
timeoutSeconds)` overload and an equivalent bounded variant for
`ToolPublicationRetentionStore.lockTenant`:

- **Guard acquisition budget: 5 s** per statement on hot paths.
- A timeout surfaces as a fast data-access failure mapped to HTTP 503
  `tenant_guard_contended` (lock wait), not a silent long wait.
- The harness client's existing `uncertain` classification treats 5xx as
  retryable; with server-side waits now ≤5 s, a 3-attempt retry fits in one
  client budget for transient contention, and persistent contention degrades
  to the named error instead of the 30 s freeze. On the covered lanes
  `innodb_lock_wait_timeout` (50 s) no longer binds before the client
  (30 s) does.
- The covered lanes include a CSI-pinned Session's continuation check, whose
  placement and publication acquisitions are the first tenant-wide waits on
  renew, commit and recovery state, and the Turn submit admission.

### D3. Restructure the known unbounded holders

- `requireIdleJournal` (`WorkspaceLifecycleStore`): the journal scan first
  runs without `FOR UPDATE`. The existing head-row `FOR UPDATE` taken first
  is the per-Session fence — every writer appends revisions only behind
  it — so no revision can commit mid-scan, and the head row stays the only
  serialization point for the idle check. The unlocked scan is a snapshot
  read, though, and the enclosing lifecycle transaction may have pinned its
  REPEATABLE READ snapshot with plain reads (`beginWorkspaceLifecycle`'s
  replay and open-operation reads) before the head lock was granted. A
  revision committed in that window is invisible to the scan. The scan is
  therefore trusted only when its highest revision reaches the locked
  head's `journal_revision`; otherwise it is repeated as a locking read,
  which reads the journal as committed now, and the verdict (`turn_active`
  or admission) is taken from that. A journal that falls short of its own
  head even then fails closed with `workspace_lifecycle_journal_unverified`.
  The first version of this change refused whenever the snapshot was
  stale, which answered 409 for an idle Session whose last Turn had just
  committed (corrected in the 2026-10-16 review round).
- Lifecycle recovery transactions (`recoverEffects`/`saveEffects`) keep
  their lock set in this change; with D1 their tenants' ordinary traffic no
  longer queues on those guards, and bounding their window is follow-up
  (listed in Follow-ups).

### D4. Harness surface (TypeScript)

When every store retry in a turn is exhausted by transport/5xx failures, the
turn must end with a named reason instead of journal-frozen silence:

- `packages/cli/src/serve/hosted-harness-session.ts`: in the prompt route's
  settlement path, store-unavailability failures settle the turn as
  `turn_result` `state: 'error'` with
  `stopReason: 'managed_session_store_unavailable'` (and the same code in the
  SSE/stderr line). If the `turn_result` itself cannot be committed (write
  path latched), the daemon keeps the named failure in memory and surfaces it
  via `/session/:id/status` (`recoveryBlocked` stays per-session; the
  existing behavior sets `session.blocked`), as the `recoveryReason` field of
  the same JSON payload while the block holds.
- No change to the store client's timeout/retry budgets; the D2 change is
  what makes those budgets meaningful again.

### D5. Witness integration test

New integration test `ManagedSessionGuardConvoyIT` in `managed-agent-server`
(same fixture family as the existing `*MySqlIT` suites). It needs a
`jdbc:mysql:` URL and runs against MySQL 8.4 or MariaDB 10.11. It is not a
pull-request gate: since #14205 the Java database lanes run only on a daily
schedule and on manual dispatch, so its mutation guarantee is manual.

1. Create two sessions on one tenant; mark one `recovery_blocked` (head row
   update, mirroring the reproduction fixture).
2. Open an external JDBC transaction that locks both guard rows
   (`UPDATE ... WHERE tenant_id = ?`).
3. **Witness assertions:** with the hold in place, the other session's
   `acquireWriter` (migration-admission case) fails with the named error
   within one guard budget (asserted below a fixed 15 s ceiling, so raising
   the budget past it turns the witness red); `renewWriter`, `authorizeOrdinary`,
   `blockRecovery` (D1-decoupled cases) complete normally, while the
   ordinary record `commit` fails fast with the same named error (it
   re-acquires the placement guard bounded since R2); the blocked row's
   `recovery_status` is unchanged.
4. Release the hold; the previously named-failing operation retries to
   success.
5. The transitions the fix removes are inverted as mutation proof: restoring
   the unconditional `checkLifecycleWriter` acquisition makes the D1 cases
   blocks again (the test's fixture therefore hard-codes the expected call
   matrix).

For `requireIdleJournal`,
`WorkspaceLifecycleMySqlIT#idleJournalCheckReadsARevisionItsSnapshotCannotSee`
pins a REPEATABLE READ snapshot, commits a revision that leaves a Turn
pending from another connection, and asserts `turn_active` both from the
idle check directly and through `beginWorkspaceLifecycle`;
`#idleJournalCheckFailsClosedOnAJournalShortOfItsHead` asserts
`workspace_lifecycle_journal_unverified` for a journal behind its head.
That the idle check completes under an externally held guard is not
witnessed.

## Risks and mitigations

- **R1 — migration-admission regression (D1 does not touch it, D2 bounds
  it).** `acquireWriter` keeps the placement guard for
  `requireSessionOpen`, now taken explicitly and bounded before it;
  the 5 s budget can only convert a previously-freezing race into a named 503. Migration ITs must stay green (`WorkspaceLifecycleMySqlIT` family).
- **R2 — lifecycle protocol fencing.** Lifecycle-stamped writers keep the
  full lock set and claim checks; `authorizeLifecycle` unchanged in
  semantics. Covered by the existing lifecycle suites plus the witness's
  lifecycle arm.
- **R3 — publication domain ordering.** D1 keeps publication-lane locking
  via explicit `lockTenant` in the publication paths; the witness asserts
  the publication commit lane is unaffected (`ToolPublicationStoreTest`
  family must stay green; the publication commit goes through
  `publicationRequest` → `ToolPublicationStore`'s own locks).
- **R4 — `requireIdleJournal` unlocked read shows a stale pending set.**
  Mitigated by comparing the scan's highest revision with the locked
  head's: a scan that stops short is repeated as a locking read, and only a
  journal that still falls short of its head fails closed (blocked, not
  admitted).
- **R5 — MySQL/MariaDB dialect.** The bounded acquisition uses statement
  query timeouts (Connector/J), not `NOWAIT`/vendor clauses; measured on
  MariaDB 10.11.18 (the image of the scheduled CI lane) and MySQL 8.4.7.
- **R6 — behaviour under pathological persistent holds.** A hold longer than
  the retry budget still cannot complete (no design can without removing the
  row); the contract this design ships is: transient contention → completes;
  unrelenting contention → fast named failure, never a silent freeze, and
  never a cross-Session queue on rows the Session does not own (D1).

## Validation plan

1. Unit/integration suites of `managed-agent-server` and `runtime-broker`
   (Maven, JDK 21): lifecycle, publication, migration, credential, and
   store-binding suites must be green (`mvn verify` for the two modules).
2. The new witness `ManagedSessionGuardConvoyIT` runs in the
   `mysql-integration` profile. Pull requests no longer run it (#14205 moved
   the Java database lanes to a daily schedule and manual dispatch), so
   merge evidence is a dispatched `sdk-java.yml` run or an attached
   `mvn -Pmysql-integration -Dit.test=ManagedSessionGuardConvoyIT`
   transcript.
3. TypeScript: `packages/core` tests for the HTTP session store (existing),
   `packages/cli` hosted-harness suites; new unit tests for the named
   settle path.
4. E2E re-run of the reproduction script (driver kept under
   `.qwen/issues/13800-repro/`): guard-hold variant now yields named-fast
   failures or successful turns, never the 30 s freeze.
5. Physical-rig re-acceptance for #13532 stays an independent follow-up and
   belongs to #13800's W2 (#13816), not to this change.

## Acceptance criteria

1. `ManagedSessionGuardConvoyIT` green in a dispatched or local
   `mysql-integration` run; with the D1 call sites reverted it turns red
   (mutation-checked during development).
2. All existing managed-agent Java suites green (no semantic drift in
   lifecycle/publication/migration lanes).
3. The reproduction E2E guard-hold variant no longer freezes a fresh
   Session's create or turn on the covered lanes; failures, when they occur
   under sustained holds, carry the named code.
4. `recovery_blocked` marker remains narrated accurately: the blocked
   Session keeps reporting its own blocked state (witness step 3 assertion).

## Review corrections (R1, 2026-10-12)

The first review round proved that the decoupling itself introduced three
defects; each is fixed in this change and pinned by a witness.

### F1. The replay snapshot is only allowed to be pinned after the head lock

Removing the per-Session `lockSession` from `findHeadForUpdate` left a
plain read (`requireLive`) as the transaction's first consistent read.
Under REPEATABLE READ that read pins the snapshot _before_ the head row
lock waits: a duplicate commit released by this lock still evaluated a
stale snapshot in `findTransactionByCommand` and fell into
`validateHead`, converting an idempotent retry into a
`managed_session_head_conflict` 409. `findHeadForUpdate` now executes the
head `SELECT ... FOR UPDATE` first; the snapshot-dependent reads follow
under the held lock. Witness:
`ManagedSessionGuardConvoyIT#duplicateCommitReplaysOnceTheWinnerReleasesItsGuards`
(renamed in R2 — the retry now parks at the commit's bounded placement
guard before the head lock).

### F2. Boundedness must sit at each lane's first acquisition, not downstream

The publication lanes reach the tenant guard before
`lockPublicationWriter`: `applyLocked` executed its own tenant
INSERT/SELECT inline, `prepareAdmission` and `commitReceipt` each called
their own lock helpers (and the receipt path first took the placement
guard unbounded), and `grants.lockOriginalSettledResult` plus the
retention read-lease opener touched the CAS row ahead of them. All first
acquisitions on the apply/admission/receipt lanes and the lease opener
(`lockSessionHead`) now run bounded with the shared
`tenant_guard_contended` mapping. Witness:
`ManagedSessionGuardConvoyIT#heldTenantGuardsBoundPublicationLaneEntries`.

Native producer and dispatch entries also bound their first placement
acquisition in `lockOriginal`, before locking the original binding and
execution. They use the same transaction connection and named-failure mapping;
the grant checks and CSI path retain their existing behavior. The witness
holds placement while calling `verifyDispatch` and producer `finish`, then
verifies both succeed after release. This closes #14393 A.1. The bound is per
acquisition statement; the earlier lifecycle acquisition gap remains tracked in
#14393 A.3.

After acquiring the tenant row, `lockSessionHead` also bounds the root UPSERT,
root locking read and head locking read to five seconds per statement. These
waits share the `tenant_guard_contended` mapping, including lock-wait timeout
1205, so one Session's writer cannot hold the publication guard for the database's
default lock-wait window. Existing shorter statement or transaction timeouts
remain shorter. The ordinary root-only writer path keeps its existing wait
settings and deadlock mapping. The witness
`ManagedSessionGuardConvoyIT#heldSessionRowsBoundRetentionReads` checks held root
and head rows and successful reads after release. This covers #14393 A.2.

The A.3 follow-up in #14393 bounds only the first publication CAS acquisition
at the reported snapshot expiry, projection-body collection, tool-result
claim/settlement, Session-resource claim/page and lifecycle completion sites.
A timeout uses the existing `503 tenant_guard_contended` mapping and rolls
back the current transaction. CSI checks, placement and Session/event-stream
waits retain their existing behavior; this does not bound a whole operation.
Lifecycle publication-entry witness:
`ManagedSessionGuardConvoyIT#heldPublicationGuardBoundsLifecycleCompletion`.
Collector-entry runtime witnesses remain pending.

### F3. Writer acquisition keeps placement before the drain fence

With the ordinary branch of `checkLifecycleWriter` early-returned,
`acquireWriter` read the drain fence (`requireOrdinaryAdmission`) before
acquiring the placement guard. The drain `SELECT ... FOR UPDATE` takes a
next-key/gap lock when no row exists; the begin side takes placement
first and only then inserts the drain row, so writer-vs-lifecycle formed
a cycle that InnoDB dissolved by killing the writer (surfacing a 1213
through the bounded path instead of the correct 409). `acquireWriter` now
takes the bounded placement guard before reading the drain fence.
Witness:
`ManagedSessionGuardConvoyIT#writerAcquisitionOrdersPlacementBeforeTheDrainFence`.

## Review corrections (R2, 2026-10-12)

The two Java/MySQL CI lanes went red after the R1 push; SHA-level
reproduction at the pre-R1 head (`134ff291da`) shows all three failures
trace to D1 itself rather than the R1 changes. The two mechanisms are
fixed here and pinned by witnesses.

### F4. Ordinary record commits still hold the bounded placement guard

D1 left `commit()` acquiring no guard at all: the ordinary branch of
`checkLifecycleWriter` early-returns, and nothing else on the path
touched `qwen_runtime_placement_guard`. That row is the only
serialization point a lifecycle admission
(`INSERT INTO qwen_runtime_placement_guard`) has against an in-flight
record commit, so
`ManagedAgentMySqlIT#serializesDeletionBehindTheRecordCommit` observed
the DELETE admission race past a commit still parked on the record row.
`commit()` now re-acquires the placement guard right after
`checkLifecycleWriter`, through the same bounded wrapper — the
serialization returns, and a held row still degrades to
`tenant_guard_contended` within the hot-path budget. The convoy
witness's `committed` arm flips with it:
`heldTenantGuardsDoNotWedgeUnrelatedSessions` now expects that commit to
fail fast with the named 503 inside the bound instead of completing.
Holding the row through the record commit is exactly the serialization
the fence needs; acquiring it bounded is what keeps a held guard a named
failure instead of the original wedge.

### F5. `acquireWriter`'s first consistent read is pinned after the CAS wait

In the R1 order `WorkspaceMigrationAdmission.requireSessionOpen` — a
plain SELECT and this transaction's first consistent read — ran before
the CAS acquisition, so the REPEATABLE READ snapshot was pinned before
the wait on `qwen_tool_publication_tenant`; a retirement committed
underneath that wait stayed invisible to the later `requireLive`. The
retention harness surfaced `managed_session_not_writable` instead of
`tool_output_session_retired`
(`WorkspaceSessionRetentionMySqlIT#retirementSerializesQueuedWriterAndProjectionCompletion`),
and the O4 gate's late writer was authorized where rejection was
required
(`O4MySqlGate#writerReallyWaitsOnRetirementTransactionAndThenIsRejected`).
`acquireWriter` now runs the bounded placement acquisition, the bounded
CAS acquisition, and only then its consistent reads, so the snapshot is
pinned after the waits and sees the winner's commit. The invariant is that
every plain read on this lane runs after those waits: today the first is
the CSI runtime-marker probe (two plain `SELECT`s on `ma_runtime_slot` and
`ma_runtime_binding`, after the root lock), then `requireSessionOpen`.
Moving either above the waits restores the defect.

## Schema consolidation (#14069, 2026-10-14)

The 32-table baseline (#14069) landed while this change was in review.
The sections above keep the pre-consolidation table names. On the merged
baseline:

- `qwen_runtime_placement_guard` and `qwen_tool_publication_tenant` are
  the `runtime_placement` and `output_publication` domains of
  `ma_tenant_guard`, still one row per tenant and domain. D2's bounded
  acquisitions apply to both domains unchanged.
- The journal head and the Harness drain row are now one `ma_session_head`
  row per Session, so the drain admission read and the head lock take the
  same row.
- The baseline inserts a per-Session `ma_session` root row between the
  tenant guard and the head (`lockSessionHead`), and a record commit locks
  that root again after the head (`isBeingDeleted`). Ordinary writers keep
  the root: `findHeadForUpdate` locks root, then head, and drops only the
  tenant-wide row. `authorizeOrdinary` locks the root before its drain
  read, and `ensureSessionRoot` takes the root exclusively before its
  `INSERT IGNORE`. Every writer that runs without the tenant guard
  therefore locks root before head, and none upgrades a shared lock behind
  another writer's exclusive request.
- The baseline added `requirePhysicalSessionOpen` (placement plus physical
  storage admission) to commits, tool-result publication and the
  publication writer. Its placement acquisition goes through the same
  bounded wrapper.
- The baseline's heartbeat lock (`requireHeartbeatHead`) relied on the
  tenant fence that `checkLifecycleWriter` used to hold. It now locks the
  head before `requireLive`, the order `findHeadForUpdate` uses.
- `commit()` keeps the baseline's order: the replay lookup runs before
  the head lock. A duplicate still replays because both commits take the
  bounded placement guard first, so the loser's first consistent read
  comes after the winner commits.
- `requireNoLifecycleClaim` reads `ma_operation` by Session scope key and
  the lifecycle kinds (`CLOSE`, `ARCHIVE`, `DELETE`). Unlike the pre-PR
  probe, it does not join the drain row. It fences as soon as a v2
  lifecycle operation exists, including the window before the drain row
  carries that operation's id. No code path clears a drain row's
  operation or reopens its phase, so wherever the two predicates differ
  the drain fence refuses the write anyway; only the error code differs.
- On the tool-result lane the claim check also runs for lifecycle
  callers. That keeps the baseline's behavior: its second
  `checkLifecycleWriter(…, null)` call fenced v2 Sessions for every
  caller.

## Review corrections (2026-10-15)

The review of `f668634b96` found lanes that still waited unbounded or
skipped a fence:

- A CSI-pinned Session's continuation check took placement with a 10 s
  timeout and the publication row with none, outside the named mapping, so
  a held publication row froze renew, commit and recovery state for the
  full 50 s lock wait. Both now go through the bounded wrapper. Witness:
  `ManagedAgentCsiMutationMySqlIT#pinnedSessionBoundsItsTenantGuards`.
- The Turn submit admission (`insertTurnCommand`) took the placement row
  with no timeout; it is now bounded and named. Witness: the Turn submit
  arm of `heldTenantGuardsDoNotWedgeUnrelatedSessions`.
- A duplicate ordinary `commit()` replayed against a v2-claimed Session,
  because the relocated claim fence ran only after the replay branch. The
  replay branch now runs it too. Witness:
  `WorkspaceProfileLifecycleTest#duplicateOrdinaryCommitIsFencedByAVersionTwoClaim`.
- The CSI runtime-marker probe's two plain reads now carry the guard
  class's 10 s statement timeout, since plain reads still wait on metadata
  locks.

## Review corrections (2026-10-16)

The review of `e1ba36ad4b` found:

- **A deadlock at a bounded acquisition could escape the named mapping.**
  The bounded wrapper caught `CannotAcquireLockException` and
  `QueryTimeoutException`. Through this stack's default translator a
  MySQL/MariaDB 1213 (SQLState 40001) arrives as
  `CannotAcquireLockException` (observed on MariaDB 10.11.18 by the witness
  below), so it was named; the error-code translator reports it as
  `DeadlockLoserDataAccessException`, a sibling class, which was not. The
  wrapper now catches the whole `PessimisticLockingFailureException`
  family. Witness: `ManagedSessionGuardMappingTest`.
- **The pinned CSI cycle's other victim was unnamed.** A pinned Session's
  continuation takes its root and then the tenant guards (D1 keeps
  ordinary Sessions off the guards, so it cannot take them first), while
  every other lane on that Session, retention reads and collectors among
  them, takes the guards and then the root. InnoDB may roll back either
  side. The continuation's waits were already named; a root wait behind a
  guard (`lockSessionRoot`, the legacy `isPrivate` probe) now names a 1213
  `tenant_guard_contended` too, recognized by its vendor code so both
  translators' shapes match. Moving the retention side to root-first
  instead was tried and rejected: publication, lifecycle authorization and
  writer acquisition take the tenant CAS row before the root on every
  Session, so it formed a cycle on ordinary Sessions as well. Witnesses:
  `ToolPublicationLockOrderMySqlIT#pinnedSessionDeadlockNamesTheRetentionVictim`
  and `#ordinaryPublicationBesideARetentionOwnerDoesNotDeadlock`. Collectors
  skip pinned Sessions in their candidate queries, so in practice the
  retention side of this cycle is a request-path retention read.
- **`requireIdleJournal` refused legitimate admissions** when the enclosing
  transaction's snapshot predated the head lock (D3 above, corrected).
- **Client contention budget.** A guard retry runs inside the commit's
  shared contention deadline, but a call's first attempt keeps its own
  request budget, so a restart earned after a stall or an early contended
  refusal is not issued already expired. A contended refusal followed by a
  deadline abort keeps the guard's name and reports the shared budget as
  spent, which stops the outer restarts; the publication commit lane goes
  through the same retry engine as the transaction lane.

## Follow-ups (not in this change)

- Bound the lifecycle recovery transactions' guard window (snapshot-then-
  verify for `recoverEffects`/`saveEffects`/`verifyCompletion`).
- Bound or scope the remaining `ManagedAgentStore` acquisitions of the
  placement row (`WorkspaceMigrationAdmission.lockTenant` and
  `WorkspaceLifecycleStore.lockPlacement` without a timeout): Session
  creation and child Sessions, rename, mutation, close/archive/delete
  admission, cwd change and task-cancel operations. None is per-turn; each
  still waits up to `innodb_lock_wait_timeout` behind a long holder.
- Bound the remaining `output_publication` acquisitions:
  `ManagedAgentStore.beginLifecycle` (the close/archive/delete admission of a
  lifecycle-protocol Session) and the o3-backfill pair in
  `ManagedToolResultStore`. A user-facing close admission can still wait up to
  `innodb_lock_wait_timeout` on a held `ma_tenant_guard` row.
- Materializer gap tripwire quarantine (audit §B2; mark the poisoned
  consumer progress dead instead of a 10 Hz permanent exception).
- Renewal-scheduler isolation baseline (reproduction hypothesis H2) —
  currently unresolved; revisit if rig evidence ever implicates it.
- The stuck `dispatch_started` `child_run` record (filed separately per
  #13800's own scoping note).

## Open questions

- Whether `innodb_lock_wait_timeout` should additionally be lowered
  server-wide for the store pool (out of scope here; D2's per-statement
  budget achieves the bounded shape without a global knob).
