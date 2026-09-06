# Workspace-Qualified ACP Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six confirmed routing, rate-limit, error, logging, lifecycle, and observability gaps in PR #6621 without redesigning the per-runtime ACP mount architecture.

**Architecture:** Preserve one `mountAcpHttp` call, one WebSocket upgrade listener, one primary mount, and one mount per trusted secondary runtime. Add only the readiness predicates and additive snapshot metadata needed to make the surrounding middleware and daemon diagnostics agree with the transport.

**Tech Stack:** TypeScript, Express 5, `ws`, Vitest, npm workspaces.

## Global Constraints

- Minimum code that solves the problem; no new route-policy module and no replacement of `AcpHttpHandle`.
- Workspace-qualified ACP is ready only when ACP HTTP is enabled and the registry contains more than one runtime.
- Legacy `/acp` behavior and the public primary `AcpHttpHandle.registry` remain compatible.
- The outer limiter charges no qualified ACP request; the ACP method limiter remains the only charge.
- Only Express-marked status-400 `URIError` parameter failures become `400 invalid_request`; unrelated failures remain 500.
- `dispose()` is terminal and idempotent.
- Aggregate connection diagnostics are additive and identify `workspaceId`, `workspaceCwd`, and `primary`.
- Tests run from `packages/cli`, not the repository root.
- Every production change follows a witnessed RED → GREEN cycle.

---

### Task 1: Align qualified-route readiness and rate limiting

**Files:**

- Modify: `packages/cli/src/serve/rate-limit.ts`
- Modify: `packages/cli/src/serve/rate-limit.test.ts`
- Modify: `packages/cli/src/serve/server/rate-limiter-setup.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/acp-http/index.ts`
- Modify: `packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts`

**Interfaces:**

- Consumes: `resolveAcpHttpEnabled()`, `WorkspaceRegistry.list()`, and existing `MountAcpHttpOptions.workspaceRegistry`.
- Produces: `RateLimitConfig.workspaceQualifiedAcpEnabled?: boolean`; `installRateLimiter(..., workspaceQualifiedAcpEnabled?: boolean)`; qualified HTTP/WS paths mounted only when the registry has multiple runtimes.

- [ ] **Step 1: Write failing rate-limit tests**

Add a second limiter inside the `tier resolution` describe so the readiness flag is explicit:

```ts
it('exempts only enabled workspace-qualified ACP transport paths', () => {
  const qualifiedLimiter = createRateLimiter({
    tiers: {
      prompt: { windowMs: 60_000, max: 1 },
      mutation: { windowMs: 60_000, max: 1 },
      read: { windowMs: 60_000, max: 1 },
    },
    hostname: '127.0.0.1',
    workspaceQualifiedAcpEnabled: true,
  });

  for (const path of [
    '/workspaces/secondary-id/acp',
    '/workspaces/secondary-id/acp/',
    '/WORKSPACES/secondary-id/ACP',
  ]) {
    const next = vi.fn();
    qualifiedLimiter.middleware(mockReq({ path }), mockRes(), next);
    qualifiedLimiter.middleware(mockReq({ path }), mockRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  }

  const nearby = '/workspaces/secondary-id/acp/extra';
  qualifiedLimiter.middleware(mockReq({ path: nearby }), mockRes(), vi.fn());
  const res = mockRes();
  qualifiedLimiter.middleware(mockReq({ path: nearby }), res, vi.fn());
  expect(res.body).toMatchObject({ tier: 'mutation' });
  qualifiedLimiter.dispose();
});

it('does not exempt workspace-qualified ACP when the route is disabled', () => {
  const path = '/workspaces/secondary-id/acp';
  limiter.middleware(mockReq({ path }), mockRes(), vi.fn());
  const res = mockRes();
  limiter.middleware(mockReq({ path }), res, vi.fn());
  expect(res.body).toMatchObject({ tier: 'mutation' });
});
```

- [ ] **Step 2: Run the rate-limit test and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/rate-limit.test.ts
```

Expected: TypeScript/test failure because `workspaceQualifiedAcpEnabled` is not a `RateLimitConfig` property, or qualified paths are charged as `mutation`.

- [ ] **Step 3: Write a failing single-workspace transport test**

Add a separately owned server inside the test so the existing multi-workspace fixture stays unchanged:

```ts
it('does not expose qualified HTTP or WS routes with one runtime', async () => {
  const primaryBridge = makeBridge();
  const registry = createWorkspaceRegistry([
    makeRuntime({
      id: 'primary-id',
      cwd: '/ws',
      primary: true,
      trusted: true,
      bridge: primaryBridge,
    }),
  ]);
  const app = express();
  app.use(express.json());
  const singleHandle = mountAcpHttp(app, primaryBridge, {
    boundWorkspace: '/ws',
    workspace: {} as DaemonWorkspaceService,
    enabled: true,
    workspaceRegistry: registry,
    workspaceRememberLane: new WorkspaceRememberTaskLane(primaryBridge),
  })!;
  const singleServer = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  singleHandle.attachServer(singleServer);
  const singlePort = (singleServer.address() as AddressInfo).port;

  try {
    const qualified = await fetch(
      `http://127.0.0.1:${singlePort}/workspaces/primary-id/acp`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: INITIALIZE,
      },
    );
    expect(qualified.status).toBe(404);

    const upgradeStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${singlePort}/workspaces/primary-id/acp`,
      );
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('unexpected-response', (_req, res) => {
        ws.terminate();
        resolve(res.statusCode ?? 0);
      });
      ws.on('error', () => resolve(0));
    });
    expect(upgradeStatus).not.toBe(101);

    const legacy = await fetch(`http://127.0.0.1:${singlePort}/acp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: INITIALIZE,
    });
    expect(legacy.status).toBe(200);
  } finally {
    singleHandle.dispose();
    singleServer.closeAllConnections?.();
    await new Promise<void>((resolve) => singleServer.close(() => resolve()));
  }
});
```

- [ ] **Step 4: Run the workspace-qualified test and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/acp-http/workspace-qualified-acp.test.ts
```

Expected: qualified HTTP returns 200 and/or the qualified WebSocket opens for the single-runtime registry.

- [ ] **Step 5: Implement the minimal readiness and exemption logic**

In `rate-limit.ts`, extend the config and tier resolver:

```ts
export interface RateLimitConfig {
  tiers: Record<RateLimitTier, RateLimitTierConfig>;
  hostname: string;
  workspaceQualifiedAcpEnabled?: boolean;
  // existing callbacks stay unchanged
}

const WORKSPACE_QUALIFIED_ACP_PATH = /^\/workspaces\/[^/]+\/acp$/i;

function resolveTier(
  method: string,
  path: string,
  workspaceQualifiedAcpEnabled: boolean,
): RateLimitTier | null {
  const p = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  // existing exemptions
  if (workspaceQualifiedAcpEnabled && WORKSPACE_QUALIFIED_ACP_PATH.test(p)) {
    return null;
  }
  // existing tier resolution
}
```

Pass `config.workspaceQualifiedAcpEnabled === true` from the middleware call to `resolveTier`.

In `server/rate-limiter-setup.ts`, add the optional fourth argument and forward it:

```ts
export function installRateLimiter(
  app: Application,
  opts: ServeOptions,
  daemonLog: DaemonLogger | undefined,
  workspaceQualifiedAcpEnabled = false,
): RateLimiterInstance | undefined {
  if (!opts.rateLimit) return undefined;
  const windowMs = opts.rateLimitWindowMs ?? 60_000;
  const rateLimiter = createRateLimiter({
    tiers: {
      prompt: { windowMs, max: opts.rateLimitPrompt ?? 10 },
      mutation: { windowMs, max: opts.rateLimitMutation ?? 30 },
      read: { windowMs, max: opts.rateLimitRead ?? 120 },
    },
    hostname: opts.hostname,
    workspaceQualifiedAcpEnabled,
    onLimitReached: daemonLog
      ? (tier, key, suppressed) => {
          daemonLog.warn(
            `rate limit hit${suppressed > 0 ? ` (${suppressed} suppressed)` : ''}`,
            { tier, key: key.slice(0, 64) },
          );
        }
      : undefined,
    onError: daemonLog
      ? (err, path) => {
          daemonLog.warn(
            `rate limiter error (fail-open): ${err instanceof Error ? err.message : String(err)}`,
            { path },
          );
        }
      : undefined,
  });
  app.use(rateLimiter.middleware);
  return rateLimiter;
}
```

In `server.ts`, after `workspaceRegistry` is created, compute and pass:

```ts
const workspaceQualifiedAcpEnabled =
  resolveAcpHttpEnabled() && workspaceRegistry.list().length > 1;

const rateLimiter = installRateLimiter(
  app,
  opts,
  daemonLog,
  workspaceQualifiedAcpEnabled,
);
```

In `mountAcpHttp`, the function has already returned when ACP HTTP is disabled, so gate only on runtime count:

```ts
const workspaceQualifiedAcpEnabled =
  (opts.workspaceRegistry?.list().length ?? 0) > 1;

if (workspaceQualifiedAcpEnabled) {
  app.post(pluralAcpPath /* existing handler */);
  app.get(pluralAcpPath /* existing handler */);
  app.delete(pluralAcpPath /* existing handler */);
}

const pluralRawSelector = workspaceQualifiedAcpEnabled
  ? pluralAcpRawSelector(rawPath)
  : null;
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
cd packages/cli && npx vitest run src/serve/rate-limit.test.ts src/serve/acp-http/workspace-qualified-acp.test.ts src/serve/server.test.ts
```

Expected: all files pass; legacy `/acp` remains green.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/serve/rate-limit.ts packages/cli/src/serve/rate-limit.test.ts packages/cli/src/serve/server/rate-limiter-setup.ts packages/cli/src/serve/server.ts packages/cli/src/serve/acp-http/index.ts packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts
git commit -m "fix(cli): align workspace-qualified ACP routing"
```

Include `Co-authored-by: Qwen-Coder <qwen-coder@alibabacloud.com>` in the commit body.

### Task 2: Normalize malformed selectors and rejection logs

**Files:**

- Modify: `packages/cli/src/serve/server/error-handlers.ts`
- Create: `packages/cli/src/serve/server/error-handlers.test.ts`
- Modify: `packages/cli/src/serve/acp-http/index.ts`
- Modify: `packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts`

**Interfaces:**

- Consumes: Express router errors with `status` or `statusCode`, and existing `logSafe()`.
- Produces: structured `{ error: 'Malformed URL encoding', code: 'invalid_request' }`; log-safe selector interpolation.

- [ ] **Step 1: Write failing malformed-selector and log-safety tests**

Add a production-shaped Express parameter-decoding test:

```ts
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { installFinalErrorHandler } from './error-handlers.js';

describe('installFinalErrorHandler', () => {
  it('returns 400 invalid_request for malformed route parameter encoding', async () => {
    const app = express();
    app.get('/workspaces/:workspace/acp', (_req, res) => res.sendStatus(204));
    installFinalErrorHandler(app);

    const res = await request(app).get('/workspaces/%ZZ/acp');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Malformed URL encoding',
      code: 'invalid_request',
    });
  });
});
```

Import the mocked `writeStderrLine` in `workspace-qualified-acp.test.ts` and add:

```ts
it('sanitizes decoded selectors before logging WS rejection', async () => {
  vi.mocked(writeStderrLine).mockClear();
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/workspaces/evil%0AFORGED/acp`,
      { handshakeTimeout: 2000 },
    );
    ws.on('unexpected-response', () => {
      ws.terminate();
      resolve();
    });
    ws.on('open', () => {
      ws.close();
      reject(new Error('unknown workspace selector should not upgrade'));
    });
    ws.on('error', () => resolve());
  });

  expect(writeStderrLine).toHaveBeenCalledWith(
    expect.stringContaining('workspace-mismatch evil FORGED'),
  );
  for (const [message] of vi.mocked(writeStderrLine).mock.calls) {
    expect(message).not.toMatch(/[\r\n\u001b]/u);
  }
});
```

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/server/error-handlers.test.ts src/serve/acp-http/workspace-qualified-acp.test.ts
```

Expected: malformed path returns 500; logged selector contains a newline.

- [ ] **Step 3: Implement narrow error mapping and log sanitization**

In `error-handlers.ts`:

```ts
function isMalformedRouteEncoding(err: unknown): boolean {
  if (!(err instanceof URIError)) return false;
  const status = (err as { status?: unknown; statusCode?: unknown }).status;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return status === 400 || statusCode === 400;
}

export function installFinalErrorHandler(app: Application): void {
  app.use((err: unknown, _req, res, _next) => {
    if (sendJsonBodyParserError(res, err)) return;
    if (isMalformedRouteEncoding(err)) {
      res.status(400).json({
        error: 'Malformed URL encoding',
        code: 'invalid_request',
      });
      return;
    }
    // existing generic path
  });
}
```

In the WS mismatch log:

```ts
logReject(`workspace-mismatch ${logSafe(selector)}`);
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same command as Step 2. Expected: both files pass and unrelated generic-error assertions remain 500.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/server/error-handlers.ts packages/cli/src/serve/server/error-handlers.test.ts packages/cli/src/serve/acp-http/index.ts packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts
git commit -m "fix(cli): harden qualified ACP request errors"
```

Include the required co-author trailer.

### Task 3: Make ACP disposal terminal

**Files:**

- Modify: `packages/cli/src/serve/acp-http/index.ts`
- Modify: `packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts`

**Interfaces:**

- Consumes: existing closure-scoped `disposed` latch.
- Produces: `attachServer()` becomes a no-op after disposal.

- [ ] **Step 1: Write the failing lifecycle test**

```ts
it('does not reattach a WebSocket listener after disposal', () => {
  handle!.dispose();
  const listenerCount = server.listenerCount('upgrade');

  handle!.attachServer(server);

  expect(server.listenerCount('upgrade')).toBe(listenerCount);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/acp-http/workspace-qualified-acp.test.ts
```

Expected: listener count increases after `attachServer()`.

- [ ] **Step 3: Implement the terminal guard**

```ts
function setupWebSocket(httpServer: import('node:http').Server): void {
  if (disposed || wss) return;
  // existing setup
}
```

Do not add a second state variable or throw from `attachServer()`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same command as Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/acp-http/index.ts packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts
git commit -m "fix(cli): make ACP disposal terminal"
```

Include the required co-author trailer.

### Task 4: Aggregate workspace-attributed ACP diagnostics

**Files:**

- Modify: `packages/cli/src/serve/acp-http/index.ts`
- Modify: `packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts`
- Modify: `packages/cli/src/serve/daemon-status.ts`
- Modify: `packages/cli/src/serve/daemon-status.test.ts`

**Interfaces:**

- Consumes: `AcpConnectionDiagnostic`, `ConnectionRegistry.getSnapshot()`, and per-runtime workspace metadata.
- Produces: `AcpHttpConnectionDiagnostic`; `AcpHttpSnapshot.connections`; full daemon status sourced from the aggregate snapshot.

- [ ] **Step 1: Write failing aggregate snapshot and full-status tests**

After initializing a secondary HTTP connection, assert:

```ts
const snap = handle!.getSnapshot();
expect(snap.connections).toEqual([
  expect.objectContaining({
    workspaceId: 'secondary-id',
    workspaceCwd: '/ws-b',
    primary: false,
  }),
]);
```

In `daemon-status.test.ts`, supply an aggregate with decorated primary and secondary diagnostics and assert:

```ts
import type {
  AcpHttpConnectionDiagnostic,
  AcpHttpHandle,
  AcpHttpSnapshot,
} from './acp-http/index.js';

// Add this property to the existing MakeOptionsInput declaration.
acpAggregate?: AcpHttpSnapshot;

function makeAcpDiagnostic(
  workspaceId: string | null,
  workspaceCwd: string,
  primary: boolean,
): AcpHttpConnectionDiagnostic {
  return {
    connectionIdPrefix: primary ? 'primary' : 'secondary',
    fromLoopback: true,
    destroyed: false,
    lastActiveMs: 0,
    ownedSessionCount: 0,
    sessionBindingCount: 0,
    closingSessionCount: 0,
    pendingClientRequests: 0,
    connectionStreamOpen: true,
    sessionStreams: 0,
    sseStreams: 0,
    wsStreams: 1,
    bufferedConnectionFrames: 0,
    bufferedSessionFrames: 0,
    workspaceId,
    workspaceCwd,
    primary,
  };
}

const primaryDiagnostic = makeAcpDiagnostic(null, BASE_WORKSPACE, true);
const secondaryDiagnostic = makeAcpDiagnostic(
  'secondary-id',
  '/work/secondary',
  false,
);
const primaryRegistrySnapshot = {
  connectionCount: 1,
  connectionCap: 10,
  connectionStreams: 1,
  sessionStreams: 0,
  sseStreams: 0,
  wsStreams: 1,
  pendingClientRequests: 0,
  connections: [primaryDiagnostic],
};

const response = await buildDaemonStatusResponse(
  'full',
  makeOptions({
    acpSnapshot: primaryRegistrySnapshot,
    acpAggregate: {
      connectionCount: 2,
      connectionStreams: 2,
      sessionStreams: 0,
      sseStreams: 0,
      wsStreams: 2,
      pendingClientRequests: 0,
      mounts: [],
      connections: [primaryDiagnostic, secondaryDiagnostic],
    },
  }),
);

expect(response.runtime.transport.acp.connections).toBe(2);
expect(response.full?.acpConnections).toEqual([
  primaryDiagnostic,
  secondaryDiagnostic,
]);
```

Update `makeOptions()` so the mocked handle returns `input.acpAggregate` when
provided, otherwise it builds the existing one-mount aggregate and includes an
empty `connections` array:

```ts
getSnapshot: () =>
  input.acpAggregate ?? {
    connectionCount: input.acpSnapshot!.connectionCount,
    connectionStreams: input.acpSnapshot!.connectionStreams,
    sessionStreams: input.acpSnapshot!.sessionStreams,
    sseStreams: input.acpSnapshot!.sseStreams,
    wsStreams: input.acpSnapshot!.wsStreams,
    pendingClientRequests: input.acpSnapshot!.pendingClientRequests,
    mounts: [
      {
        workspaceId: null,
        primary: true,
        connectionCount: input.acpSnapshot!.connectionCount,
        wsStreams: input.acpSnapshot!.wsStreams,
      },
    ],
    connections: [],
  },
```

- [ ] **Step 2: Run both tests and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/acp-http/workspace-qualified-acp.test.ts src/serve/daemon-status.test.ts
```

Expected: `AcpHttpSnapshot` has no `connections`, and full status still returns the primary snapshot list.

- [ ] **Step 3: Implement additive diagnostics**

Import the diagnostic type and extend the aggregate contracts:

```ts
import {
  ConnectionRegistry,
  type AcpConnection,
  type AcpConnectionDiagnostic,
} from './connection-registry.js';

export interface AcpHttpConnectionDiagnostic extends AcpConnectionDiagnostic {
  workspaceId: string | null;
  workspaceCwd: string;
  primary: boolean;
}

export interface AcpHttpSnapshot {
  // existing counters
  mounts: AcpHttpMountSnapshot[];
  connections: AcpHttpConnectionDiagnostic[];
}
```

Add `workspaceCwd` to `RuntimeAcpMount`, set it on primary and secondary mounts, and decorate each registry diagnostic in `getSnapshot()`:

```ts
connections: perMount.flatMap((mount) =>
  mount.snap.connections.map((connection) => ({
    ...connection,
    workspaceId: mount.workspaceId,
    workspaceCwd: mount.workspaceCwd,
    primary: mount.primary,
  })),
),
```

In `daemon-status.ts`, define full diagnostics from `AcpHttpSnapshot` and pass the aggregate:

```ts
interface FullDaemonStatus {
  sessions: BridgeDaemonStatusSnapshot['sessions'];
  acpConnections: AcpHttpSnapshot['connections'];
  workspace: Record<string, WorkspaceStatusSection>;
  auth: {
    supportedDeviceFlowProviders: string[];
    pendingDeviceFlowCount: number;
  };
}

if (detail === 'full') {
  full = await buildFullStatus(
    input,
    acpAggregate,
    workspaceSnapshots.flatMap((item) => item.snapshot.sessions),
  );
}

// Change the second buildFullStatus parameter type.
acpSnapshot: AcpHttpSnapshot | undefined;

// Change the existing returned property; keep all section collectors intact.
acpConnections: acpSnapshot?.connections ?? [];
```

Keep `limits.acpConnectionCap` sourced from the primary registry because it is the uniform per-mount cap.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same command as Step 2. Expected: all tests pass and both diagnostics are present.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/acp-http/index.ts packages/cli/src/serve/acp-http/workspace-qualified-acp.test.ts packages/cli/src/serve/daemon-status.ts packages/cli/src/serve/daemon-status.test.ts
git commit -m "fix(cli): aggregate ACP connection diagnostics"
```

Include the required co-author trailer.

### Task 5: Final verification and broad audit

**Files:**

- Review: every file changed since `d56f18d0d0fb48942475fb3e1eb2d15b8398cf19`
- Update only if a verified defect is found.

**Interfaces:**

- Consumes: Tasks 1–4.
- Produces: merge-ready evidence with no unresolved Critical or Important review findings.

- [ ] **Step 1: Run focused regression suites**

```bash
cd packages/cli && npx vitest run src/serve/acp-http/workspace-qualified-acp.test.ts src/serve/rate-limit.test.ts src/serve/daemon-status.test.ts src/serve/server.test.ts src/serve/server/device-flow-registry.test.ts
```

Expected: all files pass.

- [ ] **Step 2: Run repository verification**

```bash
npm run format
npm run lint
npm run build
npm run typecheck
npm run check:serve-fast-path-bundle
```

Expected: every command exits 0.

- [ ] **Step 3: Perform repeated undirected audits**

Inspect `git diff d56f18d0...HEAD` for routing parity, failure paths, compatibility, test quality, maintainability, excess abstraction, documentation consistency, and generated-file noise. Fix any clear actionable issue, rerun its covering test, then audit again until a pass finds no new actionable issue.

- [ ] **Step 4: Request final whole-branch code review**

Provide the reviewer the implementation plan, the complete diff from `d56f18d0`, and verification results. Resolve all Critical and Important findings and rerun affected tests.

- [ ] **Step 5: Verify the final branch state**

```bash
git status --short
git log --oneline d56f18d0..HEAD
```

Expected: clean worktree and the design plus Tasks 1–4 commits present.
