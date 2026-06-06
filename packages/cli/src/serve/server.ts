/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import express from 'express';
import type { Application } from 'express';
import type { ApprovalMode } from '@qwen-code/qwen-code-core';
import { APPROVAL_MODES, TrustGateError } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import {
  bearerAuth,
  createMutationGate,
  denyBrowserOriginCors,
  hostAllowlist,
} from './auth.js';
import {
  DeviceFlowRegistry,
  setDeviceFlowRegistry,
  TooManyActiveDeviceFlowsError,
  UnsupportedDeviceFlowProviderError,
  UpstreamDeviceFlowError,
  type DeviceFlowEventSink,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
  type DeviceFlowPublicView,
} from './auth/deviceFlow.js';
import { QwenOAuthDeviceFlowProvider } from './auth/qwenDeviceFlowProvider.js';
import { createDaemonStatusProvider } from './daemonStatusProvider.js';
import { isLoopbackBind } from './loopbackBinds.js';
import {
  canonicalizeWorkspace,
  createHttpAcpBridge,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  InvalidSessionScopeError,
  MAX_WORKSPACE_PATH_LENGTH,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  RestoreInProgressError,
  SessionBusyError,
  InvalidRewindTargetError,
  SessionLimitExceededError,
  SessionNotFoundError,
  WorkspaceInitConflictError,
  WorkspaceMismatchError,
  type HttpAcpBridge,
} from './httpAcpBridge.js';
import {
  getAdvertisedServeFeatures,
  getServeProtocolVersions,
} from './capabilities.js';
import { SubscriberLimitExceededError, type BridgeEvent } from './eventBus.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeOptions,
} from './types.js';
import { getDemoHtml } from './demo.js';
import { mountWorkspaceMemoryRoutes } from './workspaceMemory.js';
import { mountWorkspaceAgentsRoutes } from './workspaceAgents.js';
import {
  createWorkspaceFileSystemFactory,
  type WorkspaceFileSystemFactory,
} from './fs/index.js';
import { registerWorkspaceFileReadRoutes } from './routes/workspaceFileRead.js';
import { registerWorkspaceFileWriteRoutes } from './routes/workspaceFileWrite.js';

/**
 * Build a no-op fs-audit emitter that logs a warning every
 * `WARN_EVERY` dropped events with as much context as the audit
 * payload exposes. The default factory uses this so a regression
 * that silently strips audit events shows up in operator logs
 * instead of disappearing — the earlier one-shot warn was a
 * permanent silent no-op after the first event, which made a PR
 * 19/20 regression where `runQwenServe` forgets to inject the real
 * factory completely invisible (every write 403s; nothing in
 * audit; one stale stderr line easy to miss for background
 * daemons). Periodic warning + dropped-event count + first-event
 * `errorKind` + `pathHash` make the regression actionable.
 *
 * PR 19/20's `runQwenServe` injection replaces this with a real
 * per-session emit, so legitimate production traffic never hits
 * the warning.
 */
export function createDefaultFsAuditEmit(): (event: BridgeEvent) => void {
  const WARN_EVERY = 100;
  let droppedCount = 0;
  return (event: BridgeEvent) => {
    droppedCount += 1;
    if (droppedCount === 1 || droppedCount % WARN_EVERY === 0) {
      const data = event.data as
        | { errorKind?: string; pathHash?: string; intent?: string }
        | undefined;
      const ctx: string[] = [];
      if (data?.errorKind) ctx.push(`errorKind=${data.errorKind}`);
      if (data?.intent) ctx.push(`intent=${data.intent}`);
      if (data?.pathHash) ctx.push(`pathHash=${data.pathHash}`);
      const ctxStr = ctx.length > 0 ? ` (${ctx.join(' ')})` : '';
      writeStderrLine(
        `qwen serve: fs audit emit is the default no-op — ${droppedCount} event(s) dropped so far. ` +
          `Latest type=${event.type}${ctxStr}. ` +
          `Inject deps.fsFactory in createServeApp to wire audit into the EventBus.`,
      );
    }
  };
}

export interface ServeAppDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: HttpAcpBridge;
  /**
   * Pre-canonicalized workspace path. When supplied, `createServeApp`
   * skips its own `canonicalizeWorkspace` call (which would issue a
   * redundant `realpathSync.native` syscall — idempotent, but a hot
   * boot-time stat we can avoid). `runQwenServe` passes this after
   * its own boot-time canonicalize so the value used by
   * `/capabilities`, the `POST /session` cwd fallback, and the
   * bridge are all the SAME canonical form. Callers that haven't
   * canonicalized yet (tests, direct embeds) omit this and
   * `createServeApp` falls back to canonicalizing `opts.workspace ??
   * process.cwd()` itself.
   */
  boundWorkspace?: string;
  /**
   * Workspace filesystem boundary factory (#4175 PR 18). When
   * supplied, PR 19/20 routes will pull a per-request
   * `WorkspaceFileSystem` off it; when omitted, `createServeApp`
   * builds a strict default (`trusted: false`, warn-once no-op
   * `emit`) so an upstream refactor that forgets to inject
   * `fsFactory` never silently allows writes against an untrusted
   * workspace. No PR 18 routes consume the factory yet — the slot
   * is wired so PR 19 read-only file routes can drop in without
   * re-shaping `ServeAppDeps`. Once PR 19 lands, `runQwenServe`
   * will inject a factory whose `trusted` flag mirrors
   * `Config.isTrustedFolder()` and whose `emit` plumbs into the
   * per-session EventBus.
   */
  fsFactory?: WorkspaceFileSystemFactory;
  /**
   * Issue #4175 PR 21 — device-flow auth registry. Tests inject a fake
   * (`now` / `schedule` overrides for deterministic timer control,
   * stubbed providers, captured event sink). Production callers omit
   * this and `createServeApp` constructs a default wired to the
   * shipped Qwen provider, the bridge's `publishWorkspaceEvent`,
   * and a stderr audit sink.
   */
  deviceFlowRegistry?: DeviceFlowRegistry;
  /**
   * Issue #4175 PR 21 — extra device-flow providers for tests / future
   * extensions. Production builds register only `QwenOAuthDeviceFlowProvider`;
   * passing extra entries here registers them in addition to the default
   * Qwen provider. Used by tests that stub the OAuth flow.
   */
  deviceFlowProviders?: DeviceFlowProvider[];
}

/**
 * Build the Express app for `qwen serve`. Pure function — no side effects on
 * the network or process; `runQwenServe` does the listen/signal handling.
 *
 * `getPort` is invoked lazily by the host-allowlist middleware so callers
 * binding to port 0 (ephemeral) can supply the actual port after `listen()`
 * resolves. Defaults to `opts.port` for callers (e.g. tests) that pin a port
 * up front.
 *
 * Stage 1 routes shipped (matches §04 of issue #3803):
 *   - `GET  /health`
 *   - `GET  /capabilities`
 *   - `GET  /workspace/mcp`
 *   - `GET  /workspace/skills`
 *   - `GET  /workspace/providers`
 *   - `GET  /workspace/env`
 *   - `GET  /workspace/preflight`
 *   - `POST /session`
 *   - `POST /session/:id/load`
 *   - `POST /session/:id/resume`
 *   - `GET  /workspace/:id/sessions`
 *   - `GET  /session/:id/context`
 *   - `GET  /session/:id/supported-commands`
 *   - `POST /session/:id/prompt`
 *   - `POST /session/:id/cancel`
 *   - `POST /session/:id/heartbeat`
 *   - `POST /session/:id/model`
 *   - `GET  /session/:id/events` (SSE)
 *   - `POST /session/:id/permission/:requestId`
 *   - `POST /permission/:requestId`
 *
 * **Workspace validation contract.** `createServeApp` itself does NOT
 * verify that `opts.workspace` exists or is a directory — it
 * canonicalizes via `canonicalizeWorkspace`, which falls back to
 * `path.resolve` on ENOENT so the app boots even against a missing
 * path. `runQwenServe` is the production entry point and DOES
 * perform the `fs.statSync` + `isDirectory()` boot-loud check before
 * calling this function. Tests inject synthetic paths (`/work/bound`
 * etc.) on purpose: they want to exercise the route layer's
 * canonicalization and `workspace_mismatch` translation without
 * needing a real directory on disk. If a future entry point binds
 * `createServeApp` directly to user input, it MUST replicate the
 * `runQwenServe` validation (or call into a shared helper if one is
 * extracted) — otherwise a non-existent `--workspace` would boot
 * a "healthy"-looking daemon whose every spawn fails with cryptic
 * child-process ENOENT.
 */
export function createServeApp(
  opts: ServeOptions,
  getPort: () => number = () => opts.port,
  deps: ServeAppDeps = {},
): Application {
  const app = express();
  // Forward `maxSessions` into the default-constructed bridge so
  // direct callers of `createServeApp` (tests, embeds) get the same
  // cap they configured via `ServeOptions`. Previously the default
  // bridge silently fell back to `DEFAULT_MAX_SESSIONS` (20) and
  // only the `runQwenServe` path piped the option through.
  //
  // Workspace binding mirrors `runQwenServe`: per #3803 §02 the
  // daemon is bound to exactly one workspace (`opts.workspace` or
  // `process.cwd()`). `POST /session` with a mismatched cwd is
  // rejected with 400 `workspace_mismatch`.
  //
  // The value advertised on `/capabilities`, used for the `POST
  // /session` cwd fallback, AND passed into the bridge must be the
  // SAME canonical form — otherwise the bridge's
  // `realpathSync.native` would diverge from what `/capabilities`
  // shows on symlinks / case-insensitive filesystems, and clients
  // echoing the advertised path back would see a response whose
  // `workspaceCwd` differs from what they sent.
  //
  // `deps.boundWorkspace` is the pre-canonicalized fast-path —
  // `runQwenServe` passes it after its own boot-time
  // `canonicalizeWorkspace`, so we skip the redundant
  // `realpathSync.native` here. When omitted (tests, direct embeds)
  // we canonicalize ourselves.
  const boundWorkspace =
    deps.boundWorkspace ??
    canonicalizeWorkspace(opts.workspace ?? process.cwd());
  const bridge =
    deps.bridge ??
    createHttpAcpBridge({
      maxSessions: opts.maxSessions,
      // Symmetric with `runQwenServe.ts` — direct embeds / tests that
      // call `createServeApp` without supplying their own bridge and
      // pass `ServeOptions.eventRingSize` would otherwise silently
      // get the default 8000 ring instead of their configured value.
      ...(opts.eventRingSize !== undefined
        ? { eventRingSize: opts.eventRingSize }
        : {}),
      boundWorkspace,
      // PR 22b/2 (wenshao/gpt-5.5 review fold-in #4304): symmetric
      // with `runQwenServe.ts` — direct embeds / tests that don't
      // inject `deps.bridge` would otherwise silently lose the
      // daemon env + preflight cells the default server app
      // reported pre-injection. Wiring the production status provider
      // here preserves byte-for-byte route output on the default
      // bridge construction path.
      statusProvider: createDaemonStatusProvider(),
    });

  // Allow same-origin requests from the demo page. Browsers send an
  // `Origin` header on same-origin POST/fetch calls; `denyBrowserOriginCors`
  // below would reject them. This middleware strips `Origin` when it
  // matches the daemon's own address so the demo page's API calls pass
  // through. Only loopback origins are matched — non-loopback deployments
  // require the operator to front the daemon with a reverse proxy for
  // browser access anyway (per the threat-model docs).
  let cachedStripPort = -1;
  let cachedSelfOrigins: Set<string> = new Set();
  app.use((req: import('express').Request, _res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      const port = getPort();
      if (port !== cachedStripPort) {
        cachedStripPort = port;
        cachedSelfOrigins = new Set([
          `http://127.0.0.1:${port}`,
          `http://localhost:${port}`,
          `http://[::1]:${port}`,
          `http://host.docker.internal:${port}`,
        ]);
      }
      if (cachedSelfOrigins.has(origin)) {
        delete req.headers.origin;
      }
    }
    next();
  });

  // Strict-default factory: `trusted: false` so an upstream refactor
  // that forgets to inject `deps.fsFactory` never silently allows
  // writes against an untrusted workspace. Read-shaped intents still
  // succeed (so tests / direct embeds can exercise the read path
  // without a config), but every mutating intent throws
  // `untrusted_workspace`. The default `emit` is a no-op that warns
  // once on first call so a future regression that silently swallows
  // audit events surfaces in operator logs the first time it bites.
  // Callers passing `deps.fsFactory` get full control of trust +
  // audit destination — `runQwenServe` will inject one whose
  // `trusted` mirrors `Config.isTrustedFolder()` and whose `emit`
  // plumbs into the per-session EventBus once PR 19/20 lands.
  const fsFactory: WorkspaceFileSystemFactory =
    deps.fsFactory ??
    createWorkspaceFileSystemFactory({
      boundWorkspace,
      trusted: false,
      emit: createDefaultFsAuditEmit(),
    });
  // Park the factory on `app.locals` so PR 19/20 route handlers can
  // pick it up via `req.app.locals.fsFactory` without re-threading
  // the value through every handler signature, and so PR 18 tests
  // can assert the factory is reachable. Express types `locals` as
  // a generic record; we cast to keep a precise property name.
  (app.locals as { fsFactory?: WorkspaceFileSystemFactory }).fsFactory =
    fsFactory;
  // Surface the bound workspace on `app.locals` so the PR 19 read
  // routes can compute workspace-relative response paths without
  // re-resolving. Same canonical form `/capabilities` advertises
  // and the bridge enforces — keeping every layer in agreement.
  (app.locals as { boundWorkspace?: string }).boundWorkspace = boundWorkspace;

  // Issue #4175 PR 21 — wire the device-flow registry. Default builds
  // a single Qwen provider; tests inject `deps.deviceFlowRegistry`
  // wholesale (with controlled clock/scheduler) or
  // `deps.deviceFlowProviders` to stub the OAuth client only.
  const deviceFlowProviderMap = new Map<
    DeviceFlowProviderId,
    DeviceFlowProvider
  >();
  for (const provider of deps.deviceFlowProviders ?? []) {
    deviceFlowProviderMap.set(provider.providerId, provider);
  }
  if (!deviceFlowProviderMap.has('qwen-oauth')) {
    deviceFlowProviderMap.set('qwen-oauth', new QwenOAuthDeviceFlowProvider());
  }
  const deviceFlowEventSink: DeviceFlowEventSink = {
    publish(emission, originatorClientId) {
      // PR #4255 fold-in 9: PR 16 (#4249) landed
      // `publishWorkspaceEvent` with the same fan-out semantics as
      // PR 21's `broadcastWorkspaceEvent`. The closed-bus +
      // all-failed-stderr operator-visibility features that PR 21
      // added have been folded INTO `publishWorkspaceEvent`; PR 21
      // now uses the canonical helper.
      bridge.publishWorkspaceEvent({
        type: `auth_device_flow_${emission.type}`,
        data: emission.data,
        ...(originatorClientId ? { originatorClientId } : {}),
      });
    },
  };
  const deviceFlowRegistry =
    deps.deviceFlowRegistry ??
    new DeviceFlowRegistry({
      events: deviceFlowEventSink,
      audit: {
        record(line) {
          // Structured stderr breadcrumb; deviceFlowId truncated to first
          // 8 chars (mirrors PR 16 audit-event-stamp shape) so log
          // skimmers can follow a flow without retaining full uuids.
          const id = line.deviceFlowId.slice(0, 8);
          const parts = [
            `[serve] auth.device-flow:`,
            `provider=${line.providerId}`,
            `deviceFlowId=${id}...`,
            line.clientId ? `clientId=${line.clientId}` : 'clientId=-',
            `status=${line.status}`,
          ];
          if (line.errorKind) parts.push(`errorKind=${line.errorKind}`);
          if (line.expiresInMs !== undefined) {
            parts.push(`expiresInMs=${Math.max(0, line.expiresInMs)}`);
          }
          // PR #4255 round-12 #7 (gpt-5.5 review CzSpd): include
          // `line.hint` in the production stderr line. The
          // registry uses the hint slot for operator-only
          // breadcrumbs that aren't surfaced over SSE: the static
          // catch-all hint "provider.poll() threw (raw): ..."
          // (round-8 #1), `lost_success_after_timeout` (round-8
          // #7's split-brain detector), `persist_also_failed_past_expiry`
          // (round-8 #13), `take-over` audit on per-provider
          // singleton, and `deferred (persist in flight; ...)` on
          // cancel-during-persist. Without echoing here, the
          // documented troubleshooting trail is invisible in
          // production. Bound at 1 KiB so a misbehaving caller
          // can't spam stderr.
          if (line.hint) {
            const STDERR_HINT_MAX = 1_024;
            const hint =
              line.hint.length > STDERR_HINT_MAX
                ? `${line.hint.slice(0, STDERR_HINT_MAX)}…[+${line.hint.length - STDERR_HINT_MAX} bytes truncated]`
                : line.hint;
            // Quote the hint so multi-word values stay parseable.
            parts.push(`hint=${JSON.stringify(hint)}`);
          }
          writeStderrLine(parts.join(' '));
        },
      },
      resolveProvider: (providerId) => deviceFlowProviderMap.get(providerId),
    });
  // Park the registry on `app.locals` so request handlers can reach it
  // without closure capture (and so future helper extracts can find it
  // without threading it through their args). Typed accessor (fold-in 4
  // review thread D) prevents a string-key typo from silently
  // detaching `runQwenServe`'s shutdown dispose call.
  setDeviceFlowRegistry(app, deviceFlowRegistry);

  // Order matters: rejection guards (CORS / Host allowlist / bearer auth)
  // run BEFORE the JSON body parser. Otherwise an unauthenticated POST
  // gets a full 10MB `JSON.parse` before the 401 fires — a trivially
  // amplified CPU/memory cost from any wrong-token client.
  app.use(denyBrowserOriginCors);
  app.use(hostAllowlist(opts.hostname, getPort));

  // --- Demo page: mirrors the `/health` loopback-gating pattern.
  // On loopback binds, registered BEFORE bearerAuth so browsers can
  // reach the page via address-bar navigation (which cannot attach
  // Authorization headers). On non-loopback binds, registered AFTER
  // bearerAuth — an unauthenticated `/demo` on a public interface
  // would leak the full API surface (route enumeration + interactive
  // console), far more than `/health`'s `{"status":"ok"}`.
  // X-Frame-Options: DENY + CSP frame-ancestors 'none' prevent
  // clickjacking — a malicious site embedding the demo in an iframe
  // could trick a user into performing daemon actions via transparent
  // overlay (the iframe's same-origin fetches bypass CORS).
  const demoHandler = (
    _req: import('express').Request,
    res: import('express').Response,
  ) => {
    try {
      res
        .type('html')
        .set('X-Frame-Options', 'DENY')
        .set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        )
        .send(getDemoHtml(getPort()));
    } catch (err) {
      writeStderrLine(
        `qwen serve: /demo render failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(500).json({ error: 'Failed to render demo page' });
    }
  };

  // `/health` is exempted from `bearerAuth` ONLY on loopback binds —
  // the canonical liveness-probe case (k8s/Compose probes don't
  // carry the daemon's bearer; round-tripping a 401 just to know
  // the listener is up is waste). On non-loopback binds the
  // exemption becomes a low-severity info leak (attacker can probe
  // arbitrary IP:port to confirm a `qwen serve` is listening), so
  // we register `/health` AFTER `bearerAuth` and let it 401 like
  // every other route. Operators using the loopback default get the
  // probe-friendly behavior; operators exposing the daemon publicly
  // gate `/health` behind their token alongside everything else.
  // CORS deny + Host allowlist still apply to `/health` in both
  // cases.
  // Shared handler so loopback (pre-auth) and non-loopback (post-auth)
  // routes return the same shape. `?deep=1` exposes bridge counters
  // (`sessions`, `pendingPermissions`) for observability — it is
  // INFORMATIONAL only, not a true liveness probe. Counter getters
  // are size accessors that don't perform per-session/channel pings,
  // so a wedged child (stuck on a request, leaked FD, etc.) won't
  // change the response. We retain the try/catch + 503 as a
  // defense-in-depth net for custom bridge impls whose getters MAY
  // throw — but the real bridge's getters never do, so under normal
  // operation the 503 path is unreachable. Per BQ-6F: the docs
  // (`docs/users/qwen-serve.md` + `qwen-serve-protocol.md`) clarify
  // that deep is for counters, not health verification. Default (no
  // query) stays cheap so high-frequency liveness probes don't load
  // the bridge.
  const healthHandler = (
    req: import('express').Request,
    res: import('express').Response,
  ): void => {
    const deepQuery = req.query['deep'];
    const deep = deepQuery === '1' || deepQuery === 'true' || deepQuery === '';
    if (!deep) {
      res.status(200).json({ status: 'ok' });
      return;
    }
    try {
      res.status(200).json({
        status: 'ok',
        sessions: bridge.sessionCount,
        pendingPermissions: bridge.pendingPermissionCount,
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: /health deep probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(503).json({ status: 'degraded' });
    }
  };

  const loopback = isLoopbackBind(opts.hostname);
  // Issue #4175 PR 15. `--require-auth` extends the non-loopback "gate
  // /health behind bearer too" rule to loopback. Without this, an
  // operator who set the flag specifically to harden the loopback
  // default would still see `/health` answering 200 to unauthenticated
  // probes — defeating the flag's purpose. The boot check in
  // `runQwenServe` guarantees `token` is set whenever `requireAuth`
  // is true, so the post-`bearerAuth` registration always has a token
  // to compare against.
  const exposeHealthPreAuth = loopback && !opts.requireAuth;
  if (exposeHealthPreAuth) {
    app.get('/health', healthHandler);
    app.get('/demo', demoHandler);
  }

  app.use(bearerAuth(opts.token));

  app.use(express.json({ limit: '10mb' }));

  if (!exposeHealthPreAuth) {
    // Non-loopback OR loopback with `--require-auth`: register
    // `/health` and `/demo` AFTER `bearerAuth` so probes must carry
    // the token. Otherwise unauthenticated callers can ping any
    // reachable address:port to confirm a daemon exists (and `/demo`
    // leaks the full API surface).
    app.get('/health', healthHandler);
    app.get('/demo', demoHandler);
  }

  // Issue #4175 PR 15. Mutation-route gate factory. Today's existing
  // mutation routes (`POST /session*`, `/permission/:requestId`) opt
  // into the default non-strict mode, which is a passthrough — so
  // backward compatibility is bit-for-bit. Wave 4 PRs will pass
  // `{ strict: true }` for routes (memory CRUD / file edit / tool
  // enable / MCP restart / device-flow auth) that should require a
  // token even when the daemon is on loopback no-token defaults.
  const mutate = createMutationGate({
    tokenConfigured: opts.token !== undefined,
    requireAuth: opts.requireAuth === true,
  });

  app.get('/capabilities', (_req, res) => {
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      protocolVersions: getServeProtocolVersions(),
      mode: opts.mode,
      // PR 15. Pass `requireAuth` so the `require_auth` tag appears
      // ONLY when the operator opted in. Tag presence = behavior is
      // on; older daemons without this PR omit the tag and SDKs that
      // post-PR feature-detect on it stay backward compatible.
      features: getAdvertisedServeFeatures(undefined, {
        requireAuth: opts.requireAuth === true,
      }),
      modelServices: [],
      // #3803 §02: surface the bound workspace so clients can detect
      // mismatch pre-flight and omit `cwd` on `POST /session`.
      workspaceCwd: boundWorkspace,
    };
    res.status(200).json(envelope);
  });

  app.get('/workspace/mcp', async (_req, res) => {
    try {
      res.status(200).json(await bridge.getWorkspaceMcpStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/mcp' });
    }
  });

  app.get('/workspace/skills', async (_req, res) => {
    try {
      res.status(200).json(await bridge.getWorkspaceSkillsStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/skills' });
    }
  });

  app.get('/workspace/providers', async (_req, res) => {
    try {
      res.status(200).json(await bridge.getWorkspaceProvidersStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/providers' });
    }
  });

  // Issue #4175 PR 16: workspace memory + agents CRUD. Routes mounted
  // through factories so server.ts stays the composition root while
  // the feature modules own their own validation, error mapping, and
  // event fan-out. Both factories receive the shared `mutate` gate
  // and the request-helpers `parseClientIdHeader` / `safeBody` so
  // strict mutation gating and pollution-key scrubbing match the
  // existing routes bit-for-bit.
  mountWorkspaceMemoryRoutes(app, {
    bridge,
    boundWorkspace,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  mountWorkspaceAgentsRoutes(app, {
    bridge,
    boundWorkspace,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });

  // TODO(#4175 PR 24 — PermissionMediator audit log): emit an
  // `audit.diagnostic_read` event from these two routes so a security
  // operator can correlate "who read what when". Read-only diagnostic
  // surfaces are reconnaissance vectors (env: secret-var presence;
  // preflight: workspace path + CLI entry + Node version) and the absence
  // of audit emission here is a deliberate scope deferral, not an
  // oversight — the audit topic does not yet exist; PR 24 lands the
  // shared `bridge.emitAudit` infrastructure that this and PR 18's
  // `fs.access` events will both use.
  app.get('/workspace/env', async (_req, res) => {
    try {
      res.status(200).json(await bridge.getWorkspaceEnvStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/env' });
    }
  });

  app.get('/workspace/preflight', async (_req, res) => {
    try {
      res.status(200).json(await bridge.getWorkspacePreflightStatus());
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /workspace/preflight' });
    }
  });

  // Issue #4175 PR 19 — read-only workspace file routes
  // (`GET /file|/list|/glob|/stat`). Registered after the workspace
  // diagnostics routes so the file surface sits next to its sibling
  // workspace-scoped reads and shares the same auth posture (no
  // `mutate()` gate; only the global `bearerAuth` middleware
  // applies). Mutation file routes (`POST /file/write|/edit`) come
  // in PR 20.
  registerWorkspaceFileReadRoutes(app, {
    parseClientId: parseClientIdHeader,
  });
  registerWorkspaceFileWriteRoutes(app, {
    bridge,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });

  // -- Issue #4175 PR 21 — auth device-flow routes ------------------------

  app.post(
    '/workspace/auth/device-flow',
    mutate({ strict: true }),
    async (req, res) => {
      const body = safeBody(req);
      const providerIdRaw = body['providerId'];
      // PR #4255 review W2: split `invalid_request` (request shape is
      // wrong — missing/non-string field) from `unsupported_provider`
      // (the field is well-formed but its value isn't in the
      // daemon's known set). Conflating the two surfaced misleading
      // remediation hints to SDK consumers branching on `code`
      // ("this provider isn't supported here" when the actual cause
      // was a serializer dropping the field).
      if (typeof providerIdRaw !== 'string' || providerIdRaw.length === 0) {
        res.status(400).json({
          error: '`providerId` must be a non-empty string',
          code: 'invalid_request',
        });
        return;
      }
      // PR #4255 round-12 #3 (gpt-5.5 review CzSpe): validate
      // against the runtime provider map, not the static
      // `DEVICE_FLOW_SUPPORTED_PROVIDERS` tuple. The static tuple
      // is the SDK-facing default; `deps.deviceFlowProviders` is
      // the documented extension hook for tests / future
      // providers. Hardcoding the static tuple here meant
      // injected providers were rejected at the route while still
      // being registered in `deviceFlowProviderMap` — easy to
      // break when adding a second provider.
      if (!deviceFlowProviderMap.has(providerIdRaw as DeviceFlowProviderId)) {
        res.status(400).json({
          error: `Unsupported device-flow provider: ${providerIdRaw}`,
          code: 'unsupported_provider',
          supportedProviders: Array.from(deviceFlowProviderMap.keys()),
        });
        return;
      }
      const providerId = providerIdRaw as DeviceFlowProviderId;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const { view, attached } = await deviceFlowRegistry.start({
          providerId,
          ...(clientId !== undefined ? { initiatorClientId: clientId } : {}),
        });
        // Idempotent take-over → 200 with `attached: true`. Fresh start →
        // 201 + `attached: false`. The registry is the source of truth on
        // which branch fired (it's the one that decided not to call
        // `provider.start()` again).
        res
          .status(attached ? 200 : 201)
          .json(toDeviceFlowStartResponseBody(view, attached, clientId));
      } catch (err) {
        if (err instanceof UnsupportedDeviceFlowProviderError) {
          res
            .status(400)
            .json({ error: err.message, code: 'unsupported_provider' });
          return;
        }
        if (err instanceof TooManyActiveDeviceFlowsError) {
          res
            .status(409)
            .json({ error: err.message, code: 'too_many_active_flows' });
          return;
        }
        if (err instanceof UpstreamDeviceFlowError) {
          // IdP-side failure (network / parse / non-2xx). 502 distinguishes
          // "the upstream we depend on misbehaved" from a daemon bug (5xx
          // generic) so SDK clients can branch on retry strategy.
          res.status(502).json({ error: err.message, code: 'upstream_error' });
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /workspace/auth/device-flow',
        });
      }
    },
  );

  // PR #4255 fold-in 3: this GET surfaces `userCode` /
  // `verificationUri` / `verificationUriComplete` for pending entries
  // — material an attacker on the same loopback host could use to
  // shoulder-surf the IdP approval flow. POST + DELETE are already
  // strict; aligning GET to `mutate({ strict: true })` closes the
  // information-disclosure asymmetry (the sibling
  // `GET /workspace/auth/status` stays bearer-only because its
  // pendingDeviceFlows entries intentionally omit `userCode`).
  //
  // PR #4291 follow-up review (qwen-latest, #4): GET now also runs
  // `parseClientIdHeader` to drive the `callerIsInitiator` gate in
  // `toDeviceFlowStateBody`. INTENTIONAL contract change: a malformed
  // `X-Qwen-Client-Id` (>128 chars or invalid characters) returns
  // `400 invalid_client_id` instead of the previous 200, matching the
  // POST/DELETE behavior. SDK clients that send the header on POST
  // should send a valid value on GET too. Anonymous callers (header
  // absent) are unaffected and continue to work as pre-PR-4291 — the
  // both-undefined branch in `callerIsInitiator` covers them.
  app.get(
    '/workspace/auth/device-flow/:id',
    mutate({ strict: true }),
    async (req, res) => {
      const id = req.params['id'];
      if (!id) {
        res.status(404).json({
          error: 'Device-flow id required',
          code: 'device_flow_not_found',
        });
        return;
      }
      const view = deviceFlowRegistry.get(id);
      if (!view) {
        res.status(404).json({
          error: `Device-flow ${id} not found`,
          code: 'device_flow_not_found',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      // PR #4291 follow-up review (qwen-latest, N4): when the
      // `callerIsInitiator` gate redacts the verification fields,
      // operators triaging "SDK got HTTP 200 but no userCode" have
      // zero signal in daemon stderr / audit. The redaction happens
      // INSIDE the body shaper which doesn't have an audit sink, so
      // the route handler is the right layer to record it. Use
      // QWEN_SERVE_DEBUG-gated stderr (rather than unconditional
      // audit) — multi-SDK setups sharing a bearer token will cause
      // legitimate "different caller GETs same flow" traffic that
      // would otherwise flood production logs. Operators who hit
      // the symptom can flip QWEN_SERVE_DEBUG=1 and get the
      // breadcrumb on the next reproduction.
      const callerIsInitiator =
        (view.initiatorClientId === undefined && clientId === undefined) ||
        (view.initiatorClientId !== undefined &&
          clientId !== undefined &&
          clientId === view.initiatorClientId);
      if (
        !callerIsInitiator &&
        process.env['QWEN_SERVE_DEBUG'] &&
        !['0', 'false', 'off', 'no'].includes(
          (process.env['QWEN_SERVE_DEBUG'] ?? '').trim().toLowerCase(),
        )
      ) {
        writeStderrLine(
          `qwen serve debug: GET /workspace/auth/device-flow/${id} redacted verification fields — caller-clientId mismatch (initiator=${view.initiatorClientId ?? 'anonymous'}, caller=${clientId ?? 'anonymous'})`,
        );
      }
      res.status(200).json(toDeviceFlowStateBody(view, clientId));
    },
  );

  app.delete(
    '/workspace/auth/device-flow/:id',
    mutate({ strict: true }),
    (req, res) => {
      const id = req.params['id'];
      if (!id) {
        res.status(404).json({
          error: 'Device-flow id required',
          code: 'device_flow_not_found',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const result = deviceFlowRegistry.cancel(id, clientId);
      if (result === undefined) {
        res.status(404).json({
          error: `Device-flow ${id} not found`,
          code: 'device_flow_not_found',
        });
        return;
      }
      // Both freshly-cancelled and already-terminal are 204 (idempotent).
      res.status(204).end();
    },
  );

  app.get('/workspace/auth/status', (_req, res) => {
    const pending = deviceFlowRegistry.listPending();
    res.status(200).json({
      v: 1,
      workspaceCwd: boundWorkspace,
      // GET /workspace/auth/status read-side intentionally minimal in
      // this PR: a future PR can broaden the per-provider view (e.g.
      // by reading SharedTokenManager.getCachedSnapshot for an `ok` /
      // `expired` cell), but landing the additive route shape now
      // unblocks SDK clients that need to know "is there a flow
      // running?" without subscribing to SSE.
      providers: [],
      pendingDeviceFlows: pending.map((view) => ({
        deviceFlowId: view.deviceFlowId,
        providerId: view.providerId,
        ...(view.expiresAt !== undefined ? { expiresAt: view.expiresAt } : {}),
      })),
      // PR #4255 round-12 #3: derive from runtime provider map so
      // injected providers are surfaced. Single source of truth
      // matches the POST validation above.
      supportedDeviceFlowProviders: Array.from(deviceFlowProviderMap.keys()),
    });
  });

  app.post('/session', mutate(), async (req, res) => {
    const body = safeBody(req);
    // #3803 §02: 1 daemon = 1 workspace. Three input shapes:
    //   - `cwd` ABSENT from body → fall back to the daemon's bound
    //     workspace (the §02 documented shape — clients pre-flight
    //     `caps.workspaceCwd` and may then omit `cwd`).
    //   - `cwd` PRESENT but not a string → 400 malformed. A
    //     client/orchestrator serialization bug (`cwd: null`,
    //     `cwd: 123`, `cwd: {}`) must not silently bind a session
    //     to the daemon's workspace; surface the bug instead.
    //   - `cwd` PRESENT as a string → fall through to the
    //     `path.isAbsolute` check (empty string and relative both
    //     fail there with "must be an absolute path when provided").
    //
    // `safeBody` returns an `Object.create(null)` map, so
    // `'cwd' in body` reflects exactly "did the client send the
    // key?" without prototype-chain confusion. The presence-check
    // is safe as long as `PROTOTYPE_POLLUTION_KEYS` doesn't grow to
    // include `cwd` — see the cross-reference in the const's JSDoc
    // for what to do if that invariant ever has to break.
    const hasCwd = 'cwd' in body;
    if (hasCwd && typeof body['cwd'] !== 'string') {
      res
        .status(400)
        .json({ error: '`cwd` must be a string absolute path when provided' });
      return;
    }
    // Length cap BEFORE assignment so a multi-MB `cwd` body can't
    // amplify through downstream interpolations
    // (`WorkspaceMismatchError`'s `.message` echoes `requested` twice;
    // `sendBridgeError` writes it to stderr; `res.json` echoes it
    // again). On the loopback-default-no-token deployment shape this
    // is pre-auth, so a 10 MB cwd body — right under
    // `express.json({limit: '10mb'})` — would otherwise cost
    // ~60 MB per request × `maxConnections` (default 256). The
    // `MAX_WORKSPACE_PATH_LENGTH` constant matches Linux's PATH_MAX
    // (4096); legitimate filesystem paths fit well under it. The
    // `WorkspaceMismatchError` constructor also truncates as a
    // belt-and-suspenders defense for non-route callers (tests,
    // embeds, future entry points that throw the error directly).
    if (hasCwd && (body['cwd'] as string).length > MAX_WORKSPACE_PATH_LENGTH) {
      res.status(400).json({
        error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
      });
      return;
    }
    const cwd = hasCwd ? (body['cwd'] as string) : boundWorkspace;
    if (!path.isAbsolute(cwd)) {
      res
        .status(400)
        .json({ error: '`cwd` must be an absolute path when provided' });
      return;
    }
    const modelServiceId =
      typeof body['modelServiceId'] === 'string'
        ? (body['modelServiceId'] as string)
        : undefined;
    // Per-request `sessionScope` override (#4175 PR 5). Validate at the
    // route boundary so a 400 surfaces a clear `code: invalid_session_scope`
    // before we touch the bridge — the bridge revalidates as a defense
    // against direct callers, but a typed 4xx is the right shape for HTTP
    // clients. The field is OPTIONAL: omitting it preserves pre-PR
    // behavior bit-for-bit (the daemon-wide `BridgeOptions.sessionScope`
    // takes effect). New clients can pre-flight `caps.features` for
    // `session_scope_override` before sending — see
    // `packages/cli/src/serve/capabilities.ts`.
    const rawSessionScope = body['sessionScope'];
    let sessionScope: 'single' | 'thread' | undefined;
    if (rawSessionScope !== undefined) {
      if (rawSessionScope !== 'single' && rawSessionScope !== 'thread') {
        res.status(400).json({
          error: '`sessionScope` must be "single" or "thread" when provided',
          code: 'invalid_session_scope',
        });
        return;
      }
      sessionScope = rawSessionScope;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const session = await bridge.spawnOrAttach({
        workspaceCwd: cwd,
        modelServiceId,
        ...(clientId !== undefined ? { clientId } : {}),
        ...(sessionScope !== undefined ? { sessionScope } : {}),
      });
      // Client may have disconnected during the 1–3s spawn window. If
      // so, the response can't be delivered. The session is otherwise
      // orphaned (in `byId` / `defaultEntry` with no client knowing the
      // id), and under churn this leaks one child per aborted request.
      //
      // Detect "can we still write the response?" via `res.writable`,
      // which stays true until the SOCKET destination side closes
      // (the right signal for our case). The legacy `req.aborted`
      // only flips while the request body is still being received,
      // so a client that completed the POST and then closed during
      // the spawn would slip past it. `req.destroyed` is too eager
      // — clients (incl. supertest) close their writable end after
      // sending the body even though they're still listening for the
      // response. `res.writable` is the documented signal for
      // "ServerResponse can still send to client".
      //
      // Combined with `!session.attached` we only reap when WE spawned
      // a fresh child for this request — if another client legitimately
      // attached, killing it would tear out their work mid-flight.
      // The disconnect-without-reap branch also needs to skip
      // `res.json` — writing to a closed socket would throw EPIPE
      // through Express's default error handler.
      if (!res.writable) {
        if (!session.attached) {
          // `requireZeroAttaches: true` closes the BQ9tV race: if
          // a second client called `spawnOrAttach` for the same
          // workspace between our `await` resolving and this reap
          // dispatching, the bridge will see `attachCount > 0` and
          // skip the kill. Without the flag, that second client's
          // session would die mid-prompt.
          bridge
            .killSession(session.sessionId, { requireZeroAttaches: true })
            .catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
        } else {
          // tanzhenxin issue 2: when an attaching client disconnects
          // before its 200 response can be written, the
          // `attachCount` bump we did inside `spawnOrAttach` is
          // fictitious — there's no live attaching client. Roll the
          // counter back and let the bridge decide whether to reap
          // (it does if attachCount returns to 0 AND no live SSE
          // subscribers). Without this, both-coalesced-callers-
          // disconnect leaves an orphan agent child no client knows
          // the id of.
          bridge.detachClient(session.sessionId, session.clientId).catch(() => {
            // Best-effort cleanup; channel.exited will eventually reap.
          });
        }
        return;
      }
      res.status(200).json(session);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /session' });
    }
  });

  const restoreSessionHandler =
    (action: 'load' | 'resume') =>
    async (req: express.Request, res: express.Response) => {
      const sessionId = req.params['id'];
      if (!sessionId) {
        res
          .status(400)
          .json({ error: '`sessionId` route parameter is required' });
        return;
      }
      const body = safeBody(req);
      const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
      if (cwd === undefined) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const session =
          action === 'load'
            ? await bridge.loadSession({
                sessionId,
                workspaceCwd: cwd,
                ...(clientId !== undefined ? { clientId } : {}),
              })
            : await bridge.resumeSession({
                sessionId,
                workspaceCwd: cwd,
                ...(clientId !== undefined ? { clientId } : {}),
              });
        // Mirror the `POST /session` disconnect-cleanup path (see the
        // long comment above the matching `if (!res.writable)` there
        // for the rationale around `res.writable` vs `req.aborted` /
        // `req.destroyed`, plus the BQ9tV `requireZeroAttaches` race
        // and the tanzhenxin attach-rollback case). Restore needs the
        // same cleanup because a client that disconnects during a
        // multi-second `session/load` would otherwise leave a freshly
        // restored session in `byId` with no client holding its id.
        if (!res.writable) {
          if (!session.attached) {
            bridge
              .killSession(session.sessionId, { requireZeroAttaches: true })
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          } else {
            bridge
              .detachClient(session.sessionId, session.clientId)
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          }
          return;
        }
        res.status(200).json(session);
      } catch (err) {
        sendBridgeError(res, err, {
          route: `POST /session/:id/${action}`,
          sessionId,
        });
      }
    };

  app.post('/session/:id/load', mutate(), restoreSessionHandler('load'));
  app.post('/session/:id/resume', mutate(), restoreSessionHandler('resume'));

  app.get('/session/:id/context', async (req, res) => {
    const sessionId = req.params['id'];
    if (!sessionId) {
      res
        .status(400)
        .json({ error: '`sessionId` route parameter is required' });
      return;
    }
    try {
      res.status(200).json(await bridge.getSessionContextStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/context',
        sessionId,
      });
    }
  });

  app.get('/session/:id/supported-commands', async (req, res) => {
    const sessionId = req.params['id'];
    if (!sessionId) {
      res
        .status(400)
        .json({ error: '`sessionId` route parameter is required' });
      return;
    }
    try {
      res
        .status(200)
        .json(await bridge.getSessionSupportedCommandsStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/supported-commands',
        sessionId,
      });
    }
  });

  app.post('/session/:id/prompt', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const prompt = body['prompt'];
    if (!Array.isArray(prompt) || prompt.length === 0) {
      res.status(400).json({
        error:
          '`prompt` is required and must be a non-empty array of content blocks',
      });
      return;
    }
    if (
      !prompt.every(
        (item: unknown) =>
          // `typeof item === 'object'` is true for arrays too, so an
          // exclude-arrays check is needed to keep the contract
          // ("ACP content block, like {type: 'text', text: '...'}")
          // honest. Without `!Array.isArray(item)`, `prompt: [[]]`
          // passes validation and a confusing 500 surfaces from the
          // ACP SDK layer.
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    ) {
      res.status(400).json({
        error: 'each `prompt` element must be an object (content block)',
      });
      return;
    }
    // Propagate HTTP-client disconnect to an ACP cancel notification so
    // the agent winds down promptly and the per-session FIFO doesn't
    // stay blocked on a dead client. Detached after the prompt settles.
    //
    // Use `res.on('close')` (NOT `req.on('close')`) — `IncomingMessage`'s
    // close event fires once the request body has been fully consumed
    // even when the client is still listening for the response, which
    // would cancel every ordinary prompt the moment its upload
    // finished. `ServerResponse`'s close event only fires when the
    // socket goes away. Guard with `!res.writableEnded` so a normal
    // response flush (which also triggers `res.close`) doesn't fire
    // the abort retroactively.
    const abort = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onResClose);
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) {
      res.off('close', onResClose);
      return;
    }
    try {
      // SECURITY NOTE: this `...(body as object)` passthrough is
      // intentional — the bridge / ACP SDK ignores fields it
      // doesn't recognize (ACP-spec `_meta` etc are forwarded
      // wholesale to the agent, which is the documented behavior).
      // `sessionId` and `prompt` are forced to the route's view to
      // prevent body-spoofing of the routing key. If a future
      // bridge version starts trusting an additional field by name,
      // that field becomes a client-controlled input surface — at
      // that point switch this to an explicit pick. The same
      // pattern repeats on cancel / model below; review them all
      // together when adding new bridge-trusted fields.
      const result = await bridge.sendPrompt(
        sessionId,
        {
          ...(body as object),
          sessionId,
          prompt,
        } as Parameters<HttpAcpBridge['sendPrompt']>[1],
        abort.signal,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(result);
    } catch (err) {
      // The HTTP client disconnecting fires the abort path above and
      // the bridge re-throws as `AbortError`. That's a normal
      // wind-down, not an error worth a 500 + stderr stack trace.
      // Drop it silently — the socket is already closed so we can't
      // send a response anyway, and active clients (e.g. an IDE
      // plugin scrubbing a stuck prompt) would otherwise spam the
      // daemon log.
      //
      // BX9_k: narrow the swallow to ONLY the case where WE armed
      // the abort. The earlier blanket `err.name === 'AbortError'`
      // could also swallow an internal bridge abort (e.g. the child
      // process aborting a prompt mid-flight) — leaving the client
      // with no response and no log trace. If `abort.signal.aborted`
      // is false, the AbortError came from somewhere we didn't
      // expect → route it through `sendBridgeError` as a real
      // failure.
      if (
        err instanceof DOMException &&
        err.name === 'AbortError' &&
        abort.signal.aborted
      ) {
        return;
      }
      sendBridgeError(res, err, {
        route: 'POST /session/:id/prompt',
        sessionId,
      });
    } finally {
      res.off('close', onResClose);
    }
  });

  app.post('/session/:id/heartbeat', mutate(), (req, res) => {
    // #4175 PR 9: clients ping the daemon to update last-seen
    // bookkeeping. Bridge throws `SessionNotFoundError` for unknown
    // ids and `InvalidClientIdError` when an `X-Qwen-Client-Id`
    // header is supplied but not registered for this session — both
    // are routed through `sendBridgeError` so they share the same
    // typed shape (`404` and `400 invalid_client_id`) the rest of
    // the routes use.
    const sessionId = req.params['id'];
    if (!sessionId) {
      res
        .status(400)
        .json({ error: '`sessionId` route parameter is required' });
      return;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const result = bridge.recordHeartbeat(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/heartbeat',
        sessionId,
      });
    }
  });

  app.post('/session/:id/cancel', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      await bridge.cancelSession(
        sessionId,
        {
          ...(body as object),
          sessionId,
        } as Parameters<HttpAcpBridge['cancelSession']>[1],
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/cancel',
        sessionId,
      });
    }
  });

  app.delete('/session/:id', async (req, res) => {
    const sessionId = req.params['id'];
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      await bridge.closeSession(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'DELETE /session/:id',
        sessionId,
      });
    }
  });

  app.patch('/session/:id/metadata', (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    const displayName = body['displayName'];
    if (displayName !== undefined && typeof displayName !== 'string') {
      res.status(400).json({
        error: '`displayName` must be a string',
        code: 'invalid_metadata',
        field: 'displayName',
      });
      return;
    }
    try {
      const effective = bridge.updateSessionMetadata(
        sessionId,
        { displayName },
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json({ sessionId, ...effective });
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'PATCH /session/:id/metadata',
        sessionId,
      });
    }
  });

  app.get('/workspace/:id/sessions', (req, res) => {
    // Express decodes URL-encoded path params automatically; clients pass
    // the absolute workspace cwd encoded (e.g.
    // GET /workspace/%2Fwork%2Fa/sessions).
    const workspaceCwd = req.params['id'] ?? '';
    if (!path.isAbsolute(workspaceCwd)) {
      res
        .status(400)
        .json({ error: '`:id` must decode to an absolute workspace path' });
      return;
    }
    // #3803 §02: reject cross-workspace queries so orchestrators
    // don't mistake "no sessions here" for "workspace is idle".
    const key = canonicalizeWorkspace(workspaceCwd);
    if (key !== boundWorkspace) {
      res.status(400).json({
        error: `Workspace mismatch: daemon is bound to "${boundWorkspace}"`,
        code: 'workspace_mismatch',
        boundWorkspace,
        requestedWorkspace: key,
      });
      return;
    }
    const sessions = bridge.listWorkspaceSessions(workspaceCwd);
    res.status(200).json({ sessions });
  });

  app.post('/session/:id/model', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const modelId = body['modelId'];
    if (typeof modelId !== 'string' || !modelId) {
      res.status(400).json({
        error: '`modelId` is required and must be a non-empty string',
      });
      return;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const response = await bridge.setSessionModel(
        sessionId,
        {
          ...(body as object),
          sessionId,
          modelId,
        } as Parameters<HttpAcpBridge['setSessionModel']>[1],
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(response);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/model',
        sessionId,
      });
    }
  });

  app.post(
    '/session/:id/approval-mode',
    mutate({ strict: true }),
    async (req, res) => {
      // #4175 Wave 4 PR 17 — first strict-gated session mutation
      // surface after PR 14 v1. Validates `mode` against the closed
      // `APPROVAL_MODES` enum and an optional `persist: boolean` flag.
      // The bridge applies the change inside the ACP child's per-session
      // `Config` and (when `persist: true`) writes `tools.approvalMode`
      // to workspace settings via the `persistApprovalMode` hook wired
      // in `runQwenServe.ts`.
      const sessionId = req.params['id'];
      const body = safeBody(req);
      const mode = body['mode'];
      const persist = body['persist'];
      if (
        typeof mode !== 'string' ||
        !APPROVAL_MODES.includes(mode as ApprovalMode)
      ) {
        res.status(400).json({
          error: '`mode` is required and must be one of the allowed values',
          code: 'invalid_approval_mode',
          allowed: APPROVAL_MODES,
        });
        return;
      }
      if (persist !== undefined && typeof persist !== 'boolean') {
        res.status(400).json({
          error: '`persist` must be a boolean when provided',
          code: 'invalid_persist_flag',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const response = await bridge.setSessionApprovalMode(
          sessionId,
          mode as ApprovalMode,
          { persist: persist === true },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /session/:id/approval-mode',
          sessionId,
        });
      }
    },
  );

  app.get('/session/:id/rewind/snapshots', async (req, res) => {
    const sessionId = req.params['id'];
    if (!sessionId) {
      res
        .status(400)
        .json({ error: '`sessionId` route parameter is required' });
      return;
    }
    try {
      res.status(200).json(await bridge.getRewindSnapshots(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/rewind/snapshots',
        sessionId,
      });
    }
  });

  app.post('/session/:id/rewind', mutate(), async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const promptId = body['promptId'];
    if (typeof promptId !== 'string' || promptId.length === 0) {
      res.status(400).json({
        error: '`promptId` is required and must be a non-empty string',
        code: 'missing_prompt_id',
      });
      return;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const response = await bridge.rewindSession(
        sessionId,
        { promptId },
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(response);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/rewind',
        sessionId,
      });
    }
  });

  app.post(
    '/workspace/mcp/:server/restart',
    mutate({ strict: true }),
    async (req, res) => {
      // #4175 Wave 4 PR 17. Forwards through the ACP child's
      // `McpClientManager.discoverMcpToolsForServer` after a budget
      // pre-check on PR 14 v1's accounting. Soft refusals are 200 OK
      // with `{restarted:false, skipped:true, reason}`; unknown server
      // names or no live ACP channel are hard errors mapped to 4xx/5xx
      // via sendBridgeError.
      const serverName = req.params['server'];
      if (!serverName || typeof serverName !== 'string') {
        res.status(400).json({
          error: 'Server name path parameter is required',
          code: 'invalid_server_name',
        });
        return;
      }
      // #4282 fold-in 4 (qwen-latest S1): match the
      // `MAX_TOOL_NAME_LENGTH` cap so the server name (which propagates
      // into SSE event bodies, ACP messages, and error responses) can't
      // be used to bloat any of those surfaces with an unbounded
      // path-parameter input.
      if (serverName.length > MAX_SERVER_NAME_LENGTH) {
        res.status(400).json({
          error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
          code: 'invalid_server_name',
        });
        return;
      }
      // #4282 fold-in 1 (gpt-5.5 C2): validate `X-Qwen-Client-Id`
      // against `bridge.knownClientIds()` so the originator stamped
      // onto `mcp_server_restart*` events is grounded in a known
      // identity rather than a forged header.
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      try {
        const result = await bridge.restartMcpServer(serverName, clientId);
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/:server/restart',
        });
      }
    },
  );

  app.post('/workspace/init', mutate({ strict: true }), async (req, res) => {
    // #4175 Wave 4 PR 17. Scaffold-only init: the bridge writes an
    // empty QWEN.md without invoking the LLM. Default refuses
    // overwrite (409); body `{force: true}` overrides.
    const body = safeBody(req);
    const force = body['force'];
    if (force !== undefined && typeof force !== 'boolean') {
      res.status(400).json({
        error: '`force` must be a boolean when provided',
        code: 'invalid_force_flag',
      });
      return;
    }
    // #4282 fold-in 1 (gpt-5.5 C2): validate against known client ids.
    const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
    if (clientId === null) return;
    try {
      const result = await bridge.initWorkspace(
        { force: force === true },
        clientId,
      );
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /workspace/init' });
    }
  });

  app.post(
    '/workspace/tools/:name/enable',
    mutate({ strict: true }),
    async (req, res) => {
      // #4175 Wave 4 PR 17. Toggles a tool name in the workspace
      // `tools.disabled` settings list. Strict-gated alongside other
      // Wave 4 mutation routes; bridge writes the file directly (no
      // ACP roundtrip) and fan-outs `tool_toggled` to every live
      // session SSE bus. Already-registered tools in live sessions
      // are NOT retroactively unregistered — toggling takes effect on
      // the next ACP child spawn or session refresh.
      const rawToolName = req.params['name'];
      if (!rawToolName || typeof rawToolName !== 'string') {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      // #4282 fold-in 4 (qwen-latest C3): trim before persistence so the
      // write path matches the read path. `loadCliConfig` applies
      // `.trim()` when consuming `tools.disabled` at child spawn, so a
      // leading/trailing space stored verbatim would never round-trip:
      // disable would persist `" Bash "`, the spawn would key on
      // `"Bash"`, and a re-enable for `"Bash"` would leave the original
      // entry permanently stuck.
      const toolName = rawToolName.trim();
      if (toolName.length === 0) {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      // #4282 fold-in 2 (deepseek SV1): cap the tool name length so
      // an extremely long path parameter can't bloat the workspace
      // settings file. Sized at 256 to comfortably accommodate the
      // longest legitimate MCP qualified names
      // (`mcp__<server>__<tool>`) while staying well under any
      // settings-file pathological-input concern. Mirrors the
      // explicit caps on `cwd` (`MAX_WORKSPACE_PATH_LENGTH`) and
      // `X-Qwen-Client-Id` (`MAX_CLIENT_ID_LENGTH`).
      if (toolName.length > MAX_TOOL_NAME_LENGTH) {
        res.status(400).json({
          error: `Tool name exceeds ${MAX_TOOL_NAME_LENGTH}-character limit`,
          code: 'invalid_tool_name',
        });
        return;
      }
      const body = safeBody(req);
      const enabled = body['enabled'];
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          error: '`enabled` is required and must be a boolean',
          code: 'invalid_enabled_flag',
        });
        return;
      }
      // #4282 fold-in 1 (gpt-5.5 C2): validate against known client ids.
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      try {
        const result = await bridge.setWorkspaceToolEnabled(
          toolName,
          enabled,
          clientId,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/tools/:name/enable',
        });
      }
    },
  );

  app.post('/session/:id/permission/:requestId', mutate(), (req, res) => {
    const sessionId = req.params['id'];
    const requestId = req.params['requestId'];
    const response = parsePermissionVoteBody(req, res);
    if (response === undefined) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    let accepted: boolean;
    try {
      accepted = bridge.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        clientId !== undefined ? { clientId } : undefined,
      );
    } catch (err) {
      sendPermissionVoteError(res, err, {
        route: 'POST /session/:id/permission/:requestId',
        sessionId,
      });
      return;
    }
    if (!accepted) {
      res.status(404).json({
        error: 'No pending permission request for session',
        sessionId,
        requestId,
      });
      return;
    }
    res.status(200).json({});
  });

  app.post('/permission/:requestId', mutate(), (req, res) => {
    const requestId = req.params['requestId'];
    const response = parsePermissionVoteBody(req, res);
    if (response === undefined) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    let accepted: boolean;
    try {
      accepted = bridge.respondToPermission(
        requestId,
        response,
        clientId !== undefined ? { clientId } : undefined,
      );
    } catch (err) {
      sendPermissionVoteError(res, err, {
        route: 'POST /permission/:requestId',
      });
      return;
    }
    if (!accepted) {
      // Either the requestId never existed or another client already won
      // the race. Stage 1 doesn't distinguish — both surface as 404.
      res
        .status(404)
        .json({ error: 'No pending permission request', requestId });
      return;
    }
    res.status(200).json({});
  });

  app.get('/session/:id/events', (req, res) => {
    const sessionId = req.params['id'];
    const lastEventId = parseLastEventId(req.headers['last-event-id']);
    const maxQueued = parseMaxQueuedQuery(req.query['maxQueued'], res);
    // `parseMaxQueuedQuery` sends its own 400 + JSON body on rejection
    // (returns `null`) so the SSE handshake doesn't get half-written.
    // `undefined` means "client didn't ask for an override; use bus
    // default 256" — proceed as before.
    if (maxQueued === null) return;

    let iter: AsyncIterator<BridgeEvent> | undefined;
    const abort = new AbortController();
    try {
      const iterable = bridge.subscribeEvents(sessionId, {
        signal: abort.signal,
        lastEventId,
        ...(maxQueued !== undefined ? { maxQueued } : {}),
      });
      iter = iterable[Symbol.asyncIterator]();
    } catch (err) {
      // `EventBus` throws `SubscriberLimitExceededError` when the
      // per-session subscriber cap (default 64) is reached.
      //
      // Bd1zJ: surface as `429 Too Many Requests` + `Retry-After`
      // header rather than `200 + stream_error`. The previous
      // SSE-shaped response triggered `EventSource`'s
      // auto-reconnect (which honors the `retry:` directive AND
      // default-reconnects on any closed stream). The reconnect hit
      // the same cap, looped, amplifying the exact load the limit
      // exists to prevent.
      //
      // `429` is the standard "back off" signal — browsers'
      // `EventSource` treats `4xx` as terminal and does NOT
      // auto-reconnect on it, unlike `200 + close` which DOES
      // reconnect. Body shape mirrors the SSE frame's data field so
      // a raw-fetch client gets the same structured error.
      if (err instanceof SubscriberLimitExceededError) {
        writeStderrLine(
          `qwen serve: subscriber limit reached for session ${sessionId} (limit=${err.limit}); rejecting new SSE client with 429`,
        );
        res.setHeader('Retry-After', '5');
        res.status(429).json({
          error: err.message,
          code: 'subscriber_limit_exceeded',
          limit: err.limit,
        });
        return;
      }
      sendBridgeError(res, err, {
        route: 'GET /session/:id/events',
        sessionId,
      });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx); event-stream content type alone
    // doesn't always reach the client through every proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    // Always present on the supported Node versions (engines.node >=22).
    res.flushHeaders();

    // Backpressure helper: `res.write` returns false when the kernel send
    // buffer is full. Without awaiting `drain` Node accumulates the
    // payload in user-space memory unboundedly — a slow consumer on a
    // chatty session can balloon daemon RSS. Wait for `drain` (or
    // close/error) before scheduling the next write.
    //
    // Concurrency: serialize ALL writes through a per-connection chain
    // so the heartbeat (fire-and-forget interval, see below) can't
    // interleave with the main event-write loop. Without serialization,
    // the heartbeat firing while the main loop is mid-`drain` await
    // would issue a second `res.write()` that bypasses the
    // backpressure guard — and could even interleave bytes between two
    // SSE frames on the wire. The chain is single-flight: each call
    // waits for the previous write to settle before scheduling its own.
    let writeChain: Promise<void> = Promise.resolve();
    const doWrite = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (res.writableEnded) {
          resolve();
          return;
        }
        // `res.write` can throw synchronously when the socket is
        // already destroyed (typical EPIPE shape). Wrap in try/catch
        // so that surfaces as a rejection on this promise instead of
        // escaping the executor and turning into an unhandled
        // exception. Async failures still arrive via the `'error'`
        // event handler below — Node's Writable.write callback isn't
        // documented to receive an error argument (errors come on
        // the event), so we don't rely on it.
        let ok: boolean;
        try {
          ok = res.write(chunk);
        } catch (err) {
          reject(err);
          return;
        }
        if (ok) {
          resolve();
          return;
        }
        const onDrain = () => {
          res.off('close', onClose);
          res.off('error', onError);
          resolve();
        };
        const onClose = () => {
          res.off('drain', onDrain);
          res.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          reject(err);
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      });
    const writeWithBackpressure = (chunk: string): Promise<void> => {
      const next = writeChain.then(() => doWrite(chunk));
      // Tail-swallow rejections on the chain itself so a single failed
      // write doesn't poison every subsequent call. The CALLER's
      // returned promise still rejects — chain-internal failures are
      // someone else's problem, not blockers for queueing.
      writeChain = next.catch(() => undefined);
      return next;
    };

    // Tell EventSource to retry after 3s on disconnect. Awaiting drain on
    // the very first write is overkill but cheap — `ok` is true the
    // overwhelming majority of the time. Always swallow rejection: a
    // socket that errors before the very first write would otherwise
    // surface as an unhandled promise rejection (the `res.on('error')`
    // hook below is what we actually rely on for cleanup).
    void writeWithBackpressure('retry: 3000\n\n').catch(() => {});

    // Heartbeat keeps NAT/proxy connections alive and lets the server
    // notice a dead client through write-back-pressure. Comment frame is
    // ignored by EventSource.
    //
    // KNOWN GAP: this only catches dead connections via write
    // back-pressure on heartbeat itself. A network partition without TCP
    // RST can leave the connection looking alive (no FIN received) for
    // however long Node's keepalive probes take to time out — usually
    // ~2 hours by default, configurable via `server.keepAliveTimeout`.
    // Stage 2 may add an explicit application-level idle timeout
    // (last-byte-written tracking + per-connection deadline).
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) {
        // Heartbeat writes are best-effort; failure swallowed via the
        // `res.on('error')` hook below.
        void writeWithBackpressure(': heartbeat\n\n').catch(() => {});
      }
    }, 15_000);
    heartbeatTimer.unref();

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      abort.abort();
    };
    req.on('close', cleanup);
    // Swallow socket-level write errors. When the underlying TCP connection
    // dies (RST, mid-flight kill -9), the next `res.write` throws EPIPE.
    // Without an `error` listener Express forwards it to its default error
    // handler which logs noisily. The req.on('close') path above is what we
    // actually rely on to tear down the subscription; this listener just
    // suppresses the noise + ensures cleanup runs even if for some reason
    // the close event doesn't fire first.
    res.on('error', (err) => {
      // Without this log the daemon side is blind to SSE disconnects
      // (RST, mid-flight kill -9, network blip). Cleanup still runs —
      // the listener exists primarily so Node doesn't crash on EPIPE
      // — but operators get a breadcrumb when chasing flaky clients.
      writeStderrLine(
        `qwen serve: SSE socket error (session ${sessionId}): ${err.message}`,
      );
      cleanup();
    });

    void (async () => {
      try {
        while (true) {
          const next = await iter!.next();
          if (next.done) break;
          if (res.writableEnded) break;
          await writeWithBackpressure(formatSseFrame(next.value));
        }
      } catch (err) {
        if (!res.writableEnded) {
          // Don't burn an `id:` slot — `stream_error` is a terminal frame
          // emitted on the daemon side when the bridge iterator throws, so
          // it has no place in the per-session monotonic sequence and a
          // hard-coded `id: 0` would regress the client's `Last-Event-ID`
          // tracker. `formatSseFrame` omits the `id:` line when the input
          // event has no id.
          await writeWithBackpressure(
            formatSseFrame({
              v: 1,
              type: 'stream_error',
              data: { error: errorMessage(err) },
            }),
          ).catch(() => {});
        }
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    })();
  });

  // Final error handler. `express.json()` throws `SyntaxError` (with
  // `status: 400`) on malformed body — without this 4-arg middleware
  // Express renders an HTML error page, which trips SDK clients that
  // expect a JSON body on every response. Anything else bubbling out
  // is a programmer error; log it and return a JSON 500 (matches the
  // route-level `sendBridgeError` shape so clients have one error
  // contract to parse).
  app.use(
    (
      err: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      if (
        err instanceof SyntaxError &&
        'status' in err &&
        (err as { status: number }).status === 400
      ) {
        res.status(400).json({ error: 'Invalid JSON in request body' });
        return;
      }
      // body-parser raises a typed error with `status: 413` when a
      // request body exceeds the `express.json({ limit: '10mb' })`
      // ceiling. Without this branch it falls through to the 500 path
      // and clients see a misleading "Internal server error" instead
      // of a clear "payload too large" — which is the kind of error
      // they can actually act on (chunk the request, raise the limit).
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        (err as { status: number }).status === 413
      ) {
        res.status(413).json({ error: 'Request body too large (max 10 MB)' });
        return;
      }
      writeStderrLine(
        `qwen serve: unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  return app;
}

/**
 * Keys stripped by `safeBody` to defend against prototype-pollution
 * — see BZ9uv/va/vs/wD/Bd1zz. Routes downstream of `safeBody` spread
 * the filtered result into objects passed to the bridge / ACP SDK;
 * without this scrub a client could set
 * `{"__proto__": {"polluted": true}}` and pollute
 * `Object.prototype` via downstream spreads.
 *
 * **Cross-reference for route maintainers:** the POST `/session`
 * route distinguishes "absent" from "present" via `'cwd' in body`
 * against `safeBody`'s output. The semantics rely on this set NOT
 * overlapping with user-payload keys. If you ever add a key here
 * that a route's presence-check cares about (highly unlikely — this
 * set is the JS prototype-attack triple, plus a route would have
 * to deliberately name a property after one of these), the
 * presence-check needs to move to the pre-`safeBody` `req.body`
 * (with its own pollution guard) or `safeBody` needs to return a
 * separate "raw-keys" set alongside the filtered object.
 */
const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const CLIENT_ID_HEADER = 'x-qwen-client-id';
const MAX_CLIENT_ID_LENGTH = 128;
/** #4282 fold-in 2 (deepseek SV1) — see /workspace/tools/:name/enable. */
const MAX_TOOL_NAME_LENGTH = 256;
/** #4282 fold-in 4 (qwen-latest S1) — see /workspace/mcp/:server/restart. */
const MAX_SERVER_NAME_LENGTH = 256;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]+$/;
const INVALID_PERMISSION_OUTCOME_ERROR =
  '`outcome` must be `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: string }`';

type PermissionVoteResponse = Parameters<
  HttpAcpBridge['respondToPermission']
>[1];

/**
 * Coerce `req.body` into a safe `Record<string, unknown>` for route
 * handlers. Replaces the 5-site copy-pasted preamble
 * `typeof req.body === 'object' && req.body !== null ? ... : {}`
 * (Bd10m).
 *
 * Strips the `PROTOTYPE_POLLUTION_KEYS` set before returning. Uses an
 * `Object.create(null)` target so the returned object itself has no
 * prototype either, blocking second-order spread-into-default-
 * prototype attacks.
 */
function safeBody(req: import('express').Request): Record<string, unknown> {
  const raw = req.body;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Object.create(null) as Record<string, unknown>;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function parseOptionalWorkspaceCwd(
  body: Record<string, unknown>,
  boundWorkspace: string,
  res: import('express').Response,
): string | undefined {
  const hasCwd = 'cwd' in body;
  if (hasCwd && typeof body['cwd'] !== 'string') {
    res
      .status(400)
      .json({ error: '`cwd` must be a string absolute path when provided' });
    return undefined;
  }
  if (hasCwd && (body['cwd'] as string).length > MAX_WORKSPACE_PATH_LENGTH) {
    res.status(400).json({
      error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
    });
    return undefined;
  }
  const cwd = hasCwd ? (body['cwd'] as string) : boundWorkspace;
  if (!path.isAbsolute(cwd)) {
    res
      .status(400)
      .json({ error: '`cwd` must be an absolute path when provided' });
    return undefined;
  }
  return cwd;
}

/**
 * PR 21 — translate the registry's redacted `DeviceFlowPublicView` into
 * the wire shape declared by `DaemonDeviceFlowStartResult`. Splitting
 * "start response" from "state body" preserves the `attached` field
 * the start route needs without polluting the GET shape.
 */
function toDeviceFlowStartResponseBody(
  view: DeviceFlowPublicView,
  attached: boolean,
  callerClientId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceFlowId: view.deviceFlowId,
    providerId: view.providerId,
    status: view.status,
    expiresAt: view.expiresAt ?? 0,
    intervalMs: view.intervalMs ?? 0,
    attached,
  };
  // PR #4291 follow-up review (gpt-5.5, #3): policy consistency with
  // `toDeviceFlowStateBody` — only the original starter sees the
  // verification material. Earlier shape unconditionally returned
  // `userCode` / `verificationUri` / `verificationUriComplete` on
  // every POST, including the `attached: true` take-over case, so any
  // bearer-token holder that POSTed `providerId: <existing>` got the
  // verification code another client started. That bypassed the
  // closed-out GET redaction completely. Apply the same gate here.
  // Fresh starts naturally pass the gate because `view.initiatorClientId`
  // was set from the same `callerClientId` on this very request.
  // Take-over callers that don't match the initiator now see the
  // public envelope only. The both-undefined branch preserves the
  // anonymous-start → anonymous-reattach use case.
  const callerIsInitiator =
    (view.initiatorClientId === undefined && callerClientId === undefined) ||
    (view.initiatorClientId !== undefined &&
      callerClientId !== undefined &&
      callerClientId === view.initiatorClientId);
  if (callerIsInitiator) {
    body['userCode'] = view.userCode ?? '';
    body['verificationUri'] = view.verificationUri ?? '';
    if (view.verificationUriComplete) {
      body['verificationUriComplete'] = view.verificationUriComplete;
    }
  }
  // PR #4255 round-12 #6 (gpt-5.5 review CzHOK): minor info-leak
  // close-out — only echo `initiatorClientId` back to a take-over
  // POST when the caller is the same client that started the flow
  // (or when the take-over caller explicitly identified
  // themselves and matches the original starter). An anonymous
  // take-over caller (no `X-Qwen-Client-Id`) gets no echo of the
  // original starter's id; this preserves the symmetry "the
  // daemon respects the absence of `X-Qwen-Client-Id` as a
  // privacy signal." Bearer-gated already, so the blast radius
  // was small, but the asymmetry is now closed.
  if (
    view.initiatorClientId &&
    callerClientId !== undefined &&
    callerClientId === view.initiatorClientId
  ) {
    body['initiatorClientId'] = view.initiatorClientId;
  }
  return body;
}

function toDeviceFlowStateBody(
  view: DeviceFlowPublicView,
  callerClientId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceFlowId: view.deviceFlowId,
    providerId: view.providerId,
    status: view.status,
    createdAt: view.createdAt,
  };
  if (view.errorKind) body['errorKind'] = view.errorKind;
  if (view.hint) body['hint'] = view.hint;
  if (view.expiresAt !== undefined) body['expiresAt'] = view.expiresAt;
  if (view.intervalMs !== undefined) body['intervalMs'] = view.intervalMs;
  if (view.lastPolledAt !== undefined) body['lastPolledAt'] = view.lastPolledAt;
  // PR #4255 follow-up review thread (deepseek-v4-pro): symmetrize with
  // the POST take-over response shape — only echo `userCode` /
  // `verificationUri` / `verificationUriComplete` / `initiatorClientId`
  // back to the original starter (matched by `X-Qwen-Client-Id`). An
  // anonymous GET caller, or a caller identifying as a different client,
  // sees only the public envelope (`status` / `errorKind` / `hint` /
  // timestamps). Bearer-token gated already (the route uses
  // `mutate({ strict: true })`), so the blast radius was small, but
  // multi-client setups sharing a single daemon token could otherwise
  // enumerate other clients' verification codes.
  //
  // **Threat model (PR #4291 follow-up review by Copilot):** this gate
  // is BEST-EFFORT ATTRIBUTION, not authentication. `X-Qwen-Client-Id`
  // is a syntactic header, not bound to a server-validated identity —
  // anyone holding the bearer token can spoof it. The bearer token IS
  // the auth boundary; this gate exists to prevent ACCIDENTAL
  // cross-client reads in well-behaved multi-SDK setups (and to keep
  // GET symmetric with the POST take-over shape closed out in
  // round-12 #6 of #4255). A determined attacker who has compromised
  // the daemon bearer token already wins; locking down GET further
  // would require binding identity into bearer-token issuance, which
  // is a separate architectural change.
  // PR #4291 follow-up review (qwen-latest, #3): the gate must accept
  // the both-undefined case too, otherwise an anonymously-started flow
  // (POST without `X-Qwen-Client-Id` → `initiatorClientId === undefined`)
  // becomes silently unreadable: even the same anonymous caller GETting
  // the same id can no longer retrieve `userCode`/`verificationUri` —
  // the body switches from "what they got from POST" to a redacted
  // public envelope, with HTTP 200, no error. Pre-PR-4291 GET returned
  // these fields to anyone with the bearer; this gate's purpose is to
  // prevent CROSS-client reads, not to lock anonymous flows out of
  // their own data.
  const callerIsInitiator =
    (view.initiatorClientId === undefined && callerClientId === undefined) ||
    (view.initiatorClientId !== undefined &&
      callerClientId !== undefined &&
      callerClientId === view.initiatorClientId);
  if (callerIsInitiator) {
    if (view.userCode) body['userCode'] = view.userCode;
    if (view.verificationUri) body['verificationUri'] = view.verificationUri;
    if (view.verificationUriComplete) {
      body['verificationUriComplete'] = view.verificationUriComplete;
    }
    if (view.initiatorClientId) {
      body['initiatorClientId'] = view.initiatorClientId;
    }
  }
  return body;
}

function parseClientIdHeader(
  req: import('express').Request,
  res: import('express').Response,
): string | undefined | null {
  const raw = req.get(CLIENT_ID_HEADER);
  if (raw === undefined || raw === '') return undefined;
  if (raw.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_RE.test(raw)) {
    res.status(400).json({
      error:
        '`X-Qwen-Client-Id` must be a non-empty token of 128 characters or fewer',
      code: 'invalid_client_id',
    });
    return null;
  }
  return raw;
}

/**
 * #4282 fold-in 1 (gpt-5.5 C2). Workspace-level mutation routes validate
 * the parsed `X-Qwen-Client-Id` against `bridge.knownClientIds()` so the
 * `originatorClientId` stamped onto fan-out events is grounded in a
 * client identity the daemon previously issued. Without this check, any
 * authenticated caller could forge the originator on `tool_toggled`,
 * `workspace_initialized`, and `mcp_server_restart*` events.
 *
 * Mirrors the inline check pattern in `workspaceMemory.ts` /
 * `workspaceAgents.ts` from PR 16. Returns the validated client id
 * (or `undefined` when no header was supplied), `null` when a 400 has
 * already been emitted by `parseClientIdHeader` or this validator.
 */
function parseAndValidateWorkspaceClientId(
  req: import('express').Request,
  res: import('express').Response,
  bridge: HttpAcpBridge,
): string | undefined | null {
  const raw = parseClientIdHeader(req, res);
  if (raw === null || raw === undefined) return raw;
  if (!bridge.knownClientIds().has(raw)) {
    res.status(400).json({
      error: `Client id "${raw}" is not registered for this workspace`,
      code: 'invalid_client_id',
      clientId: raw,
    });
    return null;
  }
  return raw;
}

function parsePermissionVoteBody(
  req: import('express').Request,
  res: import('express').Response,
): PermissionVoteResponse | undefined {
  const body = safeBody(req);
  const outcome = body['outcome'];
  if (!isValidOutcome(outcome)) {
    res.status(400).json({ error: INVALID_PERMISSION_OUTCOME_ERROR });
    return undefined;
  }
  return {
    ...(body as object),
    outcome,
  } as PermissionVoteResponse;
}

function isValidOutcome(
  raw: unknown,
): raw is { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (obj['outcome'] === 'cancelled') return true;
  // `optionId` must be a non-empty string. An empty string is technically a
  // string but isn't a meaningful selection — letting it through would
  // forward malformed votes to the bridge and the agent would reject the
  // unknown option opaquely.
  return (
    obj['outcome'] === 'selected' &&
    typeof obj['optionId'] === 'string' &&
    (obj['optionId'] as string).length > 0
  );
}

/** Range bounds for the `?maxQueued=N` query param on `/session/:id/events`. */
const MIN_QUERY_MAX_QUEUED = 16;
const MAX_QUERY_MAX_QUEUED = 2048;

/**
 * Parse the optional `?maxQueued=N` query param on
 * `GET /session/:id/events`. Returns:
 *   - `undefined` — param absent, EventBus uses its default cap (256).
 *   - a positive integer in `[16, 2048]` — caller wants a custom cap.
 *   - `null` — malformed value; the function ALREADY sent a 400 JSON
 *     response and the route must short-circuit. (Pre-handshake 400
 *     is safer than half-opening an SSE stream and emitting a
 *     `stream_error` frame the client has to parse — `EventSource`
 *     auto-reconnects on the latter.)
 *
 * Cap range rationale: lower bound 16 (smaller is useless for any
 * replay backlog); upper bound 2048 (so a single subscriber can't
 * pin ~1 MB of queue memory just by asking).
 */
function parseMaxQueuedQuery(
  raw: unknown,
  res: import('express').Response,
): number | undefined | null {
  // Absent param → undefined (use bus default). Present-but-empty
  // (`?maxQueued=` typed explicitly) → fail-CLOSED 400 — the API
  // documents fail-closed for any malformed value before opening
  // SSE, and an empty string is unambiguously malformed (real values
  // are positive integers in [16, 2048]).
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    // Sanitize via JSON.stringify so an attacker-controlled value
    // containing `\n` / `\r` / other control chars can't inject extra
    // log lines into stderr (line-based shipper like
    // journald/Loki/Splunk would otherwise treat the injected line as
    // a fresh entry). Matches the `workspace_mismatch` log style in
    // `sendBridgeError`.
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} ` +
        `(not a decimal integer)`,
    );
    res.status(400).json({
      error: '`maxQueued` must be a decimal integer',
      code: 'invalid_max_queued',
    });
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(n) ||
    n < MIN_QUERY_MAX_QUEUED ||
    n > MAX_QUERY_MAX_QUEUED
  ) {
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} ` +
        `(outside [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}])`,
    );
    res.status(400).json({
      error: `\`maxQueued\` must be in [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}]`,
      code: 'invalid_max_queued',
    });
    return null;
  }
  return n;
}

/**
 * Wrap an attacker-controllable string for safe interpolation into a
 * stderr log line. `JSON.stringify` escapes control characters
 * (`\n`, `\r`, etc.) and wraps the result in quotes — any injection
 * attempt surfaces as visible-as-quoted-noise rather than a
 * forged log line. Truncated AFTER stringify to keep the budget
 * predictable even for control-heavy inputs.
 */
function safeLogValue(raw: unknown): string {
  return JSON.stringify(String(raw)).slice(0, 82);
}

function parseLastEventId(raw: unknown): number | undefined {
  // Stricter than Number.parseInt: only accept pure decimal digits to avoid
  // values like "1abc" or "1.5e10z" silently parsing to 1.
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    // BX9_I: log a breadcrumb for the operator when a non-empty
    // header is rejected. The client resumed from event 0 instead
    // of where they meant to — without this line, the loss of
    // every event buffered during their disconnect was invisible.
    // Skip the log for missing / empty headers (the common case of
    // "first connect, no resume").
    if (typeof raw === 'string' && raw.length > 0) {
      writeStderrLine(
        `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} ` +
          `(not a decimal integer)`,
      );
    }
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  // Reject values that lose precision as a JS `number`. The bus's monotonic
  // ids are bounded by `Number.MAX_SAFE_INTEGER` (2^53 - 1); a client that
  // tries to resume from beyond that is either malicious or broken.
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
    writeStderrLine(
      `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} ` +
        `(exceeds Number.MAX_SAFE_INTEGER)`,
    );
    return undefined;
  }
  return n;
}

function sendPermissionVoteError(
  res: import('express').Response,
  err: unknown,
  ctx: { route: string; sessionId?: string },
): void {
  // BkwQI: voter's `optionId` wasn't in the option set the agent
  // originally offered (e.g. forging `ProceedAlways*` when the
  // prompt's `hideAlwaysAllow` policy suppressed it). 400, not
  // 404 — the requestId IS known, but the chosen option isn't.
  if (err instanceof InvalidPermissionOptionError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_option_id',
      requestId: err.requestId,
      optionId: err.optionId,
    });
    return;
  }
  sendBridgeError(res, err, ctx);
}

function formatSseFrame(event: BridgeEvent | OmitId<BridgeEvent>): string {
  // SSE format: id (optional), event (optional), data, blank line.
  // The `id:` line is intentionally omitted when `event.id` is absent —
  // terminal/synthetic frames (e.g. daemon-side `stream_error`) must not
  // burn a slot in the per-session monotonic sequence the client uses for
  // `Last-Event-ID` reconnect tracking.
  //
  // We always emit the payload as a single `data:` line. The EventSource
  // spec also allows a frame to span multiple `data:` lines (which a
  // conformant parser joins with `\n`); we don't emit that form because
  // our payload is JSON without embedded newlines after `JSON.stringify`.
  // The SDK parser at `sdk-typescript/src/daemon/sse.ts` handles the
  // multi-line variant on the receive side — input/output asymmetry is
  // intentional.
  const dataJson = JSON.stringify(event);
  const idLine =
    'id' in event && event.id !== undefined ? `id: ${event.id}\n` : '';
  return `${idLine}event: ${event.type}\ndata: ${dataJson}\n\n`;
}

type OmitId<T> = Omit<T, 'id'>;

/**
 * Map a thrown bridge error to an HTTP response.
 *
 * `ctx` is operator-facing: route + sessionId folded into the stderr
 * log line so a bare `ECONNRESET` / `ENOMEM` stack trace is
 * attributable to a specific session and request without having to
 * timestamp-correlate against client logs. Pass via the route handlers
 * — see how they call `sendBridgeError(res, err, { route: 'POST
 * /session/:id/prompt', sessionId })`. Optional so test/dev call
 * sites that don't care about the log can omit it.
 */
function sendBridgeError(
  res: import('express').Response,
  err: unknown,
  ctx?: { route?: string; sessionId?: string },
): void {
  if (err instanceof WorkspaceInitConflictError) {
    // #4175 Wave 4 PR 17. The target file already exists with non-
    // whitespace content and the caller did not pass `force: true`.
    // Body carries the resolved path + size so SDK clients can render
    // a "file already exists; pass force: true to overwrite" prompt
    // without re-stat'ing the workspace.
    res.status(409).json({
      error: err.message,
      code: 'workspace_init_conflict',
      path: err.path,
      existingSize: err.existingSize,
    });
    return;
  }
  if (err instanceof McpServerNotFoundError) {
    // #4282 fold-in 1 (gpt-5.5 C5). Stable 404 for "MCP server name
    // not in `mcpServers` config" so callers can distinguish a typo
    // from an internal daemon failure.
    res.status(404).json({
      error: err.message,
      code: 'mcp_server_not_found',
      serverName: err.serverName,
    });
    return;
  }
  if (err instanceof McpServerRestartFailedError) {
    // #4282 fold-in 1 (gpt-5.5 C4). 502 because the daemon understood
    // the request and the upstream (the MCP server / its child
    // process) failed to come back online. `errorKind: 'protocol_error'`
    // shares the closed PR-13 taxonomy.
    res.status(502).json({
      error: err.message,
      code: 'mcp_server_restart_failed',
      errorKind: 'protocol_error',
      serverName: err.serverName,
      mcpStatus: err.mcpStatus,
    });
    return;
  }
  if (err instanceof TrustGateError) {
    // #4175 Wave 4 PR 17: trust-folder rejection from
    // `Config.setApprovalMode`. 403 because the daemon understood the
    // request but the workspace's trust posture forbids the privileged
    // mode. `errorKind: 'auth_env_error'` shares the closed PR 13
    // taxonomy so SDK consumers branch on the same enum already used by
    // preflight / env diagnostics.
    res.status(403).json({
      error: err.message,
      code: 'trust_gate',
      errorKind: 'auth_env_error',
    });
    return;
  }
  if (err instanceof SessionNotFoundError) {
    res.status(404).json({ error: err.message, sessionId: err.sessionId });
    return;
  }
  if (err instanceof InvalidClientIdError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_client_id',
      sessionId: err.sessionId,
      clientId: err.clientId,
    });
    return;
  }
  if (err instanceof WorkspaceMismatchError) {
    // #3803 §02 single-workspace mode: the daemon binds to one
    // workspace at boot; cross-workspace POSTs are rejected here.
    // 400 (not 404 — the daemon is "fine", the client just picked
    // the wrong daemon for their workspace). Body includes both
    // paths so orchestrator-aware clients can route to the right
    // daemon / spawn a new one.
    //
    // Operator log line: unlike SessionNotFoundError (per-session
    // 404 with rich URL context), workspace_mismatch indicates an
    // orchestration / deployment drift (operator booted with the
    // wrong workspace, or client is routing to the wrong daemon).
    // Without a breadcrumb the daemon's log looks healthy while
    // every client request silently 400s. Limited to authenticated
    // requests by the upstream bearer-token gate, so probing-DoS
    // log noise stays bounded.
    // SECURITY: `err.requested` is derived from the request body
    // (`req.workspaceCwd` → `canonicalizeWorkspace` → here). `path.resolve`
    // + `realpathSync.native` both preserve control characters inside
    // path segments — they only normalize separators / `..` / `.` and
    // walk symlinks. A body like `{"cwd": "/legit/path\nqwen serve:
    // FAKE LOG LINE"}` would otherwise emit two valid-looking daemon
    // log lines, weaponizing line-based log shippers (Splunk / Loki /
    // journald → SIEM). `JSON.stringify` escapes control chars and
    // wraps in quotes so any injection attempt surfaces as
    // visible-as-quoted-noise rather than forged-line. `err.bound` is
    // safe (canonicalized at boot from operator-controlled
    // `--workspace` / `process.cwd()`) but quoted symmetrically for
    // readability.
    writeStderrLine(
      `qwen serve: workspace_mismatch (POST /session): ` +
        `daemon bound to ${JSON.stringify(err.bound)}, ` +
        `rejected ${JSON.stringify(err.requested)}`,
    );
    res.status(400).json({
      error: err.message,
      code: 'workspace_mismatch',
      boundWorkspace: err.bound,
      requestedWorkspace: err.requested,
    });
    return;
  }
  if (err instanceof InvalidSessionScopeError) {
    // Same wire shape as the route-layer 400 (`server.ts` validates
    // body['sessionScope'] before calling the bridge). A direct embed
    // / test caller bypassing the route would otherwise see a generic
    // 500 — the typed translation keeps both layers in agreement so
    // SDK clients can branch on `code` regardless of which layer
    // surfaced the rejection.
    res.status(400).json({
      error: err.message,
      code: 'invalid_session_scope',
    });
    return;
  }
  if (err instanceof InvalidSessionMetadataError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_metadata',
      field: err.field,
    });
    return;
  }
  if (err instanceof SessionLimitExceededError) {
    // 503 Service Unavailable + `Retry-After` is the canonical
    // "we'd serve you, but we're full right now" shape. The hint
    // is intentionally conservative (5s) because a session that
    // finishes a prompt frees a slot quickly under normal load;
    // a client that backs off too aggressively wastes capacity.
    res.set('Retry-After', '5');
    res.status(503).json({
      error: err.message,
      code: 'session_limit_exceeded',
      limit: err.limit,
    });
    return;
  }
  if (err instanceof RestoreInProgressError) {
    // Match `SessionLimitExceededError`'s 5s hint (above) — the
    // underlying restore can take up to `initTimeoutMs` (default
    // 10s) on the agent side, so a 1s retry hint pushed clients
    // into tight loops that kept hitting the same 409.
    res.set('Retry-After', '5');
    res.status(409).json({
      error: err.message,
      code: 'restore_in_progress',
      sessionId: err.sessionId,
      activeAction: err.activeAction,
      requestedAction: err.requestedAction,
    });
    return;
  }
  if (err instanceof SessionBusyError) {
    res.set('Retry-After', '5');
    res.status(409).json({
      error: err.message,
      code: 'session_busy',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof InvalidRewindTargetError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_rewind_target',
      sessionId: err.sessionId,
    });
    return;
  }
  // 5xx is the kind of error operators need to see in their daemon log
  // — bridge ENOMEM, agent stack trace, unexpected throw, etc. Without
  // logging here every 500 disappears once the caller consumes the
  // response body. This is a stop-gap until structured access/error
  // logging lands (tracked under §10 follow-ups). Use the stdio helper
  // (not `console.error`) to keep the no-console lint rule happy and
  // route through the same writer the rest of the daemon uses.
  const ctxParts = [
    ctx?.route,
    ctx?.sessionId ? `session=${ctx.sessionId}` : undefined,
  ].filter(Boolean);
  const ctxStr = ctxParts.length > 0 ? ` (${ctxParts.join(' ')})` : '';
  writeStderrLine(
    `qwen serve: bridge error${ctxStr}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  res.status(500).json(errorPayload(err));
}

/**
 * Coerce an arbitrary thrown value to a useful string. Plain `String(err)`
 * yields `[object Object]` for JSON-RPC-shaped errors (`{code, message,
 * data}`) which are exactly what the ACP SDK forwards from the agent. Try
 * the `message` field first, fall back to JSON-stringify, then `String`.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.length > 0) return maybe;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

/**
 * Build the JSON body for a 5xx response. The ACP SDK forwards
 * JSON-RPC-shaped errors like `{code: -32000, message: "Internal error",
 * data: {reason: "model quota exceeded"}}` — discarding `code`/`data`
 * collapses every distinct failure (quota / rate-limit / auth /
 * crash) to the same opaque `"Internal error"` string at the client.
 * Forward both fields so callers can triage from response body alone.
 * `error` stays as the human-readable string for backward compatibility
 * with clients that only consumed `error` in the original shape.
 *
 * BSA0G acknowledged: forwarding `data` verbatim leaks per-error
 * detail (file paths in upstream tool failures, partial API response
 * snippets, etc.) to every authenticated SSE subscriber that
 * observes 5xx responses. In Stage 1's single-user / small-team
 * trust model (every authenticated client is the same human or
 * collaborators they trust) this is acceptable — and the triage
 * value of the rich error is high. Stage 2 multi-tenant deployments
 * will need an opt-in `--redact-errors` flag (or per-deployment
 * policy hook) that strips `data` and replaces it with an
 * error-class identifier; tracked under #3803 follow-ups.
 */
function errorPayload(err: unknown): {
  error: string;
  code?: unknown;
  data?: unknown;
} {
  const out: { error: string; code?: unknown; data?: unknown } = {
    error: errorMessage(err),
  };
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if ('code' in obj) out.code = obj['code'];
    if ('data' in obj) out.data = obj['data'];
  }
  return out;
}
