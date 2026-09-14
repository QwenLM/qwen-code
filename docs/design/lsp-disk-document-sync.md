# Query-time native LSP document synchronization (PR1)

[English](lsp-disk-document-sync.md) | [简体中文](lsp-disk-document-sync.zh-CN.md)

Native LSP queries previously opened each URI once and never refreshed its text.
The service owns a per-server, per-connection map of delivered disk text and
version. Before location and document queries, it reads the target file and
sends only the required notification. Versions start at 1 on each connection
and increase on delivery of changes, including forced warmup. A new connection
discards its predecessor's state; configuration reload replays current disk text
for restarted servers and retains unchanged servers' state.

Saved changes from edit/write tools, hooks, shell commands, or manual editors
are covered when that target is next queried, regardless of the writer. Unsaved
buffers and edit-time feedback are not covered. #3170's edit-time `didSave` work
is complementary; #3029/#3034 diagnostics work and #11418 documentation updates
remain separate.

Initialization retains only `textDocumentSync`. Numeric Full/Incremental imply
open/close support; options honor `openClose` and `change` independently. Full
sends the new text. Incremental replaces the entire previous document range,
using UTF-16 code units and treating CRLF, LF, and CR as line breaks. None or an
absent capability does not authorize change notifications. Only notification sends that do not throw record a snapshot (not a server ACK). A server without `openClose` receives
neither `didOpen` nor orphan `didChange`; it retains ownership of disk loading
and remains queryable after edits. If a client-opened file changes without change
support, synchronization raises an unsupported-sync error and skips the request.
Read and unsupported-change failures close the opened document, release its text,
and fail the observing call. Unsupported changes park the URI for a later reopen
with current disk text. A failed close retains a pending-close error, version and
read-failure count; subsequent synchronization (including workspace diagnostics) retries the
close before any reopen. A successful close allows later calls to recover. Versions
remain monotonic across same-connection close/reopen, including identical text.
Only connection replacement resets versions. Ordinary thrown change sends retain
the prior snapshot and retryable version. No send return is an acknowledgement.

TypeScript warmup delegates delivery to the same service helper. Forced warmup
sends a capability-supported `didChange` even for unchanged text, advancing its
version without duplicate `didOpen`. Already-current supported warmup still settles without warning. If no notification
is supported (including forced unchanged warmup without change support), the
manager warns with the server and capability and records the warmup attempt to
avoid repeated discovery scans. Actual callback/read/send failures are caught
and leave the handle retryable, including after a failed forced attempt. A delayed
warmup cannot mark a replacement connection warm. Normal unchanged queries send nothing. Only
new opens trigger document-query delay/retry; changes do not. Workspace symbol
warmup distinguishes finding a usable file from sending an open: a disk-reading
server still gets indexing delay and empty-result retry when a file is available,
consistently across calls. With no warmup file, both are skipped. Reload replay
settles only when notifications were delivered.

Call hierarchy items carry an optional client `documentRevision` field, echoed
unchanged through the tool's JSON and native client. Native incoming/outgoing
calls require valid provenance rather than applying stale offsets to fresh text.
A small HMAC over the actual normalized LSP item parameters, server name, text digest,
and delivered version binds the item to a concrete connection. Signing recursively
sorts JSON object keys while preserving array order, so equivalent tool JSON is
accepted regardless of key order while changed values remain invalid. A `WeakMap`
holds one random secret per connection, not an issued-item registry. The client
field is never forwarded to the language server. Captured pre-request snapshots
are checked against disk, delivered version, active handle and connection before
signing results; for these pre-request snapshots, sibling synchronization or
replacement cannot certify an old response as new. Incoming/outgoing calls validate before and after warmup and
again after the request. Stale, missing, modified or unknown provenance rejects
with an actionable “prepare call hierarchy again” tool failure, never “no calls”.
Cross-file prepare results are certified only when their file already has a
pre-request snapshot that remains fresh. Otherwise they stay unsigned, even when
readable after the response: a post-response read cannot establish which text the
server used. Traversal of an unsigned item names its own URI and requires prepare
at a current location there. Signing sends no notification and issues no
supplemental request. The query target is
still snapshotted before its request and bound to the original handle/connection
across awaits.
Returned offsets are never used for automatic prepare, nor are names guessed.
Nested incoming/outgoing items get provenance only when their file was observed
before the request; unobserved nested files remain displayable, but need explicit
prepare at a current location before traversal. Unrelated drifted or unreadable nested files also remain unsigned without dropping
healthy siblings. Root freshness and connection changes still reject the whole
request, even for an empty result or request error. Non-file URIs remain unsigned
and report “cannot be traversed; prepare at a file location instead”, not a
retryable stale error. Ordinary non-file requests pass through unchanged.

## Boundaries

- Workspace symbols remain warmup-only. Optional warmup failures log and do not
  cancel symbol search. Successful disk-reader discovery is connection-local;
  readability is rechecked without retaining delivered text, removed candidates
  trigger rediscovery and missing candidates are not negatively cached. Workspace diagnostics additionally
  synchronize already tracked documents for each queried server, inside the
  result-limited loop (default limit 100). They neither discover more documents
  nor synchronize servers skipped after the limit. Tracked means delivered on this
  connection or parked by an earlier connection change or recoverable synchronization failure; the reload snapshot and the
  sweep use the same union, and the reload's clear consumes the parked set.
  Reconnection resync opens every
  tracked URI, then settles once on new opens only (no delay for didChange).
  Replacement during that await rejects rather than querying an unsynchronized
  connection. A fixed delay does not prove server analysis has completed. Pending closes are retried without rediscovering documents. The tool's optional top-symbol
  reference lookup is document-targeted and also synchronizes.
- No file watchers, edit-time feedback, IDE buffers, installation, workspace-wide
  dependency freshness, or diagnostic push/pull redesign. Reads observe disk
  snapshots, not an atomic transaction with concurrent external writers. For
  disk-reading servers, unchanged text has no client-delivered version; external
  edits that return to identical text between observations cannot be detected.
- Document and workspace diagnostics reject synchronization failures even after
  an earlier server returned diagnostics. Workspace synchronization failures
  (unreadable/deleted tracked files, thrown sends, or unsupported changes) escape
  the ordinary pull-request catch; no empty or partial success is returned. A
  tracked URI remains parked after its first failed read, including ENOENT. Its
  second consecutive failed read drops only that URI from the parked set; both
  observing diagnostic calls reject. The shared synchronization helper applies
  this bound to ordinary queries, warmup and sweeps, counting
  actual reads rather than calls. A successful read resets the count, and a new
  connection resets counts and versions. An untracked, unreadable first query
  does not create a replay obligation. After eviction, later sweeps can proceed;
  a successful document-targeted query is needed to track the restored file again.
  Eviction retains the same-connection version and any pending close. Unsupported
  changes and thrown sends do not consume read retries. Configuration-reload
  replay still consumes the parked set before delivery; retaining failed reload
  deliveries remains deferred. The manager catches internal TypeScript
  warmup errors; failure of a different warmup file does not prevent querying a
  synchronized target. Propagated failures reach the tool's existing failure
  message rather than claiming a clean or complete result. Successful empty
  diagnostics still display as clean. Existing request/pull catches and public
  query catches other than hierarchy provenance handling are unchanged and can
  return empty arrays or null; these are **not evidence of clean diagnostics**.
  Broader error result design remains PR2.
- Notification delivery is not acknowledged by the transport. This change does
  not redesign asynchronous writes/closed connections.

## Costs

Synchronizable target queries read and compare complete disk text even when size
and mtime are unchanged. Non-notifiable, untracked ordinary targets skip that
read; hierarchy provenance still observes disk. Retained snapshots cost memory proportional to delivered
documents per server connection until tracking is cleared. Hierarchy requests
reuse immutable snapshot text digests and capture references once per traversal.
Each pre-warmup/post-warmup/post-response/error checkpoint reobserves disk;
per-result batches share only synchronous per-URI observations, never across awaits.
HMACs remain per item and include canonical parameters, text digest and version; connection
secrets are weakly held, with no growth per issued item. Unchanged normal queries
send no notification. Both Full and Incremental send all new text; Incremental
also scans old text for its range. A minimal diff is an upgrade only if large-file
measurements justify it. The 20-item same-URI traversal test requires three target reads (one at each
happy-path checkpoint), not one per item; error paths add a fresh observation.
After prepare, 20-item traversal constructs 23 small HMACs (3 root validations
plus 20 items), and hashes text zero times for the retained snapshot, once for
an untracked disk-reader snapshot. These are test assertions, not real-server
latency guarantees.
This is an observation-bound guarantee, not atomicity against external writers.

## Verification and filenames

Focused tests cover all ten document query routes, unchanged/changed text,
per-URI versions (both B then A edited on one connection), numeric/options sync
kinds, UTF-16/CRLF replacement, connection replacement, scoped configuration
replay, stale queries resuming after reload, warmup delivery and recovery,
TSX language precedence, read/send failures including a failed second-document
open, exact request URI/position, same-size edits with restored mtime, and a
separate process saving the target. Hierarchy tests exercise JSON tool roundtrip,
nested items, line-shifting edits, sibling queries, disk-reading servers and
in-flight response races. Workspace diagnostic ordering, result-limit scoping,
and symbol retries are pinned. Actual-client/tool tests reject deleted tracked
files, thrown sends, and unsupported workspace changes, including after an
earlier server returned results, while preserving ordinary pull-request catches. Initialization tests exercise capability production through startup.
Mutation checks must kill each named mutant, all in `native-lsp-service.ts`
unless another file is named, with the listed test going red: R1-5,
`ensureDocumentSynchronized` returns a constant `true` instead of the open flag
(`does not delay or retry an empty query after didChange`); R1-6, the manager
warmup catch in `lsp-server-manager.ts` rethrows instead of returning
(`contains TypeScript warmup callback failures`); R1-8, the snapshot write moves
before the `didOpen` send (`retries a failed second-document didOpen at version
1`); R1-10, hover sends the end position instead of the start (`sends the
requested hover URI and start position`); R1-11, synchronization reads the first
tracked document instead of the requested URI (`keeps text and versions
independent for two documents`); R1-12, the delegated language ID loses
precedence over the extension-derived one (`preserves the extension-derived
language ID in a TSX-only warmup`); R1-13, reload also clears the untouched
server's tracking (`retains the unchanged server snapshot when only its sibling
reloads`); R1-15, forced warmup passes `false` instead of the force flag
(`forces unchanged TypeScript warmup with a monotonic didChange before retry`).
R1-14 is the negative control: raising `DEFAULT_LSP_WARMUP_DELAY_MS` to 300 in
`constants.ts` must leave `preserves replayed snapshots` green.

The touched service and manager and their collocated unit tests were renamed to
kebab-case per AGENTS.md. Their barrel exports, native client type imports,
integration test, and direct E2E harness imports were updated. Public class names
and root barrel export names are unchanged; import-only legacy files were not
renamed. Old PascalCase subpath imports no longer resolve. The public manager
warmup method now requires a synchronization callback returning delivery status
(`boolean`) and returns `Promise<void>` instead of `Promise<string | undefined>`.
The optional `documentRevision` field preserves item shape compatibility, but
native traversal of legacy items without provenance now explicitly fails and
requires prepare again. Repository callers are migrated; external compatibility
policy remains subject to maintainer confirmation.
