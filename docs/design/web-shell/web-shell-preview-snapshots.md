# Saved webpage versions in Web Shell

[English](web-shell-preview-snapshots.md) | [简体中文](web-shell-preview-snapshots.zh-CN.md)

## Problem

A historical link to a development server shows the current page. The user
needs the page delivered in that conversation turn to remain available after
later edits, closing the preview, reloading the shell, and restarting the
daemon.

## Design

In managed ACP sessions with chat recording enabled, each successful `Artifact`
publication also writes a separate, immutable local HTML snapshot. Ordinary CLI
publication and sessions without recording do not create historical files. The
existing publisher continues to update its stable latest URL. The snapshot contains the exact wrapped HTML published in that invocation,
including inline styles, scripts, data, and embedded assets. Each invocation
gets a new ID, even when the source path or content is unchanged.

Snapshot bytes live under the producing runtime's storage directory in
`artifacts/snapshots/<UUID>/index.html`. Exclusive creation prevents overwrites.
The tool emits a separate published HTML artifact with a unique managed ID,
file URL, `artifactType: web_preview_snapshot`, the latest publication URL,
and the existing trusted `qwen.published.sha256` checksum. Existing tool-result
artifact ingestion and persistence associate that descriptor with its tool
call and original turn; HTML bytes do not enter model context or SSE messages.
Session restore and same-runtime forks retain these descriptors, including
their original timestamps and deletion markers. Only Artifact-produced snapshot
descriptors with the expected UUID path and checksum qualify for local file URL
restoration; ordinary local file links remain untrusted. Restore does not read
the HTML, so missing bytes do not prevent restoring the conversation record.

New snapshots also contain a `references/` directory with hashed session IDs,
identified by `qwen.snapshot.references: 1` in their metadata. Publication creates
the producing session's reference. A fork acquires its own reference before
committing the transcript. Missing snapshot storage does not block the fork:
it preserves the historical descriptor and warns that the content may be
unavailable. Other reference errors still abort the fork; a failed fork releases
only its operation's reference.
The owning runtime is captured explicitly. Session deletion releases only the
snapshot UUIDs found in the exact transcripts being removed, including old side
events; it does not scan other workspaces by session ID. Removal, eviction,
successful rewind, and session deletion release that session's references. Files are removed only
when the final reference is released. Failed removal persistence preserves the
bytes needed by the durable history. Old snapshots without reference metadata
are kept conservatively because their other fork owners cannot be established.
Files left by a process crash before descriptor persistence or a failed cleanup
are also kept; this change does not add an orphan-file collector.

The new `GET /session/:id/artifacts/:artifactId/content` route is
**live-session-owner scoped**, with the same owner resolution, client filtering,
trust and cwd-bound read behavior as the artifact listing. It looks up the
registered artifact in that owner session and reads only the fixed snapshot
path beneath that runtime's storage directory. It validates the descriptor,
file URL, regular file, containment, 16 MiB bound and checksum. Missing or
altered snapshots return an error; there is no fallback to source files, latest
URLs or the primary runtime. Responses use attachment disposition and nosniff.

The browser reads this route through the authenticated daemon SDK using the
source session ID. The artifact panel renders the HTML in an opaque-origin,
script-enabled sandbox with the existing no-network artifact CSP. Saved and
ordinary HTML previews both use a fixed parent document whose `frame-src 'none'`
blocks the content frame's own navigations. The content frame has a separate
opaque origin, so its scripts cannot modify that parent policy. This preserves
the offline preview boundary while the shell allows live development URLs. The panel
shows that this is a saved version and its creation time. Closing the panel
removes only viewing state. Reopening from the original message fetches that
same version. Local file publication cards are omitted from a turn when that same publication
has its saved-version card. HTTP/HTTPS publication cards remain available for
opening the latest hosted page.

Refresh rebuilds an already loaded snapshot from its in-memory HTML, so it can
recover a blank navigated frame without another daemon request. An initial load
failure still retries the content route. Closing and reopening fetches the
version again; no snapshot bytes are persisted in browser storage.

## Boundaries and retention

This saves self-contained Artifact deliveries, not arbitrary live websites or
the transient state of a user's browser. Live URL preview remains available
and labeled as live. The Artifact tool already requires inline dependencies;
its existing best-effort validator is unchanged. The offline viewer blocks network
resources at runtime; this feature does not bundle external dependencies. Interactive state
starts from the delivered HTML when reopening a saved version.

Snapshot descriptors use existing session artifact retention and its 200-record
default limit. This increment does not implement an unlimited archive or change
session deletion/retention policy. A new publication never overwrites an earlier
snapshot; snapshots remain until their final retained record is removed. Older live-link records cannot be
retroactively reconstructed. Missing local snapshot bytes are reported as
unavailable, including when moving a transcript without its runtime storage.

## Affected components and validation

- Core Artifact tool, snapshot storage and persistence helpers, and focused tests.
- ACP artifact restore and deletion-marker validation.
- CLI owner-scoped content route and route tests.
- Daemon SDK authenticated content read method and tests.
- Web Shell turn selectors, artifact panel, translations and browser tests.
- Web Shell README and the live-preview design's version-history boundary.

Test publishing v1 then v2 from one source, retaining the stable latest URL
while both snapshot files retain their own bytes. Restart/read from persisted
session data, open each original message, exercise inline interaction, close
and reload, and make the source/latest page unavailable. Test owner isolation,
forged descriptors, symlinks, truncation and checksum mismatch. Fork with missing
snapshot bytes or reference storage and verify the conversation and descriptor
survive; other reference errors must not commit a partial fork. Run the global
CLI baseline first, then build/typecheck/bundle, focused unit tests and the
browser scenario on the local daemon. See
`.qwen/e2e-tests/web-shell-preview-snapshots.md` for commands and results.

There are no open design questions for this bounded increment.
