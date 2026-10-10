# K2 publication placement before retention

[English](2026-10-10-k2-publication-lock-order.md) | [简体中文](2026-10-10-k2-publication-lock-order.zh-CN.md)

Status: implemented prerequisite; independent baseline and candidate verification accepted.
Refs #13395 / Draft PR #13526. Generic private retention and aggregate retirement
remain separate increments.

## Problem and supported scope

Ordinary publication apply and both prepareAdmission SQL stages first acquire
the tenant retention row R, then the placement row P through the legacy writer.
Session, lifecycle, migration and native admission already acquire P before R.
Two ordinary ambient preflights, prepareAdmission and commitReceipt, also read
generic resources before their first P. Adding a current private parent check G
to those reads would retain G before a later P. The source identifies these
edges; actual MySQL schedules must establish the reachable behavior.

Move P earlier in these known publication orchestrations, with the original
REQUIRED transaction, manager and DataSource. Pure generic readers and callbacks
will keep R then G and will not acquire P. This proposal does not refuse
ordinary ambient calls or change isolation. An external caller already holding
R/G, a cross-tenant outer composition, or an unsupported custom manager remains
unqualified. There is no claim that every possible public API composition is
free of a waiting cycle.

## Qualify the target before choosing P

The Store owns a small publication-specific prefix. Existing publications are
read through the original JdbcTemplate without FOR UPDATE. Require the actual
row tenant/workspace/Session, scope key and publication ID to match the target;
parse its exact binding, verify the binding digest, and require the binding key
and publication ID to match that row. A new reservation instead uses its
contract-validated candidate. A reservation replay additionally qualifies the
existing row and candidate digest before selecting P. Its plain lookup must
distinguish absent/new from present/replay without requiring an existing row
for a new reservation.

Discover the original runtime through the existing repository and require its
tenant/workspace, binding ID and generation to match the qualified binding.
For the supported JdbcRuntimeBindingRepository on the same DataSource, also
read binding_id, tenant_id, workspace_id, runtime_generation and provisioner_kind
without a child lock through the original bound JdbcTemplate; require those
persisted values to match the discovered runtime and binding. The repository's
existing findById uses another connection and is not represented as an original
transaction read. No read-only RR snapshot, new discovery connection or child
FOR UPDATE is introduced.

Select P only for that qualified tenant. Within each SQL stage retain the
qualified expected runtime when entering the original native locking helper;
do not discover and follow a second tenant after P. The existing JDBC native
lock checks the slot and current sameIdentity on the original Connection.
Every later original-runtime discovery must still check its target scope before
any native P, including the receipt stage. A changed binding or row refuses;
the later locked publication, writer, token, epoch and execution checks remain
authoritative. Plain discovery is a scheduling prefix, not native permission.

Compare apply's later locked row with the discovered binding and digest before
using it. The existing locked candidate/install/receipt queries must retain the
target tenant/workspace/Session predicates and read binding_json/binding_digest.
Recompute the locked JSON digest and match both the saved digest and the
original finished binding. Do not lock publication before R or add a new lookup
after a child merely to perform that comparison.

Ordinary custom repositories retain their existing repository-based discovery
and identity checks; they are not required to have a SQL binding row. Their
external mutation or cross-connection behavior is not upgraded to the supported
native JDBC guarantee. Existing ordinary calls are not blanket-rejected.

## Changes to the known orchestrations

| Entry                              | Proposed prefix and retained behavior                                                                                                                                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| applyLocked                        | Qualify candidate or stored publication/runtime, acquire P, then original runtime locks, R, legacy writer and the existing locked publication/evidence checks.                                                         |
| prepareAdmission candidate/install | Extend the existing original settled-result prefix to qualify the stored tuple/runtime and acquire P before its ordinary early return and before R. Reuse the expected runtime for native locking. Both stages change. |
| prepareAdmission ambient preflight | After pure outcome size/schema checks and before finished's first generic read, execute the same publication prefix in a participating REQUIRED callback. Standalone preflight remains a sequence of short reads.      |
| commitReceipt ambient preflight    | After pure request/root checks and before the first admission resource read, execute the publication prefix in a participating REQUIRED callback. Keep finished/manifest/receipt validation.                           |
| commitReceipt SQL stage            | Qualify the stored publication/runtime before its existing first P, then retain the original Session/native, settled-result, R, writer, resource and receipt checks.                                                   |

The participating preflight callback returns without committing or releasing P.
That P stays held through the supported outer preflight, candidate, bounded
object I/O, install or receipt, and cleanup until the original outer transaction
completes. Standalone writer stages acquire their own P before R. Existing
physical I/O in an ambient caller remains visible; a fresh connection or a
savepoint cannot stand in for qualification of that caller's held locks.

## Errors and synchronization metadata

P is synchronization metadata and supplies no native authority. Modern writer
acquisition already creates it. For legacy history with a missing P row, an
early successful upsert followed by a pure validation error outside the
participating callback may leave that row committed if the outer ordinary
caller catches the error. Accept and explicitly measure this metadata-only
delta; keep publication, journal and result values exact. Do not silently mark
all caught pure validation errors rollback-only or claim full-database no-write.
The existing writer/SQL-stage failures keep their rollback-only semantics.

The existing private writer exclusion, when reached in a SQL stage, throws
inside its participating transaction and rolls back its P/R upserts and private
values. The earlier CSI ambient refusal remains outside that callback. The new
scope prefix does not itself exclude a current private parent: unsupported
ordinary saved history reassociated with a private Session can still reach a
pure preflight error, catch it and commit the missing-P metadata delta. Generic
private preflight exclusion belongs to the next increment. Keep the original
primary error, with cleanup failures suppressed where the original API promises
it; do not add G or change those callback rules here.

## Validation and acceptance

Before implementation, independently seal original sources/products and record
the three first R-before-P paths against actual P-before-R Session peers in
fresh owned MySQL READ COMMITTED and warmed REPEATABLE READ. Source-bound SQL
latches are disclosed component seams. Observe real ConnectionIDs, held locks,
waits and complete before/held/after values; a source cycle alone is not an
observed deadlock. Preserve every nonzero observer/product exit.

The candidate must put the first P before R in all three stages, put P before
the first generic read in both supported ambient preflights on the same outer
Connection, and retain ordinary producer/admission/receipt/ACK behavior. Check
missing public Session, non-private kubernetes-workspace, forged caller/binding,
stored digest drift, actual runtime scope/generation conflict and changed
expected identity. No rejected target may acquire another tenant's P. Check
existing/missing P, caught pure validation and outer commit/rollback separately.

Run build/typecheck/bundle, focused Java tests and static/package checks, then
independent candidate schedules and two clean full-diff self-audits. Only after
this bounded prerequisite passes may the generic R-to-G increment be attempted
and both complete ambient paths tested against fresh CREATE and P-to-R peers.
Arbitrary external ambient remains unqualified. Keep Draft/maintainer review
open while configured native review has no verdict.

## Affected files and remaining work

ToolPublicationStore owns the scope prefix and original-runtime qualification;
ToolPublicationDataStore and ToolPublicationAdmissionStore call it at the
identified boundaries. Focused publication, admission, acknowledgement and
native tests retain their original controls. No runtime-broker API, TypeScript,
schema, generic callback or retirement state change is planned here.

The independent baseline reproduced six actual MySQL 1213/40001 deadlocks
(apply, candidate and install under RC and warmed RR), plus 16 ambient preflight
controls with no early P. The candidate's six schedules put P before R; both
actors succeed. Independent verification accepts 90 distinct database cases
from 100 recorded cases; ten underqualified fixture controls remain excluded.
It also runs 170 unchanged focused JUnit tests. The two final recorded-data
audits pass 38,951 data checks, with every owned process, database and port
released. These checks are not additional tests.

Accepted controls include both ambient preflights, all five persisted runtime
columns on the original outer connection, post-prefix binding drift, correct
receipt and replay, ordinary custom repositories, non-private Kubernetes
history, and later native runtime discovery. Missing-P pure-error outer commits
may preserve only P metadata, including unsupported ordinary history associated
with a private parent. Later receipt helpers may reenter the same original P;
there is no claim of one P statement across the complete path. MySQL observers
use original sealed products without Mockito; unchanged H2 unit tests retain
their original Mockito transformations, whose initial file origins alone are
bound to those products.

The immutable verification report is
`.qwen/e2e-tests/k2-publication-lock-order-candidate1-20261010T131259Z-9f0cf6cd/verification-report.md`,
SHA256 `1e1e6620e3bc21efd88765e98e9e5d5c7d32a737d290b4f605aaef276c62555f`.
Root validation passes 253 focused Java tests, Checkstyle/SpotBugs/package and
Node build/typecheck/bundle. That Java input used the earlier broker before the
separate terminal semantic increment; its evidence is not reassigned to later
sources. Observer compile/audit failures and excluded cases are retained in the
report. The baseline's interpretation that legacy missing Session/isolation
made its fixture ineligible is explicitly withdrawn there.

Generic read/PUT/lease/callback closure, complete writer inventory, immutable
cut, worker finalize, DRAINED, trusted original physical source, RELEASED/reuse
and full K2 acceptance remain outstanding.
