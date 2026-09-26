# Local Managed Tool Result Segments (O1b)

[English](2026-09-26-managed-tool-result-local-store.md) | [简体中文](2026-09-26-managed-tool-result-local-store.zh-CN.md)

## Problem and scope

[O1a](2026-09-26-managed-tool-result-contract.md) defines immutable segment identities, publication, sealing, manifests and pages, but implements only an in-memory reference ledger. `LocalManagedSessionResourceStore` publishes and reads whole buffers. A 100 MiB tool output therefore has no bounded-memory local store that survives process replacement.

O1b adds a private, Session-owned local segment store. It does not mount Tool v3 routes, capture Shell output, add hosted storage, or expose public previews. O1c connects a foreground producer; O2 adds remote storage and capacity policy; O3 projects results to Java and WebShell. This implementation supports one writer process per Session, multiple concurrent tools through one serialized writable handle, any number of read-only handles, and reopening after the writer exits.

## Interface

`ToolResultSegmentStore` exposes asynchronous `publish`, `seal`, `prefix`, `readRange`, and `close` operations. The first three use O1a's request validation, receipts and `invalid`, `conflict`, and `digest_mismatch` outcomes. The ledger remains the in-memory behavior oracle; the local adapter never stores an entire capture in memory.

`publish` snapshots one caller segment before queuing it. A segment is 1–16 MiB; a producer awaits each receipt before reusing its buffer. `seal` accepts only the exact ordinal set and a matching final length and digest. `prefix` covers the longest contiguous, verified run starting at ordinal zero. All three are serialized on the writable handle. `close` rejects new operations and drains accepted ones. The caller closes the store before releasing its `SessionWriterLease` or deleting the Session; O1c wires that lifecycle. The store requires the existing lease, checks its Session and runtime root, and never acquires another lease.

`readRange` takes a `manifestRef`, the caller's expected execution identity, a `streamId`, offset and length. A read is pinned to that immutable manifest revision, returns exact bytes as one Buffer, and rejects a request outside that revision's descriptor bounds. One read is capped at 16 MiB. Empty reads are permitted only within the valid boundary. It checks the full manifest identity, page positions, segment identities, lengths and digests before returning bytes. For `body.pages` it verifies the relevant segments. For `body.ref` it streams and hashes the whole resource while retaining only the requested range. I/O failures remain failures, not empty results.

## Durable layout and recovery

The store owns a versioned namespace below `managedSessionResourceRoot`. Its immutable owner record contains the complete `ManagedSessionKey`; opening with another tenant or workspace fails. Capture and stream path components are validated O1a tokens with fixed prefixes. The runtime root is caller-controlled; directories created beneath the resource root are checked for symlinks.

Each ordinal has an immutable directory containing the raw bytes and a receiver-computed receipt. A candidate is written to a same-filesystem staging directory with private permissions. The files and staging directory are synced, then the candidate is installed without replacing an existing ordinal; the parent directory is synced. An immutable per-ordinal publication marker in the stream directory is then synced before acknowledgement. An immutable stream anchor in the namespace records that an acknowledged stream must exist even if its whole directory later disappears. A seal is published by the same directory rule, followed by an immutable namespace-level seal anchor before acknowledgement. The anchors use hashed fixed-length file names and record the original identity or receipt. Newly created and existing ancestors are synced in dependency order, including on retry after a previous sync failure. Directory sync follows the repository's explicit platform policy; an unsupported durability guarantee is not silently asserted.

The adapter ignores uncommitted staging directories when reopened. It never infers a seal from the presence of segments. An identical retry after a lost reply verifies the content and completes any missing marker or directory sync before returning the original receipt. An incoming conflicting or digest-mismatched candidate is kept out of reads and quarantined without changing the original segment. Publication markers detect missing segment directories; namespace anchors detect missing stream or seal directories. A corrupted published segment is never replaced; readers reject it, and the writable owner records a persistent corruption marker when it confirms the corruption. No O1b operation removes orphaned, staged or quarantined bytes; Session deletion retains its existing ownership checks and removes the whole resource root.

Page and manifest bodies continue to use the existing Session resource store. O1c constructs them from verified segment receipts; O1b tests use fixture pages and manifests. A read checks the reference's digest and the exact requested revision rather than consulting a mutable latest pointer. Prefix and seal hashes are computed by scanning files in bounded chunks. There is no whole-output buffer or digest checkpoint.

## Validation and acceptance

- Replay all 28 O1a segment sequences (136 operations) against the disk adapter and the ledger, including malformed shapes, out-of-order arrival, duplicate publication, conflicts and empty sealing.
- Publish a 100 MiB stream in 4 MiB test segments from an incremental source and verify bounded retained memory. Compare with a 1 GiB stream without constructing the full input or expected output in memory. The 4 MiB size is a test input, not a product default.
- Read binary ranges across segments and pages, including a UTF-8 character split across segments, empty and out-of-range reads, and an older manifest after a newer revision exists. Check both `body.pages` and `body.ref`.
- Exercise restart and process-loss windows during staging, after installation but before reply, and before and after sealing. Reopen and assert that only durable ordinals and explicit seals are visible.
- Inject disk-write and sync failures, corrupt published files, attempt path and owner-scope substitutions, open a second writable handle, and close with queued operations. A valid retry must not substitute bytes or claim an unsynced result durable.
- Run focused core tests, build, typecheck and the existing O1a, Session resource-store and Tool v3 admission regressions.

There is no CLI or public API entrypoint in O1b. The real-process checks use a local child-process harness rather than a model conversation. A bounded in-flight segment count is the producer's responsibility in this slice; global capacity and tenant quotas follow in O2.

## Risks and follow-up

Reads of a large `body.ref` validate the full file for each bounded range, which trades I/O for bounded memory. The adapter assumes a private runtime root and a single Session writer process; cross-process concurrent publication and cross-host persistence require the later hosted storage design. O1c must close and drain the writable handle before relinquishing the existing Session lease. O4 defines reference-aware reclamation.
