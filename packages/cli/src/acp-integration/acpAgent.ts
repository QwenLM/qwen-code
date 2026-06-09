/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
  BTW_MAX_INPUT_LENGTH,
  buildBtwCacheSafeParams,
  buildBtwPrompt,
  clearCachedCredentialFile,
  createDebugLogger,
  generateSessionRecap,
  QwenOAuth2Event,
  qwenOAuth2Events,
  MCP_BUDGET_WARN_FRACTION,
  MCPServerConfig,
  runForkedAgent,
  SessionService,
  SESSION_TITLE_MAX_LENGTH,
  tokenLimit,
  getMCPDiscoveryState,
  getMCPServerStatus,
  MCPDiscoveryState,
  MCPServerStatus,
  McpTransportPool,
  POOLED_TRANSPORTS_DEFAULT,
  SessionEndReason,
  WorkspaceMcpBudget,
  DiscoveredMCPTool,
  restoreWorktreeContext,
  uiTelemetryService,
  McpBudgetWouldExceedError,
  McpServerSpawnFailedError,
  InvalidMcpConfigError,
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  subagentGenerator,
  redactUrlCredentials,
  computeUniqueBranchTitle,
} from '@qwen-code/qwen-code-core';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalMode,
  Config,
  ConversationRecord,
  DeviceAuthorizationData,
  HookConfig,
  McpBudgetEvent,
  McpBudgetMode,
  McpTransportKind,
} from '@qwen-code/qwen-code-core';
import {
  AgentSideConnection,
  RequestError,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type { Content } from '@google/genai';
import type {
  Agent,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import {
  buildAuthMethods,
  pickAuthMethodsForAuthRequired,
} from './authMethods.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { Readable, Writable } from 'node:stream';
import { normalizeDisabledToolList } from '../config/normalizeDisabledTools.js';
import type { LoadedSettings } from '../config/settings.js';
import { loadSettings, SettingScope } from '../config/settings.js';
import type { ApprovalModeValue } from './session/types.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import {
  buildDisabledSkillNamesProvider,
  loadCliConfig,
} from '../config/config.js';
import { Session, buildAvailableCommandsSnapshot } from './session/Session.js';
import { buildSessionTasksStatus } from './session/tasksSnapshot.js';
import {
  formatAcpModelId,
  parseAcpBaseModelId,
} from '../utils/acpModelUtils.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';
import { runExitCleanup } from '../utils/cleanup.js';
import { appEvents, AppEvent } from '../utils/events.js';
import {
  setLanguageAsync,
  getCurrentLanguage,
  SUPPORTED_LANGUAGES,
} from '../i18n/index.js';
import {
  resolveOutputLanguage,
  updateOutputLanguageFile,
  isAutoLanguage,
  OUTPUT_LANGUAGE_AUTO,
} from '../utils/languageUtils.js';
import {
  ACP_PREFLIGHT_KINDS,
  STATUS_SCHEMA_VERSION,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  mapDomainErrorToErrorKind,
  type AcpPreflightKind,
  type ServeErrorKind,
  type ServeMcpBudgetMode,
  type ServeMcpBudgetStatusCell,
  type ServeMcpDiscoveryState,
  type ServeMcpServerRuntimeStatus,
  type ServeMcpTransport,
  type ServeWorkspaceMcpToolStatus,
  type ServeWorkspaceMcpToolsStatus,
  type ServePreflightCell,
  type ServePreflightKind,
  type ServeSessionContextStatus,
  type ServeSessionSupportedCommandsStatus,
  type ServeSessionTasksStatus,
  type ServeStatus,
  type ServeStatusCell,
  type ServeWorkspaceMcpServerStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspaceProviderModel,
  type ServeWorkspaceProviderStatus,
  type ServeWorkspaceProvidersStatus,
  type ServeWorkspaceSkillStatus,
  type ServeWorkspaceSkillsStatus,
  type ServeWorkspaceToolStatus,
  type ServeWorkspaceToolsStatus,
  type ServeSessionContextUsageStatus,
  type ServeSessionStatsStatus,
  type ServeHookConfig,
  type ServeHookEntry,
  type ServeHookSource,
  type ServeSessionHooksStatus,
  type ServeWorkspaceHooksStatus,
  type ServeExtensionEntry,
  type ServeExtensionCapabilities,
  type ServeWorkspaceExtensionsStatus,
  IDLE_HOOK_EVENTS,
} from '../serve/status.js';
import {
  collectContextData,
  formatContextUsageText,
} from '../ui/commands/contextCommand.js';
import type { HistoryItemContextUsage } from '../ui/types.js';

const debugLogger = createDebugLogger('ACP_AGENT');
// Must be less than SESSION_BTW_TIMEOUT_MS (60s) in bridge.ts so the child
// aborts before the bridge's backstop timer fires.
const BTW_CHILD_TIMEOUT_MS = 55_000;

/**
 * Env-var candidates per auth method, used by `buildAuthPreflightCell` for
 * a side-effect-free presence check. Mirrors `AUTH_ENV_MAPPINGS` from
 * `core/src/models/constants.ts` (which isn't on the public package
 * surface). Keep in sync if a new provider is added there. Any auth method
 * not listed here surfaces as `status: 'unknown'` on the cell rather than
 * a false `auth_env_error` — full validation happens at session start.
 *
 * Drift detection: `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES` below lists every
 * `AuthType` enum value that has been triaged for this map (either keyed
 * here, or explicitly waived for non-env-based auth like qwen-oauth). The
 * paired test `AUTH_PREFLIGHT_AUDITED_AUTH_TYPES covers every AuthType`
 * walks the public enum and fails CI when core adds a new auth method
 * without a deliberate decision here.
 */
export const AUTH_PREFLIGHT_ENV_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  'vertex-ai': ['GOOGLE_API_KEY'],
};

/**
 * Auth methods deliberately not env-keyed (e.g. OAuth-based, credential
 * file). Listed here so the drift test recognizes them as triaged-but-
 * waived rather than a missing entry.
 */
export const AUTH_PREFLIGHT_WAIVED_AUTH_TYPES: ReadonlySet<string> = new Set([
  'qwen-oauth',
]);

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
) {
  // Skip MCP discovery in the BOOTSTRAP config. Bootstrap MCP clients
  // are never used to serve a session (each session runs its own
  // discovery), so skipping here avoids spawning every server twice.
  const bootstrapSkipsMcpDiscovery = true;
  await config.initialize({
    skipGeminiInitialization: true,
    skipMcpDiscovery: bootstrapSkipsMcpDiscovery,
  });
  // Skip the MCP failure warning when discovery was intentionally
  // bypassed — per-session paths surface real failures through their
  // own status routes / events.
  if (!bootstrapSkipsMcpDiscovery) {
    await config.waitForMcpReady();
    const failedMcpServers =
      typeof config.getFailedMcpServerNames === 'function'
        ? config.getFailedMcpServerNames()
        : [];
    if (failedMcpServers.length > 0) {
      process.stderr.write(
        `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
          `Continuing with built-in tools and any servers that did connect.\n`,
      );
    }
  }

  const stdout = Writable.toWeb(process.stdout) as WritableStream;
  const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

  // Stdout is used to send messages to the client, so console.log/console.info
  // messages to stderr so that they don't interfere with ACP.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const stream = ndJsonStream(stdout, stdin);
  let agentInstance: QwenAgent | undefined;
  const connection = new AgentSideConnection((conn) => {
    agentInstance = new QwenAgent(config, settings, argv, conn);
    return agentInstance;
  }, stream);

  // Both the SIGTERM handler and the IDE-initiated close path need
  // to drain the MCP pool before runExitCleanup. Single helper
  // closure keeps the timeout + log labels consistent.
  const drainPoolBeforeExit = async (label: string): Promise<void> => {
    if (!agentInstance) return;
    try {
      await agentInstance.shutdownMcpPool(8_000);
    } catch (err) {
      debugLogger.error(`[ACP] MCP pool drain (${label}) error:`, err);
    }
  };

  // Handle SIGTERM/SIGINT for graceful shutdown.
  // Without this, signal handlers registered elsewhere in the CLI
  // (e.g., stdin raw mode restoration) override the default exit behavior,
  // causing the ACP process to ignore termination signals.
  let shuttingDown = false;
  let sessionEndFired = false;

  // Helper to fire SessionEnd hook once, preventing double-fire from both
  // shutdown handler path and connection.closed path.
  const fireSessionEndOnce = async (reason: SessionEndReason) => {
    if (sessionEndFired) return;
    sessionEndFired = true;

    const configs = new Set<Config>([config]);
    const sessions = agentInstance?.getActiveSessions();
    if (sessions) {
      for (const session of sessions) {
        const sessionConfig = session.getConfig?.();
        if (sessionConfig) {
          configs.add(sessionConfig);
        }
      }
    }

    for (const cfg of configs) {
      const hookSystem = cfg.getHookSystem?.();
      const hooksEnabled = !cfg.getDisableAllHooks?.();
      if (
        !hooksEnabled ||
        !hookSystem ||
        !cfg.hasHooksForEvent?.('SessionEnd')
      ) {
        continue;
      }
      try {
        await hookSystem.fireSessionEndEvent(reason);
      } catch (err) {
        debugLogger.warn(
          `SessionEnd hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  const shutdownHandler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    debugLogger.debug('[ACP] Shutdown signal received, closing streams');

    // Fire SessionEnd hook for all active sessions (aligned with core path)
    await fireSessionEndOnce(SessionEndReason.Other);
    agentInstance?.disposeSessions();

    try {
      process.stdin.destroy();
    } catch {
      // stdin may already be closed
    }
    try {
      process.stdout.destroy();
    } catch {
      // stdout may already be closed
    }
    // Drain the workspace MCP pool BEFORE runExitCleanup so the
    // descendant pid sweep can SIGTERM wrapper grandchildren.
    await drainPoolBeforeExit('signal');
    // Clean up child processes (MCP servers, etc.) and force exit.
    // Without this, orphan subprocesses keep the Node.js event loop alive
    // and the CLI process never terminates after the IDE disconnects.
    runExitCleanup()
      .catch((err) => {
        debugLogger.error('[ACP] Cleanup error:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  await connection.closed;
  // Connection closed by IDE - fire SessionEnd hook (aligned with core path)
  await fireSessionEndOnce(SessionEndReason.PromptInputExit);
  // Mirror the SIGTERM handler's pool drain on the IDE-initiated
  // normal close path to avoid leaking shared MCP entries.
  await drainPoolBeforeExit('ide_close');
  agentInstance?.disposeSessions();

  process.off('SIGTERM', shutdownHandler);
  process.off('SIGINT', shutdownHandler);
}

export function toStdioServer(server: McpServer): McpServerStdio | undefined {
  if ('command' in server && 'args' in server && 'env' in server) {
    return server as McpServerStdio;
  }
  return undefined;
}

export function toSseServer(
  server: McpServer,
): (McpServerSse & { type: 'sse' }) | undefined {
  if ('type' in server && server.type === 'sse') {
    return server as McpServerSse & { type: 'sse' };
  }
  return undefined;
}

export function toHttpServer(
  server: McpServer,
): (McpServerHttp & { type: 'http' }) | undefined {
  if ('type' in server && server.type === 'http') {
    return server as McpServerHttp & { type: 'http' };
  }
  return undefined;
}

/**
 * Parse `QWEN_SERVE_MCP_POOL_TRANSPORTS` env var. Comma-separated list
 * e.g. "stdio,websocket,http". Falls back to `POOLED_TRANSPORTS_DEFAULT`
 * on missing / malformed input. Unknown transport names are silently dropped.
 */
function parsePooledTransports(
  envValue: string | undefined,
): ReadonlySet<McpTransportKind> {
  if (!envValue || !envValue.trim()) return POOLED_TRANSPORTS_DEFAULT;
  const KNOWN: ReadonlySet<McpTransportKind> = new Set([
    'stdio',
    'websocket',
    'http',
    'sse',
  ]);
  const out = new Set<McpTransportKind>();
  for (const raw of envValue.split(',')) {
    const trimmed = raw.trim().toLowerCase();
    if (KNOWN.has(trimmed as McpTransportKind)) {
      out.add(trimmed as McpTransportKind);
    }
  }
  // Empty after parsing (all unknown) → fall back to defaults so an
  // operator typo doesn't silently disable the pool entirely.
  return out.size > 0 ? out : POOLED_TRANSPORTS_DEFAULT;
}

/**
 * Parse `QWEN_SERVE_MCP_POOL_DRAIN_MS` env var. Default 30000ms.
 * Bounded to [1000, 600000] (1s-10min).
 */
function parsePoolDrainMs(envValue: string | undefined): number {
  if (!envValue) return 30_000;
  // Reject input that contains anything other than digits. A unit
  // suffix or typo would silently truncate; strict regex prevents this.
  const trimmed = envValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    process.stderr.write(
      `qwen serve: QWEN_SERVE_MCP_POOL_DRAIN_MS=${JSON.stringify(envValue)} ` +
        `is not a valid integer; using default 30000ms.\n`,
    );
    return 30_000;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return 30_000;
  return Math.min(600_000, Math.max(1_000, n));
}

/**
 * Construct the workspace-scoped MCP budget controller from env vars.
 * Returns `undefined` when budget is unset or `off` mode. The pool
 * invokes `tryReserve`/`release`; this helper produces the controller
 * and wires the event callback.
 */
function createWorkspaceMcpBudget(
  onEvent: (event: McpBudgetEvent) => void,
): WorkspaceMcpBudget | undefined {
  const rawBudget = process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
  const rawMode = process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  // Match `McpClientManager.readBudgetFromEnv`'s parsing exactly.
  // Use `Number(...)` + `Number.isInteger` so the pool and the manager
  // honor the same env values.
  const budget =
    rawBudget !== undefined && rawBudget !== '' ? Number(rawBudget) : undefined;
  const mode: McpBudgetMode = (() => {
    if (rawMode === 'enforce' || rawMode === 'warn' || rawMode === 'off') {
      return rawMode;
    }
    return budget !== undefined &&
      Number.isFinite(budget) &&
      Number.isInteger(budget) &&
      budget > 0
      ? 'warn'
      : 'off';
  })();
  if (
    mode === 'off' ||
    budget === undefined ||
    !Number.isFinite(budget) ||
    !Number.isInteger(budget) ||
    budget <= 0
  ) {
    return undefined;
  }
  return new WorkspaceMcpBudget({
    clientBudget: budget,
    mode,
    onEvent,
  });
}

class QwenAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private clientCapabilities: ClientCapabilities | undefined;

  /**
   * Workspace-shared MCP transport pool. Eagerly constructed; lazy
   * w.r.t. actual MCP work — spawns nothing until `pool.acquire`.
   *
   * `undefined` when `QWEN_SERVE_NO_MCP_POOL=1` (kill switch); sessions
   * then fall back to per-session McpClient spawn.
   */
  private readonly mcpPool?: McpTransportPool;

  /**
   * Workspace-scoped MCP budget controller. Constructed alongside
   * `mcpPool` when `--mcp-client-budget=N` is configured. `undefined`
   * when no budget is configured or pool kill switch is on.
   */
  private readonly workspaceMcpBudget?: WorkspaceMcpBudget;

  getActiveSessions(): Session[] {
    return [...this.sessions.values()];
  }

  async shutdownMcpPool(timeoutMs = 10_000): Promise<void> {
    if (!this.mcpPool) return;
    try {
      const result = await this.mcpPool.drainAll({ force: true, timeoutMs });
      if (result.forced > 0 || result.errors.length > 0) {
        debugLogger.warn(
          `MCP pool drain: ${result.drained} clean, ${result.forced} timed out, ` +
            `${result.errors.length} errors`,
        );
      }
    } catch (err) {
      debugLogger.error(
        `MCP pool drainAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  disposeSessions(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private async closeStoredSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.mcpPool?.releaseSession(sessionId);
      return;
    }

    try {
      await session.cancelPendingPrompt();
    } catch (err) {
      debugLogger.debug(
        `Session ${sessionId} cancel during close failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      await session.getConfig().getToolRegistry()?.stop();
    } catch (err) {
      debugLogger.debug(
        `Session ${sessionId} tool registry stop during close failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.mcpPool?.releaseSession(sessionId);
    this.sessions.delete(sessionId);
  }

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private argv: CliArgs,
    private connection: AgentSideConnection,
  ) {
    // Pool kill switch via env var so operators can A/B compare or
    // roll back without rebuilding. `runQwenServe.ts` sets this when
    // `--no-mcp-pool` is passed at daemon startup.
    if (process.env['QWEN_SERVE_NO_MCP_POOL'] === '1') {
      this.mcpPool = undefined;
      this.workspaceMcpBudget = undefined;
    } else {
      // Construct the workspace-scoped budget controller when
      // `--mcp-client-budget=N` was set at boot. With the pool active,
      // this controller's accounting REPLACES per-session copies.
      this.workspaceMcpBudget = createWorkspaceMcpBudget((event) => {
        this.broadcastBudgetEvent(event);
      });
      this.mcpPool = new McpTransportPool(this.config, {
        workspaceContext: this.config.getWorkspaceContext(),
        debugMode: this.config.getDebugMode(),
        // sendSdkMcpMessage left undefined: SDK MCP servers always
        // bypass the pool via createUnpooledConnection (per-session
        // routing through ACP control plane). The legacy
        // McpClientManager path retains its own per-session SDK
        // wiring; pool-mode discoverAllMcpToolsViaPool delegates SDK
        // MCP to that bypass.
        pooledTransports: parsePooledTransports(
          process.env['QWEN_SERVE_MCP_POOL_TRANSPORTS'],
        ),
        drainDelayMs: parsePoolDrainMs(
          process.env['QWEN_SERVE_MCP_POOL_DRAIN_MS'],
        ),
        budget: this.workspaceMcpBudget,
      });
    }
  }

  /** Expose the pool's workspace-scoped budget controller for snapshot builders. */
  getWorkspaceMcpBudget(): WorkspaceMcpBudget | undefined {
    return this.workspaceMcpBudget;
  }

  /**
   * Fan-out a workspace-scoped MCP budget event to every active
   * session's SSE bus. Each notification is independently
   * fire-and-forget.
   */
  private broadcastBudgetEvent(event: McpBudgetEvent): void {
    // The QwenAgent's `this.connection` is the single ACP channel to
    // the daemon. The daemon's bridge `bridgeClient.extNotification`
    // resolves the per-session SSE bus from the `sessionId` field of
    // each notification — so we send N notifications (one per active
    // session id) over the same connection. Each notification is
    // independently fire-and-forget; a mid-flight ACP disconnect
    // shouldn't sink delivery to siblings.
    //
    // Snapshot the session id list before the async fan-out so a
    // concurrent `killSession` can't corrupt the iterator.
    const sessionIds = Array.from(this.sessions.keys());
    for (const sid of sessionIds) {
      void this.connection
        .extNotification('qwen/notify/session/mcp-budget-event', {
          v: 1,
          sessionId: sid,
          // Tag workspace-scoped events so SDK reducers can branch.
          scope: 'workspace' as const,
          ...event,
        })
        .catch((err: unknown) => {
          debugLogger.debug(
            `MCP workspace budget event delivery to session ${sid} failed ` +
              `(kind=${event.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  async initialize(args: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = args.clientCapabilities;
    const authMethods = buildAuthMethods();
    const version = process.env['CLI_VERSION'] || process.version;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'qwen-code',
        title: 'Qwen Code',
        version,
      },
      authMethods,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        mcpCapabilities: {
          sse: true,
          http: true,
        },
      },
    };
  }

  async authenticate({ methodId }: AuthenticateRequest): Promise<void> {
    const method = z.nativeEnum(AuthType).parse(methodId);

    let authUri: string | undefined;
    const authUriHandler = (deviceAuth: DeviceAuthorizationData) => {
      authUri = deviceAuth.verification_uri_complete;
      void this.connection.extNotification('authenticate/update', {
        _meta: { authUri },
      });
    };

    if (method === AuthType.QWEN_OAUTH) {
      qwenOAuth2Events.once(QwenOAuth2Event.AuthUri, authUriHandler);
    }

    await clearCachedCredentialFile();
    try {
      await this.config.refreshAuth(method);
      this.settings.setValue(
        SettingScope.User,
        'security.auth.selectedType',
        method,
      );
    } finally {
      if (method === AuthType.QWEN_OAUTH) {
        qwenOAuth2Events.off(QwenOAuth2Event.AuthUri, authUriHandler);
      }
    }
  }

  async newSession({
    cwd,
    mcpServers,
  }: NewSessionRequest): Promise<NewSessionResponse> {
    const config = await this.newSessionConfig(cwd, mcpServers);
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const session = await this.createAndStoreSession(config);
    const availableModels = this.buildAvailableModels(config);
    const modesData = this.buildModesData(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      sessionId: session.getId(),
      models: availableModels,
      modes: modesData,
      configOptions,
    };
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const exists = await runWithAcpRuntimeOutputDir(
      this.settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }

    const config = await this.newSessionConfig(
      params.cwd,
      // `LoadSessionRequest.mcpServers` is required in today's ACP
      // schema, but mirror `unstable_resumeSession` and tolerate a
      // future loosening — `newSessionConfig` iterates the list, so
      // a `null`/`undefined` would otherwise throw `TypeError`.
      params.mcpServers ?? [],
      params.sessionId,
      true,
    );
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const sessionData = config.getResumedSessionData();
    const session = await this.createAndStoreSession(
      config,
      sessionData?.conversation,
    );

    await this.#restoreWorktreeOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      modes: modesData,
      models: availableModels,
      configOptions,
    };
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const exists = await runWithAcpRuntimeOutputDir(
      this.settings,
      params.cwd,
      async () => {
        const sessionService = new SessionService(params.cwd);
        return sessionService.sessionExists(params.sessionId);
      },
    );
    if (!exists) {
      throw RequestError.resourceNotFound(`session:${params.sessionId}`);
    }

    const config = await this.newSessionConfig(
      params.cwd,
      params.mcpServers ?? [],
      params.sessionId,
      true,
    );
    await this.ensureAuthenticated(config);
    this.setupFileSystem(config);

    const session = await this.createAndStoreSession(config);

    await this.#restoreWorktreeOnResume(config, session);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      modes: modesData,
      models: availableModels,
      configOptions,
    };
  }

  /**
   * Shared worktree restore for both ACP entry points (`loadSession` and
   * `unstable_resumeSession`). Best-effort: failures don't block session
   * load — worktree context is a hint to the model, not a correctness
   * requirement.
   */
  async #restoreWorktreeOnResume(
    config: Config,
    session: Session,
  ): Promise<void> {
    try {
      const sessionPath = config
        .getSessionService()
        .getWorktreeSessionPath(config.getSessionId());
      const restored = await restoreWorktreeContext(sessionPath);
      if (restored.contextMessage) {
        session.pendingWorktreeNotice = restored.contextMessage;
      }
    } catch (error) {
      debugLogger.warn(`ACP worktree restore failed: ${error}`);
    }
  }

  async unstable_listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const cwd = params.cwd || process.cwd();
    const numericCursor = params.cursor ? Number(params.cursor) : undefined;

    // The ACP spec's ListSessionsRequest doesn't include a page-size field,
    // so the SDK's zod validator strips any top-level `size` the client sends
    // before it reaches this handler. Carry page size through `_meta.size`
    // (same pattern filesystem.ts uses for `_meta.bom` / `_meta.encoding`).
    const metaSize = params._meta?.['size'];
    const size =
      typeof metaSize === 'number' && metaSize > 0
        ? Math.floor(metaSize)
        : undefined;

    const result = await runWithAcpRuntimeOutputDir(this.settings, cwd, () => {
      const sessionService = new SessionService(cwd);
      return sessionService.listSessions({
        cursor: Number.isNaN(numericCursor) ? undefined : numericCursor,
        size,
      });
    });

    const sessions: SessionInfo[] = result.items.map((item) => ({
      cwd: item.cwd,
      sessionId: item.sessionId,
      title: item.customTitle || item.prompt || '(session)',
      updatedAt: new Date(item.mtime).toISOString(),
    }));

    return {
      sessions,
      nextCursor:
        result.nextCursor != null ? String(result.nextCursor) : undefined,
    };
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return session.setMode(params);
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${params.sessionId}`,
      );
    }
    return await session.setModel(params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const { sessionId, configId, value } = params;

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }

    switch (configId) {
      case 'mode': {
        await this.setSessionMode({
          sessionId,
          modeId: value as string,
        });
        break;
      }
      case 'model': {
        await session.setModel(
          {
            sessionId,
            modelId: value as string,
          },
          { persistDefault: false },
        );
        break;
      }
      default:
        throw RequestError.invalidParams(
          undefined,
          `Unsupported configId: ${configId}`,
        );
    }

    return {
      configOptions: this.buildConfigOptions(session.getConfig()),
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    return session.prompt(params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    await session.cancelPendingPrompt();
  }

  private workspaceCwd(config: Config): string {
    return config.getTargetDir();
  }

  private safeWorkspaceCwd(config: Config): string {
    try {
      return this.workspaceCwd(config);
    } catch {
      return '';
    }
  }

  private mcpTransport(server: unknown): ServeMcpTransport {
    if (!server || typeof server !== 'object') return 'unknown';
    const s = server as Record<string, unknown>;
    if (s['type'] === 'sdk') return 'sdk';
    if (typeof s['httpUrl'] === 'string') return 'http';
    if (typeof s['url'] === 'string') return 'sse';
    if (typeof s['tcp'] === 'string') return 'websocket';
    if (typeof s['command'] === 'string') return 'stdio';
    return 'unknown';
  }

  private mcpStatus(status: MCPServerStatus): ServeMcpServerRuntimeStatus {
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'connected';
      case MCPServerStatus.CONNECTING:
        return 'connecting';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'disconnected';
    }
  }

  private mcpCellStatus(
    status: MCPServerStatus,
    disabled: boolean,
  ): ServeStatus {
    if (disabled) return 'disabled';
    switch (status) {
      case MCPServerStatus.CONNECTED:
        return 'ok';
      case MCPServerStatus.CONNECTING:
        return 'warning';
      case MCPServerStatus.DISCONNECTED:
      default:
        return 'error';
    }
  }

  private discoveryState(): ServeMcpDiscoveryState {
    const state = getMCPDiscoveryState();
    switch (state) {
      case MCPDiscoveryState.IN_PROGRESS:
        return 'in_progress';
      case MCPDiscoveryState.COMPLETED:
        return 'completed';
      case MCPDiscoveryState.NOT_STARTED:
      default:
        return 'not_started';
    }
  }

  private async buildWorkspaceMcpStatus(
    config: Config,
  ): Promise<ServeWorkspaceMcpStatus> {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const settings = loadSettings(config.getTargetDir());
      const workspaceSettings = settings.forScope(
        SettingScope.Workspace,
      ).settings;
      const servers = config.getMcpServers() ?? {};

      // Pool snapshot for per-server `entryCount` + `entrySummary`.
      // Captured once outside the per-server loop. Absent when the
      // pool is disabled.
      let poolByName: Record<
        string,
        {
          entryCount: number;
          entrySummary: ReadonlyArray<{
            entryIndex: number;
            refs: number;
            status: MCPServerStatus;
          }>;
        }
      > = {};
      try {
        const snap = this.mcpPool?.getSnapshot();
        if (snap) poolByName = snap.byName;
      } catch (err) {
        // Pool snapshot failures must not crash the wider status —
        // surface to stderr so silent regressions are visible without
        // depending on `debugLogger.debug` operator opt-in (matches
        // the budget-accounting fail-loud pattern below).
        process.stderr.write(
          `qwen serve: pool snapshot for workspace MCP status failed: ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      }

      // Pull live accounting + budget config. When the workspace-scoped
      // budget controller is active, prefer its accounting. Manager
      // fall-back keeps the legacy per-session cell shape.
      let clientCount: number | undefined;
      let clientBudget: number | undefined;
      let budgetMode: ServeMcpBudgetMode | undefined;
      let refusedSet: ReadonlySet<string> = new Set<string>();
      let budgetCellScope: 'workspace' | 'session' = 'session';
      const wsBudget = this.workspaceMcpBudget;
      if (wsBudget !== undefined) {
        budgetCellScope = 'workspace';
        clientCount = wsBudget.getReservedCount();
        clientBudget = wsBudget.getBudget();
        budgetMode = this.coerceBudgetMode(wsBudget.getMode());
        refusedSet = new Set(wsBudget.getRefusedServerNames());
      } else {
        try {
          const manager = config.getToolRegistry()?.getMcpClientManager();
          if (manager) {
            const accounting = manager.getMcpClientAccounting();
            clientCount = accounting.total;
            clientBudget = manager.getMcpClientBudget();
            budgetMode = manager.getMcpBudgetMode();
            refusedSet = new Set(accounting.refusedServerNames);
          }
        } catch (err) {
          // Accounting failure must not crash the snapshot — the per-
          // server data is still useful even without budget overlay.
          process.stderr.write(
            `qwen serve: getMcpClientAccounting failed: ` +
              `${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      const sharedTokenStorage = new MCPOAuthTokenStorage();

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        discoveryState: this.discoveryState(),
        servers: await Promise.all(
          Object.entries(servers).map(async ([name, server]) => {
            const disabled = config.isMcpServerDisabled(name);
            let hasOAuthTokens = false;
            try {
              const credentials = await sharedTokenStorage.getCredentials(name);
              hasOAuthTokens = credentials !== null;
            } catch {
              // Match CLI: token lookup errors should not break /mcp status.
            }
            const rawStatus = getMCPServerStatus(name);
            const refusedByBudget = refusedSet.has(name);
            // Config-disable takes precedence over budget-refusal.
            const effectivelyRefused = refusedByBudget && !disabled;
            const out: ServeWorkspaceMcpServerStatus = {
              kind: 'mcp_server',
              // Refused-by-budget shadows the raw status: the rawStatus
              // is `DISCONNECTED` (we never tried to connect), but the
              // operator-facing severity is `error` with an explanatory
              // errorKind rather than the generic disconnected `error`.
              status: effectivelyRefused
                ? 'error'
                : this.mcpCellStatus(rawStatus, disabled),
              name,
              mcpStatus: this.mcpStatus(rawStatus),
              transport: this.mcpTransport(server),
              disabled,
              hasOAuthTokens,
            };
            if (effectivelyRefused) {
              out.errorKind = 'budget_exhausted';
              out.disabledReason = 'budget';
              out.hint =
                'Raise --mcp-client-budget or remove servers from mcpServers config.';
            } else if (disabled) {
              out.disabledReason = 'config';
            }
            const description =
              server && typeof server === 'object'
                ? (server as { description?: unknown }).description
                : undefined;
            const extensionName =
              server && typeof server === 'object'
                ? (server as { extensionName?: unknown }).extensionName
                : undefined;
            if (typeof description === 'string') {
              out.description = description;
            }
            if (typeof extensionName === 'string') {
              out.extensionName = extensionName;
            }
            out.source = out.extensionName
              ? 'extension'
              : workspaceSettings.mcpServers?.[name]
                ? 'project'
                : 'user';
            if (server && typeof server === 'object') {
              const candidate = server as {
                command?: unknown;
                args?: unknown;
                httpUrl?: unknown;
                url?: unknown;
                cwd?: unknown;
              };
              const serverConfig: NonNullable<
                ServeWorkspaceMcpServerStatus['config']
              > = {};
              if (typeof candidate.command === 'string') {
                serverConfig.command = candidate.command;
              }
              if (Array.isArray(candidate.args)) {
                const args = candidate.args.filter(
                  (arg): arg is string => typeof arg === 'string',
                );
                if (args.length > 0) {
                  serverConfig.args = args;
                }
              }
              if (typeof candidate.httpUrl === 'string') {
                serverConfig.httpUrl = candidate.httpUrl;
              }
              if (typeof candidate.url === 'string') {
                serverConfig.url = candidate.url;
              }
              if (typeof candidate.cwd === 'string') {
                serverConfig.cwd = candidate.cwd;
              }
              if (Object.keys(serverConfig).length > 0) {
                out.config = serverConfig;
              }
            }
            // Pool entries enrichment.
            const poolRow = poolByName[name];
            if (poolRow) {
              out.entryCount = poolRow.entryCount;
              out.entrySummary = poolRow.entrySummary.map((e) => ({
                entryIndex: e.entryIndex,
                refs: e.refs,
                status: this.mcpStatus(e.status),
              }));
            }
            return out;
          }),
        ),
        ...(clientCount !== undefined ? { clientCount } : {}),
        ...(clientBudget !== undefined ? { clientBudget } : {}),
        ...(budgetMode !== undefined ? { budgetMode } : {}),
        ...(budgetMode !== undefined
          ? {
              // Filter out config-disabled servers so the workspace
              // cell matches the per-server cell precedence.
              budgets: this.buildBudgetCells(
                clientCount ?? 0,
                clientBudget,
                budgetMode,
                Array.from(refusedSet).filter(
                  (n) => !config.isMcpServerDisabled(n),
                ).length,
                budgetCellScope,
              ),
            }
          : {}),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        servers: [],
        errors: [this.errorCell('mcp', error)],
      };
    }
  }

  private buildWorkspaceMcpToolsStatus(
    config: Config,
    serverName: string,
  ): ServeWorkspaceMcpToolsStatus {
    const workspaceCwd = this.safeWorkspaceCwd(config);
    try {
      const servers = config.getMcpServers() ?? {};
      if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          serverName,
          initialized: true,
          acpChannelLive: true,
          tools: [],
          errors: [
            {
              kind: 'mcp_tools',
              status: 'error',
              error: `MCP server not configured: ${serverName}`,
            },
          ],
        };
      }

      let registry = config.getToolRegistry();
      let allTools = registry?.getAllTools() ?? [];
      if (
        allTools.filter(
          (t) => t instanceof DiscoveredMCPTool && t.serverName === serverName,
        ).length === 0
      ) {
        for (const session of this.getActiveSessions()) {
          const sessionRegistry = session.getConfig().getToolRegistry();
          const sessionTools = sessionRegistry?.getAllTools() ?? [];
          if (
            sessionTools.some(
              (t) =>
                t instanceof DiscoveredMCPTool && t.serverName === serverName,
            )
          ) {
            registry = sessionRegistry;
            allTools = sessionTools;
            break;
          }
        }
      }
      const tools: ServeWorkspaceMcpToolStatus[] = allTools
        .filter(
          (tool): tool is DiscoveredMCPTool =>
            tool instanceof DiscoveredMCPTool && tool.serverName === serverName,
        )
        .map((tool) => {
          const invalidReasons: string[] = [];
          if (!tool.name) invalidReasons.push('missing name');
          if (!tool.description) invalidReasons.push('missing description');
          const schema =
            tool.parameterSchema &&
            typeof tool.parameterSchema === 'object' &&
            !Array.isArray(tool.parameterSchema)
              ? (tool.parameterSchema as Record<string, unknown>)
              : undefined;
          const annotations =
            tool.annotations &&
            typeof tool.annotations === 'object' &&
            !Array.isArray(tool.annotations)
              ? (tool.annotations as Record<string, unknown>)
              : undefined;
          return {
            name: tool.name || '(unnamed)',
            serverToolName: tool.serverToolName,
            description: tool.description,
            ...(schema ? { schema } : {}),
            ...(annotations ? { annotations } : {}),
            isValid: invalidReasons.length === 0,
            ...(invalidReasons.length > 0
              ? { invalidReason: invalidReasons.join(', ') }
              : {}),
          };
        });

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        tools,
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        serverName,
        initialized: true,
        acpChannelLive: true,
        tools: [],
        errors: [this.errorCell('mcp_tools', error)],
      };
    }
  }

  /**
   * Build the MCP budget status cells exposed on `GET /workspace/mcp`.
   *
   * Cell `status` semantics:
   *   - `error`   — refusals happened this pass (enforce mode only)
   *   - `warning` — live count crossed 75% of budget
   *   - `ok`      — under threshold (or `off` mode)
   *
   * `liveCount` is the connected-client count (for operator
   * observability), while enforcement uses `reservedSlots.size` to
   * prevent capacity races.
   */
  private buildBudgetCells(
    liveCount: number,
    budget: number | undefined,
    mode: ServeMcpBudgetMode,
    refusedCount: number,
    scope: 'workspace' | 'session' = 'session',
  ): ServeMcpBudgetStatusCell[] {
    // When mode is 'off', return empty — no budget surface to show.
    if (mode === 'off') return [];
    let status: ServeStatus = 'ok';
    let errorKind: ServeErrorKind | undefined;
    let hint: string | undefined;
    if (refusedCount > 0) {
      status = 'error';
      errorKind = 'budget_exhausted';
      hint =
        'Raise --mcp-client-budget or remove servers from mcpServers config.';
    } else if (
      budget !== undefined &&
      budget > 0 &&
      liveCount >= MCP_BUDGET_WARN_FRACTION * budget
    ) {
      status = 'warning';
      hint = `Live MCP clients are above ${Math.round(
        MCP_BUDGET_WARN_FRACTION * 100,
      )}% of the configured budget.`;
    }
    const cell: ServeMcpBudgetStatusCell = {
      kind: 'mcp_budget',
      // `scope` is 'workspace' when the workspace budget controller is
      // active, otherwise 'session' for legacy per-session caps.
      scope,
      status,
      liveCount,
      mode,
      refusedCount,
    };
    if (budget !== undefined) cell.budget = budget;
    if (errorKind) cell.errorKind = errorKind;
    if (hint) cell.hint = hint;
    return [cell];
  }

  /** Map core `McpBudgetMode` to protocol `ServeMcpBudgetMode`. */
  private coerceBudgetMode(mode: McpBudgetMode): ServeMcpBudgetMode {
    return mode;
  }

  private errorCell(
    kind: string,
    error: unknown,
    errorKind?: ServeErrorKind,
  ): ServeStatusCell {
    const inferred = errorKind ?? mapDomainErrorToErrorKind(error);
    return {
      kind,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
      ...(inferred ? { errorKind: inferred } : {}),
    };
  }

  private async buildWorkspaceSkillsStatus(
    config: Config,
  ): Promise<ServeWorkspaceSkillsStatus> {
    const skillManager = config.getSkillManager();
    if (!skillManager) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
      };
    }

    try {
      const skills = await skillManager.listSkills();
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: skills.map((skill): ServeWorkspaceSkillStatus => {
          const modelInvocable = skill.disableModelInvocation !== true;
          return {
            kind: 'skill',
            status: modelInvocable ? 'ok' : 'disabled',
            name: skill.name,
            description: skill.description,
            level: skill.level,
            modelInvocable,
            ...(skill.argumentHint ? { argumentHint: skill.argumentHint } : {}),
            ...(skill.model ? { model: skill.model } : {}),
            ...(skill.extensionName
              ? { extensionName: skill.extensionName }
              : {}),
          };
        }),
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.workspaceCwd(config),
        initialized: true,
        skills: [],
        errors: [this.errorCell('skills', error)],
      };
    }
  }

  private buildWorkspaceProvidersStatus(
    config: Config,
  ): ServeWorkspaceProvidersStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const currentAuthType = config.getAuthType?.();
      const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
      const currentModelId = activeRuntimeSnapshot
        ? activeRuntimeSnapshot.id
        : (config.getModel() || '').trim();
      const hasCurrentModel = currentModelId.length > 0;
      const currentAuth = activeRuntimeSnapshot?.authType ?? currentAuthType;
      const currentAcpModelId =
        hasCurrentModel && currentAuth
          ? formatAcpModelId(currentModelId, currentAuth)
          : currentModelId || undefined;
      const providers = new Map<string, ServeWorkspaceProviderStatus>();

      for (const model of config.getAllConfiguredModels()) {
        const authType = String(model.authType);
        let provider = providers.get(authType);
        if (!provider) {
          provider = {
            kind: 'model_provider',
            status: 'ok',
            authType,
            current: false,
            models: [],
          };
          providers.set(authType, provider);
        }

        const effectiveModelId =
          model.isRuntimeModel && model.runtimeSnapshotId
            ? model.runtimeSnapshotId
            : model.id;
        const modelId = formatAcpModelId(effectiveModelId, model.authType);
        const isCurrent =
          currentAuth === model.authType &&
          hasCurrentModel &&
          (currentModelId === effectiveModelId ||
            currentModelId === model.id ||
            currentAcpModelId === modelId);
        const providerModel: ServeWorkspaceProviderModel = {
          modelId,
          baseModelId: parseAcpBaseModelId(effectiveModelId),
          name: model.label,
          ...(model.description !== undefined
            ? { description: model.description }
            : {}),
          contextLimit: model.contextWindowSize ?? tokenLimit(effectiveModelId),
          ...(model.modalities !== undefined
            ? { modalities: model.modalities }
            : {}),
          ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
          ...(model.envKey !== undefined ? { envKey: model.envKey } : {}),
          isCurrent,
          isRuntime: model.isRuntimeModel === true,
        };
        provider.models.push(providerModel);
        if (isCurrent) provider.current = true;
      }

      const cgConfig = config.getContentGeneratorConfig?.();
      const baseUrl = cgConfig?.baseUrl || undefined;
      const fastModelId = this.settings.merged?.fastModel || undefined;

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        ...(currentAuth || currentAcpModelId
          ? {
              current: {
                ...(currentAuth ? { authType: String(currentAuth) } : {}),
                ...(currentAcpModelId ? { modelId: currentAcpModelId } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(fastModelId ? { fastModelId } : {}),
              },
            }
          : {}),
        providers: [...providers.values()],
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: true,
        providers: [],
        errors: [this.errorCell('providers', error)],
      };
    }
  }

  private async buildAcpPreflightCells(
    config: Config,
  ): Promise<{ cells: ServePreflightCell[]; errors?: ServeStatusCell[] }> {
    // Drive emission order from the shared `ACP_PREFLIGHT_KINDS` constant
    // (also consumed by `createIdleAcpPreflightCells` in `serve/status.ts`)
    // so the idle-placeholder list and the live builder cannot drift —
    // adding a new ACP kind in the constant flags any builder dispatch
    // gap as a TS exhaustiveness error in the switch below, instead of
    // silently dropping the cell from one path or the other.
    const builders: Record<
      AcpPreflightKind,
      () => ServePreflightCell | Promise<ServePreflightCell>
    > = {
      auth: () => this.buildAuthPreflightCell(config),
      mcp_discovery: () => this.buildMcpDiscoveryPreflightCell(config),
      skills: () => this.buildSkillsPreflightCell(config),
      providers: () => this.buildProvidersPreflightCell(config),
      tool_registry: () => this.buildToolRegistryPreflightCell(config),
      egress: () => ({
        kind: 'egress',
        status: 'not_started',
        locality: 'acp',
        hint: 'egress probing not yet implemented',
      }),
    };
    const cells: ServePreflightCell[] = [];
    for (const kind of ACP_PREFLIGHT_KINDS) {
      cells.push(await builders[kind]());
    }
    return { cells };
  }

  private acpCell(
    kind: ServePreflightKind,
    spec: Omit<ServePreflightCell, 'kind' | 'locality'>,
  ): ServePreflightCell {
    return { kind, locality: 'acp', ...spec };
  }

  /**
   * Pure auth preflight check. Looks up the well-known env var keys for the
   * configured auth method (via `AUTH_ENV_MAPPINGS`) and reports whether at
   * least one is present.
   *
   * Deliberately does NOT call `validateAuthMethod` from `cli/config/auth.ts`:
   * that helper has side effects (reloads `.env` from disk via
   * `loadEnvironment`, writes `process.env['GOOGLE_GENAI_USE_VERTEXAI']` for
   * Vertex auth) which would let a read-only `GET /workspace/preflight`
   * mutate daemon state and produce torn snapshots when racing
   * `GET /workspace/env`. Full validation still happens at session start.
   */
  private buildAuthPreflightCell(config: Config): ServePreflightCell {
    try {
      const authType = config.getAuthType?.();
      if (!authType) {
        return this.acpCell('auth', {
          status: 'warning',
          errorKind: 'auth_env_error',
          error: 'No auth method configured.',
          hint: 'Run `qwen` and complete the auth flow, or set a provider env var.',
          detail: { source: 'none', hasToken: false },
        });
      }
      const apiKeyVars = AUTH_PREFLIGHT_ENV_KEYS[String(authType)] ?? [];
      const presentVar = apiKeyVars.find((name: string) =>
        Boolean(process.env[name]),
      );
      const hasToken = Boolean(presentVar);
      // No env-var registration → either OAuth-style auth (qwen-oauth) or
      // a custom provider whose key is sourced from settings rather than
      // env. Surface as `unknown` (the SDK consumer can defer to the
      // `/session` boot for definitive validation) rather than a false
      // negative.
      if (apiKeyVars.length === 0) {
        return this.acpCell('auth', {
          status: 'unknown',
          hint: 'Auth credentials for this provider are not env-keyed; full validation runs at session start.',
          detail: {
            source: String(authType),
            hasToken: 'unknown',
            envVarCandidates: [],
          },
        });
      }
      return this.acpCell('auth', {
        status: hasToken ? 'ok' : 'warning',
        ...(hasToken
          ? {}
          : {
              errorKind: 'auth_env_error' as const,
              error: `None of the env vars [${apiKeyVars.join(', ')}] is set for authType '${String(authType)}'.`,
              hint: `Set one of: ${apiKeyVars.join(' / ')}.`,
            }),
        detail: {
          source: String(authType),
          hasToken,
          envVarCandidates: apiKeyVars,
          ...(presentVar ? { presentVar } : {}),
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('auth', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildMcpDiscoveryPreflightCell(config: Config): ServePreflightCell {
    try {
      const discovery = this.discoveryState();
      const servers = config.getMcpServers() ?? {};
      const total = Object.keys(servers).length;
      // Today `MCPServerStatus` is `{CONNECTED, CONNECTING, DISCONNECTED}`,
      // but a future state (e.g. `ERROR`, `NEEDS_AUTH`) could be added.
      // Bucketing it as `disconnected` would silently lose the distinction
      // between "credential failed" and "idle, will spawn on demand".
      // Track an explicit `unknown` count so unrecognized states surface in
      // the cell `detail` rather than disappearing.
      const counts = {
        connected: 0,
        connecting: 0,
        disconnected: 0,
        unknown: 0,
      };
      for (const name of Object.keys(servers)) {
        const raw = getMCPServerStatus(name);
        switch (raw) {
          case MCPServerStatus.CONNECTED:
            counts.connected += 1;
            break;
          case MCPServerStatus.CONNECTING:
            counts.connecting += 1;
            break;
          case MCPServerStatus.DISCONNECTED:
            counts.disconnected += 1;
            break;
          default:
            counts.unknown += 1;
            break;
        }
      }
      const detail = { discoveryState: discovery, total, ...counts };

      if (total === 0) {
        return this.acpCell('mcp_discovery', {
          status: 'ok',
          detail,
          hint: 'No MCP servers configured.',
        });
      }
      if (counts.unknown > 0) {
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          errorKind: 'protocol_error',
          error: `${counts.unknown}/${total} MCP server(s) in an unrecognized state.`,
          detail,
        });
      }
      if (counts.disconnected > 0 && discovery === 'completed') {
        return this.acpCell('mcp_discovery', {
          status: 'error',
          errorKind: 'protocol_error',
          error: `${counts.disconnected}/${total} MCP server(s) disconnected after discovery.`,
          detail,
        });
      }
      if (counts.connecting > 0 || discovery === 'in_progress') {
        // No `errorKind`: this is a normal transitional state (just-spawned
        // MCP servers haven't completed their handshake yet), not an
        // `init_timeout`. The latter would push SDK consumers to render
        // timeout-specific remediation ("increase init timeout") when the
        // correct user action is simply "wait or retry shortly". A real
        // timeout surfaces via `BridgeTimeoutError` from the bridge's
        // `withTimeout`, mapped through `mapDomainErrorToErrorKind`.
        return this.acpCell('mcp_discovery', {
          status: 'warning',
          error: `${counts.connecting}/${total} MCP server(s) still connecting.`,
          detail,
        });
      }
      return this.acpCell('mcp_discovery', { status: 'ok', detail });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('mcp_discovery', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private async buildSkillsPreflightCell(
    config: Config,
  ): Promise<ServePreflightCell> {
    // Whole body wrapped in try so a Config getter that throws
    // synchronously (mock-style or future Config refactor) doesn't escape
    // out of `buildAcpPreflightCells` and 500 the whole envelope.
    try {
      const skillManager = config.getSkillManager();
      if (!skillManager) {
        return this.acpCell('skills', {
          status: 'disabled',
          // `disabled` here is the structural state — Config has no
          // SkillManager attached. That can mean the user opted out OR a
          // mis-config silently dropped the manager; preflight cannot
          // distinguish the two without settings introspection. Hint
          // surfaces the ambiguity so operators investigate when
          // unexpected.
          hint: 'No SkillManager attached to Config; verify settings if you expected skills to load.',
          detail: { configured: false },
        });
      }
      const skills = await skillManager.listSkills();
      return this.acpCell('skills', {
        status: 'ok',
        detail: { count: skills.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err);
      return this.acpCell('skills', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        ...(errorKind ? { errorKind } : {}),
      });
    }
  }

  private buildProvidersPreflightCell(config: Config): ServePreflightCell {
    try {
      const models = config.getAllConfiguredModels();
      const authType = config.getAuthType?.();
      if (models.length === 0) {
        // `authType` set but zero models = the next `POST /session` will
        // fail. Report `error`, not `warning`: the daemon literally cannot
        // serve a prompt in this state.
        return this.acpCell('providers', {
          status: authType ? 'error' : 'disabled',
          ...(authType ? { errorKind: 'auth_env_error' } : {}),
          ...(authType
            ? {
                error: `No model configured for authType ${String(authType)}.`,
              }
            : {}),
          detail: { count: 0, authType: authType ? String(authType) : null },
        });
      }
      const authTypes = new Set(models.map((m) => String(m.authType)));
      return this.acpCell('providers', {
        status: 'ok',
        detail: {
          count: models.length,
          providers: [...authTypes],
        },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'auth_env_error';
      return this.acpCell('providers', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildToolRegistryPreflightCell(config: Config): ServePreflightCell {
    try {
      const registry = config.getToolRegistry();
      if (!registry) {
        return this.acpCell('tool_registry', {
          status: 'error',
          errorKind: 'protocol_error',
          error: 'Tool registry is not initialized.',
        });
      }
      const tools = registry.getAllTools();
      return this.acpCell('tool_registry', {
        status: 'ok',
        detail: { count: tools.length },
      });
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'protocol_error';
      return this.acpCell('tool_registry', {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        errorKind,
      });
    }
  }

  private buildWorkspaceToolsStatus(config: Config): ServeWorkspaceToolsStatus {
    const workspaceCwd = this.safeWorkspaceCwd(config);
    try {
      const registry = config.getToolRegistry();
      if (!registry) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          initialized: true,
          acpChannelLive: true,
          tools: [],
          errors: [
            {
              kind: 'tools',
              status: 'error',
              errorKind: 'protocol_error',
              error: 'Tool registry is not initialized.',
            },
          ],
        };
      }

      const disabled = config.getDisabledTools();
      const tools: ServeWorkspaceToolStatus[] = registry
        .getAllTools()
        .filter((tool) => !('serverName' in tool))
        .map((tool) => ({
          name: tool.name,
          displayName: tool.displayName,
          description: tool.description,
          enabled: !disabled.has(tool.name),
        }));

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        acpChannelLive: true,
        tools,
      };
    } catch (err) {
      const errorKind = mapDomainErrorToErrorKind(err) ?? 'protocol_error';
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        acpChannelLive: true,
        tools: [],
        errors: [
          {
            kind: 'tools',
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            errorKind,
          },
        ],
      };
    }
  }

  private sessionOrThrow(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return session;
  }

  private buildSessionContextStatus(
    sessionId: string,
  ): ServeSessionContextStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      state: {
        models: this.buildAvailableModels(config),
        modes: this.buildModesData(config),
        configOptions: this.buildConfigOptions(config),
      },
    };
  }

  private async buildSessionContextUsageStatus(
    sessionId: string,
    showDetails: boolean,
  ): Promise<ServeSessionContextUsageStatus> {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    let usage;
    try {
      usage = await collectContextData(config, showDetails);
    } catch (err) {
      console.warn('[context-usage] collectContextData failed:', err);
      usage = {
        type: 'context_usage' as const,
        modelName: config.getModel() || 'unknown',
        totalTokens: 0,
        contextWindowSize: 0,
        breakdown: {
          systemPrompt: 0,
          builtinTools: 0,
          mcpTools: 0,
          memoryFiles: 0,
          skills: 0,
          messages: 0,
          freeSpace: 0,
          autocompactBuffer: 0,
        },
        builtinTools: [] as Array<{ name: string; tokens: number }>,
        mcpTools: [] as Array<{ name: string; tokens: number }>,
        memoryFiles: [] as Array<{ path: string; tokens: number }>,
        skills: [] as Array<{
          name: string;
          tokens: number;
          loaded?: boolean;
          bodyTokens?: number;
        }>,
        isEstimated: true,
        showDetails,
      };
    }
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      usage: {
        modelName: usage.modelName,
        totalTokens: usage.totalTokens,
        contextWindowSize: usage.contextWindowSize,
        breakdown: usage.breakdown,
        builtinTools: usage.builtinTools,
        mcpTools: usage.mcpTools,
        memoryFiles: usage.memoryFiles,
        skills: usage.skills,
        isEstimated: usage.isEstimated,
        showDetails: usage.showDetails,
      },
      formattedText: formatContextUsageText(usage as HistoryItemContextUsage),
    };
  }

  private async buildSessionSupportedCommandsStatus(
    sessionId: string,
  ): Promise<ServeSessionSupportedCommandsStatus> {
    const session = this.sessionOrThrow(sessionId);
    const { availableCommands, availableSkills } =
      await buildAvailableCommandsSnapshot(session.getConfig());
    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      availableCommands,
      availableSkills: availableSkills ?? [],
    };
  }

  private buildSessionTasksStatus(sessionId: string): ServeSessionTasksStatus {
    const session = this.sessionOrThrow(sessionId);
    return buildSessionTasksStatus(sessionId, session.getConfig());
  }

  private buildSessionStatsStatus(sessionId: string): ServeSessionStatsStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    // TODO: uiTelemetryService is process-wide; multi-session stats are cumulative
    const metrics = uiTelemetryService.getMetrics();
    const now = Date.now();
    const createdAt = session.getCreatedAt();

    const models: ServeSessionStatsStatus['models'] = {};
    for (const [name, m] of Object.entries(metrics.models)) {
      models[name] = {
        api: { ...m.api },
        tokens: { ...m.tokens },
      };
    }

    const byName: ServeSessionStatsStatus['tools']['byName'] = {};
    for (const [name, t] of Object.entries(metrics.tools.byName)) {
      byName[name] = {
        count: t.count,
        success: t.success,
        fail: t.fail,
        durationMs: t.durationMs,
        decisions: {
          accept: t.decisions.accept,
          reject: t.decisions.reject,
          modify: t.decisions.modify,
          auto_accept: t.decisions.auto_accept,
        },
      };
    }

    return {
      v: STATUS_SCHEMA_VERSION,
      sessionId,
      workspaceCwd: this.workspaceCwd(config),
      sessionStartTimeMs: createdAt,
      durationMs: now - createdAt,
      promptCount: session.getTurnCount(),
      models,
      tools: {
        totalCalls: metrics.tools.totalCalls,
        totalSuccess: metrics.tools.totalSuccess,
        totalFail: metrics.tools.totalFail,
        totalDurationMs: metrics.tools.totalDurationMs,
        byName,
      },
      files: {
        totalLinesAdded: metrics.files.totalLinesAdded,
        totalLinesRemoved: metrics.files.totalLinesRemoved,
      },
    };
  }

  private serializeHookConfig(config: HookConfig): ServeHookConfig {
    switch (config.type) {
      case 'command':
        return {
          type: 'command',
          command: config.command,
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.env ? { env: config.env } : {}),
          ...(config.async !== undefined ? { async: config.async } : {}),
          ...(config.shell ? { shell: config.shell } : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
        };
      case 'http':
        return {
          type: 'http',
          url: config.url,
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.headers ? { headers: config.headers } : {}),
          ...(config.allowedEnvVars
            ? { allowedEnvVars: config.allowedEnvVars }
            : {}),
          ...(config.if !== undefined ? { if: config.if } : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
          ...(config.once !== undefined ? { once: config.once } : {}),
        };
      case 'function':
        return {
          type: 'function',
          ...(config.id !== undefined ? { id: config.id } : {}),
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.errorMessage !== undefined
            ? { errorMessage: config.errorMessage }
            : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
        };
      case 'prompt':
        return {
          type: 'prompt',
          prompt: config.prompt,
          ...(config.name !== undefined ? { name: config.name } : {}),
          ...(config.description !== undefined
            ? { description: config.description }
            : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
          ...(config.model ? { model: config.model } : {}),
          ...(config.statusMessage !== undefined
            ? { statusMessage: config.statusMessage }
            : {}),
        };
      default:
        return { type: (config as { type: string }).type };
    }
  }

  private buildWorkspaceHooksStatus(config: Config): ServeWorkspaceHooksStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const disabled = config.getDisableAllHooks();
      const hookSystem = config.getHookSystem();
      if (!hookSystem) {
        return {
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd,
          initialized: true,
          disabled,
          hooks: [],
          events: IDLE_HOOK_EVENTS,
        };
      }
      const registryEntries = hookSystem.getAllHooks();
      const hooks: ServeHookEntry[] = registryEntries.map(
        (entry): ServeHookEntry => ({
          kind: 'hook',
          eventName: entry.eventName,
          config: this.serializeHookConfig(entry.config),
          source: entry.source as ServeHookSource,
          ...(entry.matcher ? { matcher: entry.matcher } : {}),
          ...(entry.sequential !== undefined
            ? { sequential: entry.sequential }
            : {}),
          enabled: entry.enabled,
        }),
      );
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        disabled,
        hooks,
        events: IDLE_HOOK_EVENTS,
      };
    } catch (error) {
      let disabled = false;
      try {
        disabled = config.getDisableAllHooks();
      } catch {
        // config may be in a broken state; fall back to false
      }
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: false,
        disabled,
        hooks: [],
        events: IDLE_HOOK_EVENTS,
        errors: [this.errorCell('hooks', error)],
      };
    }
  }

  private buildSessionHooksStatus(sessionId: string): ServeSessionHooksStatus {
    const session = this.sessionOrThrow(sessionId);
    const config = session.getConfig();
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const disabled = config.getDisableAllHooks();
      const hookSystem = config.getHookSystem();
      if (!hookSystem) {
        return {
          v: STATUS_SCHEMA_VERSION,
          sessionId,
          workspaceCwd,
          disabled,
          hooks: [],
        };
      }
      const sessionHooks = hookSystem
        .getSessionHooksManager()
        .getAllSessionHooks(sessionId);
      const hooks: ServeHookEntry[] = sessionHooks.map(
        (entry): ServeHookEntry => ({
          kind: 'hook',
          eventName: entry.eventName,
          config: this.serializeHookConfig(entry.config),
          source: 'session',
          ...(entry.matcher ? { matcher: entry.matcher } : {}),
          ...(entry.sequential !== undefined
            ? { sequential: entry.sequential }
            : {}),
          enabled: true,
          hookId: entry.hookId,
          ...(entry.skillRoot ? { skillRoot: entry.skillRoot } : {}),
        }),
      );
      return {
        v: STATUS_SCHEMA_VERSION,
        sessionId,
        workspaceCwd,
        disabled,
        hooks,
      };
    } catch (error) {
      let disabled = false;
      try {
        disabled = config.getDisableAllHooks();
      } catch {
        // config may be in a broken state; fall back to false
      }
      return {
        v: STATUS_SCHEMA_VERSION,
        sessionId,
        workspaceCwd: this.safeWorkspaceCwd(config),
        disabled,
        hooks: [],
        errors: [this.errorCell('session_hooks', error)],
      };
    }
  }

  private buildWorkspaceExtensionsStatus(
    config: Config,
  ): ServeWorkspaceExtensionsStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const extensions = config.getExtensions();
      const entries: ServeExtensionEntry[] = extensions.map(
        (ext): ServeExtensionEntry => {
          const capabilities: ServeExtensionCapabilities = {
            mcpServerCount: ext.mcpServers
              ? Object.keys(ext.mcpServers).length
              : 0,
            skillCount: ext.skills?.length ?? 0,
            agentCount: ext.agents?.length ?? 0,
            hookCount: ext.hooks
              ? Object.values(ext.hooks).reduce(
                  (sum, defs) => sum + (defs?.length ?? 0),
                  0,
                )
              : 0,
            commandCount: ext.commands?.length ?? 0,
            contextFileCount: ext.contextFiles.length,
            channelCount: ext.channels ? Object.keys(ext.channels).length : 0,
            hasSettings: (ext.settings?.length ?? 0) > 0,
          };
          return {
            kind: 'extension',
            id: ext.id,
            name: ext.name,
            version: ext.version,
            isActive: ext.isActive,
            path: ext.path,
            ...(ext.installMetadata?.source
              ? { source: redactUrlCredentials(ext.installMetadata.source) }
              : {}),
            ...(ext.installMetadata?.type
              ? { installType: ext.installMetadata.type }
              : {}),
            ...(ext.installMetadata?.originSource
              ? { originSource: ext.installMetadata.originSource }
              : {}),
            ...(ext.installMetadata?.ref
              ? { ref: ext.installMetadata.ref }
              : {}),
            ...(ext.installMetadata?.autoUpdate !== undefined
              ? { autoUpdate: ext.installMetadata.autoUpdate }
              : {}),
            capabilities,
          };
        },
      );
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        extensions: entries,
      };
    } catch (error) {
      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd: this.safeWorkspaceCwd(config),
        initialized: false,
        extensions: [],
        errors: [this.errorCell('extensions', error)],
      };
    }
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cwd = (params['cwd'] as string) || process.cwd();
    const SESSION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;

    switch (method) {
      case SERVE_STATUS_EXT_METHODS.workspaceMcp:
        return (await this.buildWorkspaceMcpStatus(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspaceMcpTools: {
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        return this.buildWorkspaceMcpToolsStatus(
          this.config,
          serverName,
        ) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceSkills:
        return (await this.buildWorkspaceSkillsStatus(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspaceTools:
        return this.buildWorkspaceToolsStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.workspaceProviders:
        return this.buildWorkspaceProvidersStatus(
          this.config,
        ) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspacePreflight:
        return (await this.buildAcpPreflightCells(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.sessionContext: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionContextStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionContextUsage: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return (await this.buildSessionContextUsageStatus(
          sessionId,
          params['detail'] === true,
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.sessionSupportedCommands: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return (await this.buildSessionSupportedCommandsStatus(
          sessionId,
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.sessionTasks: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionTasksStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionStats: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionStatsStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.sessionRewindSnapshots: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessions.get(sessionId as string);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }
        const fhs = session.getConfig().getFileHistoryService();
        const snapshots = fhs.getSnapshots();
        const prefix = (sessionId as string) + '########';
        const results = await Promise.all(
          snapshots
            .map((s, idx) => ({ s, idx }))
            .filter(
              ({ s }) =>
                s.promptId.startsWith(prefix) &&
                /^\d+$/.test(s.promptId.slice(prefix.length)),
            )
            .map(async ({ s, idx }) => {
              const stats = await fhs.getDiffStats(s.promptId);
              return {
                promptId: s.promptId,
                turnIndex: idx,
                timestamp: s.timestamp.toISOString(),
                diffStats: {
                  filesChanged: stats?.filesChanged?.length ?? 0,
                  insertions: stats?.insertions ?? 0,
                  deletions: stats?.deletions ?? 0,
                },
              };
            }),
        );
        return { snapshots: results } as unknown as Record<string, unknown>;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceHooks:
        return this.buildWorkspaceHooksStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.sessionHooks: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        return this.buildSessionHooksStatus(sessionId) as unknown as Record<
          string,
          unknown
        >;
      }
      case SERVE_STATUS_EXT_METHODS.workspaceExtensions:
        return this.buildWorkspaceExtensionsStatus(
          this.config,
        ) as unknown as Record<string, unknown>;
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart: {
        // Single-server MCP restart with budget pre-check. Soft skips
        // return structured 200 responses; hard errors propagate as
        // JSON-RPC errors. Pool-mode routing when available.
        const serverName = params['serverName'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        // Optional `entryIndex` selector for pool-mode targeted restarts.
        let entryIndex: number | undefined;
        const rawEntryIndex = params['entryIndex'];
        if (rawEntryIndex !== undefined && rawEntryIndex !== '*') {
          if (
            typeof rawEntryIndex !== 'number' ||
            !Number.isInteger(rawEntryIndex) ||
            rawEntryIndex < 0
          ) {
            throw RequestError.invalidParams(
              undefined,
              'entryIndex must be a non-negative integer or "*"',
            );
          }
          entryIndex = rawEntryIndex;
        }
        const servers = this.config.getMcpServers() ?? {};
        if (!Object.prototype.hasOwnProperty.call(servers, serverName)) {
          // Structured payload so the bridge can map to a typed
          // `McpServerNotFoundError` and HTTP 404.
          throw new RequestError(
            -32004,
            `MCP server not configured: ${JSON.stringify(serverName)}`,
            { errorKind: 'mcp_server_not_found', serverName },
          );
        }
        if (this.config.isMcpServerDisabled(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'disabled' as const,
          };
        }
        const manager = this.config.getToolRegistry()?.getMcpClientManager();
        if (!manager) {
          throw RequestError.internalError(
            undefined,
            'McpClientManager unavailable on this Config',
          );
        }
        if (manager.isServerDiscovering(serverName)) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'in_flight' as const,
          };
        }
        const accounting = manager.getMcpClientAccounting();
        const budget = manager.getMcpClientBudget();
        const mode = manager.getMcpBudgetMode();
        // Check `reservedSlots.length` (not `total`) to mirror the
        // manager's enforce-mode capacity policy.
        if (
          mode === 'enforce' &&
          budget !== undefined &&
          !accounting.reservedSlots.includes(serverName) &&
          accounting.reservedSlots.length >= budget
        ) {
          return {
            serverName,
            restarted: false,
            skipped: true,
            reason: 'budget_would_exceed' as const,
          };
        }
        // Re-read MERGED settings to pick up any `tools.disabled`
        // toggles applied since this ACP child booted. Reads need the
        // union (User + System + Workspace); writes target Workspace only.
        try {
          const fresh = loadSettings(this.config.getTargetDir());
          const mergedDisabled = fresh.merged.tools?.disabled;
          // Detect and stderr-log malformed `tools.disabled` before
          // clearing so a misconfigured settings file is loud.
          if (mergedDisabled !== undefined && !Array.isArray(mergedDisabled)) {
            process.stderr.write(
              `qwen serve: MCP restart for ${JSON.stringify(serverName)}: ` +
                `tools.disabled has unexpected type ${typeof mergedDisabled}; ` +
                `clearing disabled set — check settings.json. ` +
                `Expected an array of strings.\n`,
            );
          }
          // Use the shared `normalizeDisabledToolList` helper so
          // boot and restart paths agree on what counts as "disabled".
          const disabledList = normalizeDisabledToolList(mergedDisabled);
          this.config.setDisabledTools(new Set(disabledList));
        } catch (err) {
          // Settings load failures are non-fatal — fall through with
          // the existing in-memory snapshot.
          process.stderr.write(
            `qwen serve: MCP restart for ${JSON.stringify(serverName)} ` +
              `could not refresh disabledTools from merged settings ` +
              `(${err instanceof Error ? err.message : String(err)}); ` +
              `proceeding with the bootstrap snapshot — recently toggled ` +
              `tools may not take effect until daemon restart.\n`,
          );
        }
        // Pool-mode routing: when the pool holds entries for this name,
        // route through the pool. Legacy path stays as fallback.
        const poolSnapshot = this.mcpPool?.getSnapshot();
        const poolHasEntries =
          poolSnapshot !== undefined &&
          (poolSnapshot.byName[serverName]?.entryCount ?? 0) > 0;
        if (this.mcpPool && poolHasEntries) {
          const restartResults = await this.mcpPool.restartByName(serverName, {
            ...(entryIndex !== undefined ? { entryIndex } : {}),
          });
          // When `entryIndex` doesn't match any current pool entry,
          // return an empty `entries` array (soft signal).
          return {
            serverName,
            entries: restartResults,
          };
        }
        // Route through `ToolRegistry.discoverToolsForServer` (not the
        // manager directly) so existing tools are purged before
        // rediscovery — ensures toggle-disable-then-restart works.
        // An explicit `entryIndex` against the legacy (no-pool) path
        // is invalid unless it's 0.
        if (entryIndex !== undefined && entryIndex !== 0) {
          throw RequestError.invalidParams(
            undefined,
            `entryIndex=${entryIndex} requested but pool not active for ` +
              `${JSON.stringify(serverName)} — legacy single-entry path ` +
              `only supports entryIndex=0 or undefined`,
          );
        }
        const start = Date.now();
        const toolRegistry = this.config.getToolRegistry();
        if (!toolRegistry) {
          throw RequestError.internalError(
            undefined,
            'ToolRegistry unavailable on this Config',
          );
        }
        await toolRegistry.discoverToolsForServer(serverName);
        // Verify the live status after restart; anything other than
        // CONNECTED means the restart didn't take effect.
        const postStatus = getMCPServerStatus(serverName);
        if (postStatus !== MCPServerStatus.CONNECTED) {
          throw new RequestError(
            -32099,
            `MCP server ${JSON.stringify(serverName)} did not reach a ` +
              `connected state after restart (status: ${postStatus}).`,
            {
              errorKind: 'mcp_restart_failed',
              serverName,
              mcpStatus: postStatus,
            },
          );
        }
        return {
          serverName,
          restarted: true,
          durationMs: Date.now() - start,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpManage: {
        const serverName = params['serverName'];
        const action = params['action'];
        if (typeof serverName !== 'string' || serverName.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing serverName',
          );
        }
        if (
          action !== 'enable' &&
          action !== 'disable' &&
          action !== 'authenticate' &&
          action !== 'clear-auth'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing MCP manage action',
          );
        }
        const servers = this.config.getMcpServers() ?? {};
        const server = servers[serverName];
        if (!server) {
          throw new RequestError(
            -32004,
            `MCP server not configured: ${JSON.stringify(serverName)}`,
            { errorKind: 'mcp_server_not_found', serverName },
          );
        }
        const toolRegistry = this.config.getToolRegistry();
        if (!toolRegistry) {
          throw RequestError.internalError(
            undefined,
            'ToolRegistry unavailable on this Config',
          );
        }

        if (action === 'enable') {
          const settings = loadSettings(this.config.getTargetDir());
          for (const scope of [SettingScope.User, SettingScope.Workspace]) {
            const scopeSettings = settings.forScope(scope).settings;
            const currentExcluded = scopeSettings.mcp?.excluded || [];
            if (currentExcluded.includes(serverName)) {
              settings.setValue(
                scope,
                'mcp.excluded',
                currentExcluded.filter((name: string) => name !== serverName),
              );
            }
          }
          const currentExcluded = this.config.getExcludedMcpServers() || [];
          this.config.setExcludedMcpServers(
            currentExcluded.filter((name: string) => name !== serverName),
          );
          await toolRegistry.discoverToolsForServer(serverName);
          return { serverName, action, ok: true, changed: true };
        }

        if (action === 'disable') {
          const settings = loadSettings(this.config.getTargetDir());
          const userSettings = settings.forScope(SettingScope.User).settings;
          const workspaceSettings = settings.forScope(
            SettingScope.Workspace,
          ).settings;
          let targetScope = SettingScope.User;
          if (server.extensionName) {
            throw RequestError.invalidParams(
              undefined,
              `Cannot disable extension MCP server: ${serverName}`,
            );
          }
          if (workspaceSettings.mcpServers?.[serverName]) {
            targetScope = SettingScope.Workspace;
          } else if (userSettings.mcpServers?.[serverName]) {
            targetScope = SettingScope.User;
          }
          const scopeSettings = settings.forScope(targetScope).settings;
          const currentExcluded = scopeSettings.mcp?.excluded || [];
          if (!currentExcluded.includes(serverName)) {
            settings.setValue(targetScope, 'mcp.excluded', [
              ...currentExcluded,
              serverName,
            ]);
          }
          const runtimeExcluded = this.config.getExcludedMcpServers() || [];
          if (!runtimeExcluded.includes(serverName)) {
            this.config.setExcludedMcpServers([...runtimeExcluded, serverName]);
          }
          await toolRegistry.disableMcpServer(serverName);
          return { serverName, action, ok: true, changed: true };
        }

        if (action === 'clear-auth') {
          const tokenStorage = new MCPOAuthTokenStorage();
          await tokenStorage.deleteCredentials(serverName);
          await toolRegistry.disconnectServer(serverName);
          return { serverName, action, ok: true, changed: true };
        }

        const messages: string[] = [];
        let authUrl: string | undefined;
        const displayListener = (message: unknown) => {
          if (typeof message === 'string') {
            messages.push(message);
          } else if (message && typeof message === 'object') {
            const key = (message as { key?: unknown }).key;
            if (typeof key === 'string') {
              messages.push(key);
            }
          }
        };
        const authUrlListener = (url: unknown) => {
          if (typeof url === 'string') {
            authUrl = url;
          }
        };
        appEvents.on(AppEvent.OauthDisplayMessage, displayListener);
        appEvents.on(AppEvent.OauthAuthUrl, authUrlListener);
        try {
          const oauthConfig = server.oauth ?? { enabled: false };
          const mcpServerUrl = server.httpUrl || server.url;
          const authProvider = new MCPOAuthProvider(new MCPOAuthTokenStorage());
          await authProvider.authenticate(
            serverName,
            oauthConfig,
            mcpServerUrl,
            appEvents,
          );
          messages.push(
            `Successfully authenticated and refreshed tools for '${serverName}'.`,
          );
          await toolRegistry.discoverToolsForServer(serverName);
          const geminiClient = this.config.getGeminiClient();
          if (geminiClient) {
            await geminiClient.setTools();
          }
          return {
            serverName,
            action,
            ok: true,
            changed: true,
            messages,
            ...(authUrl ? { authUrl } : {}),
          };
        } finally {
          appEvents.removeListener(
            AppEvent.OauthDisplayMessage,
            displayListener,
          );
          appEvents.removeListener(AppEvent.OauthAuthUrl, authUrlListener);
        }
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceAgentGenerate: {
        const description = params['description'];
        if (
          typeof description !== 'string' ||
          !description.trim() ||
          description.length > 4096
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing description (max 4096 chars)',
          );
        }
        // No end-to-end AbortSignal from the bridge ext-method yet.
        // The bridge may time out via Promise.race, but that only
        // rejects the caller — this generator keeps running until it
        // finishes naturally. A real fix requires wiring an abort
        // signal through the ext-method protocol.
        return (await subagentGenerator(
          description.trim(),
          this.config,
          AbortSignal.timeout(5 * 60_000),
        )) as unknown as Record<string, unknown>;
      }
      case SERVE_CONTROL_EXT_METHODS.sessionClose: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        await this.closeStoredSession(sessionId);
        return { sessionId, closed: true };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionApprovalMode: {
        const sessionId = params['sessionId'];
        const mode = params['mode'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          typeof mode !== 'string' ||
          !APPROVAL_MODES.includes(mode as ApprovalMode)
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid approval mode; allowed: ${APPROVAL_MODES.join(', ')}`,
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const previous = config.getApprovalMode();
        try {
          config.setApprovalMode(mode as ApprovalMode);
        } catch (err) {
          // `TrustGateError` is the core's structured rejection for
          // untrusted-folder + privileged-mode. We re-raise it as a
          // JSON-RPC error whose `data.errorKind` is the literal the
          // bridge looks for to reconstruct a typed `TrustGateError` on
          // the daemon side (JSON-RPC strips the class name across the
          // wire). Other errors propagate unchanged.
          if (err instanceof Error && err.name === 'TrustGateError') {
            throw new RequestError(-32003, err.message, {
              errorKind: 'trust_gate',
            });
          }
          throw err;
        }
        const current = config.getApprovalMode();
        return { previous, current };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionLanguage: {
        const sessionId = params['sessionId'];
        const language = params['language'];
        const syncOutputLanguage = params['syncOutputLanguage'] === true;

        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const allowedLanguages = [
          ...SUPPORTED_LANGUAGES.map((l) => l.code),
          'auto',
        ];
        if (
          typeof language !== 'string' ||
          !allowedLanguages.includes(language)
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid language; must be one of: ${allowedLanguages.join(', ')}`,
          );
        }

        this.sessionOrThrow(sessionId);

        try {
          await setLanguageAsync(language);
        } catch (err) {
          debugLogger.warn('setLanguageAsync failed:', err);
          throw new RequestError(
            -32603,
            `Failed to switch UI language: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const resolvedLanguage = getCurrentLanguage();

        try {
          this.settings.setValue(
            SettingScope.User,
            'general.language',
            language,
          );
        } catch (err) {
          debugLogger.warn('Failed to persist UI language setting:', err);
        }

        let outputLanguage: string | null = null;
        let refreshed = false;

        if (syncOutputLanguage) {
          const resolved = resolveOutputLanguage(language);
          const settingValue = isAutoLanguage(language)
            ? OUTPUT_LANGUAGE_AUTO
            : resolved;

          let fileWriteOk = false;
          try {
            updateOutputLanguageFile(settingValue);
            fileWriteOk = true;
          } catch (err) {
            debugLogger.warn('Failed to write output-language.md:', err);
          }

          if (fileWriteOk) {
            try {
              this.settings.setValue(
                SettingScope.User,
                'general.outputLanguage',
                settingValue,
              );
            } catch (err) {
              debugLogger.warn(
                'Failed to persist output language setting:',
                err,
              );
            }
            const allSessions = [...this.sessions.values()];
            const results = await Promise.allSettled(
              allSessions.map(async (s) => {
                const cfg = s.getConfig();
                await cfg.refreshHierarchicalMemory();
                await cfg.getGeminiClient()?.refreshSystemInstruction();
              }),
            );
            const failedCount = results.filter(
              (r) => r.status === 'rejected',
            ).length;
            if (failedCount > 0) {
              debugLogger.warn(
                `Language refresh failed for ${failedCount}/${results.length} session(s)`,
              );
            }
            refreshed = results.length === 0 || failedCount === 0;
          }
          outputLanguage = fileWriteOk ? resolved : null;
        }

        return { language: resolvedLanguage, outputLanguage, refreshed };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionRecap: {
        // Generate a one-sentence "where did I leave off" summary.
        // Best-effort: returns `null` on short history or model failure.
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        debugLogger.debug(`recap ext-method received for session=${sessionId}`);
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        // v1: no cross-process abort plumbing. The bridge does not listen
        // for HTTP client disconnect and no AbortSignal is threaded through
        // the ext-method, so the LLM call in this child always runs to
        // completion. The only ceilings are the bridge's 60s
        // `SESSION_RECAP_TIMEOUT_MS` backstop and the transport-closed race
        // against ACP channel death. Acceptable because recap is short
        // (single-attempt side-query, `maxOutputTokens: 300`). A future
        // request-id-based cancel ext-method can plumb a real signal
        // end-to-end if the bandwidth cost ever becomes an issue.
        const recap = await generateSessionRecap(
          config,
          new AbortController().signal,
        );
        debugLogger.debug(
          `recap ext-method completed for session=${sessionId} result=${recap ? `len=${recap.length}` : 'null'}`,
        );
        return { sessionId, recap };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionBtw: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const question = params['question'];
        if (
          typeof question !== 'string' ||
          !question.trim() ||
          question.length > BTW_MAX_INPUT_LENGTH
        ) {
          throw RequestError.invalidParams(
            undefined,
            `Invalid or missing question (max ${BTW_MAX_INPUT_LENGTH} chars)`,
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const cacheSafeParams = buildBtwCacheSafeParams(config);
        if (!cacheSafeParams) {
          debugLogger.debug(`btw: no cacheSafeParams for session=${sessionId}`);
          return { sessionId, answer: null };
        }
        const childSignal = AbortSignal.timeout(BTW_CHILD_TIMEOUT_MS);
        let result;
        try {
          result = await runForkedAgent({
            config,
            userMessage: buildBtwPrompt(question.trim()),
            cacheSafeParams,
            abortSignal: childSignal,
          });
        } catch (err) {
          if (childSignal.aborted) {
            throw RequestError.internalError(
              undefined,
              'Side question timed out after 55s',
            );
          }
          throw err;
        }
        return { sessionId, answer: result.text || null };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionShellHistory: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const command = params['command'];
        if (typeof command !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing command',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        const config = session.getConfig();
        const geminiClient = config.getGeminiClient()!;
        const outputText =
          typeof params['output'] === 'string' ? params['output'] : '';
        geminiClient.addHistory({
          role: 'user',
          parts: [
            {
              text: `I ran the following shell command:\n\`\`\`sh\n${command}\n\`\`\`\n\nThis produced the following result:\n\`\`\`\n${outputText}\n\`\`\``,
            },
          ],
        });
        return { sessionId, injected: true };
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd: {
        const name = params['name'];
        const config = params['config'];
        const originatorClientId = params['originatorClientId'];
        if (typeof name !== 'string' || name.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing name',
          );
        }
        if (
          name.length > 256 ||
          !/^[A-Za-z0-9_-]+$/.test(name) ||
          name === '__proto__' ||
          name === 'constructor' ||
          name === 'prototype'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Server name must be ≤256 chars, alphanumeric + underscore/hyphen, and not a reserved JS property name',
          );
        }
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing config',
          );
        }
        if (
          typeof originatorClientId !== 'string' ||
          originatorClientId.length === 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing originatorClientId',
          );
        }
        const manager = this.config.getToolRegistry()?.getMcpClientManager();
        if (!manager) {
          throw RequestError.internalError(
            undefined,
            'McpClientManager unavailable on this Config',
          );
        }
        try {
          // Strip security-sensitive fields — runtime-added servers must
          // not bypass permission gates via trust:true, leak cloud creds
          // via authProviderType, manipulate tool filtering, or spawn in
          // arbitrary directories
          const {
            trust: _trust,
            authProviderType: _auth,
            includeTools: _inc,
            excludeTools: _exc,
            cwd: _cwd,
            env: _env,
            oauth: _oauth,
            headers: _headers,
            type: _type,
            ...safeConfig
          } = config as Record<string, unknown>;
          const result = await manager.addRuntimeMcpServer(
            name,
            safeConfig as MCPServerConfig,
            originatorClientId,
          );
          return result as unknown as Record<string, unknown>;
        } catch (err) {
          if (err instanceof McpBudgetWouldExceedError) {
            throw new RequestError(-32099, err.message, {
              errorKind: err.code,
              serverName: err.serverName,
            });
          }
          if (err instanceof McpServerSpawnFailedError) {
            throw new RequestError(-32099, err.message, {
              errorKind: err.code,
              serverName: err.serverName,
              ...err.details,
            });
          }
          if (err instanceof InvalidMcpConfigError) {
            throw new RequestError(-32099, err.message, {
              errorKind: err.code,
              serverName: err.serverName,
              reason: err.reason,
            });
          }
          throw err;
        }
      }
      case SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove: {
        const name = params['name'];
        const originatorClientId = params['originatorClientId'];
        if (typeof name !== 'string' || name.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing name',
          );
        }
        if (
          name.length > 256 ||
          !/^[A-Za-z0-9_-]+$/.test(name) ||
          name === '__proto__' ||
          name === 'constructor' ||
          name === 'prototype'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Server name must be ≤256 chars, alphanumeric + underscore/hyphen, and not a reserved JS property name',
          );
        }
        if (
          typeof originatorClientId !== 'string' ||
          originatorClientId.length === 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing originatorClientId',
          );
        }
        const manager = this.config.getToolRegistry()?.getMcpClientManager();
        if (!manager) {
          throw RequestError.internalError(
            undefined,
            'McpClientManager unavailable on this Config',
          );
        }
        const result = await manager.removeRuntimeMcpServer(
          name,
          originatorClientId,
        );
        return result as unknown as Record<string, unknown>;
      }
      case 'deleteSession': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.removeSession(sessionId);
          },
        );
        return { success };
      }
      case 'renameSession': {
        const sessionId = params['sessionId'] as string;
        const title = params['title'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!title || typeof title !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing title',
          );
        }
        if (title.length > SESSION_TITLE_MAX_LENGTH) {
          throw RequestError.invalidParams(
            undefined,
            `Title too long (max ${SESSION_TITLE_MAX_LENGTH} chars)`,
          );
        }
        // When the target session is currently live in this process, route
        // through its ChatRecordingService so the in-memory `currentCustomTitle`
        // stays in sync. Writing directly to disk via SessionService here
        // would leave the live recording's cache stale; the next title
        // re-anchor (every 32KB of writes) or finalize() would re-emit the
        // old title and silently revert the rename. The disk-only path
        // remains for the dead-session case (e.g., another client renaming
        // a session that isn't active in this process).
        const liveRecording = this.sessions
          .get(sessionId)
          ?.getConfig()
          .getChatRecordingService();
        if (liveRecording) {
          const ok = liveRecording.recordCustomTitle(title, 'manual');
          await liveRecording.flush();
          return { success: ok };
        }
        const success = await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.renameSession(sessionId, title);
          },
        );
        return { success };
      }
      case 'rewindSession':
      case SERVE_CONTROL_EXT_METHODS.sessionRewind: {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        let turnIndex: number | undefined = params['targetTurnIndex'] as
          | number
          | undefined;
        const promptId = params['promptId'] as string | undefined;

        if (promptId && (turnIndex === undefined || turnIndex === null)) {
          const prefix = sessionId + '########';
          if (!promptId.startsWith(prefix)) {
            throw new RequestError(-32602, 'Invalid promptId format', {
              errorKind: 'invalid_rewind_target',
            });
          }
          const suffix = promptId.slice(prefix.length);
          if (!/^\d+$/.test(suffix)) {
            throw new RequestError(
              -32602,
              'Invalid promptId: non-numeric turn suffix',
              { errorKind: 'invalid_rewind_target' },
            );
          }
          // Derive turnIndex from the snapshot's position in the array,
          // NOT from the promptId suffix. Session.turn is monotonic and
          // does not reset on rewind, so after a rewind cycle the suffix
          // no longer matches the turn's position in the current history.
          const fhs = session.getConfig().getFileHistoryService();
          const snapshots = fhs.getSnapshots();
          const snapshotIdx = snapshots.findIndex(
            (s) => s.promptId === promptId,
          );
          if (snapshotIdx < 0) {
            throw new RequestError(
              -32602,
              'Snapshot not found for the given promptId',
              { errorKind: 'invalid_rewind_target' },
            );
          }
          turnIndex = snapshotIdx;
        }

        if (!Number.isInteger(turnIndex) || (turnIndex as number) < 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing targetTurnIndex',
          );
        }

        const historyBeforeRewind = session.captureHistorySnapshot();
        let rewindResult;
        try {
          rewindResult = session.rewindToTurn(turnIndex as number);
        } catch (err) {
          if (err instanceof RequestError) {
            const msg = err.message;
            if (msg.includes('Cannot rewind while a prompt is running')) {
              throw new RequestError(err.code, msg, {
                errorKind: 'session_busy',
              });
            }
            if (msg.includes('compressed or does not exist')) {
              throw new RequestError(err.code, msg, {
                errorKind: 'invalid_rewind_target',
              });
            }
          }
          throw err;
        }

        let filesChanged: string[] = [];
        let filesFailed: string[] = [];
        const rewindFiles = params['rewindFiles'] !== false;
        if (rewindFiles && promptId) {
          const fhs = session.getConfig().getFileHistoryService();
          try {
            const fileResult = await fhs.rewind(promptId, true);
            filesChanged = fileResult.filesChanged;
            filesFailed = fileResult.filesFailed;
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            debugLogger.error(
              `[ACP] File-history rewind failed for session=${sessionId} promptId=${promptId}: ${reason}`,
            );
            filesFailed = [`file-history-rewind: ${reason}`];
          }
        }

        return {
          success: true,
          historyBeforeRewind,
          ...rewindResult,
          filesChanged,
          filesFailed,
        };
      }
      case 'restoreSessionHistory': {
        const sessionId = params['sessionId'] as string;
        const history = params['history'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!Array.isArray(history)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing history',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        session.restoreHistory(history as Content[]);
        return { success: true };
      }
      case 'getAccountInfo': {
        const sessionId = params['sessionId'] as string | undefined;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const config = session ? session.getConfig() : this.config;
        const cfg = config.getContentGeneratorConfig();
        return {
          authType: cfg?.authType ?? config.getAuthType() ?? null,
          model: cfg?.model ?? config.getModel() ?? null,
          baseUrl: cfg?.baseUrl ?? null,
          apiKeyEnvKey: cfg?.apiKeyEnvKey ?? null,
        };
      }
      case SERVE_CONTROL_EXT_METHODS.sessionBranch: {
        const sessionId = params['sessionId'];
        if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const name = params['name'];

        const sourceSession = this.sessions.get(sessionId);
        if (!sourceSession) {
          throw new RequestError(-32004, `Session not found: ${sessionId}`, {
            errorKind: 'session_not_found',
            sessionId,
          });
        }

        const recording = sourceSession.getConfig().getChatRecordingService();
        if (recording) {
          await recording.flush();
        }

        const newSessionId = randomUUID();
        return await runWithAcpRuntimeOutputDir(
          this.settings,
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            await sessionService.forkSession(sessionId, newSessionId);

            let title: string;
            try {
              let baseName: string;
              if (typeof name === 'string' && name.trim().length > 0) {
                baseName = name.trim();
              } else {
                const existingTitle = recording?.getCurrentCustomTitle();
                const stripped = existingTitle
                  ?.replace(/\s*\(Branch(?:\s+\d+)?\)\s*$/, '')
                  .trim();
                if (stripped && stripped.length > 0) {
                  baseName = stripped;
                } else {
                  baseName = sessionId.slice(0, 8);
                }
              }

              title = await computeUniqueBranchTitle(baseName, sessionService);
              const renamed = await sessionService.renameSession(
                newSessionId,
                title,
                'manual',
              );
              if (!renamed) {
                throw new RequestError(
                  -32603,
                  `Failed to set title on forked session ${newSessionId}`,
                  { errorKind: 'internal', sessionId: newSessionId },
                );
              }
            } catch (err) {
              sessionService.removeSession(newSessionId).catch((rmErr) => {
                process.stderr.write(
                  `qwen serve: failed to clean up orphan session ${newSessionId}: ${rmErr instanceof Error ? rmErr.message : rmErr}\n`,
                );
              });
              throw err;
            }

            return { newSessionId, title };
          },
        );
      }
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  // --- private helpers ---

  private async newSessionConfig(
    cwd: string,
    mcpServers: McpServer[],
    sessionId?: string,
    resume?: boolean,
  ): Promise<Config> {
    this.settings = loadSettings(cwd);
    const mergedMcpServers = { ...this.settings.merged.mcpServers };

    for (const server of mcpServers) {
      const stdioServer = toStdioServer(server);
      if (stdioServer) {
        const env: Record<string, string> = {};
        for (const { name: envName, value } of stdioServer.env) {
          env[envName] = value;
        }
        mergedMcpServers[stdioServer.name] = new MCPServerConfig(
          stdioServer.command,
          stdioServer.args,
          env,
          cwd,
        );
        continue;
      }

      const sseServer = toSseServer(server);
      if (sseServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of sseServer.headers) {
          headers[headerName] = value;
        }
        mergedMcpServers[sseServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          sseServer.url,
          undefined,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }

      const httpServer = toHttpServer(server);
      if (httpServer) {
        const headers: Record<string, string> = {};
        for (const { name: headerName, value } of httpServer.headers) {
          headers[headerName] = value;
        }
        mergedMcpServers[httpServer.name] = new MCPServerConfig(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          httpServer.url,
          Object.keys(headers).length > 0 ? headers : undefined,
        );
        continue;
      }
    }

    const settings = { ...this.settings.merged, mcpServers: mergedMcpServers };
    const argvForSession = {
      ...this.argv,
      ...(resume ? { resume: sessionId } : { sessionId }),
      continue: false,
    };

    const config = await loadCliConfig(
      settings,
      argvForSession,
      cwd,
      [],
      // Pass separated hooks for proper source attribution
      {
        userHooks: this.settings.getUserHooks(),
        projectHooks: this.settings.getProjectHooks(),
      },
      // CRITICAL: close over `this.settings` (LoadedSettings instance), NOT
      // over the local `settings` snapshot built above. `LoadedSettings.
      // setValue` replaces `_merged`, so a closure over the snapshot would
      // never see workspace toggles applied during the session. ACP/Zed
      // sessions otherwise leak persisted disabled skills into the first
      // <available_skills> at cold start.
      buildDisabledSkillNamesProvider(this.settings),
    );
    // Inject the workspace-shared MCP transport pool BEFORE
    // `config.initialize()` so the ToolRegistry picks it up.
    if (
      this.mcpPool !== undefined &&
      typeof config.setMcpTransportPool === 'function'
    ) {
      config.setMcpTransportPool(this.mcpPool);
    }
    // Register the MCP budget-event callback BEFORE `config.initialize()`
    // so it catches events from both synchronous and background discovery.
    const wiredSessionId =
      typeof config.getSessionId === 'function'
        ? config.getSessionId()
        : undefined;
    // When the workspace-scoped budget controller is active, skip the
    // per-session callback to prevent double-firing. Daemons without
    // a configured budget keep the per-session callback.
    const skipPerSessionBudgetCallback = this.workspaceMcpBudget !== undefined;
    if (
      !skipPerSessionBudgetCallback &&
      typeof config.setMcpBudgetEventCallback === 'function' &&
      wiredSessionId !== undefined
    ) {
      const sid = wiredSessionId;
      config.setMcpBudgetEventCallback((event) => {
        // Fire-and-forget. `.catch` suppresses unhandled rejections
        // and logs at debug level for operator visibility.
        void this.connection
          .extNotification('qwen/notify/session/mcp-budget-event', {
            v: 1,
            sessionId: sid,
            ...event,
          })
          .catch((err: unknown) => {
            debugLogger.debug(
              `MCP budget extNotification dropped ` +
                `(session=${sid}, kind=${event.kind}): ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          });
      });
    }
    await config.initialize();
    // Same reasoning as the top-level runAcpAgent path: ACP feeds session
    // messages to the model immediately, so we cannot return a Config whose
    // MCP discovery is still in flight.
    await config.waitForMcpReady();
    // Surface MCP failures to stderr — mirrors `runAcpAgent` (lines 95-107)
    // and the other non-interactive entry points (`gemini.tsx`,
    // `session.ts`). Without this, per-session ACP configs that lose MCP
    // servers fall back to built-in-tools-only with no user-visible
    // indication. Defensive against tests that pass a stubbed Config
    // without `getFailedMcpServerNames`.
    const failedMcpServers =
      typeof config.getFailedMcpServerNames === 'function'
        ? config.getFailedMcpServerNames()
        : [];
    if (failedMcpServers.length > 0) {
      process.stderr.write(
        `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
          `Continuing with built-in tools and any servers that did connect.\n`,
      );
    }
    return config;
  }

  private async ensureAuthenticated(config: Config): Promise<void> {
    const selectedType = config.getModelsConfig().getCurrentAuthType();
    if (!selectedType) {
      throw RequestError.authRequired(
        { authMethods: pickAuthMethodsForAuthRequired() },
        'Use Qwen Code CLI to authenticate first.',
      );
    }

    try {
      await config.refreshAuth(selectedType, true);
    } catch (e) {
      debugLogger.error(`Authentication failed: ${e}`);
      throw RequestError.authRequired(
        {
          authMethods: pickAuthMethodsForAuthRequired(selectedType),
        },
        'Authentication failed: ' + (e as Error).message,
      );
    }
  }

  private setupFileSystem(config: Config): void {
    if (!this.clientCapabilities?.fs) return;

    const acpFileSystemService = new AcpFileSystemService(
      this.connection,
      config.getSessionId(),
      this.clientCapabilities.fs,
      config.getFileSystemService(),
    );
    config.setFileSystemService(acpFileSystemService);
  }

  private async createAndStoreSession(
    config: Config,
    conversation?: ConversationRecord,
  ): Promise<Session> {
    const sessionId = config.getSessionId();
    const geminiClient = config.getGeminiClient();
    const needsInitialize = !geminiClient.isInitialized();

    if (needsInitialize) {
      await geminiClient.initialize();
    }

    this.sessions.get(sessionId)?.dispose();

    const session = new Session(
      sessionId,
      config,
      this.connection,
      this.settings,
    );
    this.sessions.set(sessionId, session);

    setTimeout(async () => {
      await session.sendAvailableCommandsUpdate();
    }, 0);

    if (conversation && conversation.messages) {
      await session.replayHistory(conversation.messages);
    }

    // Install rewriter AFTER history replay to avoid rewriting historical messages
    session.installRewriter();

    return session;
  }

  private buildAvailableModels(config: Config): NewSessionResponse['models'] {
    const rawCurrentModelId = (
      config.getModel() ||
      this.config.getModel() ||
      ''
    ).trim();
    const currentAuthType = config.getAuthType();
    const allConfiguredModels = config.getAllConfiguredModels();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = activeRuntimeSnapshot
      ? formatAcpModelId(
          activeRuntimeSnapshot.id,
          activeRuntimeSnapshot.authType,
        )
      : this.formatCurrentModelId(rawCurrentModelId, currentAuthType);

    const mappedAvailableModels = allConfiguredModels.map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;

      return {
        modelId: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? null,
        _meta: {
          contextLimit: model.contextWindowSize ?? tokenLimit(model.id),
        },
      };
    });

    return {
      currentModelId,
      availableModels: mappedAvailableModels,
    };
  }

  private buildModesData(config: Config): SessionModeState {
    const currentApprovalMode = config.getApprovalMode();

    const availableModes = APPROVAL_MODES.map((mode) => ({
      id: mode as ApprovalModeValue,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    return {
      currentModeId: currentApprovalMode as ApprovalModeValue,
      availableModes,
    };
  }

  private buildConfigOptions(config: Config): SessionConfigOption[] {
    const currentApprovalMode = config.getApprovalMode();
    const allConfiguredModels = config.getAllConfiguredModels();
    const rawCurrentModelId = (config.getModel() || '').trim();
    const currentAuthType = config.getAuthType?.();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = activeRuntimeSnapshot
      ? formatAcpModelId(
          activeRuntimeSnapshot.id,
          activeRuntimeSnapshot.authType,
        )
      : this.formatCurrentModelId(rawCurrentModelId, currentAuthType);

    const modeOptions = APPROVAL_MODES.map((mode) => ({
      value: mode,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    const modeConfigOption: SessionConfigOption = {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: currentApprovalMode,
      options: modeOptions,
    };

    const modelOptions = allConfiguredModels.map((model) => {
      const effectiveModelId =
        model.isRuntimeModel && model.runtimeSnapshotId
          ? model.runtimeSnapshotId
          : model.id;
      return {
        value: formatAcpModelId(effectiveModelId, model.authType),
        name: model.label,
        description: model.description ?? '',
      };
    });

    const modelConfigOption: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: currentModelId,
      options: modelOptions,
    };

    return [modeConfigOption, modelConfigOption];
  }

  private formatCurrentModelId(
    baseModelId: string,
    authType?: AuthType,
  ): string {
    if (!baseModelId) return baseModelId;
    return authType ? formatAcpModelId(baseModelId, authType) : baseModelId;
  }
}
