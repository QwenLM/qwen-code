# Edit output and automatic stale recovery

[English](2026-11-15-edit-stale-recovery.md) | [简体中文](2026-11-15-edit-stale-recovery.zh-CN.md)

## Goal and scope

Keep automatic recovery enabled by default without adding human confirmation.
Normal Edit success results omit model-supplied text. User-modified replacements
and recovered edits return new information through a bounded snippet, while the
UI keeps its diff. Whole-file replacements supplied by the confirmation editor
must not be echoed in full.

## Target semantics and authorization

Recovery replaces the one exact literal occurrence of `old_string` in the
**current file**, preserving content outside that replacement. It does not prove
that this occurrence is the semantic location seen in an earlier Read. If an
external rewrite moves the only matching text into another function, that current
occurrence is the target. Callers should include enough context to express their
intended target; neither a two-line minimum nor a fixed offset proves continuity.
This is a deliberate tradeoff for default automatic recovery, including
AUTO_EDIT/YOLO and noninteractive execution. A confirmation warning or a returned
snippet communicates the event; neither is an authorization boundary or a proof
of the old semantic location.

An existing file still needs prior session text-read evidence. Recovery applies
only to single, nonempty, non-no-op text replacements, with automatic read
permission from the production default-read rules and permission manager. It
respects canonical workspace and managed-memory roots, approved runtime roots,
ignore files, explicit ask/deny rules and scoped-I/O exclusion. An explicit allow
rule does not widen an otherwise nonautomatic default root. Recovery never uses
fuzzy whitespace, quotation or Unicode matching. Missing and multiple matches,
no-ops and unsupported cases return `FILE_CHANGED_SINCE_READ` without exposing
unread contents through distinct content-derived errors.

## Fingerprint, Read baseline and snapshot

`FileReadCache` separates two facts:

- The inode, mtime and size fingerprint describes the latest disk state.
- `readBaselineNeedsRefresh` means recovery preserved external bytes that have
  not been refreshed by a successful text Read.

A recovered write records the post-write fingerprint and explicitly passes the
baseline flag, including when atomic replacement creates a new inode. It disarms
full-read history residency. Further Edit calls use recovery permission, exact
matching and snapshot checks even while the disk fingerprint is fresh. WriteFile
rejects until a successful text Read refreshes the baseline. Partial or truncated
text reads qualify under the existing prior-read contract; requiring a full Read
would reintroduce the large-file deadlock from #3945 / #4002. An internal disk read
while preparing an Edit does not call `recordRead` and cannot clear this flag.
ReadFile, attached text and injected memory retain their existing `recordRead`
semantics. Grep and RipGrep retain ordinary prior-read credit, but search snippets
do not clear a pending recovery baseline; only an actual text Read does.
A partial Read clears the baseline flag without falsely making the whole file
resident; a following full Read returns real content rather than a placeholder.
Normal writes retain their existing read-credit behavior. User-modified Edits
disarm full-content history residency because their bounded result can omit
user-authored bytes. A partial Read does not re-arm that residency; a full Read
must first return actual content before later Reads can use a placeholder.

The shell tool's simulated `sed -i` edit also waits for a successful text Read.
It supports regex substitution against the current file and writes the complete
result; it does not use Edit's unique-literal recovery contract. A fresh
fingerprint with a pending baseline reports that Read is required after recovery,
rather than claiming that mtime or size changed. Actual drift retains the drift
message. Frozen-snapshot mismatches name the prepared snapshot, even when the
cache is fresh; they still return `FILE_CHANGED_SINCE_READ`.

A recovery decision captures a dev/inode/mtime/size snapshot. Post-read,
confirmation and pre-write checks must match that snapshot. Passing
`expectedStaleSnapshot` grants a matching recovery continuation even without
`allowStaleRecovery`; callers must pass only an authorized captured snapshot.
A concurrent Read making the cache fresh does not replace the frozen snapshot.
A later file change or deletion is still rejected. Snapshot pinning protects the
preparation-to-write interval, not continuity with the old Read's semantic target.
The stat-to-write race and identical-mtime/size collisions remain limitations of
fingerprint-based checks; this change introduces neither locks nor content hashes.

## Results and diagnostics

Normal edits and file creation return a concise confirmation. User-modified edits
retain a modification notice, without interpolating `new_string` (which can be
the entire file). User-modified and recovered results include an edited snippet
when the existing line bound and an 8,000-character bound allow it; otherwise they
ask for Read. Recovered results explain that WriteFile needs Read and subsequent
Edit still uses recovery checks. Existing confirmation UI gets an informational
warning without requiring an additional dialog. One debug event is emitted after
a successful recovered write, never merely during preparation.

## Verification and acceptance

- Read, externally modify, then perform consecutive automatic Edits: each succeeds
  with recovery checks and preserves external non-target content. A stale full
  overwrite is rejected; an actual full or partial text Read permits WriteFile.
- Repeat with an atomic inode replacement; the baseline flag must survive.
- Fresh-fingerprint recovery must still reject `replace_all`, no-op, fuzzy or
  multiple targets and newly restricted read permission.
- Verify canonical workspace/runtime/memory authorization, ignored/private paths,
  permission ask/deny and scoped I/O through production permission rules.
- Confirm at snapshot S, externally write F2, refresh the cache at F2, then execute:
  F2 survives. Re-reading S without drift still permits the captured edit. Deletion
  after confirmation remains a stale-file rejection.
- User-modified whole-file params and long single-line replacements cannot cause
  unbounded result echoing. Normal Edit results remain concise.
- Hot restore and cold resume preserve original tool-call arguments, one paired
  result, actual disk bytes and trimmed history without depending on a success
  snippet. These assertions run on Node+Ink, Bun+Ink and Bun+OpenTUI.

The regression tests specify current behavior; no model latency, token savings or
production recovery-rate claim follows from deterministic replay results.
