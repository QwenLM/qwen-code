# Remote-Control Gateway — Audit Query + Rotation (Design)

**Date:** 2026-06-07
**Status:** Proposed (cycle 4)
**Scope:** An owner-gated `GET /rc/audit` query API over the cycle-3 audit log, plus size-based rotation so the log doesn't grow unbounded. Builds on cycles 1–3.

## Context

Cycle 3 added a write-only audit log: `AuditLog.record()` appends one JSON line
per security event to `~/.qwen/rc/audit.log` (best-effort, never throws). It is
not readable over the API and the file grows forever. This cycle adds a query
endpoint and rotation.

## Goal of this cycle

> The workstation owner can query recent audit events over the API (filtered by
> action / actor / time, newest-first), and the on-disk log is bounded by
> size-based rotation while remaining fully queryable across its archives.

## Non-goals (this cycle)

- No time-based (daily) rotation — size-based only.
- No compression of rotated archives.
- No tamper-evidence (hash chaining / signing).
- No external shipping (syslog/SIEM).
- The audit query itself is **not** audited (it is not one of the 7 recorded
  events; auditing reads would add noise and recursion).

## Decisions (from brainstorming)

1. **Query reads live + rotated archives**, newest-first, honoring filters and
   `limit` across all files.
2. **Read-all-then-sort** query implementation (bounded by
   `maxBytes × (maxFiles + 1)`, owner-only, infrequent) — correct and simple,
   no fragile cross-file early-termination.
3. **Size-based rotation**, defaults **5 MiB** cap / **3 archives** kept.

## Components

### AuditLog additions (`src/auditLog.ts`)

Constructor stays backward-compatible by appending an optional options arg:

```ts
new AuditLog(
  filePath: string,
  nowFn: () => number = Date.now,
  opts: { maxBytes?: number; maxFiles?: number } = {},
)
// defaults: maxBytes = 5 * 1024 * 1024, maxFiles = 3
```

**Rotation (best-effort, never throws — same contract as `record`).** Inside
`record()`, before appending: if `audit.log` exists and its size `>= maxBytes`,
rotate first. Rotation shifts archives down and renames the live file:

- delete `audit.log.<maxFiles>` if present (drops the oldest),
- for `i` from `maxFiles-1` down to `1`: rename `audit.log.<i>` → `audit.log.<i+1>`,
- rename `audit.log` → `audit.log.1`.

The next `appendFile` recreates a fresh `audit.log`. Archives therefore hold
strictly older entries than the live file. Any rotation error is caught and
swallowed (writes continue to the current file); `record()` still never throws.

**Read types + query:**

```ts
/** A persisted entry: an AuditEntry plus the stamped timestamp. */
export type AuditRecord = AuditEntry & { ts: number };

export interface AuditQuery {
  limit?: number; // default 100, capped at 1000
  since?: number; // include only ts >= since (epoch ms)
  action?: AuditAction; // exact match
  actor?: string; // exact actorTokenId match
}

/** Narrow read dependency (the route depends on this; AuditLog implements it). */
export interface AuditReader {
  query(q: AuditQuery): Promise<AuditRecord[]>;
}
```

`AuditLog implements AuditRecorder, AuditReader`.

`query(q)` algorithm:

1. Build the file list: `audit.log`, `audit.log.1` … `audit.log.<maxFiles>`.
2. For each existing file, read it, split into lines, `JSON.parse` each
   non-empty line inside a try/catch (skip unparseable lines), collect the
   objects. A missing file is treated as empty.
3. Filter the collected records: `since` (`ts >= since`), `action` (exact),
   `actor` (`actorTokenId === actor`).
4. Sort by `ts` descending (newest-first).
5. Slice to `min(limit ?? 100, 1000)`.
   Returns `AuditRecord[]`. Never throws; on any unexpected error returns what was
   collected so far (or `[]`).

### Route (`src/routes/audit.ts`) — new

```ts
export function createAuditQueryRoute(reader: AuditReader): RequestHandler;
```

`GET /rc/audit` — parses query params and calls `reader.query`:

- `limit`: parsed int; non-numeric/`<1` → default 100; `>1000` → 1000.
- `since`: parsed int (epoch ms); non-numeric → omitted.
- `action`: passed through only if it is a known `AuditAction` (else omitted).
- `actor`: string, passed through if present.
  Responds `200` with the JSON array (newest-first). Gated by
  `requireScope(OWNER)` at the wiring site.

### Wiring (`src/server.ts`)

The `AuditLog` already exists in `createGatewayApp`. Add one route:

```ts
app.get('/rc/audit', requireScope(OWNER, audit), createAuditQueryRoute(audit));
```

(`requireScope` also takes `audit` so a non-owner hitting `/rc/audit` records a
`scope_denied` — consistent with the other owner routes.)

### Exports (`src/index.ts`)

Add `createAuditQueryRoute`, and `type AuditRecord`, `type AuditQuery`,
`type AuditReader` from their modules.

## Data flow (owner queries recent revocations)

1. Owner: `GET /rc/audit?action=token_revoked&limit=20` with an owner bearer.
2. `requireScope(OWNER)` passes → `createAuditQueryRoute` parses
   `{ action: 'token_revoked', limit: 20 }` → `audit.query(...)`.
3. `query` reads `audit.log` + archives, filters to `token_revoked`, sorts by
   `ts` desc, slices to 20 → returns the array → `200`.

## Error handling

- `query` is read-only and defensive: unparseable lines skipped, missing files
  treated as empty, never throws (returns partial/empty on error). A fresh
  install with no log file returns `[]`.
- Rotation failures are swallowed; `record()` keeps its never-throw contract.
- Invalid query params are clamped/ignored, not errored.

## Testing strategy (TDD)

**Unit — rotation (`auditLog.test.ts`):**

- With a tiny `maxBytes`, several `record()` calls produce `audit.log.1`; the
  live `audit.log` holds the newest entry; with `maxFiles = 1`, only one archive
  is kept (older dropped). Assert via file existence + contents.

**Unit — query (`auditLog.test.ts`):**

- Records returned newest-first by `ts`.
- `action` / `actor` / `since` filters each narrow correctly.
- `limit` slices; a `limit > 1000` is capped.
- Query spans rotated files: force a rotation, then assert an entry that landed
  in `audit.log.1` is still returned.
- A manually-corrupted (non-JSON) line in the file is skipped, not fatal.
- Querying a never-written path returns `[]`.

**Integration — route (`routes/audit.test.ts`):**

- Mount `bearerResolve` + `requireScope(OWNER)` + `createAuditQueryRoute` over a
  real `AuditLog` in a temp dir (seeded via `record`); owner `GET /rc/audit` →
  200 array; `?action=...` filters; non-owner token → 403.

**Integration — server (`server.test.ts`):**

- After a redeem + a bad-token request, owner `GET /rc/audit` returns entries
  including `pairing_redeemed` and `auth_failed`, newest-first.

Tests inject `maxBytes`/`maxFiles` and `auditPath` for determinism; `query`
awaits, so no polling needed for the read path.

## File boundary / isolation

All within `packages/rc-gateway/` — zero upstream-file edits. New:
`src/routes/audit.ts` (+ test). Modified: `src/auditLog.ts` (rotation + query +
types, + test), `src/server.ts` (one route), `src/index.ts` (exports),
`src/server.test.ts`.

## Follow-on cycles (still not now)

Time-based rotation, archive compression, tamper-evidence, external shipping;
then scope hierarchy, CORS + hosted web client, durable WAL, SSE fan-out,
`qwen rc` TUI, bridges.
