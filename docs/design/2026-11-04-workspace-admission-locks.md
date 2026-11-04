# Remove duplicate default Workspace admission reads

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
| Selected Workspace row                                                   | Read the current generation/storage/configuration/state and hold them through admission, including administrator SQL changes               | Retain the first locking read                                      |
| Actor permission row                                                     | Order grant changes and revocation against the admitted transaction; administrator SQL need not acquire placement                          | Retain                                                             |
| Default Workspace lookup followed by a second lookup of the selected row | Lock the same Workspace twice to obtain its ID and then its complete binding                                                               | Read the complete row once through the existing unique default key |
| Storage and resident checks                                              | Check independent physical fences, registration and active Session/Runtime state; locking reads also avoid stale REPEATABLE READ snapshots | Retain                                                             |

Ordinary and internal team-lead creation acquire placement before resolving the
Workspace. Private CSI creation acquires placement in its owning transaction;
worktree source resolution does likewise. File-scope resolution and
source-directory selection can call the resolver without placement. None of
these facts makes administrator changes to Workspace or permission rows share
the placement protocol. The existing row locks therefore cannot all be removed
on the strength of the outer lock.

## Change

Resolve an omitted selection with a single locking query on `default_tenant`,
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

## Compatibility and limits

- Explicit selection never falls back to a default. Missing, unreadable,
  non-operator and inactive Workspace refusals retain their existing codes and
  precedence. Omitted selection still uses `workspace_required` for an unusable
  default.
- Registration and permission changes still wait for an admitted transaction;
  after they commit, a new resolver sees their current values.
- Creation idempotency, original-binding replay, resident single-Session
  admission and private CSI ownership are unchanged.
- No new shared-lock mode, lock cache or alternative authorization semantics is
  introduced. Tenant placement still serializes the creation paths that use it;
  this change does not claim parallel Session creation within one tenant.
- The remaining row checks need their existing synchronization. Considering
  shared reads separately requires auditing later writes/lock upgrades and
  demonstrating a useful reduction in contention beyond the outer guard.

## Validation and acceptance

Measure default-resolution SQL and the actual MySQL lock scope before and after
the change. Verify that unrelated Workspace metadata can progress while the
selected default's transaction remains open. Verify default switching,
registration changes, permission revocation, an already established REPEATABLE
READ snapshot, explicit selection and refusal behavior. Exercise the actual
creation/retirement boundary and relevant resolver consumers.

Use the Managed Agent module's shared local verification budget, focused
H2/MySQL tests and Checkstyle. Record query and lock-scope evidence separately
from latency or throughput claims. Full Java/MySQL/Hosted/fault gates remain CI
acceptance; targeted local results do not establish those gates passed.
