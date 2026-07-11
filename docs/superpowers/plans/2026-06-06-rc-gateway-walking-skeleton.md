# RC Gateway Walking Skeleton — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fork-owned `@qwen-code/rc-gateway` package that wraps the unmodified `qwen serve` daemon and proves the remote-control seam end-to-end: pairing code → scoped token → authenticated, scope-gated SSE proxy of one daemon route.

**Architecture:** A new package under `packages/rc-gateway/` (auto-included by the `packages/*` workspace glob — zero upstream-file edits). It consumes the published `@qwen-code/sdk` `DaemonClient` to talk to a loopback daemon. An Express app exposes `POST /rc/pair/redeem`, `GET /rc/session/:id/events`, `GET /rc/health`. Tokens persist as sha256 hashes in `~/.qwen/rc/tokens.json` (0600). Integration tests run the real `DaemonClient` against a hermetic stub daemon (Express SSE) — no monorepo boot needed.

**Tech Stack:** TypeScript (ESM, NodeNext), Express, Node `crypto`, vitest, `@qwen-code/sdk`.

---

## File Structure

```
packages/rc-gateway/
  package.json                     # @qwen-code/rc-gateway, bin qwen-rc, deps express + @qwen-code/sdk
  tsconfig.json
  vitest.config.ts
  src/
    scopes.ts                      # SESSION_READ constant + RcScope type
    types.ts                       # Express Request augmentation (req.rcClient)
    tokenStore.ts                  # issue/resolve, sha256+timingSafe, JSON 0600 persistence
    tokenStore.test.ts
    pairing.ts                     # PairingService: mint/redeem, TTL, single-use
    pairing.test.ts
    auth.ts                        # bearerResolve + requireScope middleware
    auth.test.ts
    routes/
      pair.ts                      # POST /rc/pair/redeem
      sessionEvents.ts             # GET /rc/session/:id/events (SSE relay)
    server.ts                      # createGatewayApp(deps)
    server.test.ts                 # integration: redeem -> events, 401/403/400/502, Last-Event-ID, disconnect
    testing/stubDaemon.ts          # test-only Express SSE stub daemon
    daemonSupervisor.ts            # spawn qwen serve, health poll, build DaemonClient, stop()
    daemonSupervisor.test.ts       # orchestration via injected spawner + stub health server
    cli.ts                         # qwen-rc serve entrypoint (wiring + console output)
```

---

## Task 0: Package skeleton + toolchain smoke test

**Files:**

- Create: `packages/rc-gateway/package.json`
- Create: `packages/rc-gateway/tsconfig.json`
- Create: `packages/rc-gateway/vitest.config.ts`
- Create: `packages/rc-gateway/src/scopes.ts`
- Create: `packages/rc-gateway/src/scopes.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@qwen-code/rc-gateway",
  "version": "0.17.1",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "qwen-rc": "dist/cli.js" },
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:ci": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src"
  },
  "dependencies": {
    "@qwen-code/sdk": "*",
    "express": "^4.21.2"
  },
  "devDependencies": {
    "@types/express": "^4.17.21"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/testing/**"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `src/scopes.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** A remote-control capability scope. Flat set for the walking skeleton. */
export type RcScope = string;

/** The only scope exercised this cycle: read a session's event stream. */
export const SESSION_READ: RcScope = 'session:read';
```

- [ ] **Step 5: Create `src/scopes.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { DaemonClient } from '@qwen-code/sdk';
import { SESSION_READ } from './scopes.js';

describe('toolchain smoke', () => {
  it('defines the session:read scope', () => {
    expect(SESSION_READ).toBe('session:read');
  });

  // Proves vitest can resolve the dual CJS/ESM @qwen-code/sdk workspace dep
  // NOW, rather than discovering an interop break four tasks later.
  it('can import DaemonClient from @qwen-code/sdk', () => {
    expect(DaemonClient).toBeTypeOf('function');
  });
});
```

- [ ] **Step 6: Install workspaces and build the SDK dependency**

Run:

```bash
cd /home/evan/projects/qwen-code
npm install
npm run build --workspace @qwen-code/sdk
ls packages/sdk-typescript/dist/index.mjs packages/sdk-typescript/dist/index.cjs packages/sdk-typescript/dist/index.d.ts
```

Expected: install completes and links `@qwen-code/rc-gateway`; the `ls` lists all
three artifacts. If `dist/index.mjs` is missing (the package's publish flow runs
`build && bundle:cli`), also run `npm run build --workspace @qwen-code/sdk &&
npm run --workspace @qwen-code/sdk prepack` or build everything once with
`npm run build:packages`.

- [ ] **Step 7: Run the smoke test**

Run: `npm run test --workspace @qwen-code/rc-gateway`
Expected: PASS (2 tests). If the `@qwen-code/sdk` import fails with
`ERR_MODULE_NOT_FOUND` or a named-export interop error, add to
`vitest.config.ts`: `test: { server: { deps: { inline: ['@qwen-code/sdk'] } } }`
and re-run.

- [ ] **Step 8: Commit**

```bash
git add packages/rc-gateway
git commit -m "feat(rc-gateway): package skeleton + scopes"
```

---

## Task 1: Token store

**Files:**

- Create: `packages/rc-gateway/src/tokenStore.ts`
- Test: `packages/rc-gateway/src/tokenStore.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from './tokenStore.js';
import { SESSION_READ } from './scopes.js';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'rc-tokens-')), 'tokens.json');
}

describe('TokenStore', () => {
  let path: string;
  beforeEach(() => {
    path = freshPath();
  });

  it('issues a token that resolves to its id and scopes', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    expect(token).toMatch(/.{20,}/);
    const resolved = store.resolve(`Bearer ${token}`);
    expect(resolved).toEqual({ id, scopes: [SESSION_READ] });
  });

  it('returns null for an unknown or malformed bearer', async () => {
    const store = await TokenStore.open(path);
    await store.issue([SESSION_READ], 'phone');
    expect(store.resolve('Bearer not-a-real-token')).toBeNull();
    expect(store.resolve('')).toBeNull();
    expect(store.resolve('Basic abc')).toBeNull();
  });

  it('never stores the raw token, only a sha256 hash', async () => {
    const store = await TokenStore.open(path);
    const { token } = await store.issue([SESSION_READ], 'phone');
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain(token);
  });

  it('persists tokens across reopen', async () => {
    const store = await TokenStore.open(path);
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    const reopened = await TokenStore.open(path);
    expect(reopened.resolve(`Bearer ${token}`)).toEqual({
      id,
      scopes: [SESSION_READ],
    });
  });

  it('writes the token file with 0600 permissions', async () => {
    const store = await TokenStore.open(path);
    await store.issue([SESSION_READ], 'phone');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace @qwen-code/rc-gateway -- tokenStore`
Expected: FAIL (`TokenStore` not exported).

- [ ] **Step 3: Implement `tokenStore.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RcScope } from './scopes.js';

interface TokenRecord {
  id: string;
  /** Hex-encoded sha256 of the raw token. The raw token is never stored. */
  tokenHash: string;
  scopes: RcScope[];
  label: string;
  createdAt: number;
}

interface PersistShape {
  tokens: TokenRecord[];
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Parse `Authorization: Bearer <token>` → credential, or null. */
function parseBearer(header: string): string | null {
  const sp = header.indexOf(' ');
  if (sp <= 0) return null;
  if (header.slice(0, sp).toLowerCase() !== 'bearer') return null;
  const cred = header.slice(sp + 1).trim();
  return cred.length > 0 ? cred : null;
}

export class TokenStore {
  private constructor(
    private readonly filePath: string,
    private records: TokenRecord[],
    private nowFn: () => number,
  ) {}

  static async open(
    filePath: string,
    nowFn: () => number = Date.now,
  ): Promise<TokenStore> {
    let records: TokenRecord[] = [];
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      if (Array.isArray(parsed.tokens)) records = parsed.tokens;
    } catch {
      // Missing/corrupt file → start empty. First issue() persists it.
    }
    return new TokenStore(filePath, records, nowFn);
  }

  async issue(
    scopes: RcScope[],
    label: string,
  ): Promise<{ id: string; token: string }> {
    const id = randomBytes(8).toString('hex');
    const token = randomBytes(32).toString('base64url');
    this.records.push({
      id,
      tokenHash: sha256Hex(token),
      scopes: [...scopes],
      label,
      createdAt: this.nowFn(),
    });
    await this.persist();
    return { id, token };
  }

  /** Resolve a raw `Authorization` header value to identity + scopes. */
  resolve(authHeader: string): { id: string; scopes: RcScope[] } | null {
    const cred = parseBearer(authHeader);
    if (!cred) return null;
    const candidate = Buffer.from(sha256Hex(cred), 'hex');
    for (const rec of this.records) {
      const stored = Buffer.from(rec.tokenHash, 'hex');
      if (
        stored.length === candidate.length &&
        timingSafeEqual(stored, candidate)
      ) {
        return { id: rec.id, scopes: [...rec.scopes] };
      }
    }
    return null;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const body: PersistShape = { tokens: this.records };
    await writeFile(this.filePath, JSON.stringify(body, null, 2), {
      mode: 0o600,
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace @qwen-code/rc-gateway -- tokenStore`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/tokenStore.ts packages/rc-gateway/src/tokenStore.test.ts
git commit -m "feat(rc-gateway): persistent scoped token store"
```

---

## Task 2: Pairing service

**Files:**

- Create: `packages/rc-gateway/src/pairing.ts`
- Test: `packages/rc-gateway/src/pairing.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { PairingService } from './pairing.js';
import { SESSION_READ } from './scopes.js';

describe('PairingService', () => {
  it('mints a code that redeems to its grant scopes', () => {
    let now = 1000;
    const svc = new PairingService(() => now);
    const { code, expiresAt } = svc.mint([SESSION_READ]);
    expect(code).toMatch(/.{6,}/);
    expect(expiresAt).toBeGreaterThan(now);
    expect(svc.redeem(code)).toEqual({ grantScopes: [SESSION_READ] });
  });

  it('mints codes with arbitrary grant sets (including empty)', () => {
    const svc = new PairingService(() => 0);
    const { code } = svc.mint([]);
    expect(svc.redeem(code)).toEqual({ grantScopes: [] });
  });

  it('is single-use: a redeemed code cannot be redeemed again', () => {
    const svc = new PairingService(() => 0);
    const { code } = svc.mint([SESSION_READ]);
    expect(svc.redeem(code)).not.toBeNull();
    expect(svc.redeem(code)).toBeNull();
  });

  it('rejects an expired code', () => {
    let now = 0;
    const svc = new PairingService(() => now);
    const { code, expiresAt } = svc.mint([SESSION_READ]);
    now = expiresAt + 1;
    expect(svc.redeem(code)).toBeNull();
  });

  it('rejects an unknown code', () => {
    const svc = new PairingService(() => 0);
    expect(svc.redeem('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace @qwen-code/rc-gateway -- pairing`
Expected: FAIL (`PairingService` not exported).

- [ ] **Step 3: Implement `pairing.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { RcScope } from './scopes.js';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface PendingCode {
  grantScopes: RcScope[];
  expiresAt: number;
}

/** In-memory, single-use, short-lived pairing codes. */
export class PairingService {
  private pending = new Map<string, PendingCode>();

  constructor(
    private readonly nowFn: () => number = Date.now,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
  ) {}

  mint(grantScopes: RcScope[]): { code: string; expiresAt: number } {
    const code = randomBytes(6).toString('base64url');
    const expiresAt = this.nowFn() + this.ttlMs;
    this.pending.set(code, { grantScopes: [...grantScopes], expiresAt });
    return { code, expiresAt };
  }

  /** Validate + consume a code. Returns its grant scopes or null. */
  redeem(code: string): { grantScopes: RcScope[] } | null {
    const entry = this.pending.get(code);
    if (!entry) return null;
    // Single-use regardless of outcome: remove before validating expiry.
    this.pending.delete(code);
    if (this.nowFn() > entry.expiresAt) return null;
    return { grantScopes: entry.grantScopes };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace @qwen-code/rc-gateway -- pairing`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/pairing.ts packages/rc-gateway/src/pairing.test.ts
git commit -m "feat(rc-gateway): single-use pairing codes"
```

---

## Task 3: Auth + scope middleware

**Files:**

- Create: `packages/rc-gateway/src/types.ts`
- Create: `packages/rc-gateway/src/auth.ts`
- Test: `packages/rc-gateway/src/auth.test.ts`

- [ ] **Step 1: Create `src/types.ts` (Express Request augmentation)**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RcScope } from './scopes.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `bearerResolve` once a token is validated. */
      rcClient?: { id: string; scopes: RcScope[] };
    }
  }
}

export {};
```

- [ ] **Step 2: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { TokenStore } from './tokenStore.js';
import { bearerResolve, requireScope } from './auth.js';
import { SESSION_READ } from './scopes.js';

function fakeRes(): Response & { _status: number; _json: unknown } {
  const res = {
    _status: 200,
    _json: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: unknown) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: unknown };
}

describe('auth middleware', () => {
  let store: TokenStore;
  beforeEach(async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rc-auth-')), 'tokens.json');
    store = await TokenStore.open(path);
  });

  it('bearerResolve attaches rcClient for a valid token', async () => {
    const { id, token } = await store.issue([SESSION_READ], 'phone');
    const req = { headers: { authorization: `Bearer ${token}` } } as Request;
    const res = fakeRes();
    let called = false;
    bearerResolve(store)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(req.rcClient).toEqual({ id, scopes: [SESSION_READ] });
  });

  it('bearerResolve 401s a missing/invalid token', () => {
    const req = { headers: {} } as Request;
    const res = fakeRes();
    let called = false;
    bearerResolve(store)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(401);
    expect(res._json).toMatchObject({ code: 'unauthorized' });
  });

  it('requireScope passes when the scope is present', () => {
    const req = { rcClient: { id: 'x', scopes: [SESSION_READ] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('requireScope 403s when the scope is absent', () => {
    const req = { rcClient: { id: 'x', scopes: [] } } as Request;
    const res = fakeRes();
    let called = false;
    requireScope(SESSION_READ)(req, res, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(res._status).toBe(403);
    expect(res._json).toMatchObject({ code: 'insufficient_scope' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run test --workspace @qwen-code/rc-gateway -- auth`
Expected: FAIL (`bearerResolve` not exported).

- [ ] **Step 4: Implement `auth.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { TokenStore } from './tokenStore.js';
import type { RcScope } from './scopes.js';
import './types.js';

/** Resolve the bearer token to `req.rcClient`, or 401. */
export function bearerResolve(store: TokenStore): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const resolved = store.resolve(header);
    if (!resolved) {
      res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
      return;
    }
    req.rcClient = resolved;
    next();
  };
}

/** Require a scope on the resolved client, or 403. */
export function requireScope(scope: RcScope): RequestHandler {
  return (req, res, next) => {
    if (!req.rcClient || !req.rcClient.scopes.includes(scope)) {
      res
        .status(403)
        .json({ error: 'Insufficient scope', code: 'insufficient_scope' });
      return;
    }
    next();
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test --workspace @qwen-code/rc-gateway -- auth`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/rc-gateway/src/types.ts packages/rc-gateway/src/auth.ts packages/rc-gateway/src/auth.test.ts
git commit -m "feat(rc-gateway): bearer-resolve + require-scope middleware"
```

---

## Task 4: Stub daemon (test helper)

**Files:**

- Create: `packages/rc-gateway/src/testing/stubDaemon.ts`

This is a test-only helper used by Tasks 5–6. It records the `Last-Event-ID`
header it received and streams a fixed set of SSE frames shaped like the real
daemon's (`id:` line + `data:` JSON envelope).

- [ ] **Step 1: Implement `testing/stubDaemon.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export interface StubDaemon {
  baseUrl: string;
  /** Last-Event-ID header value seen on the most recent /events request. */
  lastEventIdHeader: string | undefined;
  close: () => Promise<void>;
}

export interface StubDaemonOptions {
  /** Frames to emit on /session/:id/events, as {id, type, data}. */
  frames?: Array<{ id: number; type: string; data: unknown }>;
  /** When set, /events responds with this status instead of streaming. */
  eventsStatus?: number;
}

/** Start a minimal daemon-shaped SSE server on an ephemeral loopback port. */
export async function startStubDaemon(
  opts: StubDaemonOptions = {},
): Promise<StubDaemon> {
  const frames = opts.frames ?? [
    { id: 1, type: 'session_update', data: { text: 'one' } },
    { id: 2, type: 'session_update', data: { text: 'two' } },
  ];
  const state = { lastEventIdHeader: undefined as string | undefined };
  const app = express();

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.get('/session/:id/events', (req, res) => {
    state.lastEventIdHeader = req.headers['last-event-id'] as
      | string
      | undefined;
    if (opts.eventsStatus && opts.eventsStatus !== 200) {
      res.status(opts.eventsStatus).json({ error: 'stub error' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const f of frames) {
      // IMPORTANT: the SDK's parseSseStream reads the event id from INSIDE
      // the data JSON envelope (`parsed.id`, required to be an integer >= 1),
      // and ignores the SSE `id:` line. So the id MUST live in the JSON. We
      // also emit the `id:` line to mirror real SSE framing (harmless; the
      // DaemonClient ignores it, but downstream EventSource clients use it).
      res.write(`id: ${f.id}\n`);
      res.write(
        `data: ${JSON.stringify({ v: 1, id: f.id, type: f.type, data: f.data })}\n\n`,
      );
    }
    res.end();
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    get lastEventIdHeader() {
      return state.lastEventIdHeader;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/rc-gateway/src/testing/stubDaemon.ts
git commit -m "test(rc-gateway): daemon-shaped SSE stub helper"
```

---

## Task 5: Session-events proxy route

**Files:**

- Create: `packages/rc-gateway/src/routes/sessionEvents.ts`
- Test: `packages/rc-gateway/src/routes/sessionEvents.test.ts`

The route relays `daemonClient.subscribeEvents` frames downstream as SSE,
preserving event ids, forwarding `Last-Event-ID`, and aborting upstream on
client disconnect.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from '../testing/stubDaemon.js';
import { createSessionEventsRoute } from './sessionEvents.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function mountGateway(daemon: DaemonClient): Promise<string> {
  const app = express();
  app.get('/rc/session/:id/events', createSessionEventsRoute(daemon));
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** Read an SSE response body into discrete {id, data} frames. */
async function readFrames(
  res: Response,
): Promise<Array<{ id?: string; data: string }>> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.includes('data:'))
    .map((block) => {
      const lines = block.split('\n');
      const id = lines
        .find((l) => l.startsWith('id:'))
        ?.slice(3)
        .trim();
      const data = lines
        .find((l) => l.startsWith('data:'))!
        .slice(5)
        .trim();
      return { id, data };
    });
}

describe('session-events proxy', () => {
  it('relays daemon frames downstream preserving ids', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/rc/session/sess-1/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readFrames(res);
    expect(frames.map((f) => f.id)).toEqual(['1', '2']);
    expect(frames[0].data).toContain('"text":"one"');
  });

  it('forwards Last-Event-ID upstream to the daemon', async () => {
    stub = await startStubDaemon();
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { 'Last-Event-ID': '5' },
    });
    expect(stub.lastEventIdHeader).toBe('5');
  });

  it('returns 502 when the daemon errors', async () => {
    stub = await startStubDaemon({ eventsStatus: 500 });
    const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
    const url = await mountGateway(daemon);
    const res = await fetch(`${url}/rc/session/sess-1/events`);
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace @qwen-code/rc-gateway -- sessionEvents`
Expected: FAIL (`createSessionEventsRoute` not exported).

- [ ] **Step 3: Implement `routes/sessionEvents.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { DaemonClient } from '@qwen-code/sdk';

/**
 * GET /rc/session/:id/events — relay the daemon's SSE stream downstream,
 * preserving event ids and forwarding Last-Event-ID. Aborts the upstream
 * subscription when the client disconnects.
 */
export function createSessionEventsRoute(daemon: DaemonClient): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const lastEventIdRaw = req.headers['last-event-id'];
    const lastEventId =
      typeof lastEventIdRaw === 'string' && lastEventIdRaw.length > 0
        ? Number(lastEventIdRaw)
        : undefined;

    const abort = new AbortController();
    req.on('close', () => abort.abort());

    let iterator;
    try {
      iterator = daemon.subscribeEvents(sessionId, {
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
    } catch (err) {
      if (abort.signal.aborted) {
        // Client went away mid-stream; nothing to send.
        res.end();
        return;
      }
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Daemon unavailable',
          code: 'daemon_unavailable',
        });
      } else {
        res.end();
      }
    }
  };
}

function writeFrame(
  res: import('express').Response,
  ev: { id?: number; type?: string; data?: unknown },
): void {
  if (ev.id !== undefined) res.write(`id: ${ev.id}\n`);
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace @qwen-code/rc-gateway -- sessionEvents`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/routes/sessionEvents.ts packages/rc-gateway/src/routes/sessionEvents.test.ts
git commit -m "feat(rc-gateway): SSE proxy route with Last-Event-ID + 502 mapping"
```

---

## Task 6: Pair-redeem route + gateway app assembly

**Files:**

- Create: `packages/rc-gateway/src/routes/pair.ts`
- Create: `packages/rc-gateway/src/server.ts`
- Test: `packages/rc-gateway/src/server.test.ts`

- [ ] **Step 1: Implement `routes/pair.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type { PairingService } from '../pairing.js';
import type { TokenStore } from '../tokenStore.js';

/** POST /rc/pair/redeem { code, label } → { id, token, scopes }. */
export function createPairRedeemRoute(
  pairing: PairingService,
  store: TokenStore,
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
    res.status(200).json({ id, token, scopes: grant.grantScopes });
  };
}
```

- [ ] **Step 2: Implement `server.ts`**

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
import { SESSION_READ } from './scopes.js';
import { createPairRedeemRoute } from './routes/pair.js';
import { createSessionEventsRoute } from './routes/sessionEvents.js';

export interface GatewayDeps {
  daemon: DaemonClient;
  store: TokenStore;
  pairing: PairingService;
}

export function createGatewayApp(deps: GatewayDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/rc/health', (_req, res) => res.json({ status: 'ok' }));

  // Pairing redemption is gated by the code itself, not a bearer token.
  app.post('/rc/pair/redeem', createPairRedeemRoute(deps.pairing, deps.store));

  // Everything below requires a resolved client identity.
  app.use(bearerResolve(deps.store));
  app.get(
    '/rc/session/:id/events',
    requireScope(SESSION_READ),
    createSessionEventsRoute(deps.daemon),
  );

  return app;
}
```

- [ ] **Step 3: Write failing integration tests**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DaemonClient } from '@qwen-code/sdk';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { createGatewayApp } from './server.js';
import { SESSION_READ } from './scopes.js';

let gateway: Server | undefined;
let stub: StubDaemon | undefined;

afterEach(async () => {
  if (gateway) await new Promise<void>((r) => gateway!.close(() => r()));
  if (stub) await stub.close();
  gateway = undefined;
  stub = undefined;
});

async function boot(): Promise<{
  url: string;
  pairing: PairingService;
  store: TokenStore;
}> {
  stub = await startStubDaemon();
  const daemon = new DaemonClient({ baseUrl: stub.baseUrl });
  const path = join(mkdtempSync(join(tmpdir(), 'rc-srv-')), 'tokens.json');
  const store = await TokenStore.open(path);
  const pairing = new PairingService();
  const app = createGatewayApp({ daemon, store, pairing });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  gateway = server;
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, pairing, store };
}

describe('gateway app', () => {
  it('happy path: redeem a code then stream events', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([SESSION_READ]);
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'phone' }),
    });
    expect(redeem.status).toBe(200);
    const { token, scopes } = (await redeem.json()) as {
      token: string;
      scopes: string[];
    };
    expect(scopes).toEqual([SESSION_READ]);

    const events = await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(events.status).toBe(200);
    const text = await events.text();
    expect(text).toContain('"text":"one"');
  });

  it('rejects an invalid pairing code with 400', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bogus', label: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('401s the events route without a token', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/rc/session/sess-1/events`);
    expect(res.status).toBe(401);
  });

  it('403s when the token lacks session:read', async () => {
    const { url, pairing } = await boot();
    const { code } = pairing.mint([]); // grant no scopes
    const redeem = await fetch(`${url}/rc/pair/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, label: 'weak' }),
    });
    const { token } = (await redeem.json()) as { token: string };
    const res = await fetch(`${url}/rc/session/sess-1/events`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 4: Run tests to verify they fail, then pass**

Run: `npm run test --workspace @qwen-code/rc-gateway -- server`
Expected first: FAIL (modules not yet wired) — after Steps 1–2 they should PASS (4 tests). If a test fails, fix the implementation, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/routes/pair.ts packages/rc-gateway/src/server.ts packages/rc-gateway/src/server.test.ts
git commit -m "feat(rc-gateway): pair-redeem route + gateway app assembly"
```

---

## Task 7: Daemon supervisor

**Files:**

- Create: `packages/rc-gateway/src/daemonSupervisor.ts`
- Test: `packages/rc-gateway/src/daemonSupervisor.test.ts`

The supervisor spawns `qwen serve` on loopback with a generated token (via
`QWEN_SERVER_TOKEN` env), waits for `/health`, and returns a ready
`DaemonClient` + `stop()`. The spawner is injected so the orchestration can be
tested against the stub daemon without launching the real CLI.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { startStubDaemon, type StubDaemon } from './testing/stubDaemon.js';
import { startDaemon } from './daemonSupervisor.js';

let stub: StubDaemon | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe('daemonSupervisor', () => {
  it('waits for health then returns a usable DaemonClient', async () => {
    stub = await startStubDaemon();
    const stubUrl = stub.baseUrl;
    let killed = false;
    const handle = await startDaemon({
      // Injected spawner: ignore the real CLI, point at the stub.
      spawner: () => ({
        baseUrl: stubUrl,
        token: undefined,
        kill: () => {
          killed = true;
        },
      }),
    });
    const health = await handle.daemon.health();
    expect(health.status).toBe('ok');
    await handle.stop();
    expect(killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace @qwen-code/rc-gateway -- daemonSupervisor`
Expected: FAIL (`startDaemon` not exported).

- [ ] **Step 3: Implement `daemonSupervisor.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DaemonClient } from '@qwen-code/sdk';

export interface SpawnedDaemon {
  baseUrl: string;
  token: string | undefined;
  kill: () => void;
}

export interface StartDaemonOptions {
  /** qwen binary to launch; defaults to "qwen" on PATH. */
  qwenBin?: string;
  /** Loopback port for the daemon; 0 = ephemeral (default). */
  port?: number;
  /** Override how the daemon process is launched (tests inject a stub). */
  spawner?: (token: string) => SpawnedDaemon;
  /** Health-poll budget in ms (default 10000). */
  readyTimeoutMs?: number;
}

export interface DaemonHandle {
  daemon: DaemonClient;
  stop: () => Promise<void>;
}

/** Default spawner: launch `qwen serve` on loopback with QWEN_SERVER_TOKEN. */
function defaultSpawner(
  token: string,
  qwenBin: string,
  port: number,
): SpawnedDaemon {
  const child = spawn(
    qwenBin,
    ['serve', '--host', '127.0.0.1', '--port', String(port), '--require-auth'],
    { env: { ...process.env, QWEN_SERVER_TOKEN: token }, stdio: 'inherit' },
  );
  // NOTE: with ephemeral port 0 the real daemon prints its chosen port;
  // wiring that read-back is a follow-on. For now require an explicit
  // non-zero port in production launches.
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    kill: () => child.kill('SIGTERM'),
  };
}

export async function startDaemon(
  opts: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const token = randomBytes(32).toString('base64url');
  const port = opts.port ?? 0;
  const spawned = opts.spawner
    ? opts.spawner(token)
    : defaultSpawner(token, opts.qwenBin ?? 'qwen', port);

  const daemon = new DaemonClient({
    baseUrl: spawned.baseUrl,
    token: spawned.token,
  });

  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10000);
  // Poll health until ready or timeout.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await daemon.health();
      break;
    } catch {
      if (Date.now() > deadline) {
        spawned.kill();
        throw new Error('Daemon did not become healthy before timeout');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    daemon,
    stop: async () => {
      spawned.kill();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace @qwen-code/rc-gateway -- daemonSupervisor`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/daemonSupervisor.ts packages/rc-gateway/src/daemonSupervisor.test.ts
git commit -m "feat(rc-gateway): daemon supervisor with injectable spawner"
```

---

## Task 8: CLI entrypoint (`qwen-rc serve`)

**Files:**

- Create: `packages/rc-gateway/src/cli.ts`

This is thin wiring + console output; correctness is proven by the manual e2e
check below rather than a unit test.

- [ ] **Step 1: Implement `cli.ts`**

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from './daemonSupervisor.js';
import { TokenStore } from './tokenStore.js';
import { PairingService } from './pairing.js';
import { createGatewayApp } from './server.js';
import { SESSION_READ } from './scopes.js';

export interface ServeOptions {
  gatewayPort?: number;
  daemonPort?: number;
}

/** Boot the daemon + gateway and print the owner pairing code. */
export async function runServe(opts: ServeOptions = {}): Promise<void> {
  const handle = await startDaemon({ port: opts.daemonPort ?? 4180 });
  const store = await TokenStore.open(
    join(homedir(), '.qwen', 'rc', 'tokens.json'),
  );
  const pairing = new PairingService();
  const app = createGatewayApp({ daemon: handle.daemon, store, pairing });

  const port = opts.gatewayPort ?? 4170;
  app.listen(port, '127.0.0.1', () => {
    const { code, expiresAt } = pairing.mint([SESSION_READ]);
    // eslint-disable-next-line no-console
    console.log(
      [
        `qwen-rc gateway listening on http://127.0.0.1:${port}`,
        `owner pairing code: ${code}`,
        `  (expires ${new Date(expiresAt).toISOString()}, grants [${SESSION_READ}])`,
        `redeem: POST /rc/pair/redeem { "code": "${code}", "label": "<name>" }`,
      ].join('\n'),
    );
  });

  const shutdown = async () => {
    await handle.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Entrypoint: `qwen-rc serve`
if (process.argv[2] === 'serve') {
  runServe().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('qwen-rc serve failed:', err);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Typecheck, lint, and build**

Run:

```bash
npm run typecheck --workspace @qwen-code/rc-gateway
npm run lint --workspace @qwen-code/rc-gateway
npm run build --workspace @qwen-code/rc-gateway
```

Expected: no type errors; lint clean (the repo enforces the
`/** @license ... Copyright 2025 Qwen Team ... */` header via `eslint-rules/` —
every `src/*.ts` file in this plan already carries it; if lint flags a missing/
mismatched header, copy the exact block from `packages/cli/src/serve/auth.ts`);
`packages/rc-gateway/dist/cli.js` exists.

- [ ] **Step 3: Run the full package test suite**

Run: `npm run test --workspace @qwen-code/rc-gateway`
Expected: PASS (all tests across tokenStore, pairing, auth, sessionEvents, server, daemonSupervisor).

- [ ] **Step 4: Manual e2e (optional, not gating)**

Run (from a built monorepo where `qwen` is available):

```bash
node packages/rc-gateway/dist/cli.js serve
```

Then in another shell, redeem the printed code and attach to a session's events
through the gateway. Confirms the real `qwen serve` proxies end-to-end.

- [ ] **Step 5: Commit**

```bash
git add packages/rc-gateway/src/cli.ts
git commit -m "feat(rc-gateway): qwen-rc serve entrypoint"
```

---

## Self-Review

**Spec coverage** (design doc §"Components" / §"Testing strategy"):

- daemonSupervisor → Task 7. tokenStore → Task 1. pairing → Task 2. auth/requireScope → Task 3. sessionEvents proxy → Task 5. pair redeem route → Task 6. server/createGatewayApp → Task 6. cli `qwen-rc` → Task 8. Stub daemon + integration tests → Tasks 4–6. All listed components have a task. ✓
- Error-handling table: 401 (Task 3/6), 403 (Task 3/6), 400 invalid_pairing_code (Task 6), 502 daemon_unavailable (Task 5), client-disconnect abort (Task 5). 404 unknown-session is handled implicitly by the daemon's own error → mapped to 502 by the connect-phase catch; not separately asserted (acceptable for the skeleton — noted as a follow-on refinement). ✓
- Non-goals (revocation, audit, CORS/web client, WAL, fan-out, scope hierarchy) → correctly absent. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code. ✓

**Type/name consistency:** `RcScope`/`SESSION_READ` (scopes.ts) used everywhere; `TokenStore.open`/`issue`/`resolve`, `PairingService.mint`/`redeem`, `bearerResolve`/`requireScope`, `createSessionEventsRoute`, `createPairRedeemRoute`, `createGatewayApp`/`GatewayDeps`, `startDaemon`/`StartDaemonOptions`/`DaemonHandle`/`SpawnedDaemon` consistent across tasks. `req.rcClient` shape matches the `types.ts` augmentation. ✓

**Known pragmatic notes (intentional, not gaps):**

- The default daemon spawner uses an explicit non-zero port (4180); ephemeral-port read-back from the daemon's stdout is a follow-on. Tests bypass this via the injected spawner.
- Integration tests run the real `DaemonClient` against the stub daemon, so they require the SDK build from Task 0 Step 6.
