# K2 cold writer contention on MySQL

[English](2026-10-18-k2-cold-writer-contention.md) | [简体中文](2026-10-18-k2-cold-writer-contention.zh-CN.md)

Status: implemented against `a682de0e996a2b6bc0482e20bd89c55106646a14` after the published-main V10/private V11 compatibility merge. The focused MySQL 8.4 run passes all four ordinary, retirement, READ COMMITTED and warmed REPEATABLE READ cases, including generation-two claim and epoch-two installation. Full module checks and independent evidence review are separate verification steps. This addresses a software verification gap required by the [cold acceptance boundary](2026-10-09-k2-native-history-integration.md#683-cold-acceptance-and-implementation-boundary). It does not implement physical release or qualify a native installation.

## Problem

The prior two-case SQL worker acceptance produces a real boot/6, attested handle/4,
encrypted binding, native journal, authorized file effects and retained results.
Both scenarios finish with writer generation one. Other READ COMMITTED and
REPEATABLE READ tests cover ordinary mutation or legacy callbacks; they do not
exercise two qualified original CSI cold acquisitions and the winner's actual
activation installation.

The production acquisition validates the original runtime and complete native
tail before changing writer ownership. Installation validates that tail again.
Testing only a phase flag, direct SQL update, ordinary writer or manually
constructed qualification result would bypass these consumers.

## Test composition

Extend the existing SQL worker integration test and its Node producer. Preserve
the ordinary and application-retirement scenarios. Add separate fresh MySQL
cases for READ COMMITTED and REPEATABLE READ; each owns its database, worker,
HTTP endpoints, process and files.

Use the existing provisioner, encrypted binding, production HTTP clients,
runtime service and actual finite file worker. Produce the first complete
Read/Write batch through the existing native preparation, grants, real file
effects, SQL settlement and receipt operations. Cut after the last original
receipt returns and before its tool message or resolve. Keep the unfinished
producer task parked at that boundary; unwinding its Hook/Harness scopes must
not append a completion or failure after the cut.

The contention scenario uses the production authority-open, activation-install
and record-sink composition already used by the private Hosted owner. The
fixture explicitly owns its activation-renewal timer and in-flight renewal.
Stop and join that renewal, then stop and join HTTP writer renewal. Do not use
retirement, activation release or writer sealing to simulate a dead owner.
The worker, original runtime and actual working/backup file instances remain
alive. The existing assembly helper's independent timer must not remain hidden.

Observe the actual database clock and both persisted lease expiries until they
expire naturally. Choose valid finite test leases and keep unrelated runtime
leases valid through their normal production lifetime. Never update expiry
columns, replace the database clock or insert positive native/grant/result rows.

## Independent acquisitions and installation

Create two independent HTTP store clients with distinct writer IDs and the same
original retained credential. Each client's journal open must make an actual
acquisition request. The test adapter runs those requests on independent JDBC
Connections using the selected isolation level. It must not return a fabricated
grant or reuse a memoized open.
The cold scenario's other adapter transactions, including the winner's activation commit, also use and assert that JDBC isolation on the transaction-bound Connection. Resource-read receipt transactions retain their production reader composition.

At the valid cut, establish a real consistent read in both transactions before
either competing ownership update. Record their actual isolation, autocommit,
connection IDs and observed original generation/revision. This makes the RR
snapshots precede the winning head change; setting an isolation constant alone
does not suffice. Hold the original tenant runtime-placement guard on a third owned Connection,
release both contenders through a barrier and use MySQL lock-wait/Connection IDs
to observe both actual production acquire queries blocked directly by that holder before releasing it within the production five-second guard budget. MySQL may also report a queue edge between the two contenders; verify every edge's actual Connection IDs and query rather than requiring exactly two rows. The inner CSI continuation helper locks its Session root before tenant guards, but the acquire entry already takes the placement guard before invoking it. Account for the production bounded-contention refusal rather than
assuming every loser waits indefinitely.

Require exactly one grant at generation two. The other original request must
refuse, and a fresh retry while the winner is live must not acquire ownership.
Open the winner's production authority through its actual HTTP acquire grant,
restore head and complete transaction pages. The HTTP handle does not expose
`takeoverCommitProof`; rely on production transaction metadata, digest and
scan/head sequence/epoch validation, as the Hosted owner does. Do not manufacture
an expected proof from the separate local sealed-journal contract. Then invoke
the actual TypeScript activation installer.
Require epoch two, one high-level installation and only its declared production
phase transitions. Before installation, replay a previously successful original `executions:prepare`
request and require the actual installed-native-head guard to refuse it without
SQL or file changes. Do not issue an expected-failed append through the winner
authority: it permanently records a write failure. Never supply an installation
receipt from the test.

Also exercise the existing standalone content-publication route in these two
cold originals. Publish the actual first SETTLED result bytes with the production
HTTP tool-result store under the live original writer/activation. Capture its
actual 200 wire request and ref, then require an identical retry to return 200
without changing the complete SQL/file image. Use the actual stored UTF-8
`result_json` bytes, not a claim about reserialized byte equality. Keep this
PUBLISHED resource as an exact original row through claim, restore and install.
Do not insert it into the existing retirement original: that separate consumer
requires referenced native resources and this test does not establish that
closure. No production permission or resource-membership rule changes.

Capture original transaction and writer-renewal requests that actually returned
200 as well. Replay all three exact wire requests and original credentials after
takeover; each must refuse with the complete SQL/file image unchanged. This
qualifies the standalone content writer predicate only, not page/manifest
closure, consumption or retirement.

## Conservation and failure evidence

Compare complete typed table images at distinct boundaries. Claim may change
only the original head's writer identity, generation, lease and modification fields; the same retained credential preserves its exact token hash. Original journal bytes, resources/references,
executions, grants, results and runtime ownership must remain unchanged.
For this inline prefix, production authority restoration reads the head and complete transaction pages without fetching resources. Require those actual GETs to succeed and the entire SQL/file image, including existing resources and read receipts, to remain exact. Do not add a resource read merely to satisfy an observer assumption. Later Hosted receipt repair and resource hydration are separate acceptance cuts.
Installation may add only its actual activation journal transaction,
resource and JOURNAL ref and corresponding head changes, validated against the
actual committed request. An activation-only transaction adds no Session record.
Original rows and the original prefix remain exact. Do not omit whole tables from comparison.

Record original and final worker identity, file/backup bytes, device/inode and
request/effect counters. Claim and install must cause no new bind, prepare,
execute, file effect, model request, result consumption or physical operation.
Record losing and stale requests separately from the successful claim/install.
Keep failed attempts and observer corrections as separate evidence.

## Scope and acceptance

Both isolation cases must pass against disposable MySQL 8.4 with current built
Core/CLI and Java sources. Run the unchanged ordinary/retirement scenarios as
regressions, affected Java checks, the required full module checks and root
build/typecheck/bundle. Independent verification must inspect raw SQL/native
images, actual request/response outcomes, source/product pins and owned cleanup.

This is component-level claim/install contention acceptance. It does not rerun
the historical Main/Hosted SIGKILL C1 process cut or qualify model2 continuation,
all other cold cuts, page/manifest closure, production Linux CSI, native
confinement, physical RELEASED, later-cycle reuse or public selection. The
[physical completion requirements](2026-10-11-k2-physical-completion.md) remain
unchanged. No cloud mutation or privileged installation is part of this work.
