# Native journal snapshots without tenant guards

[English](2026-11-05-managed-snapshot-writer-tenant-guards.md) | [简体中文](2026-11-05-managed-snapshot-writer-tenant-guards.zh-CN.md)

Status: implemented.

## Problem

Publishing a native journal snapshot (`ManagedNativeJournalSnapshots.publish`) locks
the snapshot writer (`JournalWriterLifecycle.lockSnapshotWriter`) three times, and each time
it takes the tenant `runtime_placement` row and then the tenant `output_publication`
row, through the six-argument `lockPublicationWriter`. Every snapshot of every Session
of a tenant therefore queues behind every placement owner (binding transitions,
provisioning, Runtime retention, worktree maintenance, lifecycle) and every
publication-guard owner (collectors, writer acquisition, lifecycle, CSI). Ordinary journal
commits and tool publication already take neither row
([journal commits](2026-11-03-managed-journal-commit-tenant-guard.md),
[publication guards](2026-11-04-managed-publication-tenant-guards.md),
[placement](2026-11-04-managed-publication-placement.md)).

## Current transaction shape

`publish` runs three READ COMMITTED transactions:

1. **Basis**: lock the writer and register a read lease, then commit.
2. **Build**: upsert the snapshot manifest row (`claim`), read the journal page by page,
   and for each page store a page resource and its `NATIVE_SNAPSHOT` reference. Then lock
   the writer again, check that the head has not moved, copy the journal references, and
   lock the writer a third time before committing.
3. **Close**: release the read lease.

The journal reads inside Build run in separate `REQUIRES_NEW` transactions, and each
takes a read lease on the Session root and head. So Build cannot lock the root and head
before it reads pages: its own nested reads would wait for it. Build therefore holds only
the snapshot's own new rows when it first reaches the root. A journal commit made during
Build is not blocked. It changes the head, and Build then fails with
`managed_session_head_conflict` (`ManagedNativeJournalSnapshotsMySqlIT`).

## Why the tenant guards are not needed

- **No new lock cycle.** When Build reaches the root, it holds only rows it created: the
  manifest, page resources and `NATIVE_SNAPSHOT` references. Consider a transaction that
  would hold this root or head and then wait for those rows. Today Build waits for
  placement, which every guard owner takes before the root, so that transaction already
  closes a cycle with Build. A transaction that takes no guard closes the same cycle at the
  root. Removing the guards changes only which lock Build waits on, not whether a cycle
  exists.
- **Collectors never wait for these rows.** The live-Session collector
  (`ManagedProjectionResourceCollector`) and the retired-Session collector
  (`SessionResourceCollectionCollector`) first find candidates with a plain read, so they
  see only committed rows. They then lock or update those rows by key, after root and head.
  Build's uncommitted rows are never candidates.
- **The writer checks are row-locked.** Credentials, harness placement (Session root),
  legacy and CSI pin (root), lifecycle phase and writer generation (head), retirement
  (root) and recovery status (head) are checked under the root and head locks or by
  committed reads. The physical-storage check uses the nonlocking read that ordinary
  writers use ([storage sharing](2026-11-05-managed-publication-storage-sharing.md)).
- **Copied resources stay alive.** The Basis read lease protects them from collection,
  and Build calls `checkReadView` before it copies references.
- **CSI is unchanged.** A pinned CSI Session takes both guards behind its root in
  `lockCsiContinuation`, as journal commits on it do.

## Change

`lockSnapshotWriter` no longer takes placement itself. It calls
`lockPublicationWriter(..., placement = false, publicationGuard = false)`. No schema,
API, configuration or transaction boundary changes.

## Verification

- `ManagedNativeJournalSnapshotsTest.publishesWhileBothTenantGuardsAreHeld`, run on H2
  and on MySQL through `ManagedNativeJournalSnapshotsMySqlIT`: with placement and the
  publication guard both held on another connection, a snapshot publishes within the
  bound and replays.
- The existing snapshot, snapshot retirement, journal lock contract, lock order and
  store decomposition suites pass.

## Risks

A transaction that holds a Session root or head and then waits for a snapshot's own
rows would still deadlock with Build. That cycle exists today, and this change neither
adds nor removes it. No such transaction was found: collectors pick only committed
candidates, and journal commits write references owned by `JOURNAL`, not by
`NATIVE_SNAPSHOT`.
