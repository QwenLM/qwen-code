# Publication lanes without tenant-wide guards

[English](2026-11-04-managed-publication-tenant-guards.md) | [简体中文](2026-11-04-managed-publication-tenant-guards.zh-CN.md)

Status: C1 implemented; C2 and C3 are proposals.

## Problem and current state

Tool output publication (reserve, upload, verify, finish, admission, receipt,
renew, quarantine) still takes two tenant-wide rows on every call:

- **Placement** (`runtime_placement`), first, through
  `lockPublicationPlacement` / `lockStagedPlacement`, the publication writer
  (`lockPublicationWriter`) and the CSI continuation.
- **Publication** (`output_publication`), next, through
  `ToolPublicationRetentionStore.lockTenant` in `ToolPublicationStore`,
  `ToolPublicationDataStore`, `ToolPublicationAdmissionStore` and
  `ManagedToolResultStore`.

Every Session of a tenant that publishes output therefore runs its publication
steps one at a time, behind Runtime placement, storage work, migration,
retention and collection. Journal commits, Turn admission and the Session
commands no longer take either row.

## What each guard protects

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
- The lane takes Session root and head before the publication row, the order
  collection uses, and never takes the publication guard after the root, so
  it closes no cycle with retention (publication guard, root, head).
- CSI publications keep the guard, as their retirement and continuation paths
  expect.

Considered and rejected: a dedicated `publication_quota` guard, or a counter
row with a conditional update. Either keeps tenant-wide serialization of every
reservation for an exact cap that a protective limit does not need; the
counter row would also need updates at every held-byte shrink.

### C2. Other ordinary publication lanes

Apply C1 to the ordinary upload, verify, finish, admission and receipt lanes,
the tool-result projection worker and the snapshot writer: skip the
publication guard and keep root, head, publication rows. No lane changes its
order. The work is the audit C1 needed: after the root, nothing in the lane
may take the publication guard again (C1's evidence read lease did, through
`ToolPublicationRetentionStore.read`). Such a call either takes the
Session-locked variant or the lane keeps the guard. CSI lanes keep it.

### C3. Original Runtime binding instead of placement

Replace the placement guard in ordinary (non-CSI) publication lanes with a
shared lock on the original binding row (`ma_runtime_binding`), taken where
placement is taken today. The retention sweep locks that row `FOR UPDATE`
before its reference checks, so either the lane waits for the sweep, and then
finds the binding gone and refuses, or the sweep waits for the lane and then
sees its references. CSI-pinned Sessions keep placement; the CSI retirement
and application paths are out of scope.

This is the binding handshake the
[lock scope design](2026-11-04-managed-lock-scope.md) left open for hosted
cleanup references; the same handshake can then serve those references.

## Open questions

1. C2's post-root audit covers the receipt lane's journal commit and resource
   installation in the same transaction; `ToolPublicationLockOrderMySqlIT`
   is the check that found C1's case.
2. C3 needs the binding's position in the global order: the sweep takes slot
   then binding under placement; lanes would take binding after the Session
   root. The sweep never locks Session rows after the binding, so no cycle is
   expected, but the audit must cover `ma_tool_execution` locks taken by
   lanes and by the sweep.
3. Whether `ManagedToolResultStore.claim` and `admitsLegacyProjection` (worker
   lanes for tool-result projection) follow C2 or keep the guard.

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
