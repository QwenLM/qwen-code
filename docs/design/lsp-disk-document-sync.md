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
absent capability does not authorize change notifications. Only successful
notification delivery records a snapshot. A server without `openClose` receives
neither `didOpen` nor orphan `didChange`; it retains ownership of disk loading
and remains queryable after edits. If a client-opened file changes without change
support, synchronization raises an unsupported-sync error and skips the request.
Read and thrown notification failures skip the request without advancing state.

TypeScript warmup delegates delivery to the same service helper. Forced warmup
sends a capability-supported `didChange` even for unchanged text, advancing its
version without duplicate `didOpen`. If no notification can be delivered, the
manager warns with the server and capability and records the warmup attempt to
avoid repeated discovery scans. Actual callback/read/send failures are caught
and do not mark the handle warm. Normal unchanged queries send nothing. Only
new opens trigger document-query delay/retry; changes do not. Workspace symbol
warmup distinguishes finding a usable file from sending an open: a disk-reading
server still gets indexing delay and empty-result retry when a file is available,
consistently across calls. With no warmup file, both are skipped. Reload replay
settles only when notifications were delivered.

Call hierarchy items carry an optional client `documentRevision` field, echoed
unchanged through the tool's JSON and native client. Native incoming/outgoing
calls require valid provenance rather than applying stale offsets to fresh text.
A small HMAC over the actual normalized LSP item parameters, server name, text,
and delivered version binds the item to a concrete connection. Signing recursively
sorts JSON object keys while preserving array order, so equivalent tool JSON is
accepted regardless of key order while changed values remain invalid. A `WeakMap`
holds one random secret per connection, not an issued-item registry. The client
field is never forwarded to the language server. Captured pre-request snapshots
are checked against disk, delivered version, active handle and connection before
signing results; sibling synchronization or replacement cannot certify an old
response as new. Incoming/outgoing calls validate before and after warmup and
again after the request. Stale, missing, modified or unknown provenance rejects
with an actionable “prepare call hierarchy again” tool failure, never “no calls”.
Items are not re-prepared automatically at old offsets or guessed by name.
Nested incoming/outgoing items get provenance only when their file was observed
before the request; unobserved nested files remain displayable, but need explicit
prepare at a current location before traversal. Non-file URIs have no verifiable
disk snapshot and likewise cannot be traversed with native provenance.

## Boundaries

- Workspace symbols remain warmup-only. Workspace diagnostics additionally
  synchronize already tracked documents for each queried server, inside the
  result-limited loop (default limit 100). They neither discover more documents
  nor synchronize servers skipped after the limit. The tool's optional top-symbol
  reference lookup is document-targeted and also synchronizes.
- No file watchers, edit-time feedback, IDE buffers, installation, workspace-wide
  dependency freshness, or diagnostic push/pull redesign. Reads observe disk
  snapshots, not an atomic transaction with concurrent external writers. For
  disk-reading servers, unchanged text has no client-delivered version; external
  edits that return to identical text between observations cannot be detected.
- Document and workspace diagnostics reject synchronization failures even after
  an earlier server returned diagnostics. Workspace synchronization failures
  (unreadable/deleted tracked files, thrown sends, or unsupported changes) escape
  the ordinary pull-request catch; no empty or partial success is returned. The manager catches internal TypeScript
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

Each target synchronization reads and compares complete disk text even when size
and mtime are unchanged. Retained snapshots cost memory proportional to delivered
documents per server connection until tracking is cleared. Hierarchy requests
capture snapshot references and hash the relevant text/parameters; connection
secrets are weakly held, with no growth per issued item. Unchanged normal queries
send no notification. Both Full and Incremental send all new text; Incremental
also scans old text for its range. A minimal diff is an upgrade only if large-file
measurements justify it. No broad performance improvement is claimed.

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
Mutation checks must kill the R1-5/6/8/10/11/12/13/15 mutants; raising
`DEFAULT_LSP_WARMUP_DELAY_MS` to 300 must leave the R1-14 reload cases green.

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
