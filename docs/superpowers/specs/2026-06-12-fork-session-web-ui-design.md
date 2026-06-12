# Cycle 69 — Fork-session web UI (`POST /rc/session/:id/fork`)

Proposal: `add-session-forking`. The fork backend (full-copy `include` mode) and
the lineage/listing reads + the fork-tree UI (cycle 57) exist. This adds the
ACTION: forking a session from the owner console.

## Deviation note

Gateway UI; consumes the existing WRITE+session-locked `POST /rc/session/:id/
fork`. No daemon change.

## Route contract (read from source)

`POST /rc/session/:id/fork` (WRITE, session-lock-enforced) body `{transcript?:
'include'}` → 200 `{sessionId, parentSessionId, forkedAt}`. Errors: 400
`unsupported_fork_mode`; 404 `parent_transcript_not_found`; 502
`daemon_unavailable` (also rolls back the written fork). Full-copy include only.

## What it adds

A "Fork session" `<section>`: a parent-session-id input + a Fork button →
`POST /rc/session/<id>/fork` → renders the new `sessionId` + `forkedAt`. Pre-fills
the input from the watched session (`watchedSessionId`) when present, so the
common path is one click.

## Decisions

1. Input-driven (not watched-only) — forking is a settled-session action that
   doesn't require an active watch; pre-fill from `watchedSessionId` for
   convenience but allow any id.
2. Surface the specific error codes (404 parent-not-found, 502 daemon, 400
   mode) so a failed fork is legible.
3. textContent-only (the returned ids are server hex/uuid). Additive section
   (new ids `fork-session`/`fork-id`/`fork-btn`/`fork-result`), no existing
   handler touched. No src change.

## Feasibility / harness

The fork route reads the parent JSONL (the harness already writes a parent
transcript at `1×32`) then drives `daemon.loadSession(newId)`. The `/tmp`
harness stub daemon is enhanced with `loadSession: async () => ({})` so the
restore step succeeds and the route returns 200 with the new id (else it 502s +
rolls back). No product code depends on the harness.

## Verification

Playwright in-session (OWNER, has WRITE): enter the seeded parent id `1×32` →
Fork → a new `sessionId` (uuid) + `forkedAt` render; then List sessions
(cycle 57) shows the new fork under the parent. lint/build/test unchanged (no
src change), e2e 45/45.

## Deferred

`empty`/`summary` fork modes (HARD-BLOCKED at core loadSession:704); fork from a
fork-tree node click; naming the fork; fork-from-event.
