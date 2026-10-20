# Hosted cleanup debt protects its original Runtime

[English](2026-10-20-hosted-cleanup-retention.md) | [简体中文](2026-10-20-hosted-cleanup-retention.zh-CN.md)

## Problem

Issue #13992 identifies an enablement prerequisite for Runtime history retention.
A committed `hosted.cleanup` descriptor can still owe confirmation after its
original Runtime was released. Removing that binding or Runtime Session makes
the original release return `runtime_session_conflict`, permanently preventing
the debt from being confirmed. A missing binding cannot safely imply success.

## Decision and scope

Retain the original binding through an authoritative cleanup-debt projection,
rather than introduce release-success tombstones with an arbitrary lifetime.
The projection is written in the same transaction as the native journal event.
It protects the complete original binding family until every debt is confirmed.
Retention stays disabled by default. No release authorization is relaxed.

## Projection

Each owed cleanup adds a `HOSTED_CLEANUP` owner in `ma_resource_ref`. Its owner
key identifies the cleanup within its Session, its owner revision is the
original Runtime generation, and its resource key identifies the immutable
descriptor. An indexed `runtime_binding_key` identifies the tenant, Workspace
and binding. The existing raw tenant and Workspace fields are also checked.
The descriptor is already validated against the journal's exact Session scope
and reference census before the projection is changed.

A repeated outstanding cleanup preserves the same descriptor and original identity.
A confirmed event removes only its own cleanup owner. Another cleanup, Session
or generation remains protected. The descriptor's ordinary journal reference
continues to protect its bytes independently of the additional owner.

## Compatibility

Schema V13 adds the reference owner, binding index and a nullable
`cleanup_head_revision` stamp to the native journal head. Fresh heads start at
zero. Ordinary commits advance a current stamp atomically with the journal and
cleanup owners. A missing or stale stamp never becomes current merely because
a later transaction contains no cleanup event.

The frozen CSI terminal path accepts exactly one `activation.changed` release
event and its boundary resource; it cannot carry a `hosted.cleanup` event.
It does not advance the cleanup stamp, so even a fresh head that takes this
path becomes unverified. Its binding family remains protected until permanent
journal collection. Extending stamp coverage to this path is deferred; the
current behavior conservatively over-retains rather than losing cleanup debt.

Existing heads are deliberately unverified. Retention preserves their binding
families while their journals remain recoverable; this avoids an unsafe partial
backfill and never treats missing history as proof of release. Permanently
deleted Sessions may release this protection only after their journal owners
and transactions have been collected. Upgrade every Java catalog reader and
writer together; an older binary is not a compatible rollback after V13.

The existing deployment cutover policy still applies: use a new database,
quiesce old admissions, settle in-flight work, and retain the old environment
for historical reads. A V12 frozen, cut, or drained CSI retirement inventory
cannot be resumed by a V13 reader. The native V12-to-V13 test verifies ordinary
head/reference preservation in an isolated catalog; it does not qualify replay
of an in-flight CSI retirement or an in-place production migration.

## Lifetime and concurrency

Owed debts do not expire. A debt's original owner must remain available for an
arbitrarily late recovery. Confirmation removes that debt's extra reference.
Permanent Session retirement removes the remaining cleanup references only
after the native journal is no longer readable, so descriptors cannot become
reachable again through a retained journal. This retains outstanding work,
rather than accumulating permanent success markers for completed releases.

The Runtime collector checks the projection on its own transaction connection
before deleting any family member, preserving placement and binding lock order.
The normal journal path changes only Session-scoped journal/reference state;
it never acquires a Runtime binding lock while holding the journal head.
Uncertainty or unreadable evidence retains history rather than acknowledging a
release that cannot be proven.

## Affected components

Native journal commit, schema initialization and validation, Runtime retention
guards, and permanently retired Session reference collection. The public API,
Hosted descriptor format, Runtime release route and default deployment switches
remain compatible.

## Validation and acceptance

- Commit owed cleanup, release and age the original family, then sweep: the
  exact binding and Runtime Session survive and original release still succeeds.
- Reopen the stores and repeat the same release; never-existing, foreign and
  mismatched-generation controls still refuse.
- Confirm one debt while another still exists; collection remains blocked until
  every original-owner debt is confirmed.
- Roll back a journal transaction and verify its projection rolls back with it.
- Preserve legacy or stale-stamped journals and release their protection only
  after permanent journal collection.
- Verify fresh and forward schema initialization on H2 and MySQL 8.4, including
  independent standalone/Flyway inventories. Runtime retention stays off.

## Open questions

None for this bounded implementation. Backfilling live legacy heads may be a
later optimization; it is unnecessary for safe retention enablement.
