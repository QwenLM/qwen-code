# Native Managed Session journal snapshots (PR2)

[English](2026-10-26-managed-native-journal-snapshots.md) | [简体中文](2026-10-26-managed-native-journal-snapshots.zh-CN.md)

## Problem and current state

Issue [#13184](https://github.com/QwenLM/qwen-code/issues/13184) needs a native restore boundary before journal deletion or authority eviction is safe. The Java public message snapshot cannot restore a Harness. Before the protocol and HTTP recovery increments, the native journal exposed a head and transaction pages starting at revision zero. Its `compacted_through_revision` remains zero for live Sessions.

The authority reconstructs command replay, event identities, receipts, checkpoints, Actions, domain revisions, extension uniqueness, Hook once keys and occurrences, and child continuations from the native committed prefix. Neither a Harness checkpoint nor Java's latest-record projections contain all these facts.

## Scope and dependency order

PR1 (activation/inbox identity lookup) and this PR2 can be developed independently. PR3 (Hosted HTTP recovery) and PR4 (local lease-aware replacement) depend on the snapshot contract; PR5 enables resident windows only after durable identity lookup and both restore paths are verified. This updates the earlier serial development recommendation in the [bounded-retention design](2026-10-19-managed-session-bounded-retention.md).

PR3 [#15599](https://github.com/QwenLM/qwen-code/pull/15599) is merged into the PR2 branch. [#15569](https://github.com/QwenLM/qwen-code/pull/15569) delivers both increments together to main. This document describes the protocol/storage slice; the linked [HTTP recovery design](2026-10-26-managed-http-snapshot-recovery.md) describes its production consumer. Acceptance of the combined PR requires both slices.

The storage slice provides publishing, immutable storage, integrity checks, resource ownership, and bounded page reads. The HTTP slice connects Core journal restoration to an already-published snapshot and its continuous tail, while preserving head-only settlement and legacy restoration when no eligible snapshot is advertised. Automatic publishing, native transaction deletion, public event snapshot changes, local journal replacement, and authority eviction remain out of scope. The first payload format is explicitly `committed-prefix-v1`: a lossless replay image, rather than a claim of compact authority state. Its size and replay work remain proportional to history. A future compact format must explicitly preserve every authority index and historical query contract; it cannot reinterpret this version.

## Protocol

All new routes are internal, Session-scoped, and require the same tenant/Workspace credential and live writer grant as native journal reads:

| Method | Suffix under `/internal/managed-session-store/v1/sessions/{sessionId}` | Behavior                                                                                   |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| POST   | `/journal-snapshots:publish`                                           | Publish a named snapshot from an exact committed head.                                     |
| GET    | `/journal-snapshots/{snapshotId}`                                      | Read its immutable descriptor.                                                             |
| GET    | `/journal-snapshots/{snapshotId}/pages`                                | Read at most 100 pages, within a response byte budget, after an exclusive revision cursor. |

Publish names `snapshotId`, `workspaceId`, writer ID/generation, expected journal revision, expected committed sequence, and expected last commit digest. The server generates the payload from authoritative committed rows; callers cannot upload an opaque authority state. A valid current writer may retry an existing ID with the same head tuple and receive the original descriptor, including after a subsequent append. Reusing the ID for another head is a conflict. Old generations and expired or sealed writers cannot publish or read.

The descriptor binds format, tenant/Workspace/Session, snapshot ID, covered journal revision, committed sequence, commit digest, activation epoch, latest checkpoint, storage version, page count, resource count, and final page digest. Each page contains one complete `StoredTransaction`, its exact record bytes and commit marker, original command/operation/content digest and sequence range, its resource census, and the preceding page digest. Pages start with genesis and form a contiguous digest chain. The descriptor commits the final page digest. Consumers must verify page digests and continuity, the final digest, native record/marker semantics, resource references, and the snapshot-to-tail boundary before accepting recovery.

This lossless representation preserves all source facts needed to reconstruct execution recovery state, command replay, and authority indexes. It does not promise a ready-to-install serialized private TypeScript object or a smaller in-memory state.

## Storage and publication

Native manifests and pages use distinct resource kinds, `managed-native-journal-snapshot` and `managed-native-journal-snapshot-page`, in `ma_resource`. They never use `ma_snapshot` or its public projection fields. The new `NATIVE_SNAPSHOT` resource owner pins the manifest, pages, and complete original resource census. Its owner key is derived from Session scope and snapshot ID, with coverage as owner revision. Page resources use content-derived IDs and may be shared by multiple snapshots. Original resource bytes remain immutable and use the existing inline/publication verifiers and read boundary.

An initial short transaction authenticates before state lookup, requires ordinary admission and READY recovery state, and captures a head plus a durable retirement read lease. The build runs in a separate READ_COMMITTED transaction, claiming only its named manifest row and private native page rows while copying the immutable prefix. Source batches and resource bodies are read through separate short transactions without retaining tenant/head locks or updating source metadata. The initial read lease is checked without renewal and limits a build to its existing 120-second horizon. Concurrent append or takeover can proceed and makes a new publication fail its final CAS.

Only final publication takes the existing placement/publication/root/head locks, reads the current locked head, and validates revision/sequence/digest CAS. Original resource FK pins are copied in one SQL statement after those guards, with a two-second query timeout; taking those resource locks during the build would invert the ordinary writer order. A fresh database-time writer check also follows the final inserts. Any failure rolls back the claimed manifest, pages, and ownership together, leaving no staged build to collect. Original resource references retain their source revision in each page census. Missing, corrupt, foreign, collected, or incompletely referenced resources abort publication. Publishing consumes no journal revision or sequence and never advances a live replay floor.

The manifest claim validates an existing row's scope, kind, schema, storage, and state before reuse. Ordinary commit/tool-result/inherited-extension publication and generic resource reads reject the reserved native resource ID namespaces; native reads use the dedicated nonlocking path. This prevents a normal writer from holding a head lock while waiting on a build's private manifest/page row. Event dependencies are enumerated at schema-declared fields, including the optional header `baseTranscriptProof`; arbitrary JSON such as `cancel.requested.target` is data. Resource graph traversal is iterative, so the JSON nesting bound does not become a limit on the number of history pages.

Each page and each page response is capped at 16 MiB of decoded page bytes, with at most 100 pages per response. Base64 increases the wire size. The first format still duplicates native record storage; metadata pinning and large-history runtime need CI and deployment qualification before any automatic publisher is enabled.

The initial publisher uses the existing publication lane, which refuses private original-CSI mutation. The HTTP consumer does not broaden that admission; production CSI recovery and qualification remain separate acceptance work. Snapshot resources cannot be submitted through ordinary commit resource publication.

Until the first formal Managed Agent release, the shared V1 baseline is edited in place to add the owner kind; the schema version is unchanged. Development catalogs must be recreated. Server and Broker use the same baseline and closed owner-kind contract.

## Reads, failures, and retirement

Descriptor and page reads authenticate the current writer and verify manifest integrity and ownership. The descriptor's census count detects missing pins. Page reads verify bytes, page ordinal, native revision, resource metadata, and resource bodies before returning data. Missing pages cannot be reported as end-of-stream. Unsupported formats and corruption fail closed; a caller must not silently recover from a different head.

Snapshot ownership persists across writer takeover; the new writer can read an existing snapshot after obtaining a grant. Existing fenced permanent Session retirement removes native snapshot ownership in bounded batches before the existing resource collector clears bodies. Live Session retention and permanent retirement remain separate policies.

## Affected components and consumers

The storage slice changes the Java Session store API/persistence, resource-owner baseline/contract, retirement, and focused tests. The combined PR also adds selection on the existing restore route and snapshot reconstruction in the Core HTTP journal adapter. The public OpenAPI and WebShell types do not change; the internal surface registry gains the three snapshot routes.

HTTP snapshot reconstruction does not authorize journal deletion. Before any future deletion, migrate or qualify every remaining original-history path: `WakeRecoveryStore`, cancel evidence, lifecycle cleanup, command/model/history reads, tool details/results, publication admission/proofs, child relays, original-CSI admission/qualification, CSI inventory/history/images, CSI snapshot/recovery exports, the remaining Core HTTP query paths, and the CLI recovery worker. Local replacement additionally requires `SessionWriterLease` inode/hash/seal proof support. These remaining readers retain their complete original journal.

## Validation and acceptance

- Baseline: inspect global `qwen` capabilities and directly exercise the internal store where the CLI does not expose the API.
- Round-trip genesis and multiple committed transactions, exact command replay metadata, resource references, stable old snapshots after append, and takeover reads.
- Reject stale writer/generation, wrong scope/token, wrong revision/sequence/digest, blocked or retired Sessions, missing/corrupt transactions/pages/resources, and ID conflicts.
- Inject failures during resource and ownership insertion; reopening must see either the original state or the entire snapshot, with no partial pins.
- Verify page count/byte limits and cursor continuity, resource closure, and bounded permanent-retirement cleanup.
- Restore a published prefix plus a newer tail through Core HTTP, preserving command replay and rejecting conflicting reuse. An exact-head snapshot must avoid prefix transaction reads; selected corruption must fail without fallback, and head-only settlement must not consult snapshot selection.
- Run focused H2 and real MySQL 8.4 cases plus style, shared schema and API surface checks within the module's shared ten-minute local budget. Complete profiles remain CI gates; H2 does not prove MySQL concurrency or physical process recovery.

Storage acceptance means the native protocol/storage slice passes its required gates. Acceptance of combined #15569 additionally requires the HTTP prefix-plus-tail, legacy compatibility, corruption refusal, and writer-fence checks defined in the HTTP recovery design. It does not close #13184 or establish local snapshot recovery, compact payloads, bounded authority memory, or production Hosted/CSI acceptance. No open behavior decisions remain for these two slices.

Local storage evidence on macOS includes the pre-review H2/MySQL 8.4 increment (24 focused cases), API/schema/surface checks, 202 CLI parity cases, build, typecheck, bundle, ESLint, and Checkstyle. Review then corrected dependency enumeration, lock ordering, and the reserved resource namespace, and added regression cases. The storage task's shared ten-minute verification budget was conservatively closed at 574 seconds and its disposable MySQL was stopped; combining the increments does not reset it. The separate PR3 report records its own earlier local evidence and final real-process gap. Compilation, H2 and style results must be tied to exact-revision CI; full MySQL/concurrency/fault profiles, final integrated recovery, large-history behavior, and platform qualification remain separate gates. Earlier selected passes do not establish combined acceptance.
