# Remote-Control Gateway — Request Audit Log (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 3)
**Scope:** A write-only, append-only audit log of security-relevant gateway events. Builds on cycles 1–2.

## Context

The gateway (`packages/rc-gateway/`) now does pairing → scoped tokens → SSE proxy
(cycle 1) and owner-authorized token list/mint/revoke with live eviction
(cycle 2). None of these security-relevant actions are recorded anywhere: there
is no way to answer "which tokens were issued or revoked, by whom, and who was
denied access." This cycle adds an append-only audit log.

## Goal of this cycle

> Every security-relevant gateway event — credential lifecycle, access denials,
> and session attach/detach — is appended as one JSON line to
> `~/.qwen/rc/audit.log`, best-effort and never blocking or breaking a request.

## Non-goals (this cycle)

- No query API (`GET /rc/audit`) — operator reads/greps the file directly.
- No log rotation or size cap (single growing append-only file for now).
- No tamper-evidence (hash chaining / signing).
- No external shipping (syslog, SIEM).

## Decisions (from brainstorming)

1. **Capture all seven events:** `pairing_redeemed`, `token_minted`,
   `token_revoked`, `auth_failed` (401), `scope_denied` (403),
   `session_attached`, `session_detached`.
2. **Write-only to disk** — append JSONL to `~/.qwen/rc/audit.log`; no read API.
3. **Best-effort fire-and-forget** — `record()` is non-blocking and never
   throws; a failed/lost audit write must never delay or fail a request.

## Components

### AuditLog (`src/auditLog.ts`) — new

```ts
export type AuditAction =
  | 'pairing_redeemed'
  | 'token_minted'
  | 'token_revoked'
  | 'auth_failed'
  | 'scope_denied'
  | 'session_attached'
  | 'session_detached';

export interface AuditEntry {
  action: AuditAction;
  /** Resolved caller token id, when known. Never a raw token or hash. */
  actorTokenId?: string;
  /** Affected resource: a token id (mint/revoke) or a session id (attach/detach). */
  target?: string;
  /** Small extras: granted scopes, required scope, request path. No secrets. */
  detail?: Record<string, unknown>;
}
```

- Construct: `new AuditLog(filePath: string, nowFn: () => number = Date.now)`.
- `record(entry: AuditEntry): Promise<void>` — stamps `ts` (epoch ms from
  `nowFn`) and appends `JSON.stringify({ ts, ...entry }) + '\n'` to the file via
  `appendFile`. Ensures the directory exists and the file mode is `0600`.
  **Never throws** — wraps its own I/O in try/catch (on failure: best-effort
  `console.warn`, swallow). Returns a promise that always resolves.
- Concurrency: relies on `O_APPEND` (the default for `appendFile`), under which
  each small line-sized write lands atomically at EOF — no interleaving, no
  mutex needed.
- Callers fire-and-forget: `void audit.record({ ... })`. Tests may `await` it
  before reading the file.

### Sensitive-data rule

Never log raw tokens or token hashes. Log only token **ids** (already
non-secret, surfaced by `/rc/tokens`) and scope names.

## Integration points (explicit `record()` calls)

Explicit semantic calls at each security point — not a generic
response-status middleware, which could neither name `pairing_redeemed` vs
`token_minted` nor attribute a 401.

| Action             | Call site                                                            | Fields                                                                 |
| ------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pairing_redeemed` | `routes/pair.ts`, after `store.issue` succeeds                       | `target` = new token id, `detail.scopes`                               |
| `token_minted`     | `routes/tokens.ts` POST, after `store.issue`                         | `actorTokenId` = `req.rcClient.id`, `target` = new id, `detail.scopes` |
| `token_revoked`    | `routes/tokens.ts` DELETE, after successful revoke                   | `actorTokenId`, `target` = revoked id                                  |
| `auth_failed`      | `auth.ts` `bearerResolve`, on the 401 branch                         | `detail.path` = `req.path` (no actor — token didn't resolve)           |
| `scope_denied`     | `auth.ts` `requireScope`, on the 403 branch                          | `actorTokenId` = `req.rcClient?.id`, `detail.required` = scope         |
| `session_attached` | `routes/sessionEvents.ts`, immediately after `writeHead(200)`        | `actorTokenId`, `target` = sessionId                                   |
| `session_detached` | `routes/sessionEvents.ts`, in the `finally` (once, only if attached) | `actorTokenId`, `target` = sessionId                                   |

`session_detached` is recorded only if `session_attached` was (i.e., the stream
reached `writeHead(200)`); a request that 502s during connect logs neither
attach nor detach.

## Wiring (`server.ts`)

`createGatewayApp` constructs one `AuditLog` at `~/.qwen/rc/audit.log` (path
injectable via an optional `GatewayDeps.auditPath` for tests) and threads it
into the middlewares and route factories that need it:

- `bearerResolve(store, audit)` — logs `auth_failed`.
- `requireScope(scope, audit)` — logs `scope_denied`.
- `createPairRedeemRoute(pairing, store, audit)`
- `createMintTokenRoute(store, audit)`, `createRevokeTokenRoute(store, registry, audit)`
- `createSessionEventsRoute(daemon, registry, audit)`

`GatewayDeps` gains an optional `auditPath?: string` (defaults to
`~/.qwen/rc/audit.log`). The two auth middlewares change signature to take
`audit`; they stay synchronous and fire-and-forget the record call.

## Data flow (example: non-owner hits /rc/tokens)

1. Request with a `session:read`-only token → `bearerResolve` resolves it
   (sets `req.rcClient`) → `requireScope(OWNER)` fails.
2. `requireScope` calls `void audit.record({ action: 'scope_denied',
actorTokenId: req.rcClient.id, detail: { required: 'owner' } })` then sends
   `403`.
3. One line appended to `~/.qwen/rc/audit.log`; the 403 is not delayed by the
   write.

## Error handling

`record()` is the only new I/O and it self-contains all failures (try/catch,
warn-and-swallow). No request path can throw, block, or change behavior because
of audit logging. A crash may lose the last unflushed line(s) — accepted per the
best-effort decision.

## Testing strategy (TDD)

**Unit (`auditLog.test.ts`):**

- `record` appends a single JSON line containing `ts` (number) plus the entry
  fields; a second `record` appends a second line (file has 2 lines).
- The file is created `0600`.
- `record` never throws and resolves even when the target path is unwritable
  (e.g., a path whose parent is a file) — assert no throw and the request-side
  contract holds.
- Lines are valid JSON and contain no raw token (only ids/scopes).

**Integration (gateway app + stub daemon), reading the audit file after each:**

- pair redeem → a `pairing_redeemed` line with the new token id + scopes.
- owner `POST /rc/tokens` → `token_minted`; `DELETE /rc/tokens/:id` → `token_revoked`.
- request with a bad bearer → `auth_failed` (no actor, has `path`).
- non-owner `GET /rc/tokens` → `scope_denied` with `required: 'owner'`.
- open an SSE stream then close it → `session_attached` then `session_detached`
  for that session id and actor.
- assert no audit line anywhere contains a raw token value.

Tests inject `auditPath` into a temp dir and may `await audit.record` (or poll
the file briefly) given the fire-and-forget call sites.

## File boundary / isolation

All changes within `packages/rc-gateway/` — zero upstream-file edits. New:
`src/auditLog.ts` (+ test). Modified: `auth.ts` (2 middlewares take `audit`),
`routes/pair.ts`, `routes/tokens.ts`, `routes/sessionEvents.ts`, `server.ts`
(build + thread `AuditLog`, add `auditPath` to `GatewayDeps`), `index.ts`
(export `AuditLog`, `AuditEntry`, `AuditAction`), and the affected tests.

## Follow-on cycles (still not now)

`GET /rc/audit` query endpoint, log rotation + size cap, tamper-evidence,
external shipping; then scope hierarchy, CORS + hosted web client, durable WAL,
SSE fan-out, `qwen rc` TUI, bridges.
