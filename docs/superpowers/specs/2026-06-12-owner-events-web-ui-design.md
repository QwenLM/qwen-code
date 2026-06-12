# Cycle 54 — Owner event-stream web UI (`/rc/events` consumer)

Proposal: `add-policy-engine` Phase 4 (the web UI consuming the cycle-49
owner-broadcast SSE) + `add-notification-routing` R6 ("operator sees why
no push fired" — the prefs/quiet/working/routing suppression audits from
cycles 29/46/49/53 now have a live browser view).

First cycle of a web-UI batch enabled by a verified premise: **the
playwright MCP browser CAN reach a WSL-localhost gateway** (confirmed by
navigating `/ui/` against a `/tmp` harness that mounts `createGatewayApp`
on a fixed port). So these UIs are playwright-verified IN-SESSION — NOT
e2e-covered (the suite stays at 45; `scripts/rc-gateway-e2e.mjs` mounts
no browser).

## What it adds

A self-contained "Owner event stream" section in `public/index.html`:
a Watch/Stop pair that streams `GET /rc/events` into a dedicated log,
rendering each live audit record (`{ts, action, actorTokenId?, target?,
detail?}`). This is the browser consumer of cycle 49's `OwnerEventBus`.

## Feasibility (verified, primary-source)

- **`bearerResolve` reads ONLY the `Authorization` header** (auth.ts:19),
  no query-param token. So a browser `EventSource` (cannot set headers)
  CANNOT authenticate. The UI uses **fetch-based SSE**: `fetch('/rc/events',
{headers:{Authorization:'Bearer '+token}})` → `res.body.getReader()` →
  `TextDecoder` → split on `\n\n` → parse `data:` lines. This is the
  EXACT pattern the existing `watch` handler already uses against
  `/rc/session/:id/events` (index.html:289-338) — a near-copy, low risk.
- Browser `response.body` streams per spec (the cycle-49 undici batching
  was node-fetch-specific, not browser); the existing `watch` UI already
  depends on incremental delivery.
- The token from the existing pairing flow works if it carries OWNER
  (a non-owner gets 403 at the gate — surfaced as "not authorized").

## SSE frame handling (the only real logic)

Per `\n\n`-delimited block: a `data:` line → JSON-parse → render
`ts action [target] detail`; an `event: resync` block (cycle-49
backpressure marker) → render a "dropped N (see /rc/audit)" notice; a
`:`-comment line (the `: ok` opener + 25 s heartbeats) → ignore. Mirrors
the cycle-49 server contract.

## Decisions

1. **Extend `index.html`, don't add a page.** Owner already paired here;
   reuse the `localStorage` token. A NEW section + handler that does NOT
   touch the existing pair/watch/send handlers — a mid-cycle cut leaves
   today's UI working (the HTML analogue of inert-first).
2. **Inline SSE parsing (not a shared/extracted helper).** public/ is
   served raw (no bundler/build step copies src→public), so a browser
   page cannot import a unit-tested `src` TS module without duplicating
   it. Mirroring the existing `watch` handler's inline parse is the
   honest choice; playwright covers it end-to-end. Not refactoring the
   working `watch` handler (keeps the cut safe).
3. **Read-only.** No new gateway route/audit — `/rc/events` (OWNER) and
   the audit producer already exist (cycle 49). This is purely a client.

## Verification

Playwright in-session against the `/tmp` harness: navigate `/ui/` → pair
with an OWNER code → click "Watch events" (assert "streaming") →
`browser_evaluate` a `POST /rc/tokens` mint (generates a `token_minted`
audit) → assert the events log shows the `token_minted` frame live. Plus
typecheck/lint/build/test unchanged (no `src` change) and the existing
e2e 45/45 (no backend change).

## Deferred

Filtering/pause/clear controls, a fork-tree view (cycle-50 `/rc/sessions`
consumer — a later UI cycle), `Last-Event-ID` replay via `/rc/audit`,
styling polish.
