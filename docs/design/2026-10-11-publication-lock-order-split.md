# Publication placement before retention

[English](2026-10-11-publication-lock-order-split.md) | [简体中文](2026-10-11-publication-lock-order-split.zh-CN.md)

## Problem and scope

Publication mutation can take a retention lock before the Session writer path
takes placement. Admission takes placement before retention. Concurrent
transactions can therefore wait on each other in opposite orders. An ambient
transaction can also retain preflight locks through the later admission call.

Extract the ordering increment from PR #13526 against current main. Cover
publication mutations, admission preparation, admission installation, and
verification quarantine for ordinary and existing K1 publication flows.
Private CSI Session guards, new producer restrictions, generic retention,
native execution and retirement qualification remain separate work.

## Decision and contract

Before choosing placement, read the actual stored publication and validate its
scope, canonical binding digest, publication ID and original Runtime identity.
For a new reservation, use its qualified candidate binding. When a JDBC Runtime
repository shares the database, verify persisted tenant, Workspace, generation
and provisioner fields as well as the discovered binding.

Take placement before retention, quota and Session writer locks. Preflight
participating in an existing transaction acquires the same qualified placement
before it can retain later locks. Standalone preflight retains its existing
transaction boundaries. Reuse the qualified original Runtime while following
the existing K1 retention path.

After locking the publication row, compare the complete binding and digest with
the preflight target. Admission and quarantine also constrain their locked row
queries to the original tenant, Workspace and Session. A stale or conflicting
target refuses rather than acting on another publication.

No route, schema, public selector or private CSI execution authority changes.
The existing placement guard may be recreated for a qualified missing guard.
If an ambient caller catches a later failure and commits, that metadata can
remain; it does not establish successful admission or a file effect.

## Validation and acceptance

Use a fixed main baseline and candidate with the same concurrency schedules.
Confirm a competing placement owner does not deadlock with publication
mutation or admission preflight. Test standalone and ambient transactions.
Verify stored-row scope, binding key, publication ID, digest, persisted Runtime
tenant, Workspace and generation conflicts refuse before selecting placement
and roll back publication, quota and journal changes. Keep the ordinary
missing-Session reservation and its exact replay available.

Run the affected publication/admission tests, static Java checks, packaging,
root build/typecheck, independent database verification and two clean full-diff
audits. Report database isolation and actual schedules exercised. H2 tests alone
do not qualify MySQL contention. This slice does not establish full K2,
physical release, CSI unpublish, volume reuse or generic retention closure.
