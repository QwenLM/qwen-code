# Remote-Control Gateway — Prompt Sending (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 7)
**Scope:** Send a prompt to a session from the browser viewer — the write
counterpart of cycle 6's approve/deny. Completes the core "fully drive the agent
from your phone" loop (watch + approve + **prompt**). Builds on cycles 1–6.

## Relationship to the OpenSpec proposal

This finishes the user-facing surface of `add-remote-control`. The proposal's
`design.md` is daemon-centric (it assumes prompt routing is baked into
`packages/cli/src/serve/`). We **deviate**: the unmodified daemon already exposes
prompt routing through the SDK (`DaemonClient.prompt`), so the gateway proxies it.
Zero upstream-file edits — consistent with cycles 1–6.

## Context

Cycle 6 added the first write surface (voting on permission requests). The viewer
can watch a session's SSE stream and approve/deny tool calls, but it cannot yet
_start_ a turn — the operator still needs a local terminal to type a prompt. This
cycle adds prompt submission, gated by a new `write` scope and audited.

Interaction surface (verified against `@qwen-code/sdk`):

- `DaemonClient.prompt(sessionId, req, signal?, clientId?)` → `Promise<PromptResult>`.
- `PromptRequest = { prompt: PromptContentBlock[]; _meta?; [k]: unknown }`.
- `PromptContentBlock = { type: 'text'; text: string } | Record<string, unknown>`.
- `PromptResult = { stopReason: string; [k]: unknown }`.
- `prompt()` is **long-lived** — a model+tool turn can take minutes; the SDK
  bypasses its fetch timeout. Cancellation is via an `AbortSignal`.

## Goal of this cycle

> From the browser viewer, type a prompt and send it to the watched session — the
> turn runs on the daemon, its events stream back into the same SSE view — gated by
> a `write` scope and recorded in the audit log.

## Non-goals (this cycle)

- No streaming of the prompt _response body_ back to the HTTP caller — the turn's
  output already arrives via the existing SSE events route. The POST returns once
  the daemon resolves the turn (with its `stopReason`).
- No cancel button (cancel is a later, small follow-on; `cancel(sessionId)` exists
  in the SDK).
- No rich content blocks in the UI — the viewer sends a single `text` block. The
  route accepts the full `PromptContentBlock[]` for forward-compat.
- No push/notification, no `@qwen-code/webui`.

## Decisions

1. **New flat `write` scope** gates prompt-sending; the **boot pairing code grants
   `[owner, session:read, approve, write]`** so the owner's viewer can drive out of
   the box. (A `session:read`-only token can watch but not prompt; `approve` does
   not imply `write`.)
2. **Audit every prompt attempt** after the daemon call, recording `stopReason`
   (and never the prompt text — keep audit free of payload content/secrets).
3. **Session-scoped route** (`POST /rc/session/:id/prompt`), mirroring the
   events and permission routes.
4. **Long-lived request handling:** the route awaits `daemon.prompt(...)` and does
   not impose its own timeout (the SDK already bypasses its timeout for prompt).
   If the HTTP client disconnects, abort the daemon prompt via an `AbortController`
   wired to `req`'s close — symmetric to how the SSE route aborts on disconnect.

## Components

### Scope (`src/scopes.ts`)

- Add `export const WRITE: RcScope = 'write'`.
- Add `WRITE` to `KNOWN_SCOPES` (so it's mintable and validated).

### Audit action (`src/auditLog.ts`)

- Add `'prompt_sent'` to the `AuditAction` union **and** to the `AUDIT_ACTIONS`
  runtime list.

### Prompt route (`src/routes/prompt.ts`) — new

```ts
export function createPromptRoute(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): RequestHandler;
```

`POST /rc/session/:id/prompt`, body `{ prompt: string } | { blocks: PromptContentBlock[] }`:

- Parse/validate the body into a `PromptContentBlock[]`:
  - If `body.prompt` is a non-empty string → `[{ type: 'text', text: body.prompt }]`.
  - Else if `body.blocks` is a non-empty array → use it verbatim (forward-compat).
  - Otherwise → `400 { code: 'invalid_prompt' }`.
- Create an `AbortController`; on `req` `'close'` _before_ the daemon resolves,
  `controller.abort()` (so a client disconnect cancels the daemon turn).
- Call `daemon.prompt(sessionId, { prompt: blocks }, controller.signal)`.
  - resolves → `200 { stopReason }`.
  - throws because the client aborted → no response needed (socket already closed);
    do not treat as a 502.
  - throws otherwise → `502 { code: 'daemon_unavailable' }`.
- After a resolved call, record audit `prompt_sent`:
  `{ actorTokenId: req.rcClient?.id, target: sessionId, detail: { stopReason,
blocks: <count> } }`. **Never** logs the prompt text. (Not recorded on `400` or
  on client-abort — no daemon decision/result.)

Gated by `requireScope(WRITE)` at the wiring site.

### Wiring (`src/server.ts`)

After the permission route:

```ts
app.post(
  '/rc/session/:id/prompt',
  requireScope(WRITE, audit),
  createPromptRoute(deps.daemon, audit),
);
```

### Boot grant (`src/cli.ts`)

Boot pairing code grants `[OWNER, SESSION_READ, APPROVE, WRITE]` (was
`[OWNER, SESSION_READ, APPROVE]`); banner scope line updated.

### Viewer UI (`public/index.html`)

Add a prompt composer below the event stream, shown once a session is being
watched:

- A `<textarea>` + **Send** button. On Send, `POST
/rc/session/<watchedSessionId>/prompt` with `{ prompt: <textarea value> }` and
  the bearer header.
- While the request is in flight, disable the button and show "sending…"; on
  `200` clear the textarea and show the returned `stopReason` briefly; on
  `401/403` show "not authorized"; on `400` show "empty prompt"; on `5xx`/network
  show "send failed".
- The turn's actual output arrives via the already-open SSE stream (no special
  handling needed). All status text via `textContent` (XSS-safe).

### Stub daemon (`src/testing/stubDaemon.ts`)

Add a `POST /session/:id/prompt` handler, configurable via a new option
(`promptStatus?: number` default `200`; `promptStopReason?: string` default
`'end_turn'`) returning `{ stopReason }` so the route is testable through the real
`DaemonClient`. (As with permission, the stub ignores the request body — wire
shape is covered by typecheck + the real-daemon e2e.)

## Data flow (drive the agent from a phone)

1. Operator watches a session in the viewer (cycle 5 SSE).
2. Types a prompt, taps Send → viewer `POST /rc/session/:id/prompt
{ prompt }` with the bearer.
3. `requireScope(write)` passes → route calls `daemon.prompt(...)` → daemon runs
   the turn; its `session_update`/`permission_request`/etc. events stream back
   into the viewer's open SSE view in real time.
4. The turn resolves → `200 { stopReason }`; `prompt_sent` is audited.

## Error model

| Condition                   | Response                                           |
| --------------------------- | -------------------------------------------------- |
| Missing/invalid bearer      | `401 unauthorized`                                 |
| Token lacks `write`         | `403 insufficient_scope` (+ `scope_denied` audit)  |
| Empty/!valid prompt body    | `400 invalid_prompt`                               |
| Daemon unreachable / errors | `502 daemon_unavailable`                           |
| Client disconnects mid-turn | daemon prompt aborted; no response (socket closed) |
| Turn resolved               | `200 { stopReason }`                               |

## Testing strategy (TDD)

**Route integration (`routes/prompt.test.ts`, real `DaemonClient` + stub):**

- `{ prompt: 'hello' }` with a `write` token → `200 { stopReason: 'end_turn' }`.
- `{ blocks: [{ type:'text', text:'hi' }] }` → `200`.
- empty body / `{ prompt: '' }` / `{ blocks: [] }` → `400`.
- token without `write` → `403`.
- stub returns 500 → route `502 daemon_unavailable`.
- a fake audit recorder captures a `prompt_sent` entry with `stopReason` and a
  block count, and **no prompt text**.

**Server integration (`server.test.ts`):** boot, mint a `write`-scoped token via a
pairing code, `POST` a prompt against the stub daemon → asserts the route is wired

- scope-gated (status per stub config).

**Manual e2e (`scripts/rc-gateway-e2e.mjs`):** with a `write`-scoped token, `POST`
a prompt for a bogus session id against the real daemon → expect a non-2xx daemon
error surfaced as `502` (proves route + scope + daemon reached without needing a
live model turn). Browser Send is manual.

## File boundary / isolation

All within `packages/rc-gateway/` — zero upstream-file edits. New:
`src/routes/prompt.ts` (+ test). Modified: `src/scopes.ts`, `src/auditLog.ts`
(one action), `src/server.ts` (wire + export), `src/cli.ts` (boot grant),
`src/testing/stubDaemon.ts` (prompt endpoint), `public/index.html` (composer),
`src/index.ts` (export `createPromptRoute`, `WRITE`), `src/server.test.ts`,
`scripts/rc-gateway-e2e.mjs`.

## Follow-on cycles

Next per the backlog: `add-webpush-notifications` (gateway-side push fed by the
SSE relay), then `add-policy-engine` (gateway auto-votes permission requests),
`add-notification-routing`, `add-link-share`, `add-cost-tracking`, etc. See
`qwen-rc-full-backlog-goal` memory for the full ordered plan.
