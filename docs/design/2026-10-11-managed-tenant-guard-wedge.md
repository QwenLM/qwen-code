# Bounded tenant-guard coupling for Managed Session traffic

[English](2026-10-11-managed-tenant-guard-wedge.md) | [简体中文](2026-10-11-managed-tenant-guard-wedge.zh-CN.md)

- Status: proposal
- Issue: [#13800](https://github.com/QwenLM/qwen-code/issues/13800) — a
  `recovery_blocked` Session wedges later turns of other Sessions on the same
  daemon
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
but not the mechanism; the issue's work items W1 (name the mechanism) and W2
(bound the blast radius) are what this design implements.

## Mechanism (W1)

The Managed Session store takes two per-tenant InnoDB record locks on the hot
write path of **every** Session, unconditionally:

1. `qwen_runtime_placement_guard` (one row per tenant), acquired in
   `JdbcRuntimeBindingRepository.lockPlacementDomain` via
   `WorkspaceLifecycleStore.lockPlacement` and
   `WorkspaceMigrationAdmission.lockTenant`.
2. `qwen_tool_publication_tenant` (one row per tenant), acquired in
   `ToolPublicationRetentionStore.lockTenant`.

The current call matrix in `ManagedSessionStore`:

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
`checkLifecycleWriter` performs **no validation at all** — it only takes the
two locks. Any transaction that holds either row longer than the harness
client's 30-second request timeout freezes every Session of the tenant whose
next store call arrives meanwhile, because:

- InnoDB lock wait (default 50 s) exceeds the client timeout (30 s);
- each timed-out call is retried, and the server-side statement may still be
  queued when the next retry arrives, so client wait and server wait
  accumulate;
- a failed `acquireWriter` can leave a head row inserted but unclaimed, so
  later creates of the same session id answer `409
managed_session_writer_conflict` until the dead writer lease expires.

### Reproduction (W1 evidence)

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

The physical rig's specific long-lived holder is not identified — the rig
captured no InnoDB lock evidence, and the reproduction deliberately does not
guess it. The demonstrated defect is the coupling itself: **no tenant-wide
lock may gate the per-turn store traffic of sessions it does not belong to.**
Any long hold, whatever produces it, must leave other sessions' turns either
completing or failing fast with a named reason.

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

- W1-G1: A fresh Session's ordinary turn **completes** on a daemon whose
  tenant contains a `recovery_blocked` Session and whose lifecycle/recovery
  work is churning — i.e. ordinary traffic no longer queues behind
  tenant-wide guard rows it does not need. (Issue W2 exit check.)
- W1-G2: When a guard a hot path genuinely needs is contended beyond a short
  budget, the call fails **fast with a named reason** instead of a 30 s
  client timeout; the reason is visible to the caller and, for turns, model-
  visible rather than a silent freeze. (Issue W2.)
- W1-G3: Guard-holding transactions never hold the rows across unbounded
  work; the worst known holders are restructured to snapshot unlocked and
  verify under a short re-lock.
- W1-G4: A witness integration test pins the geometry: red when the coupling
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
   stays: the head row `FOR UPDATE` serializes writers of one Session; the
   drain-row fence (`requireOrdinaryAdmission`, `lifecycleFenced`,
   `lifecycleProtocolFenced`) keeps the ordinary-vs-lifecycle barrier.
2. `authorizeOrdinary` drops its explicit guard acquisitions; admission
   remains governed by `requireOrdinaryAdmission` (drain row) plus the head
   row.
3. `findHeadForUpdate`/`requireHeadForUpdate` no longer route through
   `lockSessionHead` (which drags `lockTenant`); they lock the head row
   directly and keep `requireLive`. `lockSessionHead`/`lockTenant` remain for
   publication-domain owners (publish, receipts, retirement, retention).
4. `blockRecovery` keeps its current shape minus the inherited tenant row.

What admission paths keep: `authorizeLifecycle` (claim protocol),
`acquireWriter`'s migration admission (`sessionAdmission`) **and its
publication tenant CAS row** — while a Session has no head row, that row is
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
  to the named error instead of the 30 s freeze. `innodb_lock_wait_timeout`
  (50 s) no longer binds before the client (30 s) does.

### D3. Restructure the known unbounded holders

- `requireIdleJournal` (`WorkspaceLifecycleStore`): drop the journal-wide
  `FOR UPDATE` scan. The existing head-row `FOR UPDATE` taken first is the
  per-Session fence — every writer appends revisions only behind it — so the
  ordered read is already consistent; no revision can commit mid-scan. The
  head row stays the only serialization point for the idle check.
- Lifecycle recovery transactions (`recoverEffects`/`saveEffects`) keep
  their lock set in this change; with D1 their tenants' ordinary traffic no
  longer queues on those guards, and bounding their window is follow-up
  (listed in Follow-ups).

### D4. Harness surface (W2, TypeScript)

When every store retry in a turn is exhausted by transport/5xx failures, the
turn must end with a named reason instead of journal-frozen silence:

- `packages/cli/src/serve/hosted-harness-session.ts`: in the prompt route's
  settlement path, store-unavailability failures settle the turn as
  `turn_result` `state: 'error'` with
  `stopReason: 'managed_session_store_unavailable'` (and the same code in the
  SSE/stderr line). If the `turn_result` itself cannot be committed (write
  path latched), the daemon keeps the named failure in memory and surfaces it
  via `/session/:id/status` (`recoveryBlocked` stays per-session; the
  existing behavior sets `session.blocked`).
- No change to the store client's timeout/retry budgets; the D2 change is
  what makes those budgets meaningful again.

### D5. Witness integration test (W1 exit check)

New MySQL-backed integration test
`ManagedSessionGuardConvoyIT` in `managed-agent-server` (same fixture family
as the existing `*MySqlIT` suites):

1. Create two sessions on one tenant; mark one `recovery_blocked` (head row
   update, mirroring the reproduction fixture).
2. Open an external JDBC transaction that locks both guard rows
   (`UPDATE ... WHERE tenant_id = ?`).
3. **Witness assertions:** with the hold in place, the other session's
   `acquireWriter` (migration-admission case) fails within ≈ guard budget
   with the named error, and `renewWriter`, `commit`, `authorizeOrdinary`,
   `blockRecovery` (D1-decoupled cases) complete normally; the blocked row's
   `recovery_status` is unchanged.
4. Release the hold; the previously named-failing operation retries to
   success.
5. The transitions the fix removes are inverted as mutation proof: restoring
   the unconditional `checkLifecycleWriter` acquisition makes the D1 cases
   blocks again (the test's fixture therefore hard-codes the expected call
   matrix).

`requireIdleJournal` restructuring is covered by an assertion comparing
journal reads under an externally held guard: the idle check completes for a
session with an unlocked head row.

## Risks and mitigations

- **R1 — migration-admission regression (D1 does not touch it, D2 bounds
  it).** `acquireWriter` keeps the placement guard for `sessionAdmission`;
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
  Mitigated by the head-revision re-verification under the head lock; a
  mismatch fails closed (blocked, not admitted).
- **R5 — MySQL/MariaDB dialect.** The bounded acquisition uses statement
  query timeouts (Connector/J), not `NOWAIT`/vendor clauses; both the CI
  MySQL lane and the MariaDB rig path work.
- **R6 — behaviour under pathological persistent holds.** A hold longer than
  the retry budget still cannot complete (no design can without removing the
  row); the contract this design ships is: transient contention → completes;
  unrelenting contention → fast named failure, never a silent freeze, and
  never a cross-Session queue on rows the Session does not own (D1).

## Validation plan

1. Unit/integration suites of `managed-agent-server` and `runtime-broker`
   (Maven, JDK 21): lifecycle, publication, migration, credential, and
   store-binding suites must be green (`mvn verify` for the two modules).
2. The new witness `ManagedSessionGuardConvoyIT` runs in the MySQL lane.
3. TypeScript: `packages/core` tests for the HTTP session store (existing),
   `packages/cli` hosted-harness suites; new unit tests for the named
   settle path.
4. E2E re-run of the reproduction script (driver kept under
   `.qwen/issues/13800-repro/`): guard-hold variant now yields named-fast
   failures or successful turns, never the 30 s freeze.
5. Physical-rig re-acceptance for #13532 stays an independent follow-up; the
   W2 exit check is demonstrated locally by witness + E2E.

## Acceptance criteria

1. `ManagedSessionGuardConvoyIT` green; with the D1 call sites reverted it
   turns red (mutation-checked during development).
2. All existing managed-agent Java suites green (no semantic drift in
   lifecycle/publication/migration lanes).
3. The reproduction E2E guard-hold variant no longer freezes a fresh
   Session's create or turn; failures, when they occur under sustained
   holds, carry the named code.
4. `recovery_blocked` marker remains narrated accurately: the blocked
   Session keeps reporting its own blocked state (witness step 3 assertion).

## Follow-ups (not in this change)

- Bound the lifecycle recovery transactions' guard window (snapshot-then-
  verify for `recoverEffects`/`saveEffects`/`verifyCompletion`).
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
