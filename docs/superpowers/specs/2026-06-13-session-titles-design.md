# Cycle 85 — Surface session custom-titles in `/rc/sessions`

Proposal: `add-session-forking`. `/rc/sessions` (cycle 50) + the session-tree UI
(cycle 57) list sessions by id + fork lineage, but every node is a bare 32-hex
id. Core persists a human title as a JSONL system record (`{type:'system',
subtype:'custom_title', systemPayload:{customTitle, titleSource}}`) — set via the
TUI `/rename`, `/branch`, or auto-title, and read back by the core picker. This
cycle reads that title back gateway-side so a remote client sees named sessions.

This is the **surface half** of the deferred fork-title work (cycle 79 notes).
It is independently valuable (it surfaces titles set by ANY core path, not just
gateway forks), fully server-testable (no daemon), and carries NO restore risk
(read-only; no fork-writer edit). The **write half** (a gateway fork accepting
`{name}` → stamping a custom_title record) stays deferred.

## Deviation note

The daemon's `listWorkspaceSessions` serves an in-memory `displayName` (not read
from disk); the gateway reads the on-disk `custom_title` directly (the same
on-disk-scan posture cycle 50 chose over the active-only daemon list). No daemon
change.

## Mechanism (`sessions/sessionList.ts`)

New `readSessionTitle(chatsDir, id, {maxBytes?})` — a bounded TAIL reader
mirroring `readFirstRecord` but from EOF: `stat` the size, read the last
`min(size, 64 KiB)` bytes at an explicit offset, decode once, split on `\n`, drop
the first (possibly partial) line when the window did not start at byte 0, then
scan BACKWARDS for the most recent line whose parsed record has
`subtype === 'custom_title'`, returning `systemPayload.customTitle` (a non-empty
string) or `null`. A cheap `indexOf('custom_title')` pre-filter avoids parsing
unrelated lines. **Never throws** (ENOENT / any open/read/parse error → `null`)
— a title is enrichment and must never break the listing; the handle is always
closed.

`SessionEntry` + `SessionListItem` gain optional `title?: string`. `listSessions`
calls `readSessionTitle` per session (alongside the existing `readFirstRecord`)
and threads it through `assembleListing` (copied onto the item when present). The
route serializes the listing as-is, so `title` rides along — no `routes/
sessions.ts` change.

## Decisions

1. **Tail window, 64 KiB** (matches core's anchor strategy: it re-appends the
   title near EOF every 32 KiB + on finalize, so a 64 KiB tail catches it for any
   non-trivial session; a short session whose only title is at the start is fully
   covered because `size <= 64 KiB` reads from offset 0). The rare miss — a
   > 64 KiB session whose title was written ONLY at the very start and never
   > re-anchored — yields no title (graceful), not a wrong one. Documented.
2. **Always-on** (no `?titles` gate). The endpoint is OWNER-only and capped at
   500 sessions; the added cost is one extra bounded tail-read per session.
   Acceptable for an owner listing; gate it later if it ever matters.
3. **Privacy**: titles surface ONLY to the OWNER (the endpoint is OWNER-scoped; a
   session-locked share can never reach it). The `session_list_read` audit still
   logs count + truncated ONLY — never the titles (which are user content). No
   audit change.
4. **Tree UI**: `buildSessionTree` appends ` — <title>` to a node line when
   present (textContent — titles are user content, XSS-safe).

## Fail-safe commit order

docs → `readSessionTitle` + `title?` field + listSessions wiring + unit/route
tests (additive: a session with no title lists exactly as before) → tree UI
` — title` + harness seed + playwright.

## Verification

vitest: `readSessionTitle` — reads a title from a record at EOF; from a record
not-last (most-recent wins); short file (title at start, window from 0); no title
→ null; missing file → null; a window-straddling first line is dropped (a title
only in the dropped prefix → null, the documented limit). listSessions —
threads `title` onto the right items; a no-title session has no `title` key.
route/server — `/rc/sessions` returns `title` for a seeded titled session.
typecheck/lint/build, e2e 45 (the existing fork e2e has no titles → unchanged).
Playwright: the tree shows `<id> — <title>` for a harness-seeded titled session.

## Deferred

The fork `{name}` write half (stamp a custom_title into a gateway fork — the
deepest-coupling piece, needs a real-daemon restore check); `titleSource`
(manual/auto) surfacing; a `?titles=0` opt-out; lineage-endpoint titles.
