# RC Gateway Audit Query + Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-gated `GET /rc/audit` (filter by limit/since/action/actor, newest-first across live + rotated files) and size-based rotation to `@qwen-code/rc-gateway`'s audit log.

**Architecture:** Extend `AuditLog` with size-based rotation (best-effort, never throws — checked inside `record()` before append) and a defensive `query()` that reads the live file plus archives, parses/filters/sorts-by-ts-desc, and slices to a capped limit. A new `createAuditQueryRoute` parses query params and calls a narrow `AuditReader`. Zero upstream-file edits.

**Tech Stack:** TypeScript (ESM, NodeNext), Express, Node `fs/promises`, vitest.

---

## File Structure

```
packages/rc-gateway/src/
  auditLog.ts            # MODIFY: opts{maxBytes,maxFiles}; rotation; query; AUDIT_ACTIONS, AuditRecord, AuditQuery, AuditReader
  auditLog.test.ts       # MODIFY: rotation + query tests
  routes/audit.ts        # NEW: createAuditQueryRoute (param parsing → reader.query)
  routes/audit.test.ts   # NEW: route integration (owner 200 + filters; non-owner 403)
  server.ts              # MODIFY: GET /rc/audit route
  server.test.ts         # MODIFY: end-to-end audit query test
  index.ts               # MODIFY: export route + audit query/reader types
```

---

## Task 1: AuditLog rotation + query

**Files:**

- Modify: `packages/rc-gateway/src/auditLog.ts`
- Test: `packages/rc-gateway/src/auditLog.test.ts`

- [ ] **Step 1: Add failing tests** to `auditLog.test.ts`. First add to the existing `node:fs` import the names `existsSync` and `appendFileSync` (the file already imports some of `mkdtempSync, readFileSync, statSync, writeFileSync` from `'node:fs'` — extend that import to include `existsSync` and `appendFileSync`). Then append these tests inside the existing `describe('AuditLog', ...)` block:

```ts
it('rotates when the live file exceeds maxBytes and stays queryable', async () => {
  const path = join(dir, 'audit.log');
  let t = 0;
  const audit = new AuditLog(path, () => ++t, { maxBytes: 10, maxFiles: 2 });
  await audit.record({ action: 'token_minted', target: 'a' });
  await audit.record({ action: 'token_minted', target: 'b' });
  await audit.record({ action: 'token_minted', target: 'c' });
  expect(existsSync(`${path}.1`)).toBe(true);
  const rows = await audit.query({});
  expect(rows.map((r) => r.target)).toEqual(['c', 'b', 'a']);
});

it('keeps at most maxFiles archives (drops the oldest)', async () => {
  const path = join(dir, 'audit.log');
  let t = 0;
  const audit = new AuditLog(path, () => ++t, { maxBytes: 10, maxFiles: 1 });
  for (const x of ['a', 'b', 'c', 'd']) {
    await audit.record({ action: 'token_minted', target: x });
  }
  expect(existsSync(`${path}.2`)).toBe(false);
  const rows = await audit.query({});
  expect(rows.map((r) => r.target)).toEqual(['d', 'c']);
});

it('filters by action / actor / since and caps limit', async () => {
  const path = join(dir, 'audit.log');
  let t = 0;
  const audit = new AuditLog(path, () => ++t);
  await audit.record({
    action: 'token_minted',
    actorTokenId: 'o',
    target: '1',
  });
  await audit.record({ action: 'auth_failed' });
  await audit.record({
    action: 'token_minted',
    actorTokenId: 'p',
    target: '2',
  });
  expect(
    (await audit.query({ action: 'token_minted' })).map((r) => r.target),
  ).toEqual(['2', '1']);
  expect((await audit.query({ actor: 'o' })).map((r) => r.target)).toEqual([
    '1',
  ]);
  expect((await audit.query({ since: 3 })).map((r) => r.action)).toEqual([
    'token_minted',
  ]);
  expect(await audit.query({ limit: 1 })).toHaveLength(1);
});

it('skips corrupt lines and returns [] for a missing log', async () => {
  const path = join(dir, 'audit.log');
  const audit = new AuditLog(path, () => 1);
  expect(await audit.query({})).toEqual([]);
  await audit.record({ action: 'token_minted', target: 'a' });
  appendFileSync(path, 'not json\n');
  const rows = await audit.query({});
  expect(rows.map((r) => r.target)).toEqual(['a']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway auditLog`
Expected: FAIL (`audit.query is not a function` / options arg ignored).

- [ ] **Step 3: Rewrite `auditLog.ts`** (keep the license header). Replace the imports and the class; keep the existing `AuditAction`/`AuditEntry`/`AuditRecorder` and ADD `AUDIT_ACTIONS`, `AuditRecord`, `AuditQuery`, `AuditReader`:

```ts
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';

export type AuditAction =
  | 'pairing_redeemed'
  | 'token_minted'
  | 'token_revoked'
  | 'auth_failed'
  | 'scope_denied'
  | 'session_attached'
  | 'session_detached';

/** Runtime list of valid actions (for validating query params). */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'pairing_redeemed',
  'token_minted',
  'token_revoked',
  'auth_failed',
  'scope_denied',
  'session_attached',
  'session_detached',
];

export interface AuditEntry {
  action: AuditAction;
  /** Resolved caller token id, when known. Never a raw token or hash. */
  actorTokenId?: string;
  /** Affected resource: a token id or a session id. */
  target?: string;
  /** Small extras (granted scopes, required scope, request path). No secrets. */
  detail?: Record<string, unknown>;
}

/** A persisted entry: an AuditEntry plus the stamped timestamp. */
export type AuditRecord = AuditEntry & { ts: number };

export interface AuditQuery {
  /** Max rows returned. Default 100, capped at 1000. */
  limit?: number;
  /** Include only entries with ts >= since (epoch ms). */
  since?: number;
  /** Exact action match. */
  action?: AuditAction;
  /** Exact actorTokenId match. */
  actor?: string;
}

/** Write side. */
export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
}

/** Read side. */
export interface AuditReader {
  query(q: AuditQuery): Promise<AuditRecord[]>;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n < 1) return 100;
  return Math.min(Math.trunc(n), 1000);
}

/**
 * Append-only, best-effort audit log with size-based rotation. record() never
 * throws; query() reads the live file plus rotated archives, newest-first.
 */
export class AuditLog implements AuditRecorder, AuditReader {
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    private readonly filePath: string,
    private readonly nowFn: () => number = Date.now,
    opts: { maxBytes?: number; maxFiles?: number } = {},
  ) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  }

  async record(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await this.rotateIfNeeded();
      const line = JSON.stringify({ ts: this.nowFn(), ...entry }) + '\n';
      await appendFile(this.filePath, line, { mode: 0o600 });
    } catch (err) {
      // Best-effort: audit failure must not affect the request path.
      // eslint-disable-next-line no-console
      console.warn('audit record failed:', err);
    }
  }

  async query(q: AuditQuery = {}): Promise<AuditRecord[]> {
    const files = [this.filePath];
    for (let i = 1; i <= this.maxFiles; i++) {
      files.push(`${this.filePath}.${i}`);
    }
    const rows: AuditRecord[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue; // missing file → skip
      }
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as AuditRecord;
          if (obj && typeof obj.ts === 'number') rows.push(obj);
        } catch {
          // skip corrupt line
        }
      }
    }
    let out = rows;
    if (q.since !== undefined) out = out.filter((r) => r.ts >= q.since!);
    if (q.action !== undefined) out = out.filter((r) => r.action === q.action);
    if (q.actor !== undefined)
      out = out.filter((r) => r.actorTokenId === q.actor);
    out.sort((a, b) => b.ts - a.ts);
    return out.slice(0, clampLimit(q.limit));
  }

  /** Rotate when the live file is at/over maxBytes. Best-effort; never throws. */
  private async rotateIfNeeded(): Promise<void> {
    try {
      const s = await stat(this.filePath);
      if (s.size < this.maxBytes) return;
    } catch {
      return; // no live file yet
    }
    try {
      await unlink(`${this.filePath}.${this.maxFiles}`).catch(() => {});
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        await rename(
          `${this.filePath}.${i}`,
          `${this.filePath}.${i + 1}`,
        ).catch(() => {});
      }
      await rename(this.filePath, `${this.filePath}.1`).catch(() => {});
    } catch {
      // swallow — keep writing to the current file
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway auditLog`
Expected: PASS (existing 3 + 4 new = 7).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/auditLog.test.ts
git commit -m "feat(rc-gateway): AuditLog size-based rotation + query"
```

---

## Task 2: GET /rc/audit route

**Files:**

- Create: `packages/rc-gateway/src/routes/audit.ts`
- Test: `packages/rc-gateway/src/routes/audit.test.ts`

- [ ] **Step 1: Write failing tests** in `routes/audit.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TokenStore } from '../tokenStore.js';
import { AuditLog } from '../auditLog.js';
import { bearerResolve, requireScope } from '../auth.js';
import { OWNER, SESSION_READ } from '../scopes.js';
import { createAuditQueryRoute } from './audit.js';

let server: Server | undefined;
let store: TokenStore;
let audit: AuditLog;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-auditq-'));
  store = await TokenStore.open(join(dir, 'tokens.json'));
  audit = new AuditLog(join(dir, 'audit.log'), () => Date.now());
});

async function mount(): Promise<string> {
  const app = express();
  app.use(bearerResolve(store, audit));
  app.get(
    '/rc/audit',
    requireScope(OWNER, audit),
    createAuditQueryRoute(audit),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('GET /rc/audit', () => {
  it('returns recorded entries to an owner (newest-first)', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await audit.record({ action: 'token_minted', target: 'x' });
    await audit.record({ action: 'token_revoked', target: 'x' });
    const url = await mount();
    const res = await fetch(`${url}/rc/audit`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].action).toBe('token_revoked'); // newest first
  });

  it('honors the action filter', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await audit.record({ action: 'token_minted', target: 'x' });
    await audit.record({ action: 'token_revoked', target: 'x' });
    const url = await mount();
    const res = await fetch(`${url}/rc/audit?action=token_minted`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    const rows = (await res.json()) as Array<{ action: string }>;
    expect(rows.every((r) => r.action === 'token_minted')).toBe(true);
    expect(rows).toHaveLength(1);
  });

  it('forbids a non-owner token', async () => {
    const weak = await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/audit`, {
      headers: { Authorization: `Bearer ${weak.token}` },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway "routes/audit"`
Expected: FAIL (`createAuditQueryRoute` not exported).

- [ ] **Step 3: Implement `routes/audit.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditQuery,
  type AuditReader,
} from '../auditLog.js';

/** GET /rc/audit?limit&since&action&actor → newest-first audit records. */
export function createAuditQueryRoute(reader: AuditReader): RequestHandler {
  return async (req, res) => {
    const q: AuditQuery = {};

    const limit = Number(req.query.limit);
    if (Number.isFinite(limit) && limit >= 1) q.limit = Math.trunc(limit);

    const since = Number(req.query.since);
    if (req.query.since !== undefined && Number.isFinite(since))
      q.since = since;

    const action = req.query.action;
    if (
      typeof action === 'string' &&
      (AUDIT_ACTIONS as readonly string[]).includes(action)
    ) {
      q.action = action as AuditAction;
    }

    const actor = req.query.actor;
    if (typeof actor === 'string' && actor.length > 0) q.actor = actor;

    const rows = await reader.query(q);
    res.status(200).json(rows);
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway "routes/audit"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/routes/audit.ts packages/rc-gateway/src/routes/audit.test.ts
git commit -m "feat(rc-gateway): owner-gated GET /rc/audit query route"
```

---

## Task 3: Wire route + exports + verification

**Files:**

- Modify: `packages/rc-gateway/src/server.ts`
- Modify: `packages/rc-gateway/src/server.test.ts`
- Modify: `packages/rc-gateway/src/index.ts`

- [ ] **Step 1: Wire the route in `server.ts`.** Add the import (alongside the other route imports):

```ts
import { createAuditQueryRoute } from './routes/audit.js';
```

Add this route registration after the `DELETE /rc/tokens/:id` registration (still inside `createGatewayApp`, after `bearerResolve` is applied):

```ts
app.get('/rc/audit', requireScope(OWNER, audit), createAuditQueryRoute(audit));
```

- [ ] **Step 2: Add an end-to-end test to `server.test.ts`.** Append inside `describe('gateway app', ...)`:

```ts
it('serves owner GET /rc/audit with recorded events', async () => {
  const { url, pairing } = await boot();
  const { code } = pairing.mint([OWNER, SESSION_READ]);
  const redeem = await fetch(`${url}/rc/pair/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label: 'owner' }),
  });
  const ownerToken = ((await redeem.json()) as { token: string }).token;

  const res = await fetch(`${url}/rc/audit`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(res.status).toBe(200);
  const rows = (await res.json()) as Array<{ action: string }>;
  expect(rows.some((r) => r.action === 'pairing_redeemed')).toBe(true);
});
```

(Note: `boot()` already injects an `auditPath`, and `createGatewayApp` builds the `AuditLog` from it, so the redeem above is recorded to the same file the query reads.)

- [ ] **Step 3: Update `index.ts` exports.** Replace the existing audit export block:

```ts
export {
  AuditLog,
  type AuditEntry,
  type AuditAction,
  type AuditRecorder,
} from './auditLog.js';
```

with:

```ts
export {
  AuditLog,
  AUDIT_ACTIONS,
  type AuditEntry,
  type AuditAction,
  type AuditRecord,
  type AuditQuery,
  type AuditRecorder,
  type AuditReader,
} from './auditLog.js';
export { createAuditQueryRoute } from './routes/audit.js';
```

- [ ] **Step 4: Typecheck, lint, build**

Run:

```bash
cd /home/evan/projects/qwen-code
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
```

Expected: no type errors; lint clean; build succeeds.

- [ ] **Step 5: Run the full package suite**

Run: `cd /home/evan/projects/qwen-code && npm run test --workspace @qwen-code/rc-gateway`
Expected: PASS — all suites green (auditLog 7, routes/audit 3, server 7, plus existing auth 7, tokens 9, sessionEvents 5, scopes 2, tokenStore 8, pairing 5, connectionRegistry 4, daemonSupervisor 2 = 59 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/server.test.ts packages/rc-gateway/src/index.ts
git commit -m "feat(rc-gateway): wire GET /rc/audit; export audit query API"
```

---

## Self-Review

**Spec coverage** (design §Components / §Error model / §Testing):

- Rotation (size-based, before-append, best-effort never-throws, drops oldest beyond `maxFiles`) → Task 1 (`rotateIfNeeded`). ✓
- `query` reads live + archives, parse-skip-corrupt, filter (since/action/actor), sort ts-desc, clamp limit → Task 1. ✓
- `AuditRecord`/`AuditQuery`/`AuditReader`/`AUDIT_ACTIONS` types → Task 1. ✓
- `createAuditQueryRoute` param parsing (limit clamp, since, action validated against `AUDIT_ACTIONS`, actor) → Task 2. ✓
- `GET /rc/audit` owner-gated, non-owner 403 → Task 2 test + Task 3 wiring (`requireScope(OWNER, audit)`). ✓
- Wiring + exports → Task 3. ✓
- Backward-compatible constructor (`nowFn` stays 2nd positional; `opts` 3rd) → Task 1 (existing `new AuditLog(path)` / `new AuditLog(path, () => 1234)` still compile). ✓
- Deferred items (time-based rotation, compression, tamper-evidence, auditing the query) → correctly absent. ✓

**Placeholder scan:** No TBD/TODO; complete code in every step. ✓

**Type/name consistency:** `AuditLog` (now `implements AuditRecorder, AuditReader`); `query(q: AuditQuery): Promise<AuditRecord[]>`; `AUDIT_ACTIONS`; `createAuditQueryRoute(reader: AuditReader)`; constructor `(filePath, nowFn?, opts?)`. Route validates `action` against `AUDIT_ACTIONS` and narrows to `AuditAction`. `requireScope(OWNER, audit)` matches the cycle-3 two-arg signature. ✓

**Note:** `query`'s `clampLimit` defaults undefined/NaN/<1 → 100 and caps >1000 → 1000; the route only sets `q.limit` for finite `>=1` values, so `clampLimit` is the single source of truth for the cap.
