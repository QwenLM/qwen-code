# Saved webpage versions in Web Shell

## Problem

A historical link to a development server shows the current page. The user
needs the page delivered in that conversation turn to remain available after
later edits, closing the preview, reloading the shell, and restarting the
daemon.

## Design

Each successful `Artifact` publication also writes a separate, immutable local
HTML snapshot. The existing publisher continues to update its stable latest
URL. The snapshot contains the exact wrapped HTML published in that invocation,
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
same version. Latest publication cards are omitted from a turn when that same
publication has its saved-version card, avoiding two indistinguishable outputs.

## Boundaries and retention

This saves self-contained Artifact deliveries, not arbitrary live websites or
the transient state of a user's browser. Live URL preview remains available
and labeled as live. The Artifact tool already requires inline dependencies;
its existing best-effort validator is unchanged. The offline viewer blocks network
resources at runtime; this feature does not bundle external dependencies. Interactive state
starts from the delivered HTML when reopening a saved version.

Snapshot descriptors use existing session artifact retention and its 200-record
default limit. This increment does not implement an unlimited archive or change
session deletion/retention policy. Snapshot files are not overwritten or garbage
collected when another version is generated. Older live-link records cannot be
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
forged descriptors, symlinks, truncation and checksum mismatch. Run the global
CLI baseline first, then build/typecheck/bundle, focused unit tests and the
browser scenario on the local daemon. See
`.qwen/e2e-tests/web-shell-preview-snapshots.md` for commands and results.

There are no open design questions for this bounded increment.
