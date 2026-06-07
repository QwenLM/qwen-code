# Remote-Control Gateway — Minimal Web Viewer (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 5)
**Scope:** A minimal same-origin, read-only web client served by the gateway: pair in a browser, then watch a session's event stream live. First browser-facing slice. Builds on cycles 1–4.

## Context

The gateway has pairing → scoped tokens → SSE proxy (cycle 1), token management
(cycle 2), audit log (cycle 3), and audit query + rotation (cycle 4) — all
API-only. There is no browser client. This cycle adds a tiny self-hosted web
viewer so a human can pair and watch a session from a phone/laptop browser.

Three facts established during brainstorming that shape this design:

- The gateway has **no CORS/origin denial** (that was the daemon's middleware).
  Serving the client at the gateway's own origin is **same-origin → no CORS
  needed**. Cross-origin embedders are a later concern.
- `@qwen-code/webui` is a React + Tailwind component library — embedding it pulls
  in a bundler/build step. Out of scope; this slice is **vanilla**.
- Browsers' `EventSource` cannot send an `Authorization` header, and a
  token-in-URL would leak into our audit `path` logging. So the client reads SSE
  via **`fetch` + `getReader()`** with the bearer header.

## Goal of this cycle

> Open the gateway URL in a browser, paste a pairing code to get a token, enter a
> session id, and watch that session's events stream in live — all same-origin,
> read-only, no build tooling.

## Non-goals (this cycle)

- No interactivity (sending prompts, approving permissions) — that's cycle 6
  (needs new proxy routes + a write/approve scope).
- No `@qwen-code/webui` / framework / bundler.
- No cross-origin CORS allowlist (same-origin only).
- No PWA / offline / service worker; no multi-session dashboard.
- No automated browser tests (no Playwright this cycle) — serving is
  integration-tested; the UI itself is proven by manual e2e.

## Components

### Static client (`packages/rc-gateway/public/index.html`) — new

A single self-contained file (inline CSS + JS, no external deps):

- **Pair section:** a text input for a pairing code + "Pair" button. On click:
  `POST /rc/pair/redeem` with `{ code, label: 'web' }`; on `200`, store
  `token` in `localStorage['qwen-rc-token']` and show "paired"; on `400`, show
  "invalid code".
- **Watch section:** a text input for a session id + "Watch" button. On click:
  `fetch('/rc/session/' + encodeURIComponent(id) + '/events', { headers: {
Authorization: 'Bearer ' + token } })`, then read `res.body.getReader()` in a
  loop, decode chunks, split on `\n\n`, and for each block take the `data:` line,
  `JSON.parse` it, and append a row to a scrolling `<pre>` log. On `401/403`,
  show "not authorized — re-pair". A "Stop" button aborts via `AbortController`.
- **Status line** for messages; minimal inline styling. No secrets in markup.

The token lives only in `localStorage` and the `Authorization` header — never in
a URL or query string.

### Static serving (`packages/rc-gateway/src/server.ts`)

Add, **before** `app.use(bearerResolve(...))` (so the shell is public, like
`/rc/health` and `/rc/pair/redeem`):

```ts
const webRoot =
  deps.webRoot ?? fileURLToPath(new URL('../public', import.meta.url));
app.use('/ui', express.static(webRoot));
```

`new URL('../public', import.meta.url)` resolves to `packages/rc-gateway/public`
from both `src/` (vitest) and `dist/` (runtime), since both sit one level under
the package root. `express.static` serves `index.html` for `/ui/` and safely
404s unknown or `..`-traversal paths. `GatewayDeps` gains an optional
`webRoot?: string` (override for tests/embedders; defaults as above).

### CLI hint (`packages/rc-gateway/src/cli.ts`)

Add a line to the boot banner pointing at the viewer, e.g.
`web viewer: http://127.0.0.1:<port>/ui/`. (Cosmetic; no logic.)

## Data flow (watch from a phone)

1. Phone browser → `GET /ui/` → gateway serves `index.html` (public, no token).
2. User pastes the owner pairing code → JS `POST /rc/pair/redeem` → token saved
   in `localStorage`.
3. User enters a session id → JS `fetch` the events route with the bearer →
   gateway proxies the daemon SSE (cycle 1) → JS renders frames live.

No CORS is involved (same origin). The events request is an authenticated
fetch, so `session_attached`/`session_detached` audit entries (cycle 3) attribute
to the web token.

## Error handling

- `express.static` returns `404` for missing assets and blocks path traversal.
- Client surfaces: redeem `400` ("invalid code"), stream `401/403`
  ("re-pair / not authorized"), and network/abort states in the status line.
- Serving the shell never requires auth; it exposes no secrets.

## Testing strategy

**Integration (`server.test.ts`):**

- `GET /ui/` → `200`, `content-type` includes `text/html`, body contains a known
  marker from the page (e.g. the title or an element id), reachable with **no**
  `Authorization` header.
- `GET /ui/does-not-exist.js` → `404`.

**Manual e2e (this slice's real proof):**

- `node packages/rc-gateway/dist/cli.js serve`, open
  `http://127.0.0.1:4170/ui/`, paste the printed owner pairing code, enter a
  session id, confirm events render. (Documented; not automated.)
- Extend `scripts/rc-gateway-e2e.mjs` to assert `GET /ui/` returns HTML against
  the real daemon (cheap automated coverage of the serving path).

## File boundary / isolation

All within `packages/rc-gateway/` — zero upstream-file edits. New:
`public/index.html`. Modified: `src/server.ts` (static route + `webRoot` dep),
`src/server.test.ts` (serving tests), `src/cli.ts` (banner line),
`scripts/rc-gateway-e2e.mjs` (assert `/ui/`). Note: `public/` is a static asset
dir (not compiled by tsc); it ships alongside `dist/`.

## Follow-on cycles (still not now)

Cycle 6: interactivity — `POST` prompt + permission-vote proxy routes, a
write/approve scope, and browser controls (the "approve a bash command from my
phone" use case). Then: `@qwen-code/webui`-based UI, cross-origin CORS allowlist,
PWA/offline, durable WAL, SSE fan-out, scope hierarchy, `qwen rc` TUI, bridges.
