/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Application, Request, Response } from 'express';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import type { DaemonLogger } from './daemon-logger.js';
import type { DaemonStartupSnapshot } from './daemon-status.js';
import {
  allowOriginCors,
  bearerAuth,
  createMutationGate,
  denyBrowserOriginCors,
  hostAllowlist,
  parseAllowOriginPatterns,
} from './auth.js';
import {
  DeviceFlowRegistry,
  setDeviceFlowRegistry,
  type DeviceFlowEventSink,
  type DeviceFlowProvider,
  type DeviceFlowProviderId,
} from './auth/device-flow.js';
import type { DaemonStatusProvider } from '@qwen-code/acp-bridge';
import { QwenOAuthDeviceFlowProvider } from './auth/qwen-device-flow-provider.js';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import { createDaemonStatusProvider } from './daemon-status-provider.js';
import { createWorkspaceProvidersStatusProvider } from './workspace-providers-status.js';
import { SUPPORTED_LANGUAGES } from '../i18n/index.js';
import { loadSettings } from '../config/settings.js';
import { mountAcpHttp, type AcpHttpHandle } from './acp-http/index.js';
import { createVoiceWsConnectionHandler } from './voice/voice-ws.js';
import {
  canonicalizeWorkspace,
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import {
  getAdvertisedServeFeatures,
  getServeProtocolVersions,
} from './capabilities.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeAuthProviderInstallRequest,
  type ServeAuthProviderInstallResult,
  type ServeOptions,
} from './types.js';
import {
  mountWebShellAssets,
  mountWebShellSpaFallback,
} from './web-shell-static.js';
import { mountWorkspaceMemoryRoutes } from './workspace-memory.js';
import { mountWorkspaceAgentsRoutes } from './workspace-agents.js';
import { registerDaemonStatusRoutes } from './routes/daemon-status.js';
import { createHealthDemoRoutes } from './routes/health-demo.js';
import { registerWorkspaceAuthRoutes } from './routes/workspace-auth.js';
import { registerWorkspaceExtensionRoutes } from './routes/workspace-extensions.js';
import type { WorkspaceFileSystemFactory } from './fs/index.js';
import { registerWorkspaceFileReadRoutes } from './routes/workspace-file-read.js';
import { registerWorkspaceFileWriteRoutes } from './routes/workspace-file-write.js';
import { registerWorkspaceSetupGithubRoutes } from './routes/workspace-setup-github.js';
import { registerWorkspaceTrustRoutes } from './routes/workspace-trust.js';
import { registerPermissionRoutes } from './routes/permission.js';
import { registerSessionRoutes } from './routes/session.js';
import {
  registerWorkspaceDiagnosticStatusRoutes,
  registerWorkspaceStatusRoutes,
} from './routes/workspace-status.js';
import {
  createDaemonWorkspaceService,
  type DaemonWorkspaceService,
  type WorkspaceRequestContext,
} from './workspace-service/index.js';
import { registerWorkspacePermissionsRoutes } from './routes/workspace-permissions.js';
import { registerWorkspaceSettingsRoutes } from './routes/workspace-settings.js';
import {
  getActiveSseCount,
  registerSseEventsRoutes,
} from './routes/sse-events.js';
import {
  registerWorkspaceVoiceRoutes,
  type WorkspaceVoiceRouteDeps,
} from './routes/workspace-voice.js';
import { hasConfiguredBatchVoiceTranscriptionModel } from '../services/voice-service.js';
import { registerA2uiActionRoutes } from './routes/a2ui-action.js';
import {
  createRateLimiter,
  setRateLimiter,
  type RateLimiterInstance,
} from './rate-limit.js';
import {
  sendBridgeError as sendBridgeErrorResponse,
  sendPermissionVoteError as sendPermissionVoteErrorResponse,
  type SendBridgeError,
} from './server/error-response.js';
import { resolveBridgeFsFactory } from './server/fs-factory.js';
import {
  MAX_SERVER_NAME_LENGTH,
  MAX_TOOL_NAME_LENGTH,
  parseAndValidateWorkspaceClientId,
  parseClientIdHeader,
  safeBody,
  sendJsonBodyParserError,
  validateMcpRuntimeServerName,
} from './server/request-helpers.js';
import { daemonTelemetryMiddleware } from './server/telemetry.js';

export {
  createDefaultFsAuditEmit,
  resolveBridgeFsFactory,
} from './server/fs-factory.js';
export {
  PromptDeadlineExceededError,
  resolvePromptDeadlineMs,
} from './server/prompt-deadline.js';
export { detectFromLoopback } from './server/request-helpers.js';
export {
  InvalidCursorError,
  listWorkspaceSessionsForResponse,
} from './server/session-list.js';
export type {
  ListWorkspaceSessionsOptions,
  ListWorkspaceSessionsResult,
} from './server/session-list.js';
export { getActiveSseCount } from './routes/sse-events.js';

function isWorkspaceVoiceTranscriptionAvailable(
  boundWorkspace: string,
): boolean {
  try {
    return hasConfiguredBatchVoiceTranscriptionModel(
      loadSettings(boundWorkspace),
    );
  } catch (err) {
    writeStderrLine(
      `qwen serve: workspace voice transcription capability check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Module-scoped once-per-process guard for the `createServeApp`
 * default-trust stderr warning. Without this, tests calling
 * `createServeApp` repeatedly would flood stderr with identical lines.
 */
let warnedDefaultTrust = false;

export interface ServeAppDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: AcpSessionBridge;
  /**
   * Directory of the built Web Shell SPA (`index.html` + `assets/`). When
   * set (and `opts.serveWebShell !== false`), `createServeApp` mounts the
   * UI at the daemon root before `bearerAuth`. Production `runQwenServe`
   * resolves this via `resolveWebShellDir()` and injects it here; direct
   * embeds / tests opt in by passing a fixture dir, so the default
   * `createServeApp` (no injection) stays API-only and existing route tests
   * are unaffected.
   */
  webShellDir?: string;
  /**
   * Qwen Code version advertised to web/SDK clients. Production passes the
   * resolved CLI package version; tests/direct embeds may omit it.
   */
  qwenCodeVersion?: string;
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
   * Workspace filesystem boundary factory. When supplied, file routes
   * pull a per-request `WorkspaceFileSystem` off it; when omitted,
   * `createServeApp` builds a strict default (`trusted: false`,
   * warn-once no-op `emit`) so an upstream refactor that forgets to
   * inject `fsFactory` never silently allows writes against an
   * untrusted workspace.
   */
  fsFactory?: WorkspaceFileSystemFactory;
  /**
   * Device-flow auth registry. Tests inject a fake; production callers
   * omit this and `createServeApp` constructs a default wired to the
   * shipped Qwen provider, the bridge's `publishWorkspaceEvent`,
   * and a stderr audit sink.
   */
  deviceFlowRegistry?: DeviceFlowRegistry;
  /**
   * Extra device-flow providers for tests / future extensions.
   * Production builds register only `QwenOAuthDeviceFlowProvider`;
   * passing extra entries here registers them in addition.
   */
  deviceFlowProviders?: DeviceFlowProvider[];
  /**
   * Installs an LLM auth provider by applying the same provider install plan
   * used by interactive `/auth`. Production `runQwenServe` injects a
   * settings-backed implementation; tests/direct embeds may omit it, in which
   * case the route reports `not_implemented`.
   */
  installAuthProvider?: (
    req: ServeAuthProviderInstallRequest,
  ) => Promise<ServeAuthProviderInstallResult>;
  /**
   * Optional daemon logger. When provided, `sendBridgeError` routes
   * each 5xx error through `daemonLog.error(...)` (which tees to stderr +
   * the daemon log file). When omitted, falls back to existing
   * stderr-only behavior.
   */
  daemonLog?: DaemonLogger;
  startup?: DaemonStartupSnapshot;
  workspace?: DaemonWorkspaceService;
  statusProvider?: DaemonStatusProvider;
  persistDisabledTools?: (
    workspace: string,
    toolName: string,
    enabled: boolean,
  ) => Promise<void>;
  contextFilename?: string;
  persistSetting?: (
    workspace: string,
    scope: import('../config/settings.js').SettingScope,
    key: string,
    value: unknown,
  ) => Promise<void | import('../config/settings.js').LoadedSettings>;
  persistSettings?: (
    workspace: string,
    writes: Array<{
      scope: import('../config/settings.js').SettingScope;
      key: string;
      value: unknown;
    }>,
  ) => Promise<void>;
  voiceTranscriber?: WorkspaceVoiceRouteDeps['transcribe'];
}

// Keep in sync with acp-bridge bridge.ts and SDK DaemonClient.ts.
const DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;

function advertisedMaxPendingPromptsPerSession(
  value: number | undefined,
): number | null {
  if (value === undefined) return DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  if (value === 0 || value === Number.POSITIVE_INFINITY) return null;
  return value;
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
 * Supported routes:
 *   - `GET  /health`
 *   - `GET  /daemon/status`
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
 *   - `GET  /session/:id/status`
 *   - `GET  /session/:id/context`
 *   - `GET  /session/:id/supported-commands`
 *   - `GET  /session/:id/tasks`
 *   - `GET  /session/:id/lsp`
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
  // The daemon is bound to exactly one workspace. The value advertised
  // on `/capabilities`, used for the `POST /session` cwd fallback,
  // AND passed into the bridge must be the SAME canonical form.
  // `deps.boundWorkspace` is the pre-canonicalized fast-path from
  // `runQwenServe`; when omitted we canonicalize ourselves.
  const boundWorkspace =
    deps.boundWorkspace ??
    canonicalizeWorkspace(opts.workspace ?? process.cwd());
  // Construct `fsFactory` BEFORE the bridge so the bridge can wire it
  // through `BridgeFileSystem` for ACP-side writeTextFile/readTextFile.
  // Default trust is `false` (test-safe). Embeds without `deps.fsFactory`
  // or `deps.bridge` will see agent writes rejected with
  // `untrusted_workspace` — warn once so the asymmetry is visible.
  if (!deps.fsFactory && !deps.bridge && !warnedDefaultTrust) {
    warnedDefaultTrust = true;
    process.stderr.write(
      'qwen serve: createServeApp default fsFactory uses trusted=false ' +
        '— agent ACP writeTextFile calls will reject with untrusted_workspace. ' +
        'Inject deps.fsFactory (with explicit trust) or deps.bridge to override.\n',
    );
  }
  const fsFactory = resolveBridgeFsFactory({
    boundWorkspace,
    injected: deps.fsFactory,
    trusted: false,
  });
  let cachedVoiceTranscriptionAvailable: boolean | undefined;
  const invalidateServeFeaturesCache = () => {
    cachedVoiceTranscriptionAvailable = undefined;
  };
  const getCachedVoiceTranscriptionAvailable = () => {
    cachedVoiceTranscriptionAvailable ??=
      isWorkspaceVoiceTranscriptionAvailable(boundWorkspace);
    return cachedVoiceTranscriptionAvailable;
  };
  const tokenConfigured =
    typeof opts.token === 'string' && opts.token.length > 0;
  const sessionShellCommandEnabled =
    opts.enableSessionShell === true && tokenConfigured;
  const statusProvider = deps.statusProvider ?? createDaemonStatusProvider();
  const bridge =
    deps.bridge ??
    createAcpSessionBridge({
      maxSessions: opts.maxSessions,
      maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession,
      eventRingSize: opts.eventRingSize,
      permissionResponseTimeoutMs: opts.permissionResponseTimeoutMs,
      boundWorkspace,
      sessionShellCommandEnabled,
      // Wire the production status provider so direct embeds / tests
      // that don't inject `deps.bridge` get daemon env + preflight cells.
      statusProvider,
      // Wire the WorkspaceFileSystem adapter so ACP writeTextFile /
      // readTextFile pick up trust / TOCTOU / audit.
      fileSystem: createBridgeFileSystemAdapter(fsFactory),
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

  // Park the factory on `app.locals` so route handlers can pick it up
  // via `req.app.locals.fsFactory` without re-threading the value
  // through every handler signature.
  (app.locals as { fsFactory?: WorkspaceFileSystemFactory }).fsFactory =
    fsFactory;
  // Surface the bound workspace on `app.locals` so file routes can
  // compute workspace-relative response paths without re-resolving.
  (app.locals as { boundWorkspace?: string }).boundWorkspace = boundWorkspace;

  // Wire the device-flow registry. Default builds a single Qwen
  // provider; tests inject `deps.deviceFlowRegistry` or
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
          // 8 chars so log
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
          // Include `line.hint` for operator-only breadcrumbs that
          // aren't surfaced over SSE. Bound at 1 KiB.
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
  // Park the registry on `app.locals` so request handlers can reach it.
  // Typed accessor prevents a string-key typo from silently detaching
  // `runQwenServe`'s shutdown dispose call.
  setDeviceFlowRegistry(app, deviceFlowRegistry);

  const { daemonLog } = deps;

  const sendBridgeError: SendBridgeError = (res, err, ctx) =>
    sendBridgeErrorResponse(res, err, ctx, daemonLog);
  const sendPermissionVoteError = (
    res: import('express').Response,
    err: unknown,
    ctx: { route: string; sessionId?: string },
  ) => sendPermissionVoteErrorResponse(res, err, ctx, daemonLog);

  const workspace: DaemonWorkspaceService =
    deps.workspace ??
    createDaemonWorkspaceService({
      boundWorkspace,
      contextFilename: deps.contextFilename ?? 'QWEN.md',
      statusProvider,
      workspaceProvidersStatusProvider:
        createWorkspaceProvidersStatusProvider(),
      isChannelLive: () => bridge.isChannelLive(),
      persistDisabledTools:
        deps.persistDisabledTools ??
        (async () => {
          throw new Error(
            'setWorkspaceToolEnabled requires persistDisabledTools in ServeAppDeps',
          );
        }),
      queryWorkspaceStatus: (method, idle) =>
        bridge.queryWorkspaceStatus(method, idle),
      invokeWorkspaceCommand: (method, params, invokeOpts) =>
        bridge.invokeWorkspaceCommand(method, params, invokeOpts),
      refreshExtensionsForAllSessions: () =>
        bridge.refreshExtensionsForAllSessions(),
      ...(deps.persistSetting ? { persistSetting: deps.persistSetting } : {}),
      ...(deps.persistSettings
        ? { persistSettings: deps.persistSettings }
        : {}),
      publishWorkspaceEvent: (event) => {
        if (
          event.type === 'settings_changed' ||
          event.type === 'settings_reloaded'
        ) {
          invalidateServeFeaturesCache();
        }
        bridge.publishWorkspaceEvent(event);
      },
    });
  let rateLimiter: RateLimiterInstance | undefined;

  // Order matters: rejection guards (CORS / Host allowlist / bearer auth)
  // run BEFORE the JSON body parser. Otherwise an unauthenticated POST
  // gets a full 10MB `JSON.parse` before the 401 fires — a trivially
  // amplified CPU/memory cost from any wrong-token client.
  //
  // When `--allow-origin` is configured, install the
  // allowlist middleware instead of the deny-wall. The allowlist owns
  // both halves of the policy (matched → CORS headers + pass-through or
  // 204 preflight; unmatched → 403 with the same error envelope as the
  // wall). When `--allow-origin` is empty/undefined, the deny-wall stays
  // installed. Pattern parsing happens in `run-qwen-serve.ts` for validation;
  // here we still keep the wildcard/no-token invariant for embedded
  // callers that construct the app directly.
  if (opts.allowOrigins && opts.allowOrigins.length > 0) {
    const parsedAllowOrigins = parseAllowOriginPatterns(opts.allowOrigins);
    if (parsedAllowOrigins.allowAny && !opts.token) {
      throw new Error(
        `Refusing to start with --allow-origin '*' but no bearer token ` +
          `configured. '*' admits any cross-origin browser to the API; ` +
          `without a token, any local page can drive the daemon. Set a ` +
          `token or list specific origins instead of '*'.`,
      );
    }
    app.use(allowOriginCors(parsedAllowOrigins));
  } else {
    app.use(denyBrowserOriginCors);
  }
  app.use(hostAllowlist(opts.hostname, getPort));

  const healthDemoRoutes = createHealthDemoRoutes({
    opts,
    getPort,
    bridge,
    getActiveSseCount,
    getRateLimiter: () => rateLimiter,
  });
  if (healthDemoRoutes.exposeHealthPreAuth) {
    healthDemoRoutes.register(app);
  }

  // Access-log middleware. Registered BEFORE bearerAuth and JSON parser
  // so auth rejections (401) and malformed-body errors (400) are also
  // captured in the daemon log. Excluded:
  //  - GET /health (high-frequency probe, would drown signal)
  //  - Successful SSE streams (GET .../events with 200) — logged inline
  //    at open/close; failed SSE handshakes (4xx) are still recorded.
  if (daemonLog) {
    const SESSION_ID_RE = /\/session\/([^/]+)/;
    app.use((req, res, next) => {
      const { method, path: reqPath } = req;
      if (
        (method === 'GET' && reqPath === '/health') ||
        (method === 'POST' && reqPath.endsWith('/heartbeat'))
      ) {
        return next();
      }
      const startMs = Date.now();
      res.on('finish', () => {
        try {
          const status = res.statusCode;
          if (
            method === 'GET' &&
            reqPath.endsWith('/events') &&
            status === 200
          ) {
            return;
          }
          const durationMs = Date.now() - startMs;
          const sessionMatch = reqPath.match(SESSION_ID_RE);
          const sessionId = sessionMatch?.[1];
          const clientId = req.headers['x-qwen-client-id'] as
            | string
            | undefined;
          const ctx = {
            route: `${method} ${reqPath}`,
            ...(sessionId ? { sessionId } : {}),
            ...(clientId ? { clientId } : {}),
            status,
            durationMs,
          };
          if (status >= 400) {
            daemonLog.warn('request completed', ctx);
          } else {
            daemonLog.info('request completed', ctx);
          }
        } catch {
          // Logging failure must not affect the request.
        }
      });
      next();
    });
  }

  // Serve the Web Shell static assets (/ and /assets) BEFORE bearerAuth. The
  // static shell carries no secrets and a browser cannot attach an
  // Authorization header to a `<script src>` subresource or an address-bar
  // navigation, so gating it would just break the UI — the front-end's own
  // API calls still carry the bearer (getDaemonAuthHeaders) and every API
  // route below stays token-gated. The SPA deep-link fallback is registered
  // LATER (after all API routes, see mountWebShellSpaFallback) so authed
  // routes win over the shell. The assets dir is resolved by the caller
  // (runQwenServe) and injected via deps.webShellDir; `--no-web` sets
  // opts.serveWebShell=false to opt out.
  const webShellDir =
    opts.serveWebShell !== false ? deps.webShellDir : undefined;
  if (webShellDir) {
    mountWebShellAssets(app, webShellDir);
  }

  app.use(bearerAuth(opts.token));

  // Rate limiter: after auth (only count authenticated requests),
  // before body parser (reject early without burning JSON.parse CPU).
  if (opts.rateLimit) {
    const windowMs = opts.rateLimitWindowMs ?? 60_000;
    rateLimiter = createRateLimiter({
      tiers: {
        prompt: { windowMs, max: opts.rateLimitPrompt ?? 10 },
        mutation: { windowMs, max: opts.rateLimitMutation ?? 30 },
        read: { windowMs, max: opts.rateLimitRead ?? 120 },
      },
      hostname: opts.hostname,
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
  }

  app.use(express.json({ limit: '10mb' }));
  app.use(
    (
      err: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      if (sendJsonBodyParserError(res, err)) return;
      next(err);
    },
  );

  if (!healthDemoRoutes.exposeHealthPreAuth) {
    // Non-loopback OR loopback with `--require-auth`: register
    // `/health` and `/demo` AFTER `bearerAuth` so probes must carry
    // the token. Otherwise unauthenticated callers can ping any
    // reachable address:port to confirm a daemon exists (and `/demo`
    // leaks the full API surface).
    healthDemoRoutes.register(app);
  }

  // Mutation-route gate factory. Non-strict mode is passthrough;
  // `{ strict: true }` requires a token even on loopback defaults.
  const mutate = createMutationGate({
    tokenConfigured,
    requireAuth: opts.requireAuth === true,
  });

  app.use(daemonTelemetryMiddleware(boundWorkspace));

  function buildWorkspaceCtx(
    req: import('express').Request,
    route: string,
    clientId?: string,
  ): WorkspaceRequestContext {
    return {
      originatorClientId: clientId,
      route,
      workspaceCwd: boundWorkspace,
    };
  }

  const LANGUAGE_CODES = [...SUPPORTED_LANGUAGES.map((l) => l.code), 'auto'];
  const currentServeFeatures = () =>
    getAdvertisedServeFeatures(undefined, {
      requireAuth: opts.requireAuth === true,
      mcpPoolActive: opts.mcpPoolActive !== false,
      allowOriginActive:
        opts.allowOrigins !== undefined && opts.allowOrigins.length > 0,
      ...(opts.promptDeadlineMs !== undefined
        ? { promptDeadlineMs: opts.promptDeadlineMs }
        : {}),
      ...(opts.writerIdleTimeoutMs !== undefined
        ? { writerIdleTimeoutMs: opts.writerIdleTimeoutMs }
        : {}),
      persistSettingAvailable: deps.persistSetting !== undefined,
      sessionShellCommandEnabled,
      rateLimit: opts.rateLimit === true,
      reloadAvailable: deps.workspace !== undefined,
      voiceTranscriptionAvailable: getCachedVoiceTranscriptionAvailable(),
      // Advertised whenever the `/voice/stream` WS endpoint exists (ACP HTTP
      // on). A configured token no longer suppresses it — the browser carries
      // the bearer token via the WS subprotocol, which the upgrade listener
      // verifies (acp-http/index.ts).
      voiceWsAvailable: process.env['QWEN_SERVE_ACP_HTTP'] !== '0',
    });
  const acpHandleRef: { current?: AcpHttpHandle } = {};

  registerDaemonStatusRoutes(app, {
    opts,
    boundWorkspace,
    bridge,
    workspace,
    daemonLog,
    startup: deps.startup,
    qwenCodeVersion: deps.qwenCodeVersion,
    getAcpHandle: () => acpHandleRef.current,
    getRateLimiter: () => rateLimiter,
    getRestSseActive: getActiveSseCount,
    currentServeFeatures,
    getSupportedDeviceFlowProviders: () =>
      Array.from(deviceFlowProviderMap.keys()),
    deviceFlowRegistry,
    sessionShellCommandEnabled,
  });

  app.get('/capabilities', (_req, res) => {
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      protocolVersions: getServeProtocolVersions(),
      ...(deps.qwenCodeVersion
        ? { qwenCodeVersion: deps.qwenCodeVersion }
        : {}),
      mode: opts.mode,
      features: currentServeFeatures(),
      modelServices: [],
      // Surface the bound workspace so clients can detect mismatch
      // pre-flight and omit `cwd` on `POST /session`.
      workspaceCwd: boundWorkspace,
      // Advertise supported transport families so SDK clients can
      // auto-negotiate the best available transport via
      // `negotiateTransport()`. REST is always available; future PRs
      // will add 'acp-http' / 'acp-ws' entries when the corresponding
      // routes are wired.
      transports: ['rest'],
      // Active mediation policy under the `policy` namespace.
      policy: { permission: bridge.permissionPolicy },
      limits: {
        maxPendingPromptsPerSession: advertisedMaxPendingPromptsPerSession(
          opts.maxPendingPromptsPerSession,
        ),
      },
      supportedLanguages: LANGUAGE_CODES,
    };
    res.status(200).json(envelope);
  });

  registerWorkspaceStatusRoutes(app, {
    boundWorkspace,
    bridge,
    workspace,
    sendBridgeError,
  });

  // Workspace memory + agents CRUD routes.
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

  registerWorkspaceDiagnosticStatusRoutes(app, {
    boundWorkspace,
    bridge,
    workspace,
    sendBridgeError,
  });

  registerWorkspaceExtensionRoutes(app, {
    boundWorkspace,
    bridge,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
  });

  // Workspace file routes (read-only + mutation).
  registerWorkspaceFileReadRoutes(app, {
    parseClientId: parseClientIdHeader,
  });
  registerWorkspaceFileWriteRoutes(app, {
    bridge,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  registerWorkspaceSetupGithubRoutes(app, {
    boundWorkspace,
    bridge,
    mutate,
    parseClientId: parseClientIdHeader,
    safeBody,
  });
  registerWorkspaceTrustRoutes(app, {
    boundWorkspace,
    workspace,
    mutate,
    safeBody,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, bridge),
  });

  const broadcastSettingsChanged = (
    key: string,
    value: unknown,
    scope: string,
    clientId: string | undefined,
  ) => {
    invalidateServeFeaturesCache();
    bridge.publishWorkspaceEvent({
      type: 'settings_changed',
      data: { key, value, scope },
      ...(clientId ? { originatorClientId: clientId } : {}),
    });
  };

  if (deps.persistSetting) {
    const persistSetting = deps.persistSetting;
    registerWorkspaceSettingsRoutes(app, {
      boundWorkspace,
      mutate,
      safeBody,
      persistSetting: async (...args) => {
        await persistSetting(...args);
      },
      broadcastSettingsChanged,
      parseAndValidateClientId: (req, res) =>
        parseAndValidateWorkspaceClientId(req, res, bridge),
    });
  }
  registerWorkspacePermissionsRoutes(app, {
    boundWorkspace,
    mutate,
    safeBody,
    workspace,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, bridge),
  });
  registerWorkspaceVoiceRoutes(app, {
    boundWorkspace,
    mutate,
    safeBody,
    persistSetting: deps.persistSetting,
    persistSettings: deps.persistSettings,
    transcribe: deps.voiceTranscriber,
    broadcastSettingsChanged,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, bridge),
  });

  // A2UI action inbound (the upstream half of A2UI-over-MCP): user
  // interactions from web clients are proxied to the UI MCP server's
  // standard `action` tool.
  registerA2uiActionRoutes(app, {
    boundWorkspace,
    mutate,
    safeBody,
    // UI-server discovery uses the daemon's workspace MCP status, which
    // includes servers registered at runtime.
    getMcpServers: async (req) => {
      const ctx = buildWorkspaceCtx(req, 'POST /session/:id/a2ui-action');
      const status = await workspace.getWorkspaceMcpStatus(ctx);
      return (status.servers ?? []) as Array<{
        name: string;
        mcpStatus?: string;
        config?: Record<string, unknown>;
      }>;
    },
  });

  registerWorkspaceAuthRoutes(app, {
    mutate,
    deviceFlowRegistry,
    getSupportedDeviceFlowProviders: () =>
      Array.from(deviceFlowProviderMap.keys()),
    sendBridgeError,
    boundWorkspace,
    allowPrivateAuthBaseUrl: opts.allowPrivateAuthBaseUrl === true,
    installAuthProvider: deps.installAuthProvider,
  });

  registerSessionRoutes(app, {
    boundWorkspace,
    bridge,
    mutate,
    sendBridgeError,
    daemonLog,
    promptDeadlineMs: opts.promptDeadlineMs,
    sessionShellCommandEnabled,
    languageCodes: LANGUAGE_CODES,
  });

  app.post(
    '/workspace/mcp/:server/restart',
    mutate({ strict: true }),
    async (req, res) => {
      // Single-server MCP restart with budget pre-check. Soft refusals
      // are 200 OK with `{restarted:false, skipped:true, reason}`.
      const serverName = req.params['server'];
      if (!serverName || typeof serverName !== 'string') {
        res.status(400).json({
          error: 'Server name path parameter is required',
          code: 'invalid_server_name',
        });
        return;
      }
      // Cap server name length to prevent unbounded path-parameter input.
      if (serverName.length > MAX_SERVER_NAME_LENGTH) {
        res.status(400).json({
          error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
          code: 'invalid_server_name',
        });
        return;
      }
      // Validate `X-Qwen-Client-Id` against known client ids.
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      // Parse `?entryIndex=` for pool-mode targeted restarts. Accepts
      // a non-negative integer or `*` / omitted (restart all).
      let entryIndex: number | undefined;
      const rawEntryIndex = req.query['entryIndex'];
      if (rawEntryIndex !== undefined && rawEntryIndex !== '*') {
        const candidate =
          typeof rawEntryIndex === 'string' ? rawEntryIndex : undefined;
        const parsed =
          candidate !== undefined ? Number.parseInt(candidate, 10) : NaN;
        if (
          !Number.isInteger(parsed) ||
          parsed < 0 ||
          String(parsed) !== candidate
        ) {
          res.status(400).json({
            error:
              '`entryIndex` query parameter must be a non-negative integer or "*"',
            code: 'invalid_entry_index',
          });
          return;
        }
        entryIndex = parsed;
      }
      try {
        const ctx = buildWorkspaceCtx(
          req,
          'POST /workspace/mcp/:server/restart',
          clientId,
        );
        const result = await workspace.restartMcpServer(
          ctx,
          serverName,
          entryIndex !== undefined ? { entryIndex } : undefined,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/:server/restart',
        });
      }
    },
  );

  for (const [routeAction, bridgeAction] of [
    ['enable', 'enable'],
    ['disable', 'disable'],
    ['authenticate', 'authenticate'],
    ['clear-auth', 'clear-auth'],
  ] as const) {
    app.post(
      `/workspace/mcp/:server/${routeAction}`,
      mutate({ strict: true }),
      async (req, res) => {
        const serverName = req.params['server'];
        if (!serverName || typeof serverName !== 'string') {
          res.status(400).json({
            error: 'Server name path parameter is required',
            code: 'invalid_server_name',
          });
          return;
        }
        if (serverName.length > MAX_SERVER_NAME_LENGTH) {
          res.status(400).json({
            error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
            code: 'invalid_server_name',
          });
          return;
        }
        const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
        if (clientId === null) return;
        try {
          const result = await bridge.manageMcpServer(
            serverName,
            bridgeAction,
            clientId,
          );
          res.status(200).json(result);
        } catch (err) {
          sendBridgeError(res, err, {
            route: `POST /workspace/mcp/:server/${routeAction}`,
          });
        }
      },
    );
  }

  // Add a runtime MCP server.
  app.post(
    '/workspace/mcp/servers',
    mutate({ strict: true }),
    async (req, res) => {
      const body = safeBody(req);
      const name = body['name'];
      if (!validateMcpRuntimeServerName(name, res)) return;
      // Validate config: must be a non-null object
      const config = body['config'];
      if (
        typeof config !== 'object' ||
        config === null ||
        Array.isArray(config)
      ) {
        res.status(400).json({
          error: '`config` must be a non-null object',
          code: 'missing_required_field',
          field: 'config',
        });
        return;
      }
      // Validate client identity (required for runtime MCP mutation)
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      try {
        const result = await bridge.addRuntimeMcpServer(
          name,
          config as Record<string, unknown>,
          clientId,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/mcp/servers',
        });
      }
    },
  );

  // Remove a runtime MCP server. Idempotent.
  app.delete(
    '/workspace/mcp/servers/:name',
    mutate({ strict: true }),
    async (req, res) => {
      const name = req.params['name'] ?? '';
      if (!validateMcpRuntimeServerName(name, res)) return;
      // Validate client identity (required for runtime MCP mutation)
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      if (!clientId) {
        res.status(400).json({
          error:
            '`X-Qwen-Client-Id` header is required for runtime MCP mutation',
          code: 'missing_client_id',
        });
        return;
      }
      try {
        const result = await bridge.removeRuntimeMcpServer(name, clientId);
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/mcp/servers/:name',
        });
      }
    },
  );

  app.post('/workspace/init', mutate({ strict: true }), async (req, res) => {
    // #4175 Wave 4 PR 17. Scaffold-only init: the workspace service
    // writes an empty QWEN.md without invoking the LLM. Default refuses
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
    // Validate against known client ids.
    const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
    if (clientId === null) return;
    try {
      const ctx = buildWorkspaceCtx(req, 'POST /workspace/init', clientId);
      const result = await workspace.initWorkspace(ctx, {
        force: force === true,
      });
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /workspace/init' });
    }
  });

  app.post(
    '/workspace/reload',
    mutate({ strict: true }),
    async (req: Request, res: Response) => {
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      try {
        const ctx = buildWorkspaceCtx(req, 'POST /workspace/reload', clientId);
        const result = await workspace.reload(ctx);
        invalidateServeFeaturesCache();
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, { route: 'POST /workspace/reload' });
      }
    },
  );

  app.post(
    '/workspace/tools/:name/enable',
    mutate({ strict: true }),
    async (req, res) => {
      // Toggles a tool name in the workspace `tools.disabled` settings
      // list. Strict-gated alongside other
      // mutation routes; bridge writes the file directly (no
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
      // Trim before persistence so the write path matches the read path.
      const toolName = rawToolName.trim();
      if (toolName.length === 0) {
        res.status(400).json({
          error: 'Tool name path parameter is required',
          code: 'invalid_tool_name',
        });
        return;
      }
      // Cap tool name length to prevent settings file bloat.
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
      // Validate against known client ids.
      const clientId = parseAndValidateWorkspaceClientId(req, res, bridge);
      if (clientId === null) return;
      try {
        const ctx = buildWorkspaceCtx(
          req,
          'POST /workspace/tools/:name/enable',
          clientId,
        );
        const result = await workspace.setWorkspaceToolEnabled(
          ctx,
          toolName,
          enabled,
        );
        res.status(200).json(result);
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/tools/:name/enable',
        });
      }
    },
  );

  registerPermissionRoutes(app, {
    bridge,
    mutate,
    sendPermissionVoteError,
  });

  registerSseEventsRoutes(app, {
    bridge,
    daemonLog,
    writerIdleTimeoutMs: opts.writerIdleTimeoutMs,
    sendBridgeError,
  });

  // Official ACP Streamable HTTP transport (RFD #721) mounted at `/acp`
  // alongside the REST surface, sharing this same `bridge` instance.
  // Additive + toggleable (`QWEN_SERVE_ACP_HTTP=0` opts out).
  // See `docs/design/daemon-acp-http/README.md` for the dual-transport
  // decision. Mounted AFTER the REST routes (distinct path, no overlap)
  // and BEFORE the final error handler so malformed `/acp` bodies still
  // route through the JSON error contract below.
  acpHandleRef.current = mountAcpHttp(app, bridge, {
    boundWorkspace,
    workspace,
    fsFactory,
    deviceFlowRegistry,
    token: opts.token,
    sessionShellCommandEnabled,
    checkRate: rateLimiter?.checkRate,
    // Browser captures audio and streams raw PCM here; the daemon transcribes
    // server-side via the reused CLI voice pipeline. Shares the ACP upgrade
    // listener's loopback/CSRF/bearer checks.
    extraWsRoutes: [
      {
        path: '/voice/stream',
        onConnection: createVoiceWsConnectionHandler(boundWorkspace),
      },
    ],
  });
  if (acpHandleRef.current) {
    app.locals['acpHandle'] = acpHandleRef.current;
  }

  // Web Shell SPA deep-link fallback — registered AFTER every API route (and
  // just before the error handler) so real routes, including their bearerAuth
  // 401s, always win; only genuine 404 misses fall through to the shell. This
  // is what keeps an attacker-controlled `Accept: text/html` from coaxing the
  // 200 shell out of an authed route.
  if (webShellDir) {
    mountWebShellSpaFallback(app, webShellDir);
  }

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
      if (sendJsonBodyParserError(res, err)) return;
      writeStderrLine(
        `qwen serve: unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  if (rateLimiter) {
    setRateLimiter(app, rateLimiter);
  }

  return app;
}
