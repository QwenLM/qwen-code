# Narrow Managed Session lock scopes

[English](2026-11-04-managed-lock-scope.md) | [简体中文](2026-11-04-managed-lock-scope.zh-CN.md)

The storage-lock ordering below is superseded for ordinary journal commits and inline/publication results by the [2026-11-05 design](2026-11-05-managed-publication-storage-sharing.md). Those paths use nonlocking physical-state checks under the existing offline-maintenance contract; other admission and lifecycle locks remain as described.

## Problem

Ordinary journal commits already queue on their Session. Several neighboring
paths still take tenant guards, and read-only storage checks take exclusive
locks. An unrelated placement can delay an answered operation, inline tool
output, or lifecycle renewal; Sessions sharing storage also queue behind each
other while only checking its availability.

## Scope and decisions

Deliver the changes in separate commits, in this order:

1. Remove the placement guard from `markOperationAnswered`. Its conditional
   update changes one operation's retry-budget watermark, retaining the owner,
   generation, live database lease and private-CSI exclusion checks.
2. Make ordinary inline `publishToolResult` enter through the Session root
   before any consistent read, then storage and head. Lifecycle authority and
   pinned CSI retain their guards. Probe a resource without a missing-key lock,
   lock an existing row, and arbitrate insertion with its unique key. A
   duplicate must match the original scope and bytes; collected resources must
   never be resurrected.
3. Separate read-only storage admission from storage mutation. Only callers
   that will not update the checked alias/owner use shared locking reads on
   MySQL. H2 retains its supported exclusive-lock fallback. Registration,
   membership, maintenance, recovery and migration writers keep exclusive
   locks. All nested identity and readiness checks must use the selected lock
   mode, avoiding a hidden exclusive reacquisition or an S-to-X upgrade.
4. Queue lifecycle claim, renewal, retry, block and failure on their Session
   before updating the operation and head claim mirror. Keep the mirror in
   the same transaction, use database time after waits, and preserve rejection
   of stale owners. Lifecycle admission/completion and CSI authority are not
   generalized into this guard-free path. Broker admission with lifecycle
   authority must read and share-lock the current head claim through its
   transaction (exclusive on H2). A tenant placement guard alone no longer
   protects that mirror from claim updates; an older RR snapshot must not
   authorize a revoked claim. Ordinary admission keeps its existing semantics.

Remove only demonstrated duplicate acquisitions within an already locked
transaction, and peripheral monitors whose complete shared-state mutation is
already synchronized. Keep the first acquisition's position and identity
validation. Do not introduce a general lock cache or change public APIs.
Physical admission reads each alias and owner once, reducing the LOCAL/SSH
path from four queries to two. LOCAL identity lookup still permits a fenced
owner for recovery, while admission requires READY; SSH retains its stricter
identity, registration and fence checks. The logical migration-fence lookup
keeps its separate business-key validation.

## Invariants

- Session lifecycle changes and ordinary writes share a Session/root lock;
  writer generation, journal sequence and lifecycle claims still use the head.
- Storage readers hold their shared fence through transaction completion;
  migration/fence writers cannot pass them and admit incompatible work.
- Shared admission never updates the same storage row later in its transaction.
- Waiting for a lock must not leave authorization based on a stale RR snapshot.
- Conditional operation updates and the head mirror commit or roll back
  together. A lost or expired claim never regains authority by retrying.
- Publication quota reservation, runtime placement/retention protocols,
  physical owner membership and CSI original-resource proofs remain intact.

## Risks and exclusions

Removing tenant serialization exposes missing-key gap locks, ordering cycles
and stale snapshots previously hidden by that serialization. Tests must use
independent MySQL connections, not only H2 or captured SQL. Existing CSI paths
have root-to-guard and guard-to-root orders with named retryable deadlocks;
this work must not silently broaden those paths.

Hosted cleanup references need a separate original-binding existence and
generation handshake. This change does not add a binding lock behind the head
without resolving its order against retention. Runtime provider startup locks,
read-lease redesign and tenant quota accounting are also outside this increment.

## Validation and acceptance

- Reproduce each targeted wait on the unchanged baseline, then verify the
  actual store entry completes while unrelated tenant guards remain held.
- Verify different Sessions can share storage admission while an exclusive
  fence waits; after fencing, new admission must fail.
- Exercise concurrent new inline resources, exact replay, conflicting replay,
  collected tombstones, writer takeover and lifecycle/physical fences.
- Exercise lifecycle claim takeover, expired-owner rejection, mirror updates,
  missing Sessions, rollback and same-Session ordering. Verify that Broker
  authority checks reject claims revoked after an RR snapshot and that claim
  revocation waits for an already admitted Broker transaction.
- Run affected lock-contract, lifecycle, publication and storage tests and
  Checkstyle. Real MySQL checks establish row/gap-lock behavior; full Java,
  MySQL and relevant Hosted/fault profiles remain CI gates.

Local Java setup, compilation and tests share the module's ten-minute budget.
Record baseline and changed-source results separately. Implementation is not
accepted until the required CI gates pass; no throughput gain is asserted
without measurement.
