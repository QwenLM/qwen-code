# Remote-Control Gateway — Walking Skeleton (Design)

**Date:** 2026-06-06
**Status:** Proposed (first implementation cycle)
**Scope:** First vertical slice of `add-remote-control`. Proves the gateway seam end-to-end; does **not** implement the full pairing-auth feature set.

## Context

The qwen-code OpenSpec proposals (`openspec/changes/`) describe a remote-control
feature: per-client pairing with scoped tokens, a hosted web/PWA client, durable
event replay, bridges, etc. Reconciling those proposals against the actual
v0.17.1 codebase surfaced a strategic constraint:

- `packages/cli/src/serve/` (the daemon) is upstream's most actively-developed
  area (integration branch `daemon_mode_b_main`).
- Upstream's stated direction (issue #4175): the daemon is a **single-bearer**,
  multi-client runtime for TUI/channels/SDK/IDE clients; **browser clients are
  explicitly out of scope**; `@qwen-code/webui` is a library for _downstream
  embedders_ to host.
- The spec's pairing-auth + hosted web client therefore **diverge** from
  upstream and would live in the files upstream rewrites most.

**Decision (recorded):** build remote-control as a **fork-owned gateway** that
wraps the _unmodified_ daemon and consumes its public contract via the published
SDK `@qwen-code/sdk`. This keeps `git fetch upstream` clean (zero edits to
upstream files) and aligns with upstream's "downstream embedder" model.

A spike (2026-06-06) verified `@qwen-code/sdk@0.1.7`'s `DaemonClient` /
`DaemonSessionClient` expose everything the gateway must proxy: bearer-auth
passthrough, capabilities, session create/attach/list/load/resume, prompt/cancel,
SSE relay with `Last-Event-ID` reconnect, and permission voting.

## Goal of this cycle

A walking skeleton that proves the seam:

> Gateway boots → spawns `qwen serve` on loopback → operator mints a pairing
> code → a client redeems it for one persisted, scoped token → the gateway
> authenticates that token, enforces a scope, and proxies a single daemon route
> (`GET /session/:id/events`, SSE) through to the client — with tests.

Everything else (revocation, multi-scope hierarchy, request audit, CORS flip,
hosted web client, durable WAL) is explicitly **out of scope** for this cycle and
layers on as follow-on plans.

## Non-goals (this cycle)

- No browser client, no CORS allowlist (skeleton clients are a test HTTP client
  and the future `qwen rc` TUI; browser support is the web-client cycle).
- No durable WAL (rely on the daemon's in-memory replay ring for now).
- No request-level audit log, no token revocation, no scope hierarchy beyond a
  flat set, no SQLite (JSON file persistence is sufficient for the skeleton).
- No daemon auto-restart/supervision policy beyond "spawn on boot, kill on exit."
- No multi-workspace / multi-daemon management.

## Architecture

New fork-owned package **`packages/rc-gateway/`** (`@qwen-code/rc-gateway`),
auto-included by the root `packages/*` workspace glob — **zero upstream-file
edits**. It depends on `@qwen-code/sdk` (workspace dependency).

```
 client (test HTTP / future qwen rc TUI)
        │  Authorization: Bearer <gateway token>   (+ optional Last-Event-ID)
        ▼
 ┌─────────────────────────────────────────────┐
 │ rc-gateway (Express app)                     │   packages/rc-gateway/  (NEW)
 │  POST /rc/pair/redeem      (code → token)    │
 │  GET  /rc/session/:id/events  (scoped proxy) │
 │  GET  /rc/health                             │
 │  ─ bearerResolve → req.rcClient{id,scopes}   │
 │  ─ requireScope('session:read')              │
 │  ─ tokenStore (JSON, 0600)                   │
 │  ─ pairing (in-memory codes)                 │
 │  ─ DaemonClient (from @qwen-code/sdk)        │
 └───────────────┬─────────────────────────────┘
                 │ Authorization: Bearer <daemon token>  (loopback)
                 ▼
        qwen serve daemon (UNMODIFIED, upstream)
        spawned by daemonSupervisor on 127.0.0.1:<ephemeral>
```

### Components

1. **`daemonSupervisor.ts`** — production wiring. Generates a random 256-bit
   bearer token, spawns `qwen serve` as a child with `QWEN_SERVER_TOKEN` in the
   environment (not `--token`, which leaks via `/proc/<pid>/cmdline`) bound to
   `127.0.0.1` on an ephemeral port, polls `GET /health` until ready, then
   constructs a `DaemonClient({ baseUrl, token })`. Kills the child on gateway
   shutdown. **Injectable:** the gateway app accepts a ready `DaemonClient` so
   tests bypass the supervisor and point at a stub daemon.

2. **`tokenStore.ts`** — persists issued tokens at `~/.qwen/rc/tokens.json`
   (mode `0600`). Record: `{ id, tokenHash, scopes: string[], label, createdAt }`.
   Tokens are high-entropy random (256-bit); stored as `sha256(token)` and
   matched with `timingSafeEqual` (mirrors the daemon's own `auth.ts` approach —
   argon2 is unnecessary for high-entropy secrets). Raw token returned to the
   client exactly once, at redemption. API: `issue(scopes, label) → {id, token}`,
   `resolve(bearer) → {id, scopes} | null`, load/persist.

3. **`pairing.ts`** — in-memory pairing codes. `mint(grantScopes) → {code,
expiresAt}` (8+ chars, 5-min TTL, single-use). `redeem(code) → grantScopes |
error` (validates existence/expiry/unused, marks used). On gateway boot, an
   **owner pairing code** is minted and printed to the operator console.

4. **`auth.ts`** (gateway) — `bearerResolve` middleware parses
   `Authorization: Bearer` (reusing the daemon's timing-safe, CodeQL-safe
   `indexOf`-based parse), calls `tokenStore.resolve`, attaches
   `req.rcClient = { id, scopes }` or returns `401`. `requireScope(scope)`
   returns `403` (`code: 'insufficient_scope'`) when the scope is absent.

5. **`routes/sessionEvents.ts`** — `GET /rc/session/:id/events`, gated by
   `bearerResolve` + `requireScope('session:read')`. Reads the `Last-Event-ID`
   request header, calls `daemonClient.subscribeEvents(sessionId, { lastEventId })`,
   and relays each frame downstream as SSE preserving the daemon's event `id`.
   Aborts the upstream subscription when the client disconnects. Maps daemon
   errors: unreachable → `502`, unknown session → `404`.

6. **`routes/pair.ts`** — `POST /rc/pair/redeem { code, label }` → on valid code,
   `tokenStore.issue(grantScopes, label)` → `200 { id, token, scopes }`; invalid/
   expired/used → `400 { code: 'invalid_pairing_code' }`.

7. **`server.ts` (`createGatewayApp`)** — builds the Express app. Pipeline:
   `express.json()` → unauthenticated `POST /rc/pair/redeem` (code-gated) →
   `GET /rc/health` → `bearerResolve` → scope-gated `GET /rc/session/:id/events`.

8. **`cli.ts`** (bin `qwen-rc`) — `qwen-rc serve [--port] [--host]`: boots the
   supervisor + gateway, prints the gateway URL and the owner pairing code. A
   standalone `qwen-rc` binary (rather than a `qwen rc` subcommand) keeps us from
   editing the upstream CLI's command registry.

## Data flow (happy path)

1. `qwen-rc serve` → supervisor spawns `qwen serve` (loopback, ephemeral port,
   `QWEN_SERVER_TOKEN`), waits for health, builds `DaemonClient`.
2. Gateway listens on `127.0.0.1:<port>`; prints owner pairing code granting
   `["session:read"]`.
3. Client `POST /rc/pair/redeem { code, label }` → `{ token, scopes:
["session:read"] }`.
4. Client `GET /rc/session/:id/events` with `Authorization: Bearer <token>`
   (+ optional `Last-Event-ID`) → `bearerResolve` → `requireScope('session:read')`
   → `daemonClient.subscribeEvents` → frames relayed with ids preserved.

## Error handling

| Condition                         | Response                                               |
| --------------------------------- | ------------------------------------------------------ |
| Missing/invalid bearer            | `401 { error, code:'unauthorized' }`                   |
| Valid token, missing scope        | `403 { error, code:'insufficient_scope' }`             |
| Invalid/expired/used pairing code | `400 { error, code:'invalid_pairing_code' }`           |
| Daemon unreachable                | `502 { error, code:'daemon_unavailable' }`             |
| Unknown session                   | `404`                                                  |
| Client disconnects mid-SSE        | upstream `subscribeEvents` aborted, resources freed    |
| Daemon child exits                | gateway logs + shuts down (no auto-restart this cycle) |

**Known limitation (this cycle):** the proxy route awaits the first upstream
frame before sending `200` + SSE headers downstream (so a connect-phase error
surfaces as a clean `502` instead of after headers are committed). The SDK's
`subscribeEvents` does not expose a "connected but idle" signal between the HTTP
`200` and the first frame, so for a live session that is idle with no replay
backlog, the downstream client stays in `CONNECTING` until the daemon emits
something. Acceptable for the skeleton; the follow-on fix is to send headers on
connect plus a heartbeat comment to keep an idle stream open (depends on the SDK
surfacing a connect-only signal, or dropping to a lower-level call).

## Testing strategy (TDD)

**Stub daemon** for hermetic integration tests: a tiny Express+SSE server that
emits frames with incrementing ids and honors `Last-Event-ID`. The gateway's
`DaemonClient` points at it — no need to build/boot the real monorepo daemon in
unit/integration tests.

- **Unit** — `tokenStore` (issue/resolve, sha256 + timing-safe, JSON persistence,
  `0600`); `pairing` (mint/redeem, expiry, single-use); `auth` middleware
  (`401`/`403`/pass); `requireScope`.
- **Integration** (gateway app + stub daemon):
  - redeem flow yields a usable token;
  - authed + `session:read` request relays stub frames in order with ids preserved;
  - token lacking `session:read` → `403` (issued via a pairing code minted with
    a grant set that omits `session:read` — `pairing.mint(grantScopes)` accepts
    an arbitrary scope set, so the boot owner-code is not the only possible token);
  - bad/absent bearer → `401`;
  - `Last-Event-ID: N` forwards `Last-Event-ID` upstream and resumes after `N`;
  - client disconnect aborts the upstream subscription;
  - stub daemon returning 5xx/refused → `502`.
- **Manual/e2e (optional, not gating):** boot the real `qwen serve` via the
  supervisor and confirm a live proxied SSE round-trip.

## File boundary / isolation

- All new code under `packages/rc-gateway/` — **no upstream files modified.**
- Dependency on `@qwen-code/sdk` via workspace reference.
- Auto-included by the root `packages/*` workspace glob; root `package.json`
  unchanged.
- Design doc lives at `docs/superpowers/specs/` in the fork.

## Follow-on cycles (not now)

Token revocation + `GET/DELETE /rc/tokens`; request-level audit log; scope
hierarchy (`owner`/`write`/`approve`/`read`); pairing mint route (owner-gated)
beyond the boot code; CORS allowlist + hosted web client (embedding
`@qwen-code/webui`); durable WAL mirror; SSE fan-out multiplexer (one upstream
subscription per session); `qwen rc` TUI client; bridges as gateway clients.
