# Harness admission checks without the tenant guard

[English](2026-11-03-managed-harness-admission-tenant-guard.md) | [简体中文](2026-11-03-managed-harness-admission-tenant-guard.zh-CN.md)

## Problem and current state

`JdbcRuntimeBindingRepository` exposes standalone Harness checks:
`requireHarnessAdmission` (scope-only and binding-request overloads),
`requireHarnessRecovery`, `requireHarnessCleanup` (both overloads) and
`requireHookAdmission` (both overloads). Each opens its own transaction, takes the
tenant placement guard (`lockPlacementDomain`, with no statement timeout), and
then runs the shared Harness fence check.

`RuntimeExecutionDispatcher.beginDispatch` calls `requireHarnessAdmission` before
every uncancelled tool dispatch. Every tool call of every Session in a tenant
therefore queues on the tenant's placement row, behind Runtime placement,
storage registration, fencing, migration, maintenance, CSI work and retention.
For scopes the check does not cover, such as non-Session isolation without a
lifecycle authority, the check returns immediately, but only after the guard has
been taken.

The shared check only reads. It reads `ma_session` for resident scopes and the
Harness row in `ma_session_head`: its phase (`OPEN`, `DRAINING`,
`LIFECYCLE_ONLY`), operation, claim generation and claim lease. Recovery also
reads the lifecycle operation's protocol version. None of the seven methods
writes a row. The connection-taking variants used inside placement, session
admission and tombstone transactions are unchanged and keep the guard their
callers already hold.

## Goal and scope

Remove the tenant guard from those seven standalone, read-only checks without
changing any verdict. Out of scope: Harness drain (`requestHarnessDrain`),
lifecycle claim writes, `authorizeDispatch`, placement and session admission,
and every other guard holder.

## Design

Each method keeps its transaction and drops only `lockPlacementDomain`. The reads
run in one transaction, so on MySQL and MariaDB (REPEATABLE READ) they evaluate
one consistent snapshot.

The verdicts stay the same because the check writes nothing:

- With the guard, a concurrent transition such as a Harness drain or lifecycle
  claim either commits first, and the check sees it, or the check commits first
  and the transition proceeds without seeing anything from the check.
- Without the guard, a transition committed before the check's snapshot is
  still visible. One that commits later is ordered after the check, an order
  that was already possible with the guard, and the transition observes the same
  state either way.

Each method commits before returning, so even with the guard nothing was held
while the caller acted on the verdict. The window between a passing check and a
later drain therefore already existed. The protection after the check remains
where it was: `authorizeDispatch` locks the binding row and requires it to be
`READY` at the same generation; resident dispatch re-runs the Harness check
inside that transaction; and lifecycle authority is fenced by the claim
generation and lease written by the lifecycle protocol.

## Affected components

- `JdbcRuntimeBindingRepository`: the seven standalone Harness check methods.
- `SharedHarnessOwnershipTest`: admission, Hook, recovery and cleanup verdicts
  while another transaction holds the tenant guard.

There are no schema, API or configuration changes.

## Risks

- A check can pass on a snapshot taken just before a drain or claim commits.
  That ordering was already possible, and the post-check protections listed
  above are unchanged.
- An engine defaulting to READ COMMITTED evaluates the reads on separate
  snapshots; each condition is still checked against committed data. Production
  MySQL and MariaDB use REPEATABLE READ.

## Verification and acceptance

1. With the tenant guard held by another transaction, ordinary admission, Hook
   admission and recovery for an open Harness Session complete; admission for a
   draining Harness Session and cleanup without a matching claim are still
   refused with `runtime_admission_closed`.
2. Existing Harness suites pass: `SharedHarnessOwnershipTest`,
   `RuntimeHarnessDrainTest`, `WorkspaceLifecycleStoreTest` and
   `WorkspaceProfileLifecycleTest`.
3. CI runs the MySQL and Hosted profiles.

## Open questions

None.
