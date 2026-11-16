# Publication lanes without tenant-wide guards

[English](2026-11-04-managed-publication-tenant-guards.md) | [简体中文](2026-11-04-managed-publication-tenant-guards.zh-CN.md)

Status: C1 and C2 implemented; C3 is designed in
[publication lanes without the placement guard](2026-11-04-managed-publication-placement.md).

## Problem and baseline state before C1/C2

Tool output publication (reserve, upload, verify, finish, admission, receipt,
renew, quarantine) took two tenant-wide rows on every call before C1/C2:

- **Placement** (`runtime_placement`), first, through
  `lockPublicationPlacement` / `lockStagedPlacement`, the publication writer
  (`lockPublicationWriter`) and the CSI continuation.
- **Publication** (`output_publication`), next, through
  `ToolPublicationRetentionStore.lockTenant` in `ToolPublicationStore`,
  `ToolPublicationDataStore`, `ToolPublicationAdmissionStore` and
  `ManagedToolResultStore`.

Every Session of a tenant that published output therefore ran its publication
steps one at a time, behind Runtime placement, storage work, migration,
retention and collection. Journal commits, Turn admission and the Session
commands had already stopped taking either row. C1/C2 below remove the
publication guard from ordinary lanes; placement remains, while CSI originals
and lifecycle-authority receipts keep the publication guard.

## Baseline guard responsibilities

| Guard       | Protects                                                                                                                                                                                                                  | Holder on the other side                                                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placement   | The publication's original Runtime binding stays referenced: the Runtime retention sweep deletes a binding only after `executionReferenced` and `bindingReferenced` find no `ma_output_capture` or execution rows for it. | `JdbcRuntimeRetention.visit` (placement, slot, binding `FOR UPDATE`, reference reads under READ COMMITTED).                                          |
| Publication | 1. Tenant byte quota: `reserve` fences expired reservations, sums the tenant's held bytes and inserts a reservation. 2. Lock order between publication lanes and collection.                                              | `reserve` on other Sessions; `SessionResourceCollectionCollector` and the publication collector (tenant, private head, publication, public Session). |

Only `reserve` changes tenant totals upward. Upload, verify, finish, admission
and receipt move bytes within an existing reservation (`*_used_bytes` never
exceeds `*_held_bytes`), and collection only releases bytes.

Collection and retention take the publication guard, then the Session root
and head (`lockGenericSession`), then publication and operation rows. Ordinary
lanes take placement, the publication guard, then the root and head
(`lockPublicationWriter`), then publication rows: the same order below the
guard. Only CSI lanes lock the publication row before the root
(`lockOriginalSettledResult` returns early for an ordinary Runtime).

## Proposal

Three increments, each its own PR, each with MySQL lock-wait evidence.

### C1. Tenant quota without a lock

The tenant byte limit (`tool-publication.tenant-bytes`) and the active-capture
limit are protective caps, so a bounded overshoot is accepted. The ordinary
apply lane (`ToolPublicationStore.applyLocked`: reserve, renew, fence,
no-start release) and its publication writer no longer take
`output_publication`.

- The lane runs at READ COMMITTED, so each sum sees every reservation
  committed before it. Two reservations of different Sessions can overlap
  between their sums and commits and pass the tenant limits together. The
  overshoot is at most the overlapping reservations times one allocation each
  (capture size plus 4,784,128 bytes); it is held bytes, which shrink to used
  bytes at finish, and later reservations are refused until bytes are freed,
  so it does not accumulate.
- The Session byte limit stays exact: reservations of one Session serialize
  on its root, which the publication writer locks before the sums.
- Expired reservations are still fenced across the tenant before the sums.
  This update uses the hot-path statement timeout and named
  `tenant_guard_contended` mapping, so an expired row held by a collector
  cannot park the placement owner until the database's default lock timeout.
- The lane takes Session root and head before the publication row, the order
  collection uses, and never takes the publication guard after the root, so
  it closes no cycle with retention (publication guard, root, head).
- CSI publications keep the guard, as their retirement and continuation paths
  expect.

Considered and rejected: a dedicated `publication_quota` guard, or a counter
row with a conditional update. Either keeps tenant-wide serialization of every
reservation for an exact cap that a protective limit does not need; the
counter row would also need updates at every held-byte shrink.

### C2. Other ordinary publication lanes and read leases

Apply C1 to the ordinary producer (dispatch, upload, verify, finish),
admission and receipt lanes and to the tool-result projection worker: skip
the publication guard and keep root, head, publication rows. No lane changes
its order. CSI originals keep the guard, and so does a receipt whose journal
commit carries lifecycle authority, because that commit takes the guard
itself.

The projection worker's `claim`, `admitsLegacyProjection` and `complete`
follow the same guard-free order. Admission joins completion's transaction;
completion reuses its root and head locks and rechecks private-Session refusal
without acquiring the publication guard.

Read leases (`ToolPublicationRetentionStore.read`) no longer take the guard
either. Every check that can delete what a lease protects (the publication,
Session resource and projection collectors) holds the Session's root and
head, and retirement updates the root; a lease taken under that root and
head therefore excludes them on its own. Lease renewal also skips the guard:
it locks the root and rechecks retirement generation and expiry before
extending the lease. This also removes the guard from evidence reads after a
lane's root (the cycle C1 found) and from Artifact and journal resource reads.

Quarantining a corrupt publication object also locks only that Session's
root, head and publication row. Quarantine changes no tenant-wide capacity
and keeps the retained-publication state check, so the same ordering works
both independently and inside a read transaction that already holds the
root. Other retained-publication mutations keep their guard-first entry.

The audit is a test: with the guard held on another connection, reserve,
dispatch, finish, admission and receipt must all complete
(`ManagedSessionGuardConvoyIT`); a lane that took the guard after its root
would stall there. A separate witness backdates an unexpired read lease into
the renewal window while the guard is held and requires the lease's expiry
to advance inside the transaction that holds its root.
A quarantine witness requires its Session-local state changes to complete
under the same held guard. An expired-reservation witness holds a different
Session's expired capture row, checks the bounded named failure, then releases
the row and checks that a fresh reservation fences it successfully.
A complete projection witness in `ToolPublicationLockOrderMySqlIT` holds the
guard on another connection and requires the ordinary completion to publish
its result, artifacts and event. A Session pinned after claim must still refuse
completion without changing its leased operation or publishing those outputs.

Capacity accounting lives in a separate persistence helper, and admission
entry locking lives with the grant store. This keeps both existing publication
stores below their class-size ratchets; the ceilings are lowered after the
extraction. The facade inventory includes the intentional guard-selecting
writer overload without changing its transaction attributes.

Not covered: the native journal snapshot writer, whose build transaction
locks resource rows before the Session; its order needs its own analysis.

### C3. Placement

See [publication lanes without the placement guard](2026-11-04-managed-publication-placement.md).
The binding-before-root sketch first proposed here does not hold: placement
owners lock the binding and the Session root in both orders.

## Open questions

1. The native journal snapshot writer still takes the guard (see C2).

## Risks

- Removing tenant serialization exposes missing-key gap locks, order cycles
  and stale snapshots it hid; each increment needs independent MySQL
  connections in its tests, not H2 alone.
- Tenant byte and active-capture limits can be exceeded briefly by
  concurrent reservations of different Sessions (C1).

## Verification and acceptance

Per increment: reproduce the targeted wait on the baseline, then show the lane
completes while the removed guard is held; run concurrent publications of
different Sessions of one tenant on MySQL with no deadlock; run collection,
retention sweep and quota exhaustion against concurrent lanes; pass the
publication, retention, collection and lock contract suites including the
MySQL profiles in CI.
