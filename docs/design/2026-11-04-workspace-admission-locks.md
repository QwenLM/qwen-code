# Separate Workspace reads from durable admission

[English](2026-11-04-workspace-admission-locks.md) | [简体中文](2026-11-04-workspace-admission-locks.zh-CN.md)

## Scope and audit

Audit Workspace Session creation before changing its lock modes. Preserve
authorization, registration identity, default selection, retirement and replay
semantics. The creation resolver also serves file scope, source-directory
selection, worktree preparation and private CSI creation; its caller does not
always hold tenant placement.

On main `4d5e30e6f0529f11c62a853d67c0f5a237cc6ffe`, real MySQL 8.4 tests
observed two Workspace locking reads for default resolution. While that
transaction held placement and its resolved Workspace open, an update of an
unselected Workspace waited. MySQL's lock tables showed exclusive locks on
both Workspace records, confirming a wider lock scope than the chosen default.

| Protection                                                               | Existing responsibility                                                                                                                    | Decision                                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Tenant placement                                                         | Order ordinary/internal Session creation and private CSI creation against migration and retirement across several tables                   | Retain; removing it needs a separate admission protocol            |
| Selected Workspace row                                                   | Read the current generation/storage/configuration/state and hold them through durable admission, including administrator SQL changes       | Retain in writes; use snapshots for browsing and preflight         |
| Actor permission row                                                     | Order grant changes and revocation against the admitted transaction; administrator SQL need not acquire placement                          | Retain in writes; recheck snapshot authorization around reads      |
| Default Workspace lookup followed by a second lookup of the selected row | Lock the same Workspace twice to obtain its ID and then its complete binding                                                               | Read the complete row once through the existing unique default key |
| Storage and resident checks                                              | Check independent physical fences, registration and active Session/Runtime state; locking reads also avoid stale REPEATABLE READ snapshots | Retain                                                             |

Before this change, ordinary and internal team-lead creation acquire placement
before resolving the Workspace. Private CSI creation acquires placement in its
owning transaction; worktree source resolution does likewise. File-scope resolution and
source-directory selection can call the resolver without placement. None of
these facts makes administrator changes to Workspace or permission rows share
the placement protocol. The existing row locks therefore cannot all be removed
on the strength of the outer lock. Conversely, not every resolver consumer
performs durable admission. Normal creation establishes its first snapshot
after placement, so creation versus retirement alone does not justify another
Workspace lock. A file or preflight result has a different lifetime from a
committed Session or derived Workspace.

## Change

For durable admission, resolve an omitted selection with a single locking query on `default_tenant`,
the generated column already constrained by `uk_ma_workspace_default`. It
returns the ID and full Workspace record in one statement. Explicit selections
continue to use the exact tenant and Workspace business key. Both paths then
lock and validate the actor's permission, check SSH node access and verify the
Workspace is ACTIVE in the existing order.

This removes the second acquisition/query for the same default Workspace and
uses the declared unique selector instead of filtering the tenant's Workspace
rows by `is_default`. No index or schema change is required. A default change
still conflicts with the selected default's row/index lock until admission
commits or rolls back. The current read must remain a locking read: an older
REPEATABLE READ snapshot must not select a former default or an outdated
registration.

Administrator SQL that changes the default must lock the current default with
`WHERE default_tenant = ? FOR UPDATE` before modifying Workspace rows in that
transaction. Updating a Workspace row first and then changing `is_default`
can invert admission's unique-index/clustered-record order and cause an InnoDB
deadlock (1213 / SQLState 40001), rather than a simple wait. A deadlock victim
must roll back and retry its complete transaction; retrying only the resolver
inside the aborted transaction is invalid. This increment documents that
administrative ordering constraint; automatic admission-transaction retries
remain a separate change.

## Read and preflight paths

Provide named read resolvers alongside the existing admission resolvers. Reuse
the same actor, tenant, role, ACTIVE state, SSH access and error-code checks.
Read resolution uses ordinary SELECTs in a fresh REPEATABLE READ transaction;
admission resolution retains locking reads. Directory OWNER and ROOT checks
use the role and kind from that resolution, avoiding a second permission lookup
that could use an older snapshot after a locking read.

| Caller                     | Read phase                                                                                             | Durable phase                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| File query/read            | Read scope before and after I/O, then compare scope revision and physical identity                     | None                                                                                          |
| File upload                | Read scope before consuming the body                                                                   | Existing scope, authorization, fences and operation insertion stay in one locking transaction |
| Directory browser          | Read OWNER/ROOT and binding before enumeration, then reread and compare the complete binding afterward | None                                                                                          |
| Worktree options/preflight | Read source without acquiring tenant placement; keep physical storage validation                       | Creation resolves again and checks the plan's binding, root and storage identity              |
| Derived Workspace creation | Existing source selection and receipt preparation                                                      | Final source authorization, new Workspace/grant and completed receipt retain existing locks   |

Read scopes use a dedicated short transaction template with REPEATABLE READ.
Their named entry points reject an ambient transaction rather than inheriting
its snapshot or suspending a transaction that might hold a needed storage
lock. Every post-I/O check therefore opens a new snapshot. The existing write
scope continues to join the upload admission transaction. A read template is
not marked SQL read-only: worktree identity checks may persist an existing
BLOCKED diagnostic transition.

File read scope drops explicit Session, Workspace, grant and storage row locks;
write scope retains them. Physical storage, migration and identity guards are
unchanged and may still acquire their own locks. Directory browsing and
worktree preflight drop their Workspace/grant locks; worktree preflight also
drops its placement acquisition. This does not claim every read is lock-free.

The implementation is confined to the registry, file scope/upload precheck,
directory browser and worktree source stores. No public API, schema or isolation
setting for durable writes changes. No new generic locking framework is needed.

## Compatibility and limits

- Explicit selection never falls back to a default. Missing, unreadable,
  non-operator and inactive Workspace refusals retain their existing codes and
  precedence. Omitted selection still uses `workspace_required` for an unusable
  default.
- Registry-based durable admission keeps its Workspace and permission locks;
  conflicting mutations wait for that transaction. After they commit, a new
  admission resolver sees their current values.
- Creation idempotency, original-binding replay, resident single-Session
  admission and private CSI ownership are unchanged.
- No new shared-lock mode, lock cache or alternative authorization semantics is
  introduced. Tenant placement still serializes the creation paths that use it;
  this change does not claim parallel Session creation within one tenant.
- File and directory browsing recheck a fresh snapshot after I/O. Worktree
  options/preflight remain advisory and may become stale; final creation
  independently revalidates the plan before admitting it. These reads do not
  reserve authorization for later writes and need no shared metadata locks.
- Changing final admission's ordering against administrator SQL or revocation
  remains outside this increment; all such writers would need a common
  protocol before removing those protections.

## Validation and acceptance

Measure default-resolution SQL and the actual MySQL lock scope before and after
the change. Verify that unrelated Workspace metadata can progress while the
selected default's transaction remains open. Verify default switching,
registration changes, permission revocation, an already established REPEATABLE
READ snapshot, explicit selection and refusal behavior. Exercise the actual
creation/retirement boundary and relevant resolver consumers.

On real MySQL, verify browsing/preflight can finish while another connection
holds a Workspace or grant update open. Verify revoked/downgraded grants,
changed generations and fences prevent returning obsolete file/directory
results. Verify ambient old snapshots are refused at read entry points, and
upload/derived publication still retain their final transaction protection.
Assert business outcomes in addition to query/lock traces; a test that merely
requires a writer to wait does not establish that every reader needs that lock.

Use the Managed Agent module's shared local verification budget, focused
H2/MySQL tests and Checkstyle. Record query and lock-scope evidence separately
from latency or throughput claims. Full Java/MySQL/Hosted/fault gates remain CI
acceptance; targeted local results do not establish those gates passed.
