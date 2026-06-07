# Remote-Control Gateway — Permission Approval (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 6)
**Scope:** Approve/deny a session's pending permission requests from the browser — the spec's marquee "approve a bash command from my phone" (story S2). Builds on cycles 1–5.

## Context

Cycle 5 shipped a read-only web viewer at `/ui/` (pair → watch a session's SSE).
The daemon already emits `permission_request` events into that stream — the
viewer renders them as plain JSON today but can't act on them. This cycle adds
the first _write_ interaction: voting on a pending permission request.

Interaction surface (verified against `@qwen-code/sdk`):

- A `permission_request` event carries `{ requestId, toolCall, options:
[{ optionId, ... }] }` (`DaemonPermissionRequestData`).
- Responding: `respondToSessionPermission(sessionId, requestId, response)` where
  `response` is `{ outcome: 'selected', optionId } | { outcome: 'cancelled' }`;
  it `POST`s the daemon's `/session/:id/permission/:requestId` and returns a
  boolean (`true` accepted, `false` on 404 = no pending / already resolved).

## Goal of this cycle

> From the browser viewer, when the agent asks permission for a tool call,
> tap Approve (an option) or Deny — and the vote reaches the daemon, gated by an
> `approve` scope and recorded in the audit log.

## Non-goals (this cycle)

- No prompt-sending (`write` scope) — that's cycle 7.
- No push/notification of incoming permission requests (the viewer must be open
  and watching).
- No `@qwen-code/webui`; the viewer stays vanilla.
- No scope hierarchy (`approve` is another flat scope).

## Decisions (from brainstorming)

1. **New flat `approve` scope** gates voting; the **boot pairing code grants
   `[owner, session:read, approve]`** so the owner's viewer can approve out of
   the box (a `session:read`-only token cannot vote).
2. **Audit every vote attempt** (after the daemon call) with an `accepted` flag.
3. **Session-scoped vote route** (`/rc/session/:id/permission/:requestId`),
   mirroring the session-scoped events route.

## Components

### Scope (`src/scopes.ts`)

- Add `export const APPROVE: RcScope = 'approve'`.
- Add `APPROVE` to `KNOWN_SCOPES` (so it's mintable and validated).

### Audit action (`src/auditLog.ts`)

- Add `'permission_voted'` to the `AuditAction` union **and** to the
  `AUDIT_ACTIONS` runtime list.

### Permission-vote route (`src/routes/permission.ts`) — new

```ts
export function createPermissionVoteRoute(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): RequestHandler;
```

`POST /rc/session/:id/permission/:requestId`, body `{ outcome, optionId? }`:

- Parse/validate: `outcome` must be `'selected'` or `'cancelled'`; if
  `'selected'`, `optionId` must be a non-empty string. Otherwise
  `400 { code: 'invalid_vote' }`.
- Build the `PermissionResponse` (`{ outcome: 'cancelled' }` or
  `{ outcome: 'selected', optionId }`) and call
  `daemon.respondToSessionPermission(sessionId, requestId, response)`.
  - `true` → `200 { accepted: true }`.
  - `false` → `404 { code: 'no_pending_permission' }`.
  - throw → `502 { code: 'daemon_unavailable' }`.
- After the call (success or 404), record audit `permission_voted`:
  `{ actorTokenId: req.rcClient?.id, target: sessionId, detail: { requestId,
outcome, accepted } }`. (Not recorded on `400`/`502` — no daemon decision.)

Gated by `requireScope(APPROVE)` at the wiring site.

### Wiring (`src/server.ts`)

After the existing session-events route:

```ts
app.post(
  '/rc/session/:id/permission/:requestId',
  requireScope(APPROVE, audit),
  createPermissionVoteRoute(deps.daemon, audit),
);
```

### Boot grant (`src/cli.ts`)

Boot pairing code grants `[OWNER, SESSION_READ, APPROVE]` (was
`[OWNER, SESSION_READ]`); banner scope line updated.

### Viewer UI (`public/index.html`)

In the stream-render loop, when `ev.type === 'permission_request'`:

- Render an interactive card (not just a log line): a summary of `ev.data.toolCall`
  (stringified) + the `requestId`, an **Approve** button per `ev.data.options`
  entry (labeled by its option, value = `optionId`), and a **Deny** button.
- A button click `POST`s `/rc/session/<watchedSessionId>/permission/<requestId>`
  with `{ outcome }` and the bearer header; on `200` it shows "approved/denied"
  and disables the card's buttons; on `401/403` shows "not authorized"; on `404`
  shows "already resolved".
- Track the currently-watched session id (from the Watch input) so votes target
  the right session. All rendering via `textContent` (XSS-safe). Cards also
  disable if a later `permission_resolved` event for that `requestId` arrives.

### Stub daemon (`src/testing/stubDaemon.ts`)

Add a `POST /session/:id/permission/:requestId` handler, configurable via a new
option (e.g. `permissionStatus?: number`, default `200` → accepted; `404` →
no-pending) so the vote route is testable through the real `DaemonClient`.

## Data flow (approve a bash command from a phone)

1. Agent proposes a tool call → daemon emits `permission_request` → gateway
   relays it into the viewer's SSE stream → viewer renders an Approve/Deny card.
2. User taps Approve(option) → viewer `POST /rc/session/:id/permission/:requestId`
   `{ outcome: 'selected', optionId }` with the bearer.
3. `requireScope(approve)` passes → route calls
   `daemon.respondToSessionPermission(...)` → daemon resolves the request →
   `200 { accepted: true }`; `permission_voted` is audited.
4. The tool result subsequently streams back into the viewer.

## Error model

| Condition                             | Response                                          |
| ------------------------------------- | ------------------------------------------------- |
| Missing/invalid bearer                | `401 unauthorized`                                |
| Token lacks `approve`                 | `403 insufficient_scope` (+ `scope_denied` audit) |
| Bad body (outcome/optionId)           | `400 invalid_vote`                                |
| No pending request / already resolved | `404 no_pending_permission`                       |
| Daemon unreachable                    | `502 daemon_unavailable`                          |
| Vote accepted                         | `200 { accepted: true }`                          |

## Testing strategy (TDD)

**Route integration (`routes/permission.test.ts`, real `DaemonClient` + stub):**

- `{ outcome: 'selected', optionId }` with an `approve` token → `200 { accepted: true }`.
- `{ outcome: 'cancelled' }` → `200`.
- invalid body (`selected` without `optionId`; unknown outcome) → `400`.
- token without `approve` → `403`.
- stub returns 404 → route `404 no_pending_permission`.
- a fake audit recorder captures a `permission_voted` entry with the requestId.

**Server integration (`server.test.ts`):** boot, mint an `approve`-scoped token
via a pairing code, `POST` a vote for a bogus requestId against the stub daemon →
asserts the route is wired + scope-gated (status per stub config).

**Manual e2e (`scripts/rc-gateway-e2e.mjs`):** with an `approve`-scoped token,
`POST` a vote for a bogus requestId against the real daemon → expect `404`
(proves route + scope + daemon reached). Browser Approve/Deny is manual.

## File boundary / isolation

All within `packages/rc-gateway/` — zero upstream-file edits. New:
`src/routes/permission.ts` (+ test). Modified: `src/scopes.ts`,
`src/auditLog.ts` (one action), `src/server.ts` (wire + export-as-needed),
`src/cli.ts` (boot grant), `src/testing/stubDaemon.ts` (permission endpoint),
`public/index.html` (approve/deny UI), `src/index.ts` (export
`createPermissionVoteRoute`, `APPROVE`), `src/server.test.ts`,
`scripts/rc-gateway-e2e.mjs`.

## Follow-on cycles (still not now)

Cycle 7: prompt-sending (`write` scope + prompt proxy route + prompt input).
Then: push notification of permission requests, `@qwen-code/webui` UI,
cross-origin CORS, durable WAL, SSE fan-out, scope hierarchy, `qwen rc` TUI,
bridges.
