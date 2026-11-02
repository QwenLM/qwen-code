# Managed HTTP recovery from native journal snapshots (PR3)

[English](2026-10-26-managed-http-snapshot-recovery.md) | [简体中文](2026-10-26-managed-http-snapshot-recovery.zh-CN.md)

## Problem and baseline

This is the HTTP recovery slice of [#13184](https://github.com/QwenLM/qwen-code/issues/13184), following the [PR2 native snapshot contract](2026-10-26-managed-native-journal-snapshots.md). At the PR2-only baseline, named `committed-prefix-v1` snapshots were available, but HTTP restoration still read every transaction from revision zero and had no production snapshot selector. A client option without a producer would not connect recovery to these snapshots.

The HTTP slice was developed against PR2 [#15569](https://github.com/QwenLM/qwen-code/pull/15569), initially at `c144d2fa65ff1f31e616fd73d205eabdff7dbf18`. PR3 [#15599](https://github.com/QwenLM/qwen-code/pull/15599) is now merged into that branch, and #15569 delivers the protocol/storage and HTTP recovery slices together to main. This document retains the HTTP slice's design; combined acceptance requires both designs' gates on the accepted integrated revision. This is a lossless prefix transport, not compact authority state: snapshot size, replay work and resident history remain proportional to history.

## Scope and decisions

Select an already published snapshot on the existing internal Session-scoped `GET /restore` route when Core journal restoration requests `includeNativeSnapshot=true`. Return the original flattened restore fields plus an optional `nativeSnapshot` descriptor. Head-only consumers, including append settlement and the final writer probe, omit the query and do not consult snapshots. No new route, boot option, schema change or automatic snapshot publisher is needed. Old clients retain their original response; new clients use the legacy transaction path when no descriptor is advertised. A selected corrupt snapshot fails recovery instead of choosing another snapshot or silently replaying a different history.

Keep `ManagedSessionStore.restore` and its `RestoreHead` model unchanged. Only the HTTP controller wraps its response. Java history readers, the original-CSI inline receipt-checkpoint format, append settlement and lifecycle/recovery consumers continue using their existing authoritative paths. No journal deletion, replay-floor advance, local replacement, memory eviction or independently authoritative terminal archive is enabled.

## Server selection and ownership

Authenticate the existing tenant/Workspace/Session writer before selection. Read the frozen restore head, then select one committed native manifest owner at or below its journal revision. Query exact Session scope, `NATIVE_SNAPSHOT` ownership and manifest kind; order by coverage descending and resource identity for a deterministic tie. Unpinned in-progress claims are not candidates.

Reuse PR2's named descriptor/resource validation, require the selected root and owner coverage to match the returned manifest, and recheck the writer generation. The frozen head may remain behind a concurrently advancing live head; it must not regress or cross generations. Non-restorable heads retain their existing response without selecting a snapshot. A corrupt selected root is an error, never a cache miss. Selection holds no head lock while the client downloads pages.

After validating a candidate, leave it unadvertised if its ID is exactly `.` or `..`, or contains `/` or `\`: the existing named HTTP routes cannot address those otherwise-publishable names. That response retains journal recovery rather than searching for another candidate. Unicode and encoded semicolon names remain eligible. This eligibility decision happens before descriptor advertisement; corruption still fails validation first and clients never fall back after selecting an advertised descriptor.

The response remains internal and Session-scoped. Existing controller authentication, tenant headers, writer tokens and Workspace checks remain authoritative. Snapshot/page ownership remains pinned by PR2; recovery adds no resource owner and publishes nothing.

## HTTP client recovery

1. Acquire the existing writer and freeze a validated restore head.
2. If `nativeSnapshot` exists, require the exact scope, supported format/payload/storage version, positive bounded coverage, page count and valid resource metadata.
3. Read the named snapshot pages with the current writer. Verify page kind/schema/size/SHA-256, contiguous revision/cursor progression, previous-page digest chain, final digest and page count. The descriptor exposes a manifest object and reference, not raw manifest bytes: do not invent a cross-language JSON canonicalization contract by hashing `JSON.stringify` of that object.
4. Parse each transaction through the existing record/metadata validation. Check genesis, sequence, previous commit digest, activation and checkpoint continuity. Validate resource census identities, metadata, distinct count, direct dependencies and declared nested dependencies, reading original resources through their existing verified path. Native manifest/page references never go through ordinary resource routes.
5. Require the reconstructed prefix position to match its manifest, then read only transactions after the covered revision through the frozen head. Never adopt a newer head returned indirectly by a live page.
6. Validate the complete journal with the existing scanner and exact frozen head before returning it to `LocalManagedSessionAuthority`. A `maxBytes` projection cannot bypass complete snapshot validation. Recheck the writer fence before adopting the result.

No snapshot means the existing full-journal path. Once a snapshot was selected, missing/corrupt pages/resources, unknown formats, discontinuities or stale writers stop recovery. An error cannot rerun tools, create replacement operations or mutate the journal. Pending append settlement retains its exact direct transaction probe rather than consulting snapshot replay.

## Components and compatibility

| Component                         | Change                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Native snapshot repository        | Select an eligible committed descriptor against a frozen head.                                      |
| Internal Session-store controller | Flatten the existing head with an omitted-when-null descriptor.                                     |
| Core HTTP store                   | Validate and reconstruct snapshot prefix plus live tail using existing authority journal semantics. |
| Focused Java/Core tests           | Selection, JSON compatibility, corruption, resource closure, takeover and idempotent recovery.      |

Ordinary Hosted attachment and private CSI initialization already construct the same Core HTTP store, so no otherwise-unused option is added. PR2's publication boundary continues to refuse private original-CSI mutation; PR3 does not broaden that admission. The separate read-only `qwen-csi-receipt-checkpoint-snapshot/1` inspector remains offline and unchanged.

## Validation and acceptance

- Try the installed global CLI first, then use a direct protocol/adapter fallback because no public command controls native snapshot publication or selection.
- Prove an old snapshot plus newer tail restores the same commands, outcomes, events, checkpoints and resources as complete journal replay; old operation retries preserve the original transaction and sequence range with the existing current committed high-water mark, and conflicts still reject.
- Prove an exact-head snapshot makes no prefix `/transactions` reads; absent snapshots preserve the legacy path.
- Reject wrong scope/format/coverage, page digest/chain/cursor corruption, missing or conflicting census resources, stale generations and corrupted selected manifests. Test bounded `maxBytes` reads as well.
- Cover newest-eligible selection, deterministic ties, unpinned claims, frozen upper bounds, old writer refusal and unchanged legacy response shape. Run focused real MySQL selection/HTTP checks within the module's shared ten-minute local verification budget; preserve full CI gates and record unavailable real paths.
- Run affected Core/CLI consumer tests, repository build/typecheck/bundle, Java compilation/style and selected tests, bilingual/reference checks, two clean self-audits and independent review. Local passes, test-double HTTP evidence and real MySQL/process evidence are reported separately.

HTTP acceptance establishes the lossless snapshot restore path. Combined #15569 must also satisfy the native protocol/storage design's publication, ownership, fencing and retirement gates. Selected local or fast-CI passes do not replace required full profiles or a successful final integrated real-process recovery check. Acceptance does not qualify compact snapshots, bounded service memory, physical crash durability, migrated Java history readers or production Hosted/CSI recovery.

## Risks and follow-up

Recovery validates extra snapshot metadata and original resource dependencies, so it may reject a previously unnoticed inconsistency. The complete prefix still consumes history-proportional CPU and memory. Selection adds an ownership-index query; no automatic publisher increases snapshot count in this increment. Unsupported schema/storage combinations remain refused.

PR4 adds lease-aware local recovery. A later compact-state format and persistent history completeness boundary must precede the authority memory window. All old-history consumers must be migrated before deleting any live journal prefix. #13184 remains open.

## Open questions

None for the lossless consumer slice. Compact-state representation, publication scheduling and retention policy remain separate designs.
