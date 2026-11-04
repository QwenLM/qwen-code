# Snapshot storage validation for Workspace reads

[English](2026-11-04-workspace-storage-read-locks.md) | [简体中文](2026-11-04-workspace-storage-read-locks.zh-CN.md)

## Problem and scope

The [Workspace read/admission split](2026-11-04-workspace-admission-locks.md)
removed metadata locks from browsing and preflight. Two LOCAL read paths still
take exclusive storage locks inside their short REPEATABLE READ transactions:
Session worktree file scope and worktree source preflight. Storage validation
implicitly locks migration fences, aliases and physical owners whenever a
transaction is active. Worktree storage identity also explicitly locks its
alias and owner. Requests sharing the same storage can therefore serialize.

This increment covers those two paths and their internal storage validation.
It does not change public contracts, schema, Session creation placement,
retirement, migration or recovery protocols.

## Design

Provide an explicit snapshot variant of LOCAL root/file-root validation. Its
logical fence, alias, physical owner and registration queries use ordinary
SELECTs in the caller's fresh REPEATABLE READ snapshot. Reuse the existing
physical identity, canonical directory, storage marker and migration-history
checks. Existing validation entry points retain their locking behavior for
admission and recovery.

File scope chooses snapshot validation for reads and existing validation for
durable admission. The existing file exchange checks authorization and scope
revision in independent snapshots before and after file I/O and compares the
physical root identity. Upload preflight uses the same read scope; its final
admission keeps authorization, storage protection and operation insertion in
one locking transaction.

Worktree source preflight reads its storage identity without locks. It resolves
and validates the source again in a second fresh snapshot before returning,
comparing the complete resolved binding, root and storage identity. Revoked
access or a new fence refuses the result; a changed binding or registration
invalidates it. This also checks for changes during filesystem validation.
Final worktree admission continues to compare the plan against current locked
storage identity before persisting the operation.

Snapshot entry points reject an ambient transaction, as in the previous
increment. Internal snapshot helpers inherit only the short transaction opened
by those entry points. Templates remain writable because an invalid worktree
may persist its existing BLOCKED diagnostic transition.

## Consistency and limits

An in-flight read can observe the previously committed version of an
uncommitted storage mutation. The read's postcheck observes committed changes
in a fresh snapshot; filesystem identity checks still reject a replaced or
unsafe directory. These checks do not reserve permission or storage for a
future operation. Worktree Git options/preflight remain advisory after source
resolution, and final creation independently validates the plan.

Healthy reads should take no storage row locks. The existing BLOCKED diagnostic
update can still write its worktree row on an invalid-filesystem path. No
request-wide claim of zero locks or throughput improvement is made without
measurement. CSI/SSH storage admission and shared journal fences are unchanged.

## Validation and acceptance

Reproduce contention on real MySQL 8.4 through the actual file query/read and
worktree source APIs, while another connection holds a shared alias or physical
owner lock. Observe InnoDB waits and verify successful business results after
the blocker is released. After the change the same reads must finish while the
shared blocker remains held. Repeat with an exclusive row lock that leaves the
committed values unchanged to verify these reads do not request shared locks
either.

Cover access revocation, storage fencing/registration changes and filesystem
identity changes across read validation. Verify ambient old snapshots are
refused. Verify durable upload/worktree admission still orders storage mutation
and refuses a stale plan. Keep LOCAL recovery, shared journal admission and
SQL ownership contracts covered by focused consumer regressions where changed
helpers affect them.

Follow the Managed Agent local validation budget and record exact selected
cases, failures, skips and lock evidence. Full Java/MySQL/Hosted/fault profiles
remain CI acceptance. H2 checks do not establish InnoDB locking behavior;
mocked file workers do not establish real worker/process integration.
