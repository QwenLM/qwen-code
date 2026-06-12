# Cycle 64 — Owner share-creation web UI (`POST /rc/share` consumer)

Proposal: `add-link-share`. Cycle 62 added the GUEST bootstrap page
(`/ui/share/<token>`); this adds the OWNER side — a section in index.html to
CREATE a share link, completing the round-trip (owner mints the link here →
guest redeems it there).

## Deviation note

Gateway-side UI; consumes the existing owner-gated `POST /rc/share`. No daemon
change.

## Route contract (read from source)

`POST /rc/share` (OWNER) body `{sessionId (required, non-empty), ttlSec
(required, >0), label?, scope?:'view'|'approve', maxUses?}` → 201 `{id, token,
url:'/ui/share/'+token, expiresAt}`; 400 `invalid_share`. ttlSec is clamped
[300, 2592000] and maxUses clamped server-side.

## What it adds

A "Create share link" `<section>`: a session-id input, a ttl (seconds) input, a
scope `<select>` (view/approve), a maxUses input, and a Create button →
`POST /rc/share` → renders the FULL shareable URL (`location.origin` + the
returned `url`) plus the expiry, as selectable text the owner can copy.

## Decisions

1. The returned `token` (in `url`) is shown to the OWNER who is creating the
   link — that is the whole point (they forward it). Rendered via `textContent`
   in a selectable element; no auto-copy (clipboard API is permission-gated and
   non-essential).
2. The full URL is `location.origin + body.url` so it is openable as-is.
3. Surface 400 `invalid_share` and 401/403 (needs owner). Empty sessionId / bad
   ttl are guarded client-side too.
4. Self-contained section (new ids `share-*`), touches no existing handler.
   textContent-only. No src change.

## Verification

Playwright in-session (harness OWNER): enter the seeded parent session id +
ttl 3600 + scope view + maxUses 2 → Create → a `/ui/share/<token>` URL renders
with the origin + an expiry; then NAVIGATE the browser to that exact URL and
confirm the cycle-62 guest page redeems it (the full owner→guest round-trip in
one run). lint/build/test unchanged (no src change), e2e 45/45.

## Deferred

A copy-to-clipboard button; listing/revoking existing shares from the UI (GET/
DELETE /rc/share exist); a QR code; pre-filling the session id from the
fork-tree/watch panels.
