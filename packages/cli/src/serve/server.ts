/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Application } from 'express';
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
import type {
  DeviceFlowProvider,
  DeviceFlowRegistry,
} from './auth/device-flow.js';
import type { DaemonStatusProvider } from '@qwen-code/acp-bridge';
import { createBridgeFileSystemAdapter } from './bridge-file-system-adapter.js';
import { createDaemonStatusProvider } from './daemon-status-provider.js';
import { createWorkspaceProvidersStatusProvider } from './workspace-providers-status.js';
import { mountAcpHttp, type AcpHttpHandle } from './acp-http/index.js';
import { createVoiceWsConnectionHandler } from './voice/voice-ws.js';
import {
  ClientMcpSenderRegistry,
  createClientMcpServerProvider,
} from './acp-http/client-mcp-sender-registry.js';
import { CdpTunnelRegistry } from './cdp-tunnel/cdp-tunnel-registry.js';
import {
  canonicalizeWorkspace,
  createAcpSessionBridge,
  type AcpSessionBridge,
} from './acp-session-bridge.js';
import {
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
} from './workspace-service/index.js';
import { registerCapabilitiesRoutes } from './routes/capabilities.js';
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
import { registerA2uiActionRoutes } from './routes/a2ui-action.js';
import { setRateLimiter } from './rate-limit.js';
import {
  sendBridgeError as sendBridgeErrorResponse,
  sendPermissionVoteError as sendPermissionVoteErrorResponse,
  type SendBridgeError,
} from './server/error-response.js';
import { resolveBridgeFsFactory } from './server/fs-factory.js';
import {
  createBuildWorkspaceCtx,
  parseAndValidateWorkspaceClientId,
  parseClientIdHeader,
  safeBody,
} from './server/request-helpers.js';
import { daemonTelemetryMiddleware } from './server/telemetry.js';
import { installAccessLogMiddleware } from './server/access-log.js';
import { setupDeviceFlowRegistry } from './server/device-flow-registry.js';
import {
  installFinalErrorHandler,
  installJsonBodyParser,
} from './server/error-handlers.js';
import { installRateLimiter } from './server/rate-limiter-setup.js';
import { createServeFeatures } from './server/serve-features.js';
import { installSelfOriginStripMiddleware } from './server/self-origin.js';
import { registerWorkspaceLifecycleRoutes } from './routes/workspace-lifecycle.js';
import { registerWorkspaceMcpControlRoutes } from './routes/workspace-mcp-control.js';
import { registerWorkspaceToolsRoutes } from './routes/workspace-tools.js';

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
  /**
   * Reverse tool channel (issue #5626, Phase 2). Shared sender registry that
   * bridges the daemon WS (per-connection `ClientMcpRegistrar`) and the ACP
   * child's `client_mcp/message` ext-method. `runQwenServe` constructs ONE and
   * passes the SAME instance here AND to its `createAcpSessionBridge` call (as
   * `clientMcpSender: registry.lookup`) so the bridge that answers the child
   * and the WS provider that registers senders agree. When omitted (the
   * standalone `createServeApp` path with no injected bridge), `createServeApp`
   * builds its own registry and wires it into the bridge it creates.
   */
  clientMcpSenderRegistry?: ClientMcpSenderRegistry;
  voiceTranscriber?: WorkspaceVoiceRouteDeps['transcribe'];
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
 * Route modules are registered below in middleware order. Keep this file as
 * the assembly point so auth/rate-limit/body-parser/REST/ACP/Web Shell order
 * stays reviewable in one place.
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
  const tokenConfigured =
    typeof opts.token === 'string' && opts.token.length > 0;
  const sessionShellCommandEnabled =
    opts.enableSessionShell === true && tokenConfigured;
  // Reverse tool channel (issue #5626, Phase 2). Process-scoped registry that
  // bridges the daemon WS (per-connection `ClientMcpRegistrar`) and the ACP
  // child's `client_mcp/message` ext-method. Prefer the registry `runQwenServe`
  // already wired into its injected bridge (`deps.clientMcpSenderRegistry`) so
  // the bridge that answers the child and the WS provider share ONE map.
  // Standalone `createServeApp` (no injected bridge) builds its own and wires
  // it into the bridge it creates below. Inert until a WS client sends
  // `mcp_register` (gated by `clientMcpOverWs`).
  // Guard the split-brain case: an injected `deps.bridge` was already wired to
  // its own sender, so building a fresh registry here would leave the bridge
  // and this registry pointing at different maps. A caller injecting the bridge
  // must inject the matching registry too. Only enforced when `clientMcpOverWs`
  // is active — that's the only path that processes `mcp_*` frames, so without
  // it the registry is inert and a mismatch can't manifest (and the vast
  // majority of tests inject a fake bridge without ever touching client-MCP).
  if (
    opts.clientMcpOverWs === true &&
    deps.bridge &&
    !deps.clientMcpSenderRegistry
  ) {
    throw new Error(
      'createServeApp: deps.bridge requires deps.clientMcpSenderRegistry ' +
        'when clientMcpOverWs is enabled (the bridge is already wired to its ' +
        'own sender; a fresh registry here would be an orphan).',
    );
  }
  const clientMcpSenderRegistry =
    deps.clientMcpSenderRegistry ?? new ClientMcpSenderRegistry();
  const { languageCodes, currentServeFeatures, invalidateServeFeaturesCache } =
    createServeFeatures({
      opts,
      boundWorkspace,
      persistSettingAvailable: deps.persistSetting !== undefined,
      reloadAvailable: deps.workspace !== undefined,
      sessionShellCommandEnabled,
    });
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
      // Reverse tool channel: answer the child's `client_mcp/message`
      // ext-method by reaching the WS connection that hosts the named server.
      clientMcpSender: clientMcpSenderRegistry.lookup,
    });

  installSelfOriginStripMiddleware(app, getPort);

  // Park the factory on `app.locals` so route handlers can pick it up
  // via `req.app.locals.fsFactory` without re-threading the value
  // through every handler signature.
  (app.locals as { fsFactory?: WorkspaceFileSystemFactory }).fsFactory =
    fsFactory;
  // Surface the bound workspace on `app.locals` so file routes can
  // compute workspace-relative response paths without re-resolving.
  (app.locals as { boundWorkspace?: string }).boundWorkspace = boundWorkspace;

  const { deviceFlowRegistry, getSupportedDeviceFlowProviders } =
    setupDeviceFlowRegistry({
      app,
      bridge,
      registry: deps.deviceFlowRegistry,
      providers: deps.deviceFlowProviders,
    });

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

  installAccessLogMiddleware(app, daemonLog);

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
  // Extension origins (chrome-extension://…) explicitly allowed via
  // --allow-origin may frame the Web Shell so the extension can host the UI in
  // a Chrome side panel (issue #5626). All other origins still get
  // frame-ancestors 'none' + X-Frame-Options: DENY.
  const webShellFrameAncestors =
    opts.allowOrigins && opts.allowOrigins.length > 0
      ? [...parseAllowOriginPatterns(opts.allowOrigins).origins].filter(
          (o) =>
            o.startsWith('chrome-extension://') ||
            o.startsWith('moz-extension://'),
        )
      : [];
  if (webShellDir) {
    mountWebShellAssets(app, webShellDir, webShellFrameAncestors);
  }

  app.use(bearerAuth(opts.token));

  // Rate limiter: after auth (only count authenticated requests),
  // before body parser (reject early without burning JSON.parse CPU).
  const rateLimiter = installRateLimiter(app, opts, daemonLog);
  installJsonBodyParser(app);

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

  const buildWorkspaceCtx = createBuildWorkspaceCtx(boundWorkspace);

  const acpHandleRef: { current?: AcpHttpHandle } = {};

  // Plan C CDP tunnel (issue #5626): process-scoped registry pairing the
  // extension `/acp` connection with the `/cdp` puppeteer endpoint. Inert until
  // both ends connect (gated by `cdpTunnelOverWs`).
  const cdpTunnelRegistry =
    opts.cdpTunnelOverWs === true ? new CdpTunnelRegistry() : undefined;

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
    getSupportedDeviceFlowProviders,
    deviceFlowRegistry,
    sessionShellCommandEnabled,
  });

  registerCapabilitiesRoutes(app, {
    qwenCodeVersion: deps.qwenCodeVersion,
    mode: opts.mode,
    currentServeFeatures,
    boundWorkspace,
    permissionPolicy: bridge.permissionPolicy,
    maxPendingPromptsPerSession: opts.maxPendingPromptsPerSession,
    languageCodes,
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
    getMcpServers: async () => {
      const ctx = buildWorkspaceCtx('POST /session/:id/a2ui-action');
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
    getSupportedDeviceFlowProviders,
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
    languageCodes,
  });

  registerWorkspaceMcpControlRoutes(app, {
    boundWorkspace,
    bridge,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, bridge),
  });
  registerWorkspaceLifecycleRoutes(app, {
    boundWorkspace,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
    invalidateServeFeaturesCache,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, bridge),
  });
  registerWorkspaceToolsRoutes(app, {
    boundWorkspace,
    workspace,
    mutate,
    safeBody,
    sendBridgeError,
    parseAndValidateClientId: (req, res) =>
      parseAndValidateWorkspaceClientId(req, res, bridge),
  });

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
    // Mirror the REST CORS allowlist onto the WS CSRF wall so an
    // explicitly permitted origin (e.g. the extension's
    // `chrome-extension://<id>`) can open the reverse tool channel.
    allowedOrigins:
      opts.allowOrigins && opts.allowOrigins.length > 0
        ? parseAllowOriginPatterns(opts.allowOrigins)
        : undefined,
    sessionShellCommandEnabled,
    checkRate: rateLimiter?.checkRate,
    clientMcpOverWs: opts.clientMcpOverWs === true,
    // Reverse tool channel (issue #5626, Phase 2). Per-connection provider:
    // on `mcp_register` it records the WS registrar's sender in the shared
    // registry and adds an SDK-type runtime MCP server in the ACP child
    // (originator = the connection id). Only meaningful when
    // `clientMcpOverWs` is on; the WS layer never builds a provider otherwise.
    ...(opts.clientMcpOverWs === true
      ? {
          clientMcpProviderFactory: (connectionId: string) =>
            createClientMcpServerProvider(
              clientMcpSenderRegistry,
              bridge,
              connectionId,
            ),
        }
      : {}),
    // Plan C CDP tunnel (issue #5626): the `/cdp` branch + `cdp_*` routing
    // activate only when the flag is on and a registry is supplied.
    cdpTunnelOverWs: opts.cdpTunnelOverWs === true,
    ...(cdpTunnelRegistry ? { cdpTunnelRegistry } : {}),
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
    mountWebShellSpaFallback(app, webShellDir, webShellFrameAncestors);
  }

  installFinalErrorHandler(app);

  if (rateLimiter) {
    setRateLimiter(app, rateLimiter);
  }

  return app;
}
