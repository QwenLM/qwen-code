# GET /rc/peers (remote LAN daemon discovery) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner-scope `GET /rc/peers` that runs a one-shot mDNS browse and returns discovered sibling `_qwen-rc._tcp` daemons as JSON, so a remote client can find daemons to switch to without a terminal.

**Architecture:** Entirely inside `packages/rc-gateway/`. A bonjour-agnostic route factory (`routes/peers.ts`) depends on an injected `browsePeers` capability; `cli.ts` provides it by composing the existing `loadBonjourFactory()` + `browseDaemons(...)` (the same pair behind `qwen-rc daemons discover`). Threaded through `GatewayDeps` exactly like P4's `policyExplain`.

**Tech Stack:** TypeScript, Express 4, Vitest.

## Global Constraints

- **No daemon change.** Nothing under `packages/cli/src/serve` or `packages/core`. `packages/rc-gateway/src/cli.ts` IS in scope; the daemon is NOT. `/rc/peers` makes no daemon call.
- **`owner` scope, gateway-global (no `:id`), read-only** — no mutation, no state change, no audit row.
- **Response is `200 { peers }`** where `peers` is the `browseDaemons(...)` result **verbatim** — `DaemonRecord[]` (`{ name, host, port, version, tlsRequired, workspace }`), already normalized, deduped, and sorted. An empty LAN is `200 { peers: [] }`, never an error.
- **mDNS unavailable** (optional `bonjour-service` not installed) → `503 { code: 'mdns_unavailable' }`. Unexpected browse failure → `500 { code: 'peers_unavailable' }`.
- Response carries only LAN discovery metadata — never session/tool content.

---

### Task 1: `routes/peers.ts` — the route factory

**Files:**

- Create: `packages/rc-gateway/src/routes/peers.ts`
- Test: `packages/rc-gateway/src/routes/peers.test.ts`

**Interfaces:**

- Consumes: `DaemonRecord` (type) from `../mdns/advert.js`.
- Produces:
  - `export type BrowsePeers = (timeoutMs: number) => Promise<DaemonRecord[] | null>` (null ⇒ mDNS unavailable).
  - `export function createPeersRoute(browsePeers: BrowsePeers): RequestHandler`.

- [ ] **Step 1: Write the failing test**

Create `packages/rc-gateway/src/routes/peers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createPeersRoute, type BrowsePeers } from './peers.js';
import type { DaemonRecord } from '../mdns/advert.js';

const REC: DaemonRecord = {
  name: 'work',
  host: '192.168.1.9',
  port: 4123,
  version: '0.17.1',
  tlsRequired: false,
  workspace: 'myrepo',
};

function fakeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown,
    headersSent: false,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
      return this;
    },
  };
}
const call = async (browsePeers: BrowsePeers) => {
  const res = fakeRes();
  await createPeersRoute(browsePeers)(
    {} as never,
    res as never,
    (() => {}) as never,
  );
  return res;
};

describe('createPeersRoute', () => {
  it('200s with the peers array verbatim', async () => {
    const res = await call(async () => [REC]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ peers: [REC] });
  });

  it('200s with an empty list on an empty LAN', async () => {
    const res = await call(async () => []);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ peers: [] });
  });

  it('503 mdns_unavailable when browsePeers returns null', async () => {
    const res = await call(async () => null);
    expect(res.statusCode).toBe(503);
    expect((res.body as { code: string }).code).toBe('mdns_unavailable');
  });

  it('500 peers_unavailable when browsePeers throws', async () => {
    const res = await call(async () => {
      throw new Error('boom');
    });
    expect(res.statusCode).toBe(500);
    expect((res.body as { code: string }).code).toBe('peers_unavailable');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/rc-gateway && npx vitest run src/routes/peers.test.ts`
Expected: FAIL — module `./peers.js` missing.

- [ ] **Step 3: Implement the route**

Create `packages/rc-gateway/src/routes/peers.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonRecord } from '../mdns/advert.js';

/**
 * Browse the LAN for sibling `_qwen-rc._tcp` daemons. Resolves the discovered
 * records (possibly empty), or `null` when mDNS discovery is unavailable
 * (the optional `bonjour-service` dependency is not installed).
 */
export type BrowsePeers = (timeoutMs: number) => Promise<DaemonRecord[] | null>;

/**
 * The gateway's default mDNS browse window. Matches the default the
 * `qwen-rc daemons discover` CLI uses (`parseDiscoverArgs` → `timeoutMs = 5000`).
 * The endpoint blocks for roughly this long — inherent to mDNS.
 */
const PEERS_BROWSE_TIMEOUT_MS = 5000;

/**
 * `GET /rc/peers` — owner-only (enforced at the mount), read-only LAN daemon
 * discovery. Returns `200 { peers }` (the browse result verbatim; empty LAN →
 * `[]`), `503 mdns_unavailable` when discovery is unavailable, `500
 * peers_unavailable` on an unexpected browse failure. No daemon call, no
 * mutation.
 */
export function createPeersRoute(browsePeers: BrowsePeers): RequestHandler {
  return async (_req, res) => {
    try {
      const peers = await browsePeers(PEERS_BROWSE_TIMEOUT_MS);
      if (peers === null) {
        res.status(503).json({
          error:
            'mDNS discovery unavailable (optional bonjour-service dependency not installed)',
          code: 'mdns_unavailable',
        });
        return;
      }
      res.status(200).json({ peers });
    } catch {
      if (!res.headersSent) {
        res
          .status(500)
          .json({ error: 'Peer discovery failed', code: 'peers_unavailable' });
      }
    }
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/rc-gateway && npx vitest run src/routes/peers.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Typecheck**

Run: `cd packages/rc-gateway && npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors vs the pre-existing baseline (11 errors, all in unrelated files — auth.ts/cors.ts/pair.ts/server.ts/vapid.ts/discord/telegram).

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/src/routes/peers.ts packages/rc-gateway/src/routes/peers.test.ts
git commit -m "feat(rc-gateway): add /rc/peers route factory (owner LAN daemon discovery)"
```

---

### Task 2: Wire `browsePeers`, mount the owner route, integration test

**Files:**

- Modify: `packages/rc-gateway/src/server.ts` (GatewayDeps field + mount)
- Modify: `packages/rc-gateway/src/cli.ts` (the `browsePeers` provider)
- Test: `packages/rc-gateway/src/routes/peers.integration.test.ts`

**Interfaces:**

- Consumes: `createPeersRoute`, `BrowsePeers` (Task 1); `OWNER`, `requireScope` (already imported in `server.ts`); `browseDaemons`, `BrowserFactory` (already imported in `cli.ts`); `loadBonjourFactory` (a top-level function in `cli.ts`).

- [ ] **Step 1: Add the `browsePeers` dep to `GatewayDeps` and mount the route**

In `server.ts`:

1. Add the imports near the other route imports:

```ts
import { createPeersRoute } from './routes/peers.js';
import type { BrowsePeers } from './routes/peers.js';
```

2. Add an optional field to the `GatewayDeps` interface (near the other optional deps):

```ts
  /** LAN daemon discovery for GET /rc/peers. Absent → route not mounted. */
  browsePeers?: BrowsePeers;
```

3. Mount near the other `/rc/*` owner routes (after `audit` exists). Gateway-global, owner scope, no session middleware:

```ts
if (deps.browsePeers) {
  app.get(
    '/rc/peers',
    requireScope(OWNER, audit),
    createPeersRoute(deps.browsePeers),
  );
}
```

- [ ] **Step 2: Provide `browsePeers` in `cli.ts`**

In `cli.ts`, inside the `createGatewayApp({ … })` deps object (alongside the other closures like `mdnsStatus`), add:

```ts
    // GET /rc/peers: browse the LAN via the OPTIONAL bonjour-service factory
    // (same pair behind `qwen-rc daemons discover`). null → dependency absent.
    browsePeers: async (timeoutMs: number) => {
      const factory = await loadBonjourFactory();
      if (!factory) return null;
      return browseDaemons({
        factory: factory as unknown as BrowserFactory,
        timeoutMs,
      });
    },
```

(`loadBonjourFactory`, `browseDaemons`, and `BrowserFactory` are already imported/defined in `cli.ts`; the cast mirrors the existing `daemons discover` call site.)

**Note — the ~5 s browse (production behavior, deliberately untested here):** `PEERS_BROWSE_TIMEOUT_MS = 5000` means the real provider holds each `GET /rc/peers` request open for ~5 s while the mDNS browse runs. This is intended (inherent to mDNS; matches the CLI). BOTH test layers inject a stub `browsePeers` that resolves instantly, so the 5 s block is bypassed by design — do **not** add a test that runs a real 5 s browse (it would make the suite crawl for no coverage gain). Leave the timing untested.

**Note — concurrency:** each `browseDaemons` call constructs a fresh bonjour instance via `factory()` and `destroy()`s it in a `finally`; `loadBonjourFactory` is a cached dynamic import. Confirm concurrent/overlapping `GET /rc/peers` calls are safe (mDNS uses `SO_REUSEADDR` on UDP 5353, so multiple short-lived browsers normally coexist). If — and only if — you find concurrent browses are actually unsafe (a bind/socket conflict), add single-flight to the provider (share one in-flight browse promise across overlapping requests, which also gives overlapping callers the same LAN snapshot). Do not add single-flight speculatively; this endpoint is owner-only and low-traffic.

- [ ] **Step 3: Typecheck the wiring**

Run: `cd packages/rc-gateway && npx tsc --noEmit -p tsconfig.json`
Expected: no NEW errors vs the 11-error baseline (confirms `GatewayDeps` accepts the field and the `browsePeers` closure returns `DaemonRecord[] | null`).

- [ ] **Step 4: Write the failing integration test**

Create `packages/rc-gateway/src/routes/peers.integration.test.ts`. Mirror the harness in `packages/rc-gateway/src/routes/policyExplain.integration.test.ts` (real `createGatewayApp` + `startStubDaemon` + `TokenStore`), injecting a `browsePeers` stub (no real mDNS):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DaemonClient } from '@qwen-code/sdk';
import { createGatewayApp } from '../server.js';
import { TokenStore } from '../tokenStore.js';
import { PairingService } from '../pairing.js';
import { startStubDaemon } from '../testing/stubDaemon.js';
import type { DaemonRecord } from '../mdns/advert.js';
import type { BrowsePeers } from './peers.js';

const REC: DaemonRecord = {
  name: 'work',
  host: '192.168.1.9',
  port: 4123,
  version: '0.17.1',
  tlsRequired: false,
  workspace: 'myrepo',
};

async function boot(browsePeers: BrowsePeers) {
  const base = mkdtempSync(join(tmpdir(), 'peers-'));
  const stub = await startStubDaemon();
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const store = await TokenStore.open(join(base, 'tokens.json'));
  const { token: owner } = await store.issue(['owner'], 'o');
  const { token: writer } = await store.issue(['write'], 'w');
  const gw = createGatewayApp({
    daemon,
    store,
    pairing: new PairingService(),
    auditPath: join(base, 'audit.log'),
    browsePeers,
  });
  const server = await new Promise<import('node:http').Server>((r) => {
    const s = gw.app.listen(0, '127.0.0.1', () => r(s));
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/rc/peers`;
  return { base, stub, server, owner, writer, url };
}

let ctx: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(async () => {
  if (ctx) {
    ctx.server.close();
    await ctx.stub.close();
    ctx = undefined;
  }
});

describe('GET /rc/peers (integration)', () => {
  it('owner gets 200 with the discovered peers', async () => {
    ctx = await boot(async () => [REC]);
    const r = await fetch(ctx.url, {
      headers: { authorization: `Bearer ${ctx.owner}` },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ peers: [REC] });
  });

  it('503 mdns_unavailable when discovery is unavailable', async () => {
    ctx = await boot(async () => null);
    const r = await fetch(ctx.url, {
      headers: { authorization: `Bearer ${ctx.owner}` },
    });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { code: string }).code).toBe(
      'mdns_unavailable',
    );
  });

  it('rejects a write-scope token with 403', async () => {
    ctx = await boot(async () => [REC]);
    const r = await fetch(ctx.url, {
      headers: { authorization: `Bearer ${ctx.writer}` },
    });
    expect(r.status).toBe(403);
  });
});
```

(If the `startStubDaemon` / `DaemonClient` / `TokenStore.issue` / `listen` shapes differ, copy them verbatim from `policyExplain.integration.test.ts` — that file is the authoritative harness; only the `browsePeers` dep and the three assertions are new.)

- [ ] **Step 5: Run the integration test**

Run: `cd packages/rc-gateway && npx vitest run src/routes/peers.integration.test.ts`
Expected: PASS (owner 200; null → 503; write → 403).

- [ ] **Step 6: Run the full suite + typecheck**

Run: `cd packages/rc-gateway && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: full suite green (no regressions); tsc no NEW errors vs the 11-baseline.

- [ ] **Step 7: Commit**

```bash
git add packages/rc-gateway/src/server.ts packages/rc-gateway/src/cli.ts packages/rc-gateway/src/routes/peers.integration.test.ts
git commit -m "feat(rc-gateway): mount owner GET /rc/peers over the mDNS browse"
```
