# Query-time native LSP document synchronization (PR1)

Native LSP queries previously opened each URI once and never refreshed its text.
The service now owns a per-server, per-connection map of disk text and version.
Before a location, document, or incoming/outgoing call hierarchy query, it reads
the target file and sends only the required notification. Versions start at 1 on
each connection and increase only when text changes. A new connection discards
its predecessor's state; configuration reload still replays current disk text
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
absent capability does not authorize change notifications. If a tracked file
changes without change support, synchronization raises an unsupported-sync error
and skips the document request. Read and thrown notification failures also skip the
request without advancing the stored snapshot. Servers without open/close
support retain ownership of initial disk loading; the service sends no didOpen.

TypeScript warmup delegates notification delivery to the same service helper,
avoiding duplicate opens and version resets, including forced warmup. The
manager keeps its existing discovery and warmup delay. All document-targeted
queries synchronize after warmup, including call hierarchy items' URIs.

## Boundaries

- Workspace symbol and workspace diagnostic queries remain warmup-only. This is
  not workspace-wide synchronization, indexing, or watching. The tool's optional
  top-symbol reference lookup is a document-targeted query and does synchronize.
- No file watchers, edit-time feedback, IDE buffers, installation, or diagnostic
  push/pull redesign. Reads observe disk snapshots, not an atomic transaction
  with concurrent writers. Call hierarchy opaque items are not re-prepared.
- Document diagnostics reject on target-document synchronization failures or
  other errors escaping the prerequisites, even if an earlier server returned
  diagnostics. The manager still catches its internal TypeScript warmup errors;
  failure of a different warmup file does not prevent querying a synchronized
  target. Propagated failures reach the tool's existing failure message rather
  than claiming a clean or complete result. Successful empty diagnostics still
  display as clean. Existing request/pull error catches and other public query
  catches are unchanged and can return empty arrays or null; these are **not
  evidence of clean diagnostics**. Broader error result design remains PR2.
- Notification delivery is not acknowledged by the transport. This change does
  not redesign its existing handling of asynchronous writes/closed connections.

## Costs

Each target synchronization reads and compares the complete disk text, even
when size and mtime are unchanged. The service retains the last text per URI
per server connection until tracking is cleared; this costs memory proportional
to those document snapshots. Unchanged text sends no change notification. Both
Full and Incremental changes send all new text; Incremental additionally scans
the old text for its range. A minimal-diff replacement is an upgrade only if
large-file measurements justify it. No broad performance improvement is claimed.

## Verification and filenames

Focused tests cover all ten document query routes, unchanged/changed text,
versions, numeric/options sync kinds, UTF-16/CRLF replacement ranges, connection
replacement, configuration replay, stale queries resuming after reload,
warmup deduplication, read/send failures, same-size edits with identical restored
mtime, and a separate process saving the target before the next hover query.
Initialization tests exercise the capability producer through manager startup.

The touched service and manager and their collocated unit tests are renamed to
kebab-case per AGENTS.md. Their barrel exports, native client type imports,
integration test, and direct E2E harness imports are updated. Public class names
and root barrel export names are unchanged; import-only legacy files are not
renamed. Old PascalCase subpath imports no longer resolve, and the public manager
warmup method now requires a synchronization callback and returns `Promise<void>`
instead of `Promise<string | undefined>`. Repository callers are migrated;
external compatibility policy remains subject to maintainer confirmation.
