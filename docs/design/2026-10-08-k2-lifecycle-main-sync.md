# K2 alignment with the Workspace lifecycle on main

[English](2026-10-08-k2-lifecycle-main-sync.md) | [简体中文](2026-10-08-k2-lifecycle-main-sync.zh-CN.md)

## Problem and baseline

The private CSI foundation at `4f82b9d597bdc8e2c2bcba1942a344e4273c599b`
conflicts with main `fe4d4e345` after the Workspace lifecycle L3 change.
Both change the managed journal, original Runtime admission and publication
locking. Main also uses migration V51, which collides with an unpublished
CSI migration. A textual merge alone does not establish compatible behavior.

## Decisions and scope

Keep main's lifecycle claim, authorization, settlement and original Hook
recovery checks. Keep the private CSI original writer, journal admission,
publication identity and retirement checks. Lifecycle authorization cannot
replace CSI authority or make ordinary release sufficient for CSI finalization.
Run the lifecycle dispatch/settlement checks before applying the journal,
then use the existing CSI-specific application and activation validation for
an original CSI Session. Refusals retain the enclosing transaction rollback.

Keep both Runtime replacement refusals: a lifecycle recovery cannot replace
an original Runtime, and an original private CSI request cannot create a
replacement generation. Preserve both groups of tests and both sets of schema
columns. Publication admission takes placement before the CSI/retention locks,
matching the existing placement-before-retention order. Main now requires
legacy DELETE to wait behind the journal commit too; its entry must acquire
placement before the Session, preserving main's two committed revisions.
Keep private CSI CLOSE/DELETE unavailable at persisted-profile admission and
capability projection, before writing a lifecycle operation or fence.

Leave main V48–V51 byte-identical. Rename only this Draft's unpublished
request pin and first activation migrations from V51/V52 to V52/V53, keeping
their SQL bytes and order. This is not an upgrade path for a shared database
that already applied the unpublished numbers. Prior local qualification
schemas were owned and cleaned. Do not rewrite applied history or backfill
request/activation authority.

The affected layers are the Java managed Session/lifecycle stores, publication
admission, JDBC Runtime binding/schema and their tests. No new public selector,
CSI retirement coordinator, physical stop proof or volume reuse is added.
The Hosted Parts report remains evidence for its original commit; syncing main
requires fresh checks and does not extend that report to a new build.

## Validation and acceptance

Verify actual Flyway rejects the duplicate V51 before the rename. After the
rename, check fresh migration and upgrades from main V51 and request-only V52:
retain prior migration checksums/history and legacy row values, and leave the
new authority pins NULL. Verify all migration versions are unique.

Run the affected Runtime Broker and managed Session/lifecycle tests against
fresh compiled classes. Exercise the original CSI writer and finalization
refusals, ordinary lifecycle claim/settlement, and original Hook recovery.
Keep new admission closed during draining; ordinary Workspace deletion must
not authorize early CSI release. Preserve failures and distinguish isolated
repeats from a proved cause.

Build, typecheck and bundle the integrated TypeScript tree; run focused Hosted,
HTTP journal, tool-turn and environment isolation tests. Audit the resolutions
and automatic merges at the overlapping boundaries. Keep Draft and maintainer
review requirements. Native review unavailability must be reported without
substituting a reviewer verdict. CI, local stores and earlier cloud runs do not
establish complete K2 acceptance.

## Remaining work

The native conversation admission and private producer integration, atomic
batch reservation/recovery, aggregate DRAINED/RELEASED, physical writers and
CSI NodeUnpublish, safe volume reuse, public wiring and a fresh full acceptance
matrix remain separate K2 work tracked in issue 13395.
