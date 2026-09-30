# Web Shell Session Content Search

Issue: #10261. Related: #6824 (CLI / VS Code conversation search — not covered
here, but the daemon endpoint below is designed to be reusable by it).

## Problem

The web-shell sidebar "Search sessions" box filtered only over already-loaded
`DaemonSessionSummary` objects: label, session id, and git context. Session
titles are often generic or auto-generated, so a keyword the user remembers
from the conversation itself returned nothing.

## Design

A dedicated daemon endpoint scans persisted session transcripts on disk; the
sidebar keeps its local title/id/git filter as the fast path and merges the
server's content hits into the filtered list, showing a short snippet of the
matched message under the session label.

A `q` parameter on the existing sessions list route was rejected: it would
entangle search with that route's cursor pagination and live/persisted merge
semantics. A separate endpoint is additive-only.

### Daemon API

`GET /workspace/:id/sessions/search?q=<text>&maxResults=<1-50>` (also
registered on the plural `/workspaces/:workspace/` spelling).

- Same workspace-scoped runtime resolution as the sessions list route:
  resolved-runtime only, never falls back to the primary runtime; read-only
  secondary workspaces search their persisted store only.
- Response: `{ "results": [{ "session": DaemonSessionSummary, "snippet": string }] }`,
  most recently modified session first. Summaries are full (sidecar-enriched)
  so hits not yet loaded into the client catalog can render directly.
- Validation: `q` non-empty, ≤ 200 chars (`400 invalid_search_query`);
  `maxResults` 1–50 (`400 invalid_search_max_results`).
- The request abort signal cancels the scan (typing cancels in-flight
  searches).

### Matching

`SessionService.searchSessionContent()` streams each active transcript JSONL
line-by-line (most recent files first) and matches case-insensitively against
user and assistant message text (the prompt `displayText` payload when
present, otherwise text parts; subtype records like slash commands are
skipped). Reading stops at a file's first match; the snippet is a single-line
~120-character excerpt ellipsized around the match. The scan is bounded
(200 most recent files, 20 results by default) — no full-text index in v1.
Active sessions only; archived search is a follow-up.

### Client

`useSessionContentSearch(client, workspaceCwd, query)` debounces 300 ms,
ignores queries shorter than 2 characters, aborts superseded requests, and
degrades to local-only filtering on any error (including a 404 from a daemon
too old to serve the route). Both `WebShellSidebar` (primary workspace) and
`WorkspaceSection` (secondary workspaces) merge hits into their existing
filtered session lists: local title/id/git matches first in catalog order,
then content hits in recency order; hits already in the loaded catalog keep
their catalog entry (live state), others render from the search summary. The
row renders the snippet as one muted truncated line under the label.

## Non-goals (v1)

- Full-text index or persistent search cache.
- Archived-session search; `SessionOverviewPanel` search; CLI picker (#6824).
- Match-term highlighting inside snippets.
