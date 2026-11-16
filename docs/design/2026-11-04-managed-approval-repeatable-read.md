# Approval changes with an earlier transaction snapshot

[English](2026-11-04-managed-approval-repeatable-read.md) | [简体中文](2026-11-04-managed-approval-repeatable-read.zh-CN.md)

## Problem and scope

An embedded caller can invoke an approval change inside an existing MySQL
REPEATABLE READ transaction. If an earlier consistent read established a snapshot,
acquiring the Session row lock does not refresh subsequent nonlocking reads.
The approval revision, omitted permission rules and plan mode, and an idempotency
receipt can therefore come from an earlier committed state.

Two transactions that first read revision 0 can both report revision 1 as a new
success: the second conditional update affects no rows, but the unchecked result
still allows a success receipt and event. Identical-key retries can instead miss
the committed receipt and attempt another insert.

The ordinary HTTP path starts a fresh store transaction and locks the Session
before its consistent reads. This change addresses callers joining a transaction
with an earlier snapshot; it does not establish that two ordinary HTTP requests
reproduce the same failure.

## Decision

Retain the existing Session row lock and transaction boundary. After that lock
and authorization, reserve the owner-scoped receipt with a normal `INSERT` in
the existing `COMPLETED` state, initially without its result. The row is private
to this transaction until the policy, result and event commit together. A
`PENDING` reservation would incorrectly trip the existing busy-command barrier.
Catch a duplicate key inside the mutation method, then use the
existing `FOR UPDATE` lookup to read and validate that existing receipt for
replay. If the scoped receipt cannot be found, rethrow the duplicate-key error.
Do not issue a locking lookup for an absent receipt: under REPEATABLE READ that
can retain a shared index-gap lock and deadlock unrelated Session insertions.

Read `approval_revision`, `permission_rules_json` and `is_plan_enabled` together
with `FOR UPDATE`. These current reads see committed changes even when the
transaction retains an older consistent-read snapshot. Derive omitted rules and
plan mode from that same locked policy row.

Require the conditional policy update to affect exactly one row before filling
the reserved receipt's result or appending
`session.approval.changed`. Otherwise return
`409 approval_selection_conflict`, allowing the existing transaction boundary to
roll back the operation and its reservation. Other validation failures also roll
back the reservation. Keep the SQL-owner inventory synchronized.

Distinct keys competing for one expected revision produce one success and one
revision conflict. Identical keys and content return the original result as a
replay. Reusing a key with different content retains `idempotency_conflict`.
Tenant scoping, current owner and Workspace authorization, capability checks,
and admitted Turn snapshots retain their existing behavior.

## Constraints and risk

Use the existing per-Session lock order and receipt lookup; introduce no schema,
API, isolation-level, connection-pool or tenant-wide locking changes. Only the
duplicate-receipt path performs a locking lookup; the Session lock already
serializes callers for that receipt scope. Replay attempts incur a duplicate
insert before reading their original result.
The separate plan-mode query is removed. This is a correctness fix with focused
concurrency coverage, not a throughput benchmark. Model selection and other
policy mutation paths are outside this change.

## Validation and acceptance

For built-in and stored-definition Sessions, synchronize two transactions after
both read revision 0. With distinct keys, require one revision-1 result and one
`approval_selection_conflict`. With identical keys/content, require two revision-1
results and exactly one replay. In both cases, require persisted revision 1,
exactly one SET_APPROVAL receipt and exactly one `session.approval.changed` event.
Use bounded waits so failed synchronization cannot silently stall the test.

Also place absent receipt hashes for two different Sessions in the same existing
index gap. Synchronize missing lookups or initial inserts and require both
changes to commit, with two completed receipts and events and no pending receipt.
Existing rejection and revision-conflict tests must leave no reservation behind.

Run these regressions against real MySQL 8.4 with REPEATABLE READ, together with
the existing approval behavior tests. H2 covers compatibility but does not prove
MySQL snapshot behavior. Check SQL-owner and transaction contracts and production
Checkstyle. Record reproduction, focused results and environment deviations in
the PR test report. Full MySQL/Hosted profiles, SpotBugs and platform gates remain
CI acceptance requirements; focused local passes do not replace them.
