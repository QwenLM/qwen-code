# RC Gateway Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Append-only, best-effort JSON-lines audit log of 7 security events (pairing redeem, token mint/revoke, 401/403 denials, session attach/detach) at `~/.qwen/rc/audit.log`, never blocking or breaking a request.

**Architecture:** A new `AuditLog` class (implements a narrow `AuditRecorder` interface) appends one JSON line per event via `appendFile` (O_APPEND, 0600), swallowing its own errors. Security points call `void audit?.record(...)`. The `audit` parameter is optional everywhere so each task stays green; the real `AuditLog` is wired into `createGatewayApp` in the final task. Zero upstream-file edits.

**Tech Stack:** TypeScript (ESM, NodeNext), Express, Node `fs/promises`, vitest, `@qwen-code/sdk`.

---

## File Structure

```
packages/rc-gateway/src/
  auditLog.ts                  # NEW: AuditAction, AuditEntry, AuditRecorder, AuditLog
  auditLog.test.ts             # NEW
  auth.ts                      # MODIFY: bearerResolve/requireScope take optional audit
  auth.test.ts                 # MODIFY: assert auth_failed / scope_denied recorded
  routes/pair.ts               # MODIFY: record pairing_redeemed
  routes/tokens.ts             # MODIFY: record token_minted / token_revoked
  routes/tokens.test.ts        # MODIFY: pass audit; assert mint/revoke recorded
  routes/sessionEvents.ts      # MODIFY: record session_attached / session_detached
  routes/sessionEvents.test.ts # MODIFY: pass audit; assert attach/detach
  server.ts                    # MODIFY: GatewayDeps.auditPath; build + thread AuditLog
  server.test.ts               # MODIFY: inject auditPath; end-to-end audit assertions
  index.ts                     # MODIFY: export AuditLog + types
```

---

## Task 1: AuditLog component

**Files:**

- Create: `packages/rc-gateway/src/auditLog.ts`
- Test: `packages/rc-gateway/src/auditLog.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from './auditLog.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-audit-'));
}

describe('AuditLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir();
  });

  it('appends a stamped JSON line per record call', async () => {
    const path = join(dir, 'audit.log');
    const audit = new AuditLog(path, () => 1234);
    await audit.record({
      action: 'token_minted',
      actorTokenId: 'a',
      target: 'b',
    });
    await audit.record({
      action: 'token_revoked',
      actorTokenId: 'a',
      target: 'b',
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({
      ts: 1234,
      action: 'token_minted',
      actorTokenId: 'a',
      target: 'b',
    });
    expect(JSON.parse(lines[1]).action).toBe('token_revoked');
  });

  it('creates the file with 0600 permissions', async () => {
    const path = join(dir, 'nested', 'audit.log');
    const audit = new AuditLog(path);
    await audit.record({ action: 'auth_failed' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never throws when the path is unwritable', async () => {
    // Make the parent a FILE so mkdir/appendFile underneath it fails.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const path = join(blocker, 'audit.log');
    const audit = new AuditLog(path);
    await expect(
      audit.record({ action: 'token_minted' }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway auditLog`
Expected: FAIL (`AuditLog` not exported).

- [ ] **Step 3: Implement `auditLog.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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
  /** Affected resource: a token id or a session id. */
  target?: string;
  /** Small extras (granted scopes, required scope, request path). No secrets. */
  detail?: Record<string, unknown>;
}

/** Narrow dependency the middlewares/routes depend on (easy to fake in tests). */
export interface AuditRecorder {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * Append-only, best-effort audit log. Each record() appends one JSON line via
 * O_APPEND (atomic per line). Never throws — a failed audit write must never
 * delay or break a request.
 */
export class AuditLog implements AuditRecorder {
  constructor(
    private readonly filePath: string,
    private readonly nowFn: () => number = Date.now,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const line = JSON.stringify({ ts: this.nowFn(), ...entry }) + '\n';
      await appendFile(this.filePath, line, { mode: 0o600 });
    } catch (err) {
      // Best-effort: audit failure must not affect the request path.
      // eslint-disable-next-line no-console
      console.warn('audit record failed:', err);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway auditLog`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/auditLog.ts packages/rc-gateway/src/auditLog.test.ts
git commit -m "feat(rc-gateway): append-only AuditLog (best-effort JSONL)"
```

---

## Task 2: Auth middleware records denials

**Files:**

- Modify: `packages/rc-gateway/src/auth.ts`
- Test: `packages/rc-gateway/src/auth.test.ts`

- [ ] **Step 1: Add failing tests** (append inside the existing `describe('auth middleware', ...)` block in `auth.test.ts`). Add this import near the top first:

```ts
import type { AuditEntry, AuditRecorder } from './auditLog.js';
```

Add this helper above the `describe` (after `fakeRes`):

```ts
function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}
```

Append these tests inside the `describe`:

```ts
it('records auth_failed on a bad token', () => {
  const audit = fakeAudit();
  const req = { headers: {}, path: '/rc/tokens' } as Request;
  bearerResolve(store, audit)(req, fakeRes(), () => {});
  expect(audit.calls).toHaveLength(1);
  expect(audit.calls[0]).toMatchObject({
    action: 'auth_failed',
    detail: { path: '/rc/tokens' },
  });
  expect(audit.calls[0].actorTokenId).toBeUndefined();
});

it('does not record when auth succeeds', async () => {
  const audit = fakeAudit();
  const { token } = await store.issue([SESSION_READ], 'phone');
  const req = { headers: { authorization: `Bearer ${token}` } } as Request;
  bearerResolve(store, audit)(req, fakeRes(), () => {});
  expect(audit.calls).toHaveLength(0);
});

it('records scope_denied with actor and required scope', () => {
  const audit = fakeAudit();
  const req = { rcClient: { id: 'x', scopes: [] } } as Request;
  requireScope(SESSION_READ, audit)(req, fakeRes(), () => {});
  expect(audit.calls).toHaveLength(1);
  expect(audit.calls[0]).toMatchObject({
    action: 'scope_denied',
    actorTokenId: 'x',
    detail: { required: SESSION_READ },
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway auth`
Expected: FAIL (`bearerResolve` takes 1 arg / no audit recorded).

- [ ] **Step 3: Update `auth.ts`.** Add the import and an optional `audit` param to both factories; fire-and-forget record on the denial branches. Replace the file's body (keeping the header) with:

```ts
import type { RequestHandler } from 'express';
import type { TokenStore } from './tokenStore.js';
import type { RcScope } from './scopes.js';
import type { AuditRecorder } from './auditLog.js';
import './types.js';

/** Resolve the bearer token to `req.rcClient`, or 401 (+ audit auth_failed). */
export function bearerResolve(
  store: TokenStore,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const resolved = store.resolve(header);
    if (!resolved) {
      void audit?.record({ action: 'auth_failed', detail: { path: req.path } });
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }
    req.rcClient = resolved;
    next();
  };
}

/** Require a scope on the resolved client, or 403 (+ audit scope_denied). */
export function requireScope(
  scope: RcScope,
  audit?: AuditRecorder,
): RequestHandler {
  return (req, res, next) => {
    if (!req.rcClient || !req.rcClient.scopes.includes(scope)) {
      void audit?.record({
        action: 'scope_denied',
        actorTokenId: req.rcClient?.id,
        detail: { required: scope },
      });
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway auth`
Expected: PASS (existing 4 + 3 new = 7).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/auth.ts packages/rc-gateway/src/auth.test.ts
git commit -m "feat(rc-gateway): audit auth_failed / scope_denied in auth middleware"
```

---

## Task 3: Pair + token routes record lifecycle events

**Files:**

- Modify: `packages/rc-gateway/src/routes/pair.ts`
- Modify: `packages/rc-gateway/src/routes/tokens.ts`
- Test: `packages/rc-gateway/src/routes/tokens.test.ts`

- [ ] **Step 1: Update `routes/pair.ts`** to take an optional audit and record `pairing_redeemed`. Replace the file body (keep header) with:

```ts
import type { RequestHandler } from 'express';
import type { PairingService } from '../pairing.js';
import type { TokenStore } from '../tokenStore.js';
import type { AuditRecorder } from '../auditLog.js';

/** POST /rc/pair/redeem { code, label } → { id, token, scopes }. */
export function createPairRedeemRoute(
  pairing: PairingService,
  store: TokenStore,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    const label = typeof body.label === 'string' ? body.label : 'unnamed';
    const grant = pairing.redeem(code);
    if (!grant) {
      res
        .status(400)
        .json({ error: 'Invalid pairing code', code: 'invalid_pairing_code' });
      return;
    }
    const { id, token } = await store.issue(grant.grantScopes, label);
    void audit?.record({
      action: 'pairing_redeemed',
      target: id,
      detail: { scopes: grant.grantScopes },
    });
    res.status(200).json({ id, token, scopes: grant.grantScopes });
  };
}
```

- [ ] **Step 2: Update `routes/tokens.ts`** — add an optional audit param to the mint and revoke factories and record. Change the import block to add:

```ts
import type { AuditRecorder } from '../auditLog.js';
```

Change `createMintTokenRoute` signature and add the record right after a successful issue:

```ts
export function createMintTokenRoute(
  store: TokenStore,
  audit?: AuditRecorder,
): RequestHandler {
```

…and replace its success tail:

```ts
const { id, token } = await store.issue(requested, label);
res.status(200).json({ id, token, scopes: requested });
```

with:

```ts
const { id, token } = await store.issue(requested, label);
void audit?.record({
  action: 'token_minted',
  actorTokenId: req.rcClient?.id,
  target: id,
  detail: { scopes: requested },
});
res.status(200).json({ id, token, scopes: requested });
```

Change `createRevokeTokenRoute` signature:

```ts
export function createRevokeTokenRoute(
  store: TokenStore,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
): RequestHandler {
```

…and replace its success tail:

```ts
registry.evict(id);
res.status(204).end();
```

with:

```ts
registry.evict(id);
void audit?.record({
  action: 'token_revoked',
  actorTokenId: req.rcClient?.id,
  target: id,
});
res.status(204).end();
```

- [ ] **Step 3: Add failing audit assertions to `routes/tokens.test.ts`.** Add a fake-audit helper and thread it through `mount()`. Add near the imports:

```ts
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
```

Add a module-level recorder and helper (above `describe`):

```ts
function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}
let audit: AuditRecorder & { calls: AuditEntry[] };
```

In the existing `beforeEach`, after `registry = new ConnectionRegistry();` add:

```ts
audit = fakeAudit();
```

In `mount()`, pass `audit` to the audited factories — change the route registrations to:

```ts
app.use(bearerResolve(store, audit));
app.get('/rc/tokens', requireScope(OWNER, audit), createListTokensRoute(store));
app.post(
  '/rc/tokens',
  requireScope(OWNER, audit),
  createMintTokenRoute(store, audit),
);
app.delete(
  '/rc/tokens/:id',
  requireScope(OWNER, audit),
  createRevokeTokenRoute(store, registry, audit),
);
```

Append two tests inside the `describe('/rc/tokens routes', ...)`:

```ts
it('records token_minted on a successful mint', async () => {
  const owner = await store.issue([OWNER, SESSION_READ], 'owner');
  const url = await mount();
  await fetch(`${url}/rc/tokens`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${owner.token}`,
    },
    body: JSON.stringify({ scopes: [SESSION_READ], label: 'minted' }),
  });
  const minted = audit.calls.find((c) => c.action === 'token_minted');
  expect(minted).toBeDefined();
  expect(minted!.actorTokenId).toBe(owner.id);
});

it('records token_revoked on a successful revoke', async () => {
  const owner = await store.issue([OWNER, SESSION_READ], 'owner');
  const victim = await store.issue([SESSION_READ], 'victim');
  const url = await mount();
  await fetch(`${url}/rc/tokens/${victim.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  const revoked = audit.calls.find((c) => c.action === 'token_revoked');
  expect(revoked).toBeDefined();
  expect(revoked!.target).toBe(victim.id);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway "routes/tokens"`
Expected: PASS (existing 7 + 2 new = 9). The existing scope-denied test now also drives a `scope_denied` record harmlessly.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/routes/pair.ts packages/rc-gateway/src/routes/tokens.ts packages/rc-gateway/src/routes/tokens.test.ts
git commit -m "feat(rc-gateway): audit pairing_redeemed / token_minted / token_revoked"
```

---

## Task 4: Session route records attach/detach

**Files:**

- Modify: `packages/rc-gateway/src/routes/sessionEvents.ts`
- Test: `packages/rc-gateway/src/routes/sessionEvents.test.ts`

- [ ] **Step 1: Update `routes/sessionEvents.ts`.** Add an optional audit param; record `session_attached` right after `writeHead(200)` and `session_detached` in the `finally` only if attached. Replace the file (keep header) with:

```ts
import type { RequestHandler, Response } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import type { AuditRecorder } from '../auditLog.js';

/**
 * GET /rc/session/:id/events — relay the daemon's SSE stream downstream,
 * preserving event ids and forwarding Last-Event-ID. Aborts the upstream
 * subscription when the client disconnects OR when the caller's token is
 * revoked (the registry fires the same abort controller). Audits attach/detach.
 */
export function createSessionEventsRoute(
  daemon: DaemonClient,
  registry: ConnectionRegistry,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const actorTokenId = req.rcClient?.id;
    const lastEventIdRaw = req.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdRaw === 'string' && lastEventIdRaw.length > 0
        ? Number(lastEventIdRaw)
        : undefined;

    const abort = new AbortController();
    const tokenId = req.rcClient?.id;
    const unregister = tokenId ? registry.register(tokenId, abort) : () => {};
    req.on('close', () => abort.abort());

    let attached = false;
    try {
      const iterator = daemon.subscribeEvents(sessionId, {
        lastEventId: Number.isFinite(lastEventId) ? lastEventId : undefined,
        signal: abort.signal,
      });
      const first = await iterator.next();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      attached = true;
      void audit?.record({
        action: 'session_attached',
        actorTokenId,
        target: sessionId,
      });
      if (!first.done) writeFrame(res, first.value);
      for await (const ev of iterator) {
        writeFrame(res, ev);
      }
      res.end();
    } catch {
      if (abort.signal.aborted) {
        res.end();
      } else if (!res.headersSent) {
        res.status(502).json({
          error: 'Daemon unavailable',
          code: 'daemon_unavailable',
        });
      } else {
        res.end();
      }
    } finally {
      unregister();
      if (attached) {
        void audit?.record({
          action: 'session_detached',
          actorTokenId,
          target: sessionId,
        });
      }
    }
  };
}

function writeFrame(
  res: Response,
  ev: { id?: number; type?: string; data?: unknown },
): void {
  if (ev.id !== undefined) res.write(`id: ${ev.id}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}
```

- [ ] **Step 2: Add a failing audit test to `routes/sessionEvents.test.ts`.** Add imports + a fake recorder, thread it into `mountGateway`, and assert attach+detach. Add near imports:

```ts
import type { AuditEntry, AuditRecorder } from '../auditLog.js';
```

Add helper above `describe`:

```ts
function fakeAudit(): AuditRecorder & { calls: AuditEntry[] } {
  const calls: AuditEntry[] = [];
  return { calls, record: async (e: AuditEntry) => void calls.push(e) };
}
```

Change `mountGateway` to accept and use an audit recorder. Update its signature and the route line:

```ts
async function mountGateway(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): Promise<string> {
  const app = express();
  app.get(
    '/rc/session/:id/events',
    createSessionEventsRoute(daemon, new ConnectionRegistry(), audit),
  );
```

Append this test inside the `describe('session-events proxy', ...)`:

```ts
it('records session_attached then session_detached', async () => {
  stub = await startStubDaemon();
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const audit = fakeAudit();
  const url = await mountGateway(daemon, audit);
  // Default stub emits 2 frames then ends → stream completes on its own.
  const res = await fetch(`${url}/rc/session/sess-1/events`);
  await res.text();
  // Poll briefly: detach fires in the route's finally (fire-and-forget).
  const deadline = Date.now() + 2000;
  while (
    !audit.calls.some((c) => c.action === 'session_detached') &&
    Date.now() < deadline
  ) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const actions = audit.calls.map((c) => c.action);
  expect(actions).toContain('session_attached');
  expect(actions).toContain('session_detached');
  expect(actions.indexOf('session_attached')).toBeLessThan(
    actions.indexOf('session_detached'),
  );
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway sessionEvents`
Expected: PASS (existing 4 + 1 new = 5).

- [ ] **Step 4: Commit**

```bash
git add packages/rc-gateway/src/routes/sessionEvents.ts packages/rc-gateway/src/routes/sessionEvents.test.ts
git commit -m "feat(rc-gateway): audit session_attached / session_detached"
```

---

## Task 5: Wire AuditLog into the app + exports + verification

**Files:**

- Modify: `packages/rc-gateway/src/server.ts`
- Modify: `packages/rc-gateway/src/server.test.ts`
- Modify: `packages/rc-gateway/src/index.ts`

- [ ] **Step 1: Update `server.ts`** to build one `AuditLog` and thread it everywhere. Replace the file (keep header) with:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { TokenStore } from './tokenStore.js';
import type { PairingService } from './pairing.js';
import { bearerResolve, requireScope } from './auth.js';
import { OWNER, SESSION_READ } from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { AuditLog } from './auditLog.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createSessionEventsRoute } from './routes/sessionEvents.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';

export interface GatewayDeps {
  daemon: DaemonClient;
  store: TokenStore;
  pairing: PairingService;
  /** Audit log path; defaults to ~/.qwen/rc/audit.log. */
  auditPath?: string;
}

export function createGatewayApp(deps: GatewayDeps): Express {
  const app = express();
  app.use(express.json());

  const registry = new ConnectionRegistry();
  const audit = new AuditLog(
    deps.auditPath ?? join(homedir(), '.qwen', 'rc', 'audit.log'),
  );

  app.get('/rc/health', (_req, res) => res.json({ status: 'ok' }));

  app.post(
    '/rc/pair/redeem',
    createPairRedeemRoute(deps.pairing, deps.store, audit),
  );

  app.use(bearerResolve(deps.store, audit));
  app.get(
    '/rc/session/:id/events',
    requireScope(SESSION_READ, audit),
    createSessionEventsRoute(deps.daemon, registry, audit),
  );
  app.get(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createListTokensRoute(deps.store),
  );
  app.post(
    '/rc/tokens',
    requireScope(OWNER, audit),
    createMintTokenRoute(deps.store, audit),
  );
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER, audit),
    createRevokeTokenRoute(deps.store, registry, audit),
  );

  return app;
}
```

- [ ] **Step 2: Update `server.test.ts`** to inject `auditPath` and assert end-to-end. Add imports near the top:

```ts
import { readFileSync, existsSync } from 'node:fs';
```

In `boot()`, create an audit path in the same temp dir as the token store and pass it. Change the store-path block:

```ts
const path = join(mkdtempSync(join(tmpdir(), 'rc-srv-')), 'tokens.json');
const store = await TokenStore.open(path);
const pairing = new PairingService();
const app = createGatewayApp({ daemon, store, pairing });
```

to:

```ts
const dir = mkdtempSync(join(tmpdir(), 'rc-srv-'));
const auditPath = join(dir, 'audit.log');
const store = await TokenStore.open(join(dir, 'tokens.json'));
const pairing = new PairingService();
const app = createGatewayApp({ daemon, store, pairing, auditPath });
```

and change `boot`'s return type + return to expose `auditPath`:

```ts
async function boot(stubOpts?: Parameters<typeof startStubDaemon>[0]): Promise<{
  url: string;
  pairing: PairingService;
  store: TokenStore;
  auditPath: string;
}> {
```

```ts
return { url: `http://127.0.0.1:${port}`, pairing, store, auditPath };
```

Add this helper above `describe('gateway app', ...)`:

```ts
function readAudit(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const body = readFileSync(path, 'utf8').trim();
  return body ? body.split('\n').map((l) => JSON.parse(l)) : [];
}

async function pollAudit(
  path: string,
  predicate: (rows: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 2000;
  let rows = readAudit(path);
  while (!predicate(rows) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    rows = readAudit(path);
  }
  return rows;
}
```

Append this test inside `describe('gateway app', ...)`:

```ts
it('writes audit lines for redeem and a bad-token request', async () => {
  const { url, pairing, auditPath } = await boot();
  const { code } = pairing.mint([OWNER, SESSION_READ]);
  await fetch(`${url}/rc/pair/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, label: 'owner' }),
  });
  // Bad token → auth_failed.
  await fetch(`${url}/rc/session/sess-1/events`, {
    headers: { Authorization: 'Bearer not-a-token' },
  });

  const rows = await pollAudit(
    auditPath,
    (r) =>
      r.some((x) => x.action === 'pairing_redeemed') &&
      r.some((x) => x.action === 'auth_failed'),
  );
  const actions = rows.map((r) => r.action);
  expect(actions).toContain('pairing_redeemed');
  expect(actions).toContain('auth_failed');
  // No raw token ever appears in the audit file.
  expect(readFileSync(auditPath, 'utf8')).not.toContain('not-a-token');
});
```

- [ ] **Step 3: Update `index.ts`** — add the audit exports. Insert after the `ConnectionRegistry` export line:

```ts
export {
  AuditLog,
  type AuditEntry,
  type AuditAction,
  type AuditRecorder,
} from './auditLog.js';
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
Expected: PASS — all suites green (auditLog 3, auth 7, tokens 9, sessionEvents 5, server 6, scopes 2, tokenStore 8, pairing 5, connectionRegistry 4, daemonSupervisor 2 = 51 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/server.test.ts packages/rc-gateway/src/index.ts
git commit -m "feat(rc-gateway): wire AuditLog into the gateway; export audit API"
```

---

## Self-Review

**Spec coverage** (design §Components / §Integration / §Testing):

- `AuditLog` + `AuditEntry`/`AuditAction` + best-effort never-throw → Task 1. ✓
- `AuditRecorder` narrow interface (improvement over passing `AuditLog` directly — makes fire-and-forget deterministically testable; class implements it) → Task 1. ✓
- `auth_failed` (401) + `scope_denied` (403) → Task 2. ✓
- `pairing_redeemed`, `token_minted`, `token_revoked` → Task 3. ✓
- `session_attached` / `session_detached` (detach only if attached) → Task 4. ✓
- One `AuditLog` built in `createGatewayApp`, `GatewayDeps.auditPath`, threaded into all middlewares/routes → Task 5. ✓
- Sensitive-data rule (no raw tokens) → asserted in Task 5 (`not.toContain('not-a-token')`). ✓
- Exports → Task 5 Step 3. ✓
- Deferred items (query API, rotation, tamper-evidence) → correctly absent. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type/name consistency:** `AuditAction`/`AuditEntry`/`AuditRecorder`/`AuditLog`; `record(entry)`; `bearerResolve(store, audit?)`, `requireScope(scope, audit?)`, `createPairRedeemRoute(pairing, store, audit?)`, `createMintTokenRoute(store, audit?)`, `createRevokeTokenRoute(store, registry, audit?)`, `createSessionEventsRoute(daemon, registry, audit?)`; `GatewayDeps.auditPath?`. The `audit?` optional param keeps every intermediate task compiling (callers that omit it get a no-op) until Task 5 wires the real instance. `req.rcClient?.id` matches the cycle-1 `types.ts` augmentation. ✓

**Decision note:** `audit` is OPTIONAL on all factories (not required) specifically so Tasks 2–4 leave `server.ts` compiling without touching it; Task 5 supplies the real `AuditLog`. This is the cleanest task ordering and matches the spec's intent (server builds + threads the log).
