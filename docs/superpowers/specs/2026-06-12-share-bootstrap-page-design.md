# Cycle 62 — Link-share `/ui/share/<token>` bootstrap page

Proposal: `add-link-share`. Cycle 18 built the SHARE-scope backend
(`issueShare`, session-locked tokens, `GET /rc/share/whoami` redemption that
consumes one cookie-deduped use, `POST /rc/share` returning
`url:'/ui/share/'+token`). The deferred piece is the guest landing page itself.
This adds it.

## Feasibility (scoped fresh, advisor-validated)

- `bearerResolve` is header-only → the page reads the token from the URL path
  and sends it as `Authorization: Bearer`. OK.
- `/ui` is `express.static(webRoot,{fallthrough:false})` → `/ui/share/<token>`
  currently 404s. So a server route is REQUIRED to serve the page. It is a
  **dumb `sendFile`** that ignores `:token` (no server-side token lookup/log/
  validation — the whoami call is the only auth gate; an invalid token → 401 →
  the page says "expired or invalid"). Registered BEFORE the `/ui` static mount.
- `whoami` returns `{sessionId, scope:'view'|'approve', label, expiresAt,
usesRemaining}` and consumes a use (deduped by an httpOnly `rc_share_<id>`
  cookie; a reload/SSE-reconnect does NOT burn a use).

## Token-in-URL hygiene (the security crux)

A path-token can leak via Referer and history, so the page bakes in ALL of:

1. `<meta name="referrer" content="no-referrer">` — kills Referer even for the
   first request, before any script runs.
2. `history.replaceState(null,'','/ui/share')` BEFORE the first fetch — scrubs
   the token from the address bar / history.
3. Fully self-contained: inline CSS+JS, ZERO external sub-resources (any
   `<img>`/`<script src>` loading before the scrub would leak the token).
4. The token is stored in **`sessionStorage['rc-share-token']`** — a DISTINCT
   key from index.html's `localStorage` owner token (same origin!), ephemeral
   and per-tab.

**Honest limitation (in the spec by design):** the initial
`GET /ui/share/<token>` is unavoidably in the gateway/proxy access log — a
path-token cannot prevent that. TTL + revoke + `maxUses` (cycle 18) remain the
real bounds, NOT the scrub.

## Reload survival

After scrubbing to `/ui/share` (no token segment), a reload must still work. So
the server serves the page for BOTH `/ui/share` and `/ui/share/:token`, and the
page resolves the token as: path segment if present (first visit → store +
scrub), ELSE `sessionStorage` (reload). whoami's cookie-dedup means the reload
does not consume a second use.

## What it adds

- `public/share.html` (NEW): self-contained guest page. Bootstrap (extract →
  scrub → sessionStorage → whoami → render `{sessionId,scope,label,expiresAt,
usesRemaining}` via textContent) + a read-only fetch-SSE watch of the locked
  session's `/rc/session/:id/events` (mirrors index.html's watch; EventSource
  can't set Authorization). A small "read-only shared view" watermark.
- `server.ts` (EDIT): `app.get(['/ui/share','/ui/share/:token'], serveShare)`
  registered BEFORE `app.use('/ui', static)`; `serveShare` = `res.sendFile(
join(webRoot,'share.html'), cb)` with an error callback (no global error
  middleware → a sendFile error must not hang/throw).

## Decisions

1. Read-only VIEW this cycle; approve (for approve-scope shares) and prompt are
   DEFERRED. A share you can't watch is pointless, so the watch is the minimum
   core; approve is additive later.
2. textContent-only for every server field (`label`/`sessionId`/event data) —
   same XSS rule as index.html.
3. The route is a static sendFile; the page is identical for every token (the
   token never reaches the server route logic).

## Fail-safe commit order

docs → `public/share.html` INERT (not routed yet; `/ui/share/<token>` still
404s via static, identical to today → no regression) → `server.ts` route +
`server.test.ts` (wiring LAST).

## Verification

- Unit (server.test.ts): `GET /ui/share/anything` → 200, `text/html`, body
  contains a page marker; `GET /ui/share` → 200; an unrelated `/ui/sw.js` still
  served by static (no route shadowing).
- Playwright in-session: harness `issueShare({sessionId:<seeded on-disk
session>, scopes:[SHARE,SESSION_READ], ttlSec, maxUses:2})` → navigate
  `/ui/share/<token>` → assert whoami renders the locked `sessionId` + scope,
  the address bar is scrubbed to `/ui/share`, and `sessionStorage` holds the
  token (and `localStorage` does NOT). Reload → still connected, and
  `usesRemaining` UNCHANGED (cookie dedup) — the one behavior live testing can
  catch regressing.
- e2e 45/45 unchanged (no existing route changed); the new route is additive.

## Deferred

Approve/prompt from the share page; a "link expired" countdown; the
`qwen rc share` CLI; share-lifecycle SSE; hiding/streaming richer event types.
The session watch's live STREAM is not verifiable against the harness stub
daemon (it emits no session events) — the bootstrap/scrub/dedup/whoami ARE
playwright-verified; the watch wiring is the proven index.html pattern.
