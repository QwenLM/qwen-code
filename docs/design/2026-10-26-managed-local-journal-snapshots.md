# Local Managed journal snapshot recovery (PR4)

[English](2026-10-26-managed-local-journal-snapshots.md) | [简体中文](2026-10-26-managed-local-journal-snapshots.zh-CN.md)

## Problem and boundaries

Issue #13184 requires a native recovery boundary before authority eviction. The
local journal currently reads the complete JSONL file, while its writer lease
authenticates both physical transcript bytes and a logical commit proof. A
journal adapter cannot independently rename that file without invalidating the
writer's proof.

This slice moves the complete committed prefix into immutable Session resources
and replaces the active file with its original ownership/header records, one
snapshot base record, and a contiguous future tail. Conversion happens once,
when a normally sealed local Session next resumes, before the final restore projection,
activation installation, or recorder binding. New Sessions, live Sessions and
read-only requests do not convert. A torn tail follows existing recovery rather
than being incorporated into a snapshot.

There is no automatic snapshot rotation, garbage collection, compact authority
state or memory eviction. Full history and authority indexes still grow. PR2 and
PR3 define remote snapshot recovery; this local envelope preserves the same
source facts without inventing server revisions or writer generations.

## Representation and interfaces

The local manifest binds its format, Session key, ordered immutable page refs,
complete-prefix byte length and SHA-256, committed sequence, commit digest, last
record UUID, resource closure and latest title/source refs. Pages contain exact
JSONL bytes and end at transaction boundaries, with a 16 MiB page maximum.
Manifest and pages use dedicated resource kinds and content-derived IDs in the
existing Session resource root. Publication is idempotent, durable and refuses
conflicting existing bytes. Existing resource size limits also apply.

The physical file retains its original first ownership record and Managed header,
then a single `managed_session_snapshot_base_v1` record and future transactions.
The base has its own UUID, is a known non-conversation control record, and is
excluded from logical history. Its manifest ref authenticates the complete
prefix. Event and logical header format versions remain 1; only the physical
header requires `managed-session/2`. Reader capability is separate from the
minimum-reader stamp used for new ordinary Sessions.

A common local writer acquisition/preparation entry serves the adapter,
authority and Config. Config first validates restore admission and ownership,
then converts and reacquires the final projection. Invalid restore requests
must not rewrite the main file. Static read-only access never converts. `SessionWriterLease.replaceManagedTranscript` performs
ownership-checked replacement; the existing legacy replacement method continues
to reject Managed leases. Local reads explicitly receive the runtime base,
Session key and optional frozen physical byte bound. The shared HTTP journal
interface gains no local-only option or hook.

The implementation is split between the local writer preparation, the native
snapshot replay wrapper and a filesystem/display codec. The shared
`managed-session-resource-references` module enumerates declared schema paths;
channel inputs include attachment refs while their opaque reply context and
ordinary user JSON remain data. The existing HTTP collector is unchanged.

## Conversion and durability

1. Authenticate the sealed predecessor's physical proof and logical commit
   proof. Only a nonempty, fully committed v1 source without a base is eligible.
2. Install a schema-3 writer with local `format_version=2`, then durably sync its
   lock directory before installing the new layout. New ordinary Sessions remain
   format 1; converted Session acquisition, seal and reclaim never downgrade.
3. Validate schema-declared header/event references and nested resources through
   their resource-kind parsers. Publish pages before the manifest. Arbitrary JSON
   shaped like a ref is not a dependency; inconsistent refs for one ID fail.
4. Write and sync the temporary main file, recheck owner and source hash, rename,
   sync the parent directory and repin inode, metadata and rolling hash.
5. Re-read the installed snapshot plus tail and verify the original sequence,
   marker digest, last UUID and command-replay facts before admitting work.

A pre-rename failure leaves the old file and reports failure. An uncertain
replacement or failed post-install verification stops mutations and preserves
the writer fence. Abort/release cannot remove a format-2 barrier. A verified
failed open may restore its original logical seal. Missing pages, manifests or
dependencies are corruption, never an empty Session or a reason to fall back to
another head. Lock claim/primary transitions for format 2 are directory-synced
before claims protecting them are removed. Process-crash testing does not prove
power-loss durability or qualify an untested filesystem.

This integrity gate also applies to pre-existing sealed v1 Sessions selected for
conversion. Missing, truncated or digest-mismatched declared dependencies stop
resume before activation, even if an older reader tolerated that damage. The
original transcript remains unchanged and the format-2 barrier remains sealed;
there is no compatibility bypass or automatic pruning. Restoring the originally
referenced resource bytes allows a subsequent resume to retry the same history.
Static inspection of an unconverted v1 transcript keeps its previous read
semantics and never upgrades it. A journal handle's first read can prepare only
because that handle already owns the writer; it is a resume operation. Aborting
that writer seals its proof instead of deleting the upgraded barrier.

## Readers and compatibility

The logical scan includes all events, transactions and recovery facts.
Snapshot-aware reads verify the committed tail's complete resource closure as
well as the manifest census; uncommitted and frozen-boundary-excluded references
are not admitted or read.
`maxBytes`, `committedBytes`, `headerBytes` and `uncommittedBytes` continue to
describe the current physical file so tail repair truncates the correct bytes.
Read one verified file generation; frozen transcript cursors retain their
inode/length contract and return the existing 409 after replacement.

Authority, restore/history projections and failed-open cleanup use the same
snapshot-aware reader. Synchronous title/source reads scan the full committed
physical tail before using manifest anchors; this intentionally costs O(tail).
Read the controlled complete header/base rather than assuming they fit in the
64 KiB display window. Keep first-record project authorization and existing
Legacy-only refusal. Resources remain in place through archive/unarchive and are
removed through whole-Session resource cleanup.

The version barrier prevents old writer takeover and execution. Existing old
maintenance readers do not enforce that version ceiling; archive/delete must
remain safe rather than claiming every old operation is blocked. Read-only
compatibility failures must not be interpreted as Legacy or a new Session.

## Verification and acceptance

- Exact-byte, multipage recovery; original receipts and conflict rejection;
  checkpoints, activation and nested resources; repeated resumes publish once.
- Frozen byte bounds, UTF-8, empty tail, torn-tail physical truncation and append
  continuity; restored logical and physical seal proofs.
- Failures during barrier install, publication, write/fsync, rename and proof
  update; independent-process crashes and old/new writer compatibility.
- Pagination during replacement, large headers, title/source updates buried
  beyond display windows, archive/unarchive/delete and missing/corrupt/cross-scope
  or symlinked dependencies.
- Focused Core regressions, root build/typecheck/bundle, formatting and lint,
  two clean self-audit passes and independent review.

The global CLI capability check is only a baseline discovery step. If it exposes
no native snapshot operation, direct adapter/process tests exercise the applicable
contract. Executed results belong in the E2E report at the tested revision. This
design does not establish Linux/Windows, power-loss or production acceptance.
