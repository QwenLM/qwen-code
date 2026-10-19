# K2 private background retention boundary

[English](2026-10-10-k2-private-background-retention.md) | [简体中文](2026-10-10-k2-private-background-retention.zh-CN.md)

Status: implemented with bounded independent baseline/candidate qualification.
Native review has no verdict; maintainer review and full K2 remain open.
Baseline `bc2ba382a2a163abd8c3331d4b3939097c4997f2`. Refs #13395 and Draft
PR #13526. Full K2 remains incomplete.

## Problem and current behavior

The ordinary collector discovers up to 32 RETIRING/DELETING publications,
claims one, renews before each object DELETE, then confirms SQL collection.
None of these stages excludes a persisted private Session. A confirm-only guard
would be too late: physical DELETE precedes confirmation. Confirmation also
clears inline bytes, held capacity and expired Session read leases. Renew and
defer currently update without an independent transaction or target check.

Ordinary reservation fences every expired OPEN publication in the tenant and
releases its held capacity. A valid ordinary caller cannot authorize changing
another private Session. Exclusion must not remove private held capacity or
active captures from quota totals.

## Goals and scope

Freeze unsupported historical private publications in discovery, claim,
renew, defer and confirm, including existing claims. Exclude their actual
stored targets from ordinary cross-Session expiry. Preserve ordinary journals
without a public Managed Agent Session and original deferred_v3 publications.
The existing generated `csi_guard` is TRUE for the private file profile or a
retained `runtime_request_key`; changing only the profile cannot remove it.

This is legacy exclusion, never original native authority. It adds no native
collector, schema, public switch, read/PUT capability, application cut, worker
finalize, DRAINED, physical stop/unpublish, RELEASED or reuse. Generic
publication/resource read, PUT, quarantine and error callbacks remain later
work. OPEN/UNKNOWN native read history remains unresolved even after lease
expiry.

## Collector discovery and transactions

Group the complete RETIRING/DELETING OR predicate and correlate a NOT EXISTS
private filter against each publication's stored tenant/Session before ORDER
BY/LIMIT 32. Skipping in Java would starve ordinary work behind 32 immutable
private rows. Discovery is a fairness hint, never mutation authority.

Every mutation runs in a short transaction. Peek the current stored publication
tuple, lock its retention tenant, then use `ManagedLegacySessionGuard.isPrivate`
as the existing current FOR UPDATE TRUE probe before head/publication locks.
For private refusal, mark the transaction rollback-only and return its existing
no-work result; even a possible tenant upsert must disappear. Do not write a
blocker or retry date. After the ordinary check, lock the head and exact
publication and compare its tenant/Session again with the peek. Disappearance
or tuple mismatch refuses without committed writes.

Claim builds its identity from that locked row. Renew, defer and confirm derive
their target from the stored publication again and compare it with the claim's
tenant/Session, owner and generation. Claim JSON is not target authority. Renew
qualifies before each physical DELETE; defer qualifies even on the error path.
Confirm qualifies before cursor, inline/resource cleanup, quota or expired lease
removal. Keep object DELETE outside SQL. Enabled `runOnce` rejects an ambient
transaction or bound DataSource before claim, so its transaction cannot span
object I/O. Disabled collection keeps its no-work behavior.

The collector order is retention tenant → current TRUE exclusion → head →
publication. It never requests placement or original native admission. This
matches the existing legacy result completion order. A private TRUE probe can
wait on the original Session, but does not continue to request a native parent.

## Lock compatibility and target establishment

Placement and publication retention tenant are different locks. Current native
writers take placement → retention tenant → original parents → head. Private
CREATE and Broker pin validation take placement → Session pin in their own
transactions, without later requesting retention tenant; their locks are
released before a subsequent writer transaction. CREATE allocates a fresh UUID.
Current production does not promote or reassociate an existing ordinary Session
by updating its profile, request pin or identity.

Ordinary publication apply and both DataStore verification phases already have
retention tenant → placement paths. Introducing placement-first collection
would add an inverse wait direction and require broader changes, including
ordinary ambient compatibility. This design keeps the collector's existing
tenant order and adds only the TRUE exclusion before its child locks.

Protocol0 DELETE does a negative TRUE probe before retention tenant. It does not
insert or promote a Session in that gap. A fresh exact forced-index experiment
measured four RC/warmed RR schedules with an existing FALSE or missing Session.
The old actor actually waited on the collector's tenant lock; collector probes
of the same negative key and adjacent existing TRUE key both returned before
release. RR's negative `X,GAP` and positive `X,REC_NOT_GAP` coexisted; RC retained
no Session record/gap lock after the negative probe. All reduced-table values
were unchanged, SQL had no errors, and owned resources were cleaned. This is
a two-table measurement, not proof of the complete product lock graph. Full
product qualification must separately exercise supported paths and retain any
observed failures. This design does not authorize raw SQL guard promotion.

## Tenant-wide reservation expiry

Use the minimal correlated NOT EXISTS against each publication's actual
`tenant_id`/`session_id` and `csi_guard = TRUE` in the existing expiry UPDATE.
Keep both capacity SUMs and the active capture SUM unchanged. Ordinary expiry,
reservation replay and quota refusal retain their existing behavior.

The UPDATE runs after `lockPublicationWriter` returns. On the actual transaction
connection that method has already acquired the caller tenant's placement lock,
as well as retention tenant, before head qualification. Supported private CREATE
and Broker pin establishment therefore cannot cross the expiry statement while
holding that placement lock. Do not move a new target-parent lock after the head
or add an unqualified late native resolver. Existing ordinary ambient behavior
is not changed in this increment.

This prerequisite is conditional on the supported `apply` transaction using the
same DataSource and passing the original transactional-connection check. Its
nontransactional ordinary fallback does not acquire placement; normal return
alone is not proof. Verification must observe the actual held placement row
before expiry, rather than infer it from the method name. A mismatched manager
is outside that verified configuration.

The isolated MySQL 8.4.11 experiment used only three reduced tables. RC and
warmed RR DML saw private membership committed after an old plain SELECT.
RC did not wait for an uncommitted raw guard promotion and fenced that toy row;
RR waited on a shared Session lock. Explicit inverse X-lock probes deadlocked
under both levels. These are real observations, not product acceptance or proof
that raw promotion is supported. The filter alone is insufficient; its product
placement prerequisite and quota totals need independent verification with the
full schema and actual reserve caller.

## Components and compatibility

| Component                 | Change and consumers                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ToolPublicationCollector  | Filter before paging; independently qualify stored targets in all four mutation stages. Scheduled tick and runOnce are the production entry points. |
| ManagedLegacySessionGuard | Reuse current TRUE exclusion; no global lockSession change or native authority.                                                                     |
| ToolPublicationStore      | Private target filter in ordinary reserve expiry; controller grant is the apply consumer. Existing capacity sums retain private quota.              |
| Collector/Store tests     | Historical private fixtures, ordinary journal-only/deferred_v3 controls, starvation, forged claims, ambient refusal and actual MySQL observations.  |

Missing public Session metadata remains ordinary compatibility. Missing or
conflicting private original authority stays frozen and is not repaired by a
legacy check. Existing stale owner/generation/claim checks remain necessary.

## Validation and acceptance

Use feat-dev sequential phases. Attempt globally installed qwen discovery first;
its public CLI exposes no private Java collector selector. Use an explicitly
bounded Java/JDBC fallback with independently copied and sealed products. Create
a real private Session, then clearly label seeded historical publications,
objects and claims as adversarial fixtures, never natural native publication
authority. Separate preparation/restoration from each observed call.

Baseline must demonstrate actual private DELETE or gc/inline/quota/lease changes
and cross-Session expiry through actual ordinary reserve. Candidate must keep
every private row value unchanged and issue zero private object DELETE calls.
Cover both RETIRING/DELETING branches, over 32 earlier private candidates,
retained pin with changed profile, preexisting claims, renew/defer/confirm,
forged target tuples, error paths and retained OPEN/UNKNOWN reads/leases.

Owned MySQL READ COMMITTED and warmed REPEATABLE READ must observe current
qualification before child mutation, actual connection/isolation/lock waits and
all discovered base-table values. Verify actual reserve holds placement before
expiry and private held bytes/captures remain charged. H2 cannot prove MySQL
ordering. Ordinary missing-Session collection, active reader/UNKNOWN PUT
blockers, claim races, pagination, lost DELETE response, reserve replay/capacity
and original deferred_v3 completion/receipt remain controls.

Run repository build/typecheck/bundle, focused Collector/Retention/Publication/
Acknowledgement and boundary tests, applicable Java static/package checks,
independent candidate verification and two clean full-diff self-audits. Native
review currently returns configured model quota HTTP403 with no verdict. Do not
substitute a test-engineer report for review approval. Preserve every original
failed window and independently clean only registered owned resources. Keep
the PR Draft and maintainer architectural review open.

## Independent baseline and local implementation

The independently sealed baseline exercised 20 actual Java scenarios on owned
MySQL 8.4.11. Natural private CREATE preceded explicitly injected unsupported
historical rows. Public runOnce collected both RETIRING and DELETING private
rows, called a recording DELETE adapter, cleared exact inline bytes/quota and
removed expired leases. A 42-row private backlog changed the first 32 private
retry/blocker fields and delayed ordinary work. Retained request pins did not
prevent collection. Actual ordinary reserve fenced private expired OPEN rows
under RC and warmed RR; six actual expiry statements held the exact connection's
placement X RECORD lock in the supported same-DataSource transaction.

The single actual Java process exited 0. Final read-only audits checked 119
predicates plus 60 additional identity/origin checks across all 62 tables and
827 columns. Initial launcher and two offline audit failures remain preserved;
correcting audit expectations did not rerun product observations. All registered
owned resources were independently cleaned. Reflective renew/defer/confirm
probes are component seams, and the recording DELETE adapter is not actual
object storage or CSI evidence.

The local change adds the grouped discovery filter, current stored-target
qualification for claim/renew/defer/confirm, enabled ambient refusal, and the
minimal ordinary expiry exclusion. No migration or quota SUM changes were
needed. Unit cases additionally cover a stale discovery page, 40 mixed-state
private rows, retained pins, forged claim tuples, private tenant-upsert rollback,
ambient/bound connection refusal and both decisive private quota dimensions.
Repository build, typecheck and bundle passed. Focused Java verify passed all
207 tests (Collector 50, Publication 114, Retention 18, Acknowledgement 25),
with zero Checkstyle or SpotBugs findings. Earlier compile-overload, duplicate
fixture resource and indentation failures are retained with their original exits.

## Independent candidate qualification

The main sealed candidate completed 52 actual Java boundary/control scenarios
on owned MySQL 8.4.11 before an old-protocol fixture reset failed because the
observer removed a binding but retained its slot. Its actual Java exit remains
1, and the missing final fixture snapshot is not acceptance. Read-only audits
passed 559 predicates plus eight closing checks for the completed scenarios.
Private discovery/callback/retained-pin refusals preserved every discovered
base-table value and issued no private DELETE. Ordinary quota, active-reader and
UNKNOWN PUT blockers, 106-object paging, lost DELETE retry, two-collector claim
contention and ambient/bound-source/disabled controls were observed. Ten actual
reserve expiry statements held the exact connection's placement X RECORD lock.

A fresh, independently sealed database supplemented the original non-private
deferred_v3 producer/finish/admission/receipt/projection control. Actual Java
exited 0; receipt revision/sequence 3, original `abc` bytes, READY projection,
two artifacts and two RETURNED PUT attempts were verified. Its wrapper exit 1
and initial offline audit failure remain preserved: the auditors omitted normal
PUT attempts and preexisting revision-2 references. Corrected read-only audit
passed 86 predicates, checking 37 exact changed rows across 17 tables while
preserving old references. It did not rerun product observations or add private
history to this ordinary component fixture.

A separate R5/R3 candidate window passed 21 component/control scenarios with
1,054 JDBC events, 16 monitored waits and no SQL errors. Eight private
renew/defer/confirm/forged-renew RC/warmed-RR cases held retention tenant and
waited for the current TRUE Session before head/publication child locks or
mutation. Before/held/after full values were equal, tenant upserts rolled back
and private DELETE calls stayed zero. Missing-Session ordinary components and
two public runOnce controls succeeded. Four protocol0 negative-probe/tenant
prefix schedules completed without reverse waits; RR missing-key supremum
locks are recorded as such. Its first observer window remains exit 1 because
an extra ambient wrapper caused UnexpectedRollbackException; the corrected
window used a fresh database and did not adopt that failure as success.

All windows discovered 62 base tables and 827 columns, checked sealed
source/product/dependency and actual loaded origins without drift, and
independently verified cleanup of their owned databases/users/servers,
PIDs/groups/listeners/temp roots. Root documentation was subsequently updated
to record these results; observed production/test products were not changed.
Reflective callbacks, injected historical rows, warming instrumentation,
protocol0 component prefixes and recording object adapters remain explicit
seams. No window proves actual object storage/CSI deletion, arbitrary ambient
lock composition, complete deployment lock safety, native authority or full K2.

## Risks and open questions

Bounded full-schema qualification covers the recorded callbacks and controls.
Reduced-schema negative-probe measurements do not generalize all plans,
cardinalities, secondary indexes or deployment consumers. No observed
SQL wait is a complete lifecycle proof. Future
same-ID association needs a lifetime CREATE/read/PUT barrier before being
supported. Remaining callbacks and full immutable inventory must close before
an application cut. ACK diagnostic collectors exist but have not been qualified
as original-incarnation/cut-bound physical retirement sources. Complete stop,
unpublish, release and reuse remain later acceptance gates.
