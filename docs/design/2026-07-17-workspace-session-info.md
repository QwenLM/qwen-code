# Workspace `session-info` aggregate endpoint

## Problem

`GET /workspace/:id/sessions` is cursor-paginated and does not return a total.
`GET /daemon/status` exposes live in-memory `sessionCount` only. Workspaces with
many persisted sessions (for example from scheduled tasks) cannot learn the
local store size without paging every session.

## Proposal

Add:

```http
GET /workspace/:id/session-info
GET /workspaces/:workspace/session-info
```

Response (illustrative):

```json
{
  "active": 450,
  "archived": 30,
  "total": 480,
  "live": 2,
  "expensive": true,
  "cost": "disk_scan"
}
```

`live` is omitted for an untrusted secondary workspace because those catalog
reads must not query the live bridge. If the scan reaches its safety limit or
cannot classify a candidate JSONL file, the response includes
`"truncated": true`; persisted counts are then lower bounds.

## Cost model

Persisted counts reuse the existing full-directory scan pattern already used by
session title search (`SessionService.findSessionsByTitle` /
`findSessionTitlesByPrefix`):

1. `readdir` the project chats dir (and archive twin)
2. filter UUID `*.jsonl`
3. cap at the same file-processing safety limit
4. read only the first JSONL record for project-hash membership

No title/prompt hydration. This is O(n) on disk and **must not be polled**. The
response always sets `expensive: true` and `cost: "disk_scan"` so clients can
fail closed on hot paths. Docs call this out explicitly.

Default list pagination stays unchanged and does not compute totals. Do not
reuse organized-view `listAllPersistedSummaries` for counts — that path hydrates
full list metadata up to 50k sessions.

## Capability

Always-on `session_info` on `/capabilities`, next to `session_list`.

## Non-goals

- Cached counters / mutation-hook accounting (possible follow-up if call sites
  need lower latency)
- Stuffing `total` into every list page
- Organized-group or parent-filtered totals in v1
