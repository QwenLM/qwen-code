# K2 alignment with the Workspace lifecycle on main

[English](2026-10-08-k2-lifecycle-main-sync.md) | [简体中文](2026-10-08-k2-lifecycle-main-sync.zh-CN.md)

## Problem and baseline

The first synchronization integrated private CSI foundation
`4f82b9d597bdc8e2c2bcba1942a344e4273c599b` with main `fe4d4e345`
after Workspace lifecycle L3. Both changed the managed journal, original
Runtime admission and publication locking; main V51 collided with an
unpublished CSI migration.

The subsequent synchronization integrates private Hosted attachment with main
`bb213cd05`. Main adds mutation-attempt sequence V52 and ordinary Hosted
resident recovery. V52 collides again with this Draft's unpublished request-pin
migration. A textual merge alone does not establish compatible behavior.

## Decisions and scope

Keep main's lifecycle claim, authorization, settlement and original Hook
recovery checks. Keep the private CSI original writer, journal admission,
publication identity and retirement checks. Lifecycle authorization cannot
replace CSI authority or make ordinary release sufficient for CSI finalization.
Run lifecycle dispatch/settlement checks before applying the journal, then use
the CSI-specific application and activation validation for an original Session.
Refusals retain the enclosing transaction rollback.

Keep both Runtime replacement refusals: lifecycle recovery cannot replace an
original Runtime, and an original private CSI request cannot create a replacement
generation. Preserve both groups of tests and both sets of schema columns.
Publication admission takes placement before CSI/retention locks. Legacy DELETE
waits behind the journal commit and takes placement before the Session.
Private CSI CLOSE/DELETE remain unavailable at persisted-profile admission and
capability projection, before writing a lifecycle operation or fence.

The subsequent integration preserves main's creator/bound-registry checks,
recorded mutation replay boundary and resident recovery. The private Hosted
registrar remains before ordinary routes; its case-insensitive owner gate
includes ordinary sessions and opening sessions. Ordinary recovery never adopts
a reserved private owner.

Leave published main V48–V52 byte-identical. The first synchronization renamed
unpublished CSI V51/V52 to V52/V53; the subsequent one renames only those Draft
migrations to V53/V54, preserving SQL bytes and order. This is not an upgrade
path for shared databases that applied unpublished numbers. All prior local
qualification schemas were owned and cleaned. Never rewrite applied history or
backfill request/activation authority.

Affected layers are Java managed Session/lifecycle stores, publication admission,
JDBC binding/schema and tests, plus the ordinary Hosted owner/recovery boundary.
No new public selector, retirement coordinator, physical stop proof or volume
reuse is added. Previous reports remain tied to their original inputs; syncing
main requires fresh checks rather than relabeling those reports.

## Validation and acceptance

The first synchronization reproduced duplicate V51. The subsequent one reproduced
duplicate V52 using actual Flyway on an immutable merge preview: it rejected both
V52 resources before creating any PUBLIC tables. Preserve that failure evidence.

After renaming, check fresh migration and upgrades from published main V52 and
request-only V53, as well as earlier supported baselines. Preserve prior migration
checksums/history, legacy row values and NULL new authority pins. Verify unique
migration versions and byte equality for published main and renamed CSI SQL.

Run affected Runtime Broker and managed Session/lifecycle tests against fresh
compiled classes. Exercise original CSI writer/finalization refusals, ordinary
claim/settlement/replay, creator/grant checks and Hook recovery. Draining remains
closed to new admission; ordinary deletion never authorizes early CSI release.
Keep failures and distinguish isolated repeats from a proved cause.

Build, typecheck and bundle the integrated TypeScript tree; run focused Hosted,
HTTP journal, tool-turn and environment isolation tests. Independently exercise
the actual Java private text entry, integrated Hosted bundle and original SQL
Store with explicit synthetic/H2/provider seams. Audit manual resolutions and
automatic merges. Keep Draft and maintainer review. Report native review
unavailability without substituting a verdict. CI, local stores and earlier
cloud runs do not establish complete K2 acceptance.

## Remaining work

Private text attachment and bounded finite native file execution are implemented.
Genuine cold takeover, all-writer closure, aggregate DRAINED/RELEASED, physical
writers, CSI NodeUnpublish, safe volume reuse, public wiring and a fresh full
acceptance matrix remain tracked in issue 13395.

## Integration with actor roles and child Sessions, 2026-10-09

The native-execution increment `f252ada3e` is integrated with main, which has
published V53 Workspace roles, V54 child lineage and V55 channel instance
binding. Keep all published migrations byte-identical. Rename only this Draft's
request, first-activation and native-authorization SQL from V55/V56/V57 to
V56/V57/V58, with unchanged SQL bytes and order. Databases that applied earlier
unpublished numbers are not an automatic upgrade target; do not repair their
history or backfill original authority. The earlier upgrade checks included main
V53/V54/V55, request-only V56 and activation V57, preserving old rows,
checksums and null native grants.

The later merge with main `e6e2c9efd` includes published V55 channel instances.
A compiled Flyway schema test reproduces the duplicate V55 before repair. Keep
that published migration and renumber only the three unpublished CSI migrations
to V56/V57/V58 without changing their SQL bytes or order. Clean stale target
resources before building and verify the complete source/packaged inventory and
upgrade sequence through V58. Earlier unpublished databases still require a
separate explicit migration strategy and are not backfilled by this change.

The final delivery also merges main `5b1c701400c949a6e943909db6fcbcb2273dc721`, which publishes operation actor-key migration V56 and enforces the caller role plus the original creator execution facts on bound Sessions. A source-inventory check reproduces the V56 collision before repair. Preserve published V1–V56 byte-for-byte and renumber only the three still-unpublished CSI files to request V57, activation V58 and native authorization V59, with unchanged SQL bytes/order. Upgrade tests cover published V56, request-only V57 and activation-only V58; the complete migration sequence ends at V59. The private creation path retains creator/owner keys and its request pin, and its child/close/delete gates remain closed. This merge requires new shipping-head checks and does not transfer the earlier process-cut acceptance to the new head. Earlier unpublished numbering still requires a separate explicit migration strategy.

Root Session creation writes both creator and owner actor keys using main's
same original actor bytes, plus the CSI request pin when privately constructed.
Current CSI fixtures use main's OPERATOR/READER role semantics; historical
migration fixtures keep their old schema columns. New public child admission
must refuse a private CSI parent in the Service before child/harness work and
again under the Store's original parent lock before replay or insertion. Copying
its profile without its original request, Pod and reservation cannot construct
a valid child. Ordinary child admission and its existing tests remain intact.

Keep the shared Hosted turn runner. Pass main's child funnel and queued
consumption into the ordinary tool turn; after the turn-result write succeeds,
flush consumed child IDs only for a completed turn. Remove each queued ID only
after its durable consumption succeeds. A refused flush logs and preserves the
owed remainder without changing the already settled turn outcome. The private
CSI caller supplies no child callback. Preserve ordinary child redrive and wake
consumption, selected runtime ownership and all existing CSI refusals.

Validate the exact integrated commit with build/typecheck/bundle, affected
Hosted/child/HTTP Store tests, Broker and Agent tests, fresh/upgrade Flyway,
style and quality checks. Independently reproduce duplicate migrations and
private-parent child admission before their fixes, then verify refusal and
original SQL conservation. Rebuild both Agent packages with the actual Broker
bytes before a fresh owned MySQL mixed/export run. Previous f252 producer
results and five earlier negative groups retain their own source/product
versions; they are not relabeled as new integrated-commit behavior. Native
review remains unavailable and Draft/maintainer review stays required.
