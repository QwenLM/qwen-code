# RC Gateway Token Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-authorized token lifecycle to `@qwen-code/rc-gateway` — list, mint (scope-clamped), and revoke tokens, with revocation immediately evicting the token's live SSE streams.

**Architecture:** Extend the cycle-1 package in place. Add a flat `owner` scope, `TokenStore.list/revoke`, a standalone `ConnectionRegistry` (token id → active `AbortController`s), and three owner-gated `/rc/tokens` routes. The SSE route registers its existing abort controller in the registry so a revoke can fire the same abort path already used for client-disconnect. Zero upstream-file edits.

**Tech Stack:** TypeScript (ESM, NodeNext), Express, Node `crypto`, vitest, `@qwen-code/sdk`.

---

## File Structure

```
packages/rc-gateway/src/
  scopes.ts                  # MODIFY: add OWNER + KNOWN_SCOPES
  tokenStore.ts              # MODIFY: add TokenInfo, list(), revoke()
  tokenStore.test.ts         # MODIFY: add list/revoke tests
  connectionRegistry.ts      # NEW: token id -> Set<AbortController>
  connectionRegistry.test.ts # NEW
  routes/tokens.ts           # NEW: list / mint / revoke handler factories
  routes/tokens.test.ts      # NEW: route integration (with bearerResolve + requireScope)
  routes/sessionEvents.ts    # MODIFY: take registry, register/unregister the abort controller
  routes/sessionEvents.test.ts # MODIFY: pass a registry at call sites
  server.ts                  # MODIFY: build the registry, wire token routes
  server.test.ts             # MODIFY: add eviction behavioral test
  cli.ts                     # MODIFY: boot pairing code grants [OWNER, SESSION_READ]
  index.ts                   # MODIFY: export new public symbols
```

---

## Task 1: TokenStore.list + revoke

**Files:**

- Modify: `packages/rc-gateway/src/tokenStore.ts`
- Test: `packages/rc-gateway/src/tokenStore.test.ts`

- [ ] **Step 1: Add failing tests** (append inside the existing `describe('TokenStore', ...)` block in `tokenStore.test.ts`)

```ts
it('lists issued tokens as metadata only (no hash, no raw token)', async () => {
  const store = await TokenStore.open(path);
  const { id, token } = await store.issue([SESSION_READ], 'phone');
  const list = store.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ id, scopes: [SESSION_READ], label: 'phone' });
  expect(typeof list[0].createdAt).toBe('number');
  // No secret material leaks through the listing shape.
  const serialized = JSON.stringify(list);
  expect(serialized).not.toContain(token);
  expect(serialized).not.toContain('tokenHash');
});

it('revokes a token by id: removes it, persists, stops resolving', async () => {
  const store = await TokenStore.open(path);
  const { id, token } = await store.issue([SESSION_READ], 'phone');
  expect(await store.revoke(id)).toBe(true);
  expect(store.resolve(`Bearer ${token}`)).toBeNull();
  // Persisted: a reopened store also no longer has it.
  const reopened = await TokenStore.open(path);
  expect(reopened.list()).toHaveLength(0);
  expect(reopened.resolve(`Bearer ${token}`)).toBeNull();
});

it('revoke returns false for an unknown id', async () => {
  const store = await TokenStore.open(path);
  await store.issue([SESSION_READ], 'phone');
  expect(await store.revoke('does-not-exist')).toBe(false);
  expect(store.list()).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway tokenStore`
Expected: FAIL (`store.list is not a function`).

- [ ] **Step 3: Implement `list` and `revoke`** in `tokenStore.ts`. Add the `TokenInfo` export near the top (after the `TokenRecord` interface) and the two methods after `resolve(...)`:

```ts
/** Public metadata about an issued token. Never includes secret material. */
export interface TokenInfo {
  id: string;
  scopes: RcScope[];
  label: string;
  createdAt: number;
}
```

```ts
  /** List issued tokens as metadata only (no hash, no raw token). */
  list(): TokenInfo[] {
    return this.records.map((r) => ({
      id: r.id,
      scopes: [...r.scopes],
      label: r.label,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Remove a token by id. Returns true if a record was removed. Awaits the
   * persist so a revoked credential is durable before the caller responds —
   * a crash must never resurrect a revoked token on reopen.
   */
  async revoke(id: string): Promise<boolean> {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    if (this.records.length === before) return false;
    await this.persist();
    return true;
  }
```

Note: `revoke` is `async` and **awaits** persist — revocation is a security operation, so it must be durable before the route returns 204 (a fire-and-forget `void persist()` both leaves a crash-window where a revoked token resurrects and makes the persist test a ~10% flake). Callers `await store.revoke(id)`. `records` is reassigned (non-`readonly`, no decl change needed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway tokenStore`
Expected: PASS (8 tests: 5 original + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/tokenStore.ts packages/rc-gateway/src/tokenStore.test.ts
git commit -m "feat(rc-gateway): TokenStore list + revoke"
```

---

## Task 2: ConnectionRegistry

**Files:**

- Create: `packages/rc-gateway/src/connectionRegistry.ts`
- Test: `packages/rc-gateway/src/connectionRegistry.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ConnectionRegistry } from './connectionRegistry.js';

describe('ConnectionRegistry', () => {
  it('evict aborts a registered controller', () => {
    const reg = new ConnectionRegistry();
    const ctrl = new AbortController();
    reg.register('tok-1', ctrl);
    reg.evict('tok-1');
    expect(ctrl.signal.aborted).toBe(true);
  });

  it('aborts every controller registered under the same id', () => {
    const reg = new ConnectionRegistry();
    const a = new AbortController();
    const b = new AbortController();
    reg.register('tok-1', a);
    reg.register('tok-1', b);
    reg.evict('tok-1');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(true);
  });

  it('unregister prevents later eviction', () => {
    const reg = new ConnectionRegistry();
    const ctrl = new AbortController();
    const unregister = reg.register('tok-1', ctrl);
    unregister();
    reg.evict('tok-1');
    expect(ctrl.signal.aborted).toBe(false);
  });

  it('evict on an unknown id is a no-op', () => {
    const reg = new ConnectionRegistry();
    expect(() => reg.evict('nobody')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway connectionRegistry`
Expected: FAIL (`ConnectionRegistry` not exported).

- [ ] **Step 3: Implement `connectionRegistry.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tracks active stream abort controllers per token id so a token revocation
 * can immediately tear down that token's live connections.
 */
export class ConnectionRegistry {
  private byToken = new Map<string, Set<AbortController>>();

  /** Register a controller for a token id; returns an idempotent unregister. */
  register(tokenId: string, ctrl: AbortController): () => void {
    let set = this.byToken.get(tokenId);
    if (!set) {
      set = new Set();
      this.byToken.set(tokenId, set);
    }
    set.add(ctrl);
    return () => {
      const s = this.byToken.get(tokenId);
      if (!s) return;
      s.delete(ctrl);
      if (s.size === 0) this.byToken.delete(tokenId);
    };
  }

  /** Abort every controller registered under a token id, then forget them. */
  evict(tokenId: string): void {
    const set = this.byToken.get(tokenId);
    if (!set) return;
    for (const ctrl of set) ctrl.abort();
    this.byToken.delete(tokenId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway connectionRegistry`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/connectionRegistry.ts packages/rc-gateway/src/connectionRegistry.test.ts
git commit -m "feat(rc-gateway): connection registry for token eviction"
```

---

## Task 3: Scopes + /rc/tokens routes

**Files:**

- Modify: `packages/rc-gateway/src/scopes.ts`
- Create: `packages/rc-gateway/src/routes/tokens.ts`
- Test: `packages/rc-gateway/src/routes/tokens.test.ts`

- [ ] **Step 1: Add `OWNER` + `KNOWN_SCOPES` to `scopes.ts`** (append after the existing `SESSION_READ` line)

```ts
/** Management scope: list / mint / revoke tokens. */
export const OWNER: RcScope = 'owner';

/** All scopes the gateway recognizes (used to reject unknown mint scopes). */
export const KNOWN_SCOPES: readonly RcScope[] = [OWNER, SESSION_READ];
```

- [ ] **Step 2: Write failing route integration tests** in `routes/tokens.test.ts`

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
import { ConnectionRegistry } from '../connectionRegistry.js';
import { bearerResolve, requireScope } from '../auth.js';
import { OWNER, SESSION_READ } from '../scopes.js';
import {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './tokens.js';

let server: Server | undefined;
let store: TokenStore;
let registry: ConnectionRegistry;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

beforeEach(async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'rc-tok-')), 'tokens.json');
  store = await TokenStore.open(path);
  registry = new ConnectionRegistry();
});

async function mount(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(bearerResolve(store));
  app.get('/rc/tokens', requireScope(OWNER), createListTokensRoute(store));
  app.post('/rc/tokens', requireScope(OWNER), createMintTokenRoute(store));
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER),
    createRevokeTokenRoute(store, registry),
  );
  const s: Server = await new Promise((resolve) => {
    const sv = app.listen(0, '127.0.0.1', () => resolve(sv));
  });
  server = s;
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('/rc/tokens routes', () => {
  it('GET lists tokens for an owner (metadata only)', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain('tokenHash');
  });

  it('GET is forbidden for a session:read-only token', async () => {
    const weak = await store.issue([SESSION_READ], 'phone');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      headers: { Authorization: `Bearer ${weak.token}` },
    });
    expect(res.status).toBe(403);
  });

  it('POST mints a scoped token an owner is allowed to grant', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [SESSION_READ], label: 'minted' }),
    });
    expect(res.status).toBe(200);
    const { token, scopes } = (await res.json()) as {
      token: string;
      scopes: string[];
    };
    expect(scopes).toEqual([SESSION_READ]);
    // The minted token actually resolves.
    expect(store.resolve(`Bearer ${token}`)).not.toBeNull();
  });

  it('POST rejects an unknown scope with 400', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: ['session:write'] }),
    });
    expect(res.status).toBe(400);
  });

  it('POST clamps: cannot grant a scope the caller lacks', async () => {
    // Caller holds owner but NOT a hypothetical scope; use a caller that holds
    // only owner and tries to mint session:read which it does not hold.
    const owner = await store.issue([OWNER], 'owner-no-read');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${owner.token}`,
      },
      body: JSON.stringify({ scopes: [SESSION_READ] }),
    });
    expect(res.status).toBe(403);
  });

  it('DELETE revokes a token (204) and evicts its registered streams', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const victim = await store.issue([SESSION_READ], 'victim');
    // Simulate an open stream for the victim token.
    const ctrl = new AbortController();
    registry.register(victim.id, ctrl);
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/${victim.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(204);
    expect(ctrl.signal.aborted).toBe(true);
    expect(store.resolve(`Bearer ${victim.token}`)).toBeNull();
  });

  it('DELETE an unknown id returns 404', async () => {
    const owner = await store.issue([OWNER, SESSION_READ], 'owner');
    const url = await mount();
    const res = await fetch(`${url}/rc/tokens/nope`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway routes/tokens`
Expected: FAIL (`./tokens.js` does not export the route factories).

- [ ] **Step 4: Implement `routes/tokens.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from '../tokenStore.js';
import type { ConnectionRegistry } from '../connectionRegistry.js';
import { KNOWN_SCOPES, SESSION_READ, type RcScope } from '../scopes.js';

/** GET /rc/tokens → metadata list of issued tokens. */
export function createListTokensRoute(store: TokenStore): RequestHandler {
  return (_req, res) => {
    res.status(200).json(store.list());
  };
}

/** POST /rc/tokens { scopes?, label? } → mint a scope-clamped token. */
export function createMintTokenRoute(store: TokenStore): RequestHandler {
  return async (req, res) => {
    const body = (req.body ?? {}) as { scopes?: unknown; label?: unknown };
    const requested: RcScope[] = Array.isArray(body.scopes)
      ? (body.scopes as unknown[]).map(String)
      : [SESSION_READ];
    const label = typeof body.label === 'string' ? body.label : 'unnamed';

    const unknown = requested.filter((s) => !KNOWN_SCOPES.includes(s));
    if (unknown.length > 0) {
      res.status(400).json({
        error: `Unknown scope(s): ${unknown.join(', ')}`,
        code: 'invalid_scope',
      });
      return;
    }
    const callerScopes = req.rcClient?.scopes ?? [];
    const ungrantable = requested.filter((s) => !callerScopes.includes(s));
    if (ungrantable.length > 0) {
      res.status(403).json({
        error: `Cannot grant scope(s) you do not hold: ${ungrantable.join(', ')}`,
        code: 'insufficient_scope',
      });
      return;
    }
    const { id, token } = await store.issue(requested, label);
    res.status(200).json({ id, token, scopes: requested });
  };
}

/** DELETE /rc/tokens/:id → revoke + evict live streams. */
export function createRevokeTokenRoute(
  store: TokenStore,
  registry: ConnectionRegistry,
): RequestHandler {
  return async (req, res) => {
    const id = req.params.id;
    if (!(await store.revoke(id))) {
      res.status(404).json({ error: 'No such token', code: 'token_not_found' });
      return;
    }
    registry.evict(id);
    res.status(204).end();
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway routes/tokens`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/src/scopes.ts packages/rc-gateway/src/routes/tokens.ts packages/rc-gateway/src/routes/tokens.test.ts
git commit -m "feat(rc-gateway): owner-gated /rc/tokens list/mint/revoke routes"
```

---

## Task 4: Eviction wiring (SSE route + server assembly)

**Files:**

- Modify: `packages/rc-gateway/src/routes/sessionEvents.ts`
- Modify: `packages/rc-gateway/src/routes/sessionEvents.test.ts`
- Modify: `packages/rc-gateway/src/server.ts`
- Modify: `packages/rc-gateway/src/server.test.ts`

- [ ] **Step 1: Replace `routes/sessionEvents.ts` with the registry-aware version**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler, Response } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { ConnectionRegistry } from '../connectionRegistry.js';

/**
 * GET /rc/session/:id/events — relay the daemon's SSE stream downstream,
 * preserving event ids and forwarding Last-Event-ID. Aborts the upstream
 * subscription when the client disconnects OR when the caller's token is
 * revoked (the registry fires the same abort controller).
 */
export function createSessionEventsRoute(
  daemon: DaemonClient,
  registry: ConnectionRegistry,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const lastEventIdRaw = req.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdRaw === 'string' && lastEventIdRaw.length > 0
        ? Number(lastEventIdRaw)
        : undefined;

    const abort = new AbortController();
    // Register under the resolved token id so a revoke can evict this stream.
    const tokenId = req.rcClient?.id;
    const unregister = tokenId ? registry.register(tokenId, abort) : () => {};
    req.on('close', () => abort.abort());

    try {
      const iterator = daemon.subscribeEvents(sessionId, {
        lastEventId: Number.isFinite(lastEventId) ? lastEventId : undefined,
        signal: abort.signal,
      });
      // Force the connect phase (and any non-200) to surface before we
      // commit a 200 + SSE headers downstream.
      const first = await iterator.next();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (!first.done) writeFrame(res, first.value);
      for await (const ev of iterator) {
        writeFrame(res, ev);
      }
      res.end();
    } catch {
      if (abort.signal.aborted) {
        // Client disconnected or token was revoked mid-stream.
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

- [ ] **Step 2: Update `sessionEvents.test.ts` call sites** to pass a registry. At the top add the import, and change `mountGateway` to construct one.

Add import:

```ts
import { ConnectionRegistry } from '../connectionRegistry.js';
```

Change the route registration line inside `mountGateway` from:

```ts
app.get('/rc/session/:id/events', createSessionEventsRoute(daemon));
```

to:

```ts
app.get(
  '/rc/session/:id/events',
  createSessionEventsRoute(daemon, new ConnectionRegistry()),
);
```

- [ ] **Step 3: Update `server.ts`** to build one registry and wire token routes. Replace the file body's imports + `createGatewayApp` with:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Express } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';
import type { TokenStore } from './tokenStore.js';
import type { PairingService } from './pairing.js';
import { bearerResolve, requireScope } from './auth.js';
import { OWNER, SESSION_READ } from './scopes.js';
import { ConnectionRegistry } from './connectionRegistry.js';
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
}

export function createGatewayApp(deps: GatewayDeps): Express {
  const app = express();
  app.use(express.json());

  // One registry shared by the SSE route (registers streams) and the revoke
  // route (evicts them).
  const registry = new ConnectionRegistry();

  app.get('/rc/health', (_req, res) => res.json({ status: 'ok' }));

  // Pairing redemption is gated by the code itself, not a bearer token.
  app.post('/rc/pair/redeem', createPairRedeemRoute(deps.pairing, deps.store));

  // Everything below requires a resolved client identity.
  app.use(bearerResolve(deps.store));
  app.get(
    '/rc/session/:id/events',
    requireScope(SESSION_READ),
    createSessionEventsRoute(deps.daemon, registry),
  );
  app.get('/rc/tokens', requireScope(OWNER), createListTokensRoute(deps.store));
  app.post('/rc/tokens', requireScope(OWNER), createMintTokenRoute(deps.store));
  app.delete(
    '/rc/tokens/:id',
    requireScope(OWNER),
    createRevokeTokenRoute(deps.store, registry),
  );

  return app;
}
```

- [ ] **Step 4: Add the eviction behavioral test** to `server.test.ts` (append inside `describe('gateway app', ...)`). It reuses the existing `boot()` helper (which already starts a hold-open-capable stub via `startStubDaemon`). Note: `boot()` must start the stub with `holdOpenMs` so the stream stays open; add an option. First update `boot()` to accept stub options:

Change the `boot()` signature/first line from:

```ts
async function boot(): Promise<{
  url: string;
  pairing: PairingService;
  store: TokenStore;
}> {
  stub = await startStubDaemon();
```

to:

```ts
async function boot(stubOpts?: Parameters<typeof startStubDaemon>[0]): Promise<{
  url: string;
  pairing: PairingService;
  store: TokenStore;
}> {
  stub = await startStubDaemon(stubOpts);
```

Then append this test:

```ts
it('revoking a token evicts its open SSE stream', async () => {
  const { url, pairing } = await boot({ holdOpenMs: 5000 });

  // Owner token (to call DELETE) and a victim session:read token.
  const ownerCode = pairing.mint([OWNER, SESSION_READ]);
  const ownerRedeem = await fetch(`${url}/rc/pair/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: ownerCode.code, label: 'owner' }),
  });
  const ownerToken = ((await ownerRedeem.json()) as { token: string }).token;

  const victimCode = pairing.mint([SESSION_READ]);
  const victimRedeem = await fetch(`${url}/rc/pair/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: victimCode.code, label: 'victim' }),
  });
  const victim = (await victimRedeem.json()) as { id: string; token: string };

  // Open the victim's SSE stream and read the first chunk.
  const ac = new AbortController();
  const stream = await fetch(`${url}/rc/session/sess-1/events`, {
    headers: { Authorization: `Bearer ${victim.token}` },
    signal: ac.signal,
  });
  await stream.body!.getReader().read();

  // Owner revokes the victim token.
  const del = await fetch(`${url}/rc/tokens/${victim.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(del.status).toBe(204);

  // The upstream subscription is torn down (stub sees its request close).
  const deadline = Date.now() + 5000;
  while (!stub!.eventsAbortedByClient && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(stub!.eventsAbortedByClient).toBe(true);
  ac.abort();
});
```

Add the `OWNER` import to `server.test.ts` (alongside the existing `SESSION_READ` import):

```ts
import { OWNER, SESSION_READ } from './scopes.js';
```

- [ ] **Step 5: Run the affected suites**

Run: `cd /home/evan/projects/qwen-code && npx vitest run --root packages/rc-gateway sessionEvents server`
Expected: PASS (sessionEvents 4 + server 5).

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/src/routes/sessionEvents.ts packages/rc-gateway/src/routes/sessionEvents.test.ts packages/rc-gateway/src/server.ts packages/rc-gateway/src/server.test.ts
git commit -m "feat(rc-gateway): evict live SSE streams on token revoke"
```

---

## Task 5: Boot grant + exports + full verification

**Files:**

- Modify: `packages/rc-gateway/src/cli.ts`
- Modify: `packages/rc-gateway/src/index.ts`

- [ ] **Step 1: Update the boot pairing grant in `cli.ts`.** Change the import and the `mint` call.

Change:

```ts
import { SESSION_READ } from './scopes.js';
```

to:

```ts
import { OWNER, SESSION_READ } from './scopes.js';
```

Change:

```ts
const { code, expiresAt } = pairing.mint([SESSION_READ]);
```

to:

```ts
const { code, expiresAt } = pairing.mint([OWNER, SESSION_READ]);
```

And update the console line that prints the granted scopes from:

```ts
        `  (expires ${new Date(expiresAt).toISOString()}, grants [${SESSION_READ}])`,
```

to:

```ts
        `  (expires ${new Date(expiresAt).toISOString()}, grants [${OWNER}, ${SESSION_READ}])`,
```

- [ ] **Step 2: Export new public symbols from `index.ts`.** Replace the scopes export line and add the new modules:

Change:

```ts
export { SESSION_READ, type RcScope } from './scopes.js';
```

to:

```ts
export { SESSION_READ, OWNER, KNOWN_SCOPES, type RcScope } from './scopes.js';
```

Add these lines:

```ts
export { TokenStore, type TokenInfo } from './tokenStore.js';
export { ConnectionRegistry } from './connectionRegistry.js';
export {
  createListTokensRoute,
  createMintTokenRoute,
  createRevokeTokenRoute,
} from './routes/tokens.js';
```

Note: `TokenStore` is already exported in `index.ts` from cycle 1 — change that existing line to also export `TokenInfo` rather than adding a duplicate `export { TokenStore }`. The existing line is:

```ts
export { TokenStore } from './tokenStore.js';
```

Replace it with the `TokenStore, type TokenInfo` form above and do NOT add a second `TokenStore` export.

- [ ] **Step 3: Typecheck, lint, build**

Run:

```bash
cd /home/evan/projects/qwen-code
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
```

Expected: no type errors; lint clean; build succeeds.

- [ ] **Step 4: Run the full package suite**

Run: `cd /home/evan/projects/qwen-code && npm run test --workspace @qwen-code/rc-gateway`
Expected: PASS — all suites green (scopes 2, tokenStore 8, pairing 5, auth 4, connectionRegistry 4, routes/tokens 7, routes/sessionEvents 4, server 5, daemonSupervisor 2 = 41 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/cli.ts packages/rc-gateway/src/index.ts
git commit -m "feat(rc-gateway): boot grants owner scope; export token-management API"
```

- [ ] **Step 6 (optional, not gating): extend the manual e2e** in `scripts/rc-gateway-e2e.mjs` to redeem the owner-scoped boot-style code, `GET /rc/tokens`, `POST /rc/tokens`, then `DELETE` and confirm 204 against the real daemon. Run `node scripts/rc-gateway-e2e.mjs`.

---

## Self-Review

**Spec coverage** (design §Components / §Error model / §Testing):

- `owner` scope + `KNOWN_SCOPES` → Task 3 Step 1. ✓
- `TokenStore.list` / `revoke` → Task 1. ✓
- `ConnectionRegistry` → Task 2. ✓
- `GET/POST/DELETE /rc/tokens`, owner-gated, mint clamp + invalid_scope + token_not_found → Task 3. ✓
- Eviction wiring (SSE route registers; revoke evicts; reuses abort path) → Task 4. ✓
- `createGatewayApp` builds one shared registry → Task 4 Step 3. ✓
- Boot grant `[owner, session:read]` → Task 5 Step 1. ✓
- Error model rows: 403 non-owner (requireScope, Task 3 test), 401 (existing bearerResolve), 400 invalid_scope (Task 3), 403 insufficient_scope clamp (Task 3), 404 token_not_found (Task 3), 204 revoke (Task 3) + eviction behavioral (Task 4). ✓
- Deferred items (audit, capabilities, hierarchy, TTL, CORS) → correctly absent. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type/name consistency:** `OWNER`/`SESSION_READ`/`KNOWN_SCOPES`/`RcScope`; `TokenInfo`; `TokenStore.list()`/`revoke(id)`; `ConnectionRegistry.register(tokenId, ctrl)→unregister`/`evict(tokenId)`; `createListTokensRoute(store)`/`createMintTokenRoute(store)`/`createRevokeTokenRoute(store, registry)`; `createSessionEventsRoute(daemon, registry)`; `createGatewayApp(deps)` unchanged (registry built internally). `req.rcClient.id`/`.scopes` match the cycle-1 `types.ts` augmentation. ✓

**Note on `index.ts`:** cycle-1 already exports `TokenStore`; Task 5 Step 2 explicitly replaces that line rather than duplicating it — flagged to avoid a redeclare error.
