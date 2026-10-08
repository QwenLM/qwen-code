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

Private text attachment is implemented. Native file intent/definition admission,
atomic batch reservation/recovery, file grant execution, aggregate
DRAINED/RELEASED, physical writers, CSI NodeUnpublish, safe volume reuse, public
wiring and a fresh full acceptance matrix remain tracked in issue 13395.
