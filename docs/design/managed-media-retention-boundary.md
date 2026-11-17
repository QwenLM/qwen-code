# Managed media retention boundary

[English](managed-media-retention-boundary.md) | [简体中文](managed-media-retention-boundary.zh-CN.md)

## Current producers and problem

The P3 issue [#13884](https://github.com/QwenLM/qwen-code/issues/13884)
predates the shared schema consolidation. At `06efd789b1`, the Session
collector already releases retired journal owners and collects unreferenced
immutable SQL resources without restricting their kind. The remaining work
must distinguish actual producers from a proposed shared-object lifecycle.

Within its existing conversion and durable-size limits, the Hosted file-result
producer accepts inline media and `fileData` locators and converts them into
function-response parts. The ordinary Hosted turn publishes the converted
response as `managed-tool-outcome`, writes tool-result history separately as
`managed-message`, and settles a Harness checkpoint that references the outcome.
These bytes use the Session's
private `MYSQL_INLINE` resource namespace. Two Sessions may contain identical
bytes and the same resource ID, but their `resource_key` values differ. This
is independent storage, not one physically shared object.

The ordinary omni pipeline uses a different, content-addressed filesystem
store with a global media-memory ledger. Its existing GC protects referenced
objects, stops on unreadable or recently corrupt memory, and invalidates
upload/degradation caches after deletion. It is not connected to Hosted
Session permanent retirement. The ordinary Hosted restore validator explicitly rejects a nonempty
`output.mediaRefs` layout; source inspection finds no current Hosted producer
populating that field.
The private CSI Session profile is separately guarded and remains excluded
from the Session collector.

## Supported SQL lifecycle

The native witness executes the ordinary Hosted `read_file` turn on the
existing `hosted-workspace-shell/1` profile, including its real conversion,
outcome publication, message sink, activation, Harness runtime settlement,
transaction descriptor, and nested-reference discovery. Only the external
Runtime boundary is substituted with an inline-media result. A small in-memory
resource/journal transport captures all eight transactions and their eleven
resources; the Java witness acquires a real writer and commits those
transactions through the real SQL Session store. It does not handcraft a
checkpoint or change referenced resources into collectible publications. The
fixture proves accepted inline-result retention; it does not test a remote
filesystem, model, codec, or the external Runtime process.

Live Sessions and closed writers retain their media evidence. Authenticated
reads with a live writer grant and a fresh recovery reader after writer seal
must return the exact original bytes; sealing does not grant ordinary reads. A
reader lease and persisted recovery protection independently prevent retired
Session owner release. GC remains disabled by default. After permanent
retirement, grace expiry, and closure of readers/recovery, bounded owner
release precedes byte collection. The durable collection result counts each
cleared byte once, survives collector restart, and keeps the original resource
identity and digest as a tombstone. The fixture advances only its own retirement
timestamp after exercising real retirement and disabled GC, avoiding a
zero-grace clock-boundary assumption. Collecting one Session's private copy must
leave another Session's identical copy and journal readable.

The reference predicate checks every owner by `resource_key`, including a
foreign Session's ledger row. A defensive test inserts such a row explicitly
and proves it prevents deletion. This is a safety predicate witness, not an
API that creates physical sharing. A completed collection cursor does not
currently revisit a previously held row when that foreign owner later
releases it, so this test cannot establish a complete shared-object lifecycle.

## Unimplemented boundary

Physical Hosted media sharing needs an actual producer contract and a durable
Session-to-object closure before a collector can release shared bytes. That
work must distinguish a verified empty ledger from a missing/corrupt ledger,
preserve all live Session references, revisit deferred candidates after the
last release, and prevent upload/degradation caches from resurrecting deleted
objects. External `fileData` bytes remain owned by their external producer;
collecting the SQL locator does not delete the remote object.

This change does not create a speculative Hosted omni adapter or enable a
new recovery layout. It does not close [#13884](https://github.com/QwenLM/qwen-code/issues/13884) or claim production physical
collection acceptance. The future physically shared lifecycle and the
deployment gates in [#13090](https://github.com/QwenLM/qwen-code/issues/13090)
remain open.

## Validation and acceptance

Focused H2 and disposable MySQL 8.4 cases cover the actual native-produced
inline media outcome and history, exact read/reopen, duplicate-content Session isolation,
reader and recovery holds, default-disabled GC, owner-release ordering,
retirement fencing, collection restart/accounting, and defensive foreign
reference protection. Temporary owner-release and reference-predicate
mutations must fail the relevant witnesses, then restore production source.
The ordinary omni corruption and cache tests qualify its existing separate
boundary; they do not establish Hosted retirement support.

Run the Java checks with JDK 21, the focused MySQL class/method filters, both
Checkstyle gates, and SpotBugs. Native fixtures require built Core/CLI outputs
matching the unchanged main TypeScript source. Broad integration/full-module
qualification and independent review are separate evidence. No schema,
production code, public API, or default changes are proposed.
