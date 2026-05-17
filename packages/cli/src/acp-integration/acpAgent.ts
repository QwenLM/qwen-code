/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
  clearCachedCredentialFile,
  createDebugLogger,
  QwenOAuth2Event,
  qwenOAuth2Events,
  MCPServerConfig,
  SessionService,
  SESSION_TITLE_MAX_LENGTH,
  tokenLimit,
  getMCPDiscoveryState,
  getMCPServerStatus,
  MCPDiscoveryState,
  MCPServerStatus,
  type Config,
  type ConversationRecord,
  type DeviceAuthorizationData,
  SessionEndReason,
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
  AuthMethod,
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
import { buildAuthMethods } from './authMethods.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { Readable, Writable } from 'node:stream';
import type { LoadedSettings } from '../config/settings.js';
import { loadSettings, SettingScope } from '../config/settings.js';
import type { ApprovalModeValue } from './session/types.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import { loadCliConfig } from '../config/config.js';
import { Session, buildAvailableCommandsSnapshot } from './session/Session.js';
import {
  formatAcpModelId,
  parseAcpBaseModelId,
} from '../utils/acpModelUtils.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';
import { runExitCleanup } from '../utils/cleanup.js';
import {
  STATUS_SCHEMA_VERSION,
  SERVE_STATUS_EXT_METHODS,
  type ServeMcpBudgetMode,
  type ServeMcpBudgetStatusCell,
  type ServeMcpDiscoveryState,
  type ServeMcpServerRuntimeStatus,
  type ServeMcpTransport,
  type ServeSessionContextStatus,
  type ServeSessionSupportedCommandsStatus,
  type ServeStatus,
  type ServeStatusCell,
  type ServeWorkspaceMcpServerStatus,
  type ServeWorkspaceMcpStatus,
  type ServeWorkspaceProviderModel,
  type ServeWorkspaceProviderStatus,
  type ServeWorkspaceProvidersStatus,
  type ServeWorkspaceSkillStatus,
  type ServeWorkspaceSkillsStatus,
} from '../serve/status.js';

const debugLogger = createDebugLogger('ACP_AGENT');

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
) {
  // Initialize config to set up ACP bootstrap services (hooks, tools, MCP)
  // without creating a chat session. The real per-session Config will own
  // GeminiClient.initialize() and any SessionStart hook execution.
  await config.initialize({ skipGeminiInitialization: true });
  // ACP forwards session messages straight to the model; under progressive
  // MCP availability `initialize()` returns before MCP servers settle, so
  // we wait here to keep the first session's tool surface consistent with
  // the legacy synchronous behavior.
  await config.waitForMcpReady();
  // Surface MCP failures to stderr. ACP's stdout is the protocol channel
  // so info/log writes are already redirected to stderr below, but we
  // emit this BEFORE that redirection takes effect to keep the message
  // visible regardless of how the host process is wired.
  // Defensive against tests that pass a stubbed Config without
  // `getFailedMcpServerNames`.
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

class QwenAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private clientCapabilities: ClientCapabilities | undefined;

  getActiveSessions(): Session[] {
    return [...this.sessions.values()];
  }

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private argv: CliArgs,
    private connection: AgentSideConnection,
  ) {}

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
    await this.createAndStoreSession(config, sessionData?.conversation);

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

    await this.createAndStoreSession(config);

    const modesData = this.buildModesData(config);
    const availableModels = this.buildAvailableModels(config);
    const configOptions = this.buildConfigOptions(config);

    return {
      modes: modesData,
      models: availableModels,
      configOptions,
    };
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
    if (
      server &&
      typeof server === 'object' &&
      'type' in server &&
      (server as { type?: unknown }).type === 'sdk'
    ) {
      return 'sdk';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { httpUrl?: unknown }).httpUrl === 'string'
    ) {
      return 'http';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { url?: unknown }).url === 'string'
    ) {
      return 'sse';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { tcp?: unknown }).tcp === 'string'
    ) {
      return 'websocket';
    }
    if (
      server &&
      typeof server === 'object' &&
      typeof (server as { command?: unknown }).command === 'string'
    ) {
      return 'stdio';
    }
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

  private buildWorkspaceMcpStatus(config: Config): ServeWorkspaceMcpStatus {
    try {
      const workspaceCwd = this.workspaceCwd(config);
      const servers = config.getMcpServers() ?? {};

      // PR 14: pull live accounting + budget config from the child's
      // McpClientManager so the daemon's read-only route reflects the
      // single source of truth (not a daemon-side polled cache).
      // `getToolRegistry()` and `getMcpClientManager()` are best-effort
      // — older test stubs or partially-initialized configs may not
      // expose them; in that case we fall back to "no budget surface".
      let clientCount: number | undefined;
      let clientBudget: number | undefined;
      let budgetMode: ServeMcpBudgetMode | undefined;
      let refusedSet: ReadonlySet<string> = new Set<string>();
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
        debugLogger.debug(
          `getMcpClientAccounting failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        discoveryState: this.discoveryState(),
        servers: Object.entries(servers).map(([name, server]) => {
          const disabled = config.isMcpServerDisabled(name);
          const rawStatus = getMCPServerStatus(name);
          const refusedByBudget = refusedSet.has(name);
          // PR 14 fix (review #4247): config-disable takes precedence
          // over budget-refusal. `lastRefusedServerNames` is a
          // per-discovery-pass snapshot; if an operator runs
          // `/mcp disable <name>` against a server that was refused
          // last pass, the entry stays in the refused list until the
          // next discovery pass clears it (`McpClientManager.removeServer`
          // now drops the entry too — see sibling fix). Either way,
          // a `disabled` cell should NEVER show `budget_exhausted` —
          // the operator's deliberate disable wins.
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
          return out;
        }),
        ...(clientCount !== undefined ? { clientCount } : {}),
        ...(clientBudget !== undefined ? { clientBudget } : {}),
        ...(budgetMode !== undefined ? { budgetMode } : {}),
        ...(budgetMode !== undefined
          ? {
              budgets: this.buildBudgetCells(
                clientCount ?? 0,
                clientBudget,
                budgetMode,
                refusedSet.size,
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

  /**
   * Build the workspace-level budget status cells exposed on
   * `GET /workspace/mcp` (PR 14). One cell today (`scope: 'workspace'`);
   * Wave 5 PR 23 will add a `scope: 'pool'` cell alongside. Consumers
   * MUST tolerate additional entries with unrecognized scope values
   * (drop, don't fail).
   *
   * Cell `status` semantics:
   *   - `error`   — refusals happened this pass (only possible in enforce mode)
   *   - `warning` — live count crossed 75% of budget (warn or enforce mode)
   *   - `ok`      — under threshold (or `off` mode)
   */
  private buildBudgetCells(
    liveCount: number,
    budget: number | undefined,
    mode: ServeMcpBudgetMode,
    refusedCount: number,
  ): ServeMcpBudgetStatusCell[] {
    // PR 14 fix (review #4247): when no `--mcp-client-budget` is
    // configured the manager resolves to `mode: 'off'`. The protocol
    // docs and SDK type comments promise `budgets: []` for that case;
    // a synthetic `mcp_budget` cell carrying nothing actionable was
    // (a) protocol-noncompliant, (b) clutter — clients iterating
    // `budgets[]` to render rows would draw an "ok" budget row for
    // uncapped workspaces. Always return empty so the top-level
    // `budgetMode: 'off'` field is the sole signal that guardrails
    // are inactive.
    if (mode === 'off') return [];
    let status: ServeStatus = 'ok';
    let errorKind: string | undefined;
    let hint: string | undefined;
    if (refusedCount > 0) {
      status = 'error';
      errorKind = 'budget_exhausted';
      hint =
        'Raise --mcp-client-budget or remove servers from mcpServers config.';
    } else if (
      budget !== undefined &&
      budget > 0 &&
      liveCount >= 0.75 * budget
    ) {
      status = 'warning';
      hint = 'Live MCP clients are above 75% of the configured budget.';
    }
    const cell: ServeMcpBudgetStatusCell = {
      kind: 'mcp_budget',
      scope: 'workspace',
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

  private errorCell(kind: string, error: unknown): ServeStatusCell {
    return {
      kind,
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
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
          isCurrent,
          isRuntime: model.isRuntimeModel === true,
        };
        provider.models.push(providerModel);
        if (isCurrent) provider.current = true;
      }

      return {
        v: STATUS_SCHEMA_VERSION,
        workspaceCwd,
        initialized: true,
        ...(currentAuth || currentAcpModelId
          ? {
              current: {
                ...(currentAuth ? { authType: String(currentAuth) } : {}),
                ...(currentAcpModelId ? { modelId: currentAcpModelId } : {}),
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

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cwd = (params['cwd'] as string) || process.cwd();
    const SESSION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;

    switch (method) {
      case SERVE_STATUS_EXT_METHODS.workspaceMcp:
        return this.buildWorkspaceMcpStatus(this.config) as unknown as Record<
          string,
          unknown
        >;
      case SERVE_STATUS_EXT_METHODS.workspaceSkills:
        return (await this.buildWorkspaceSkillsStatus(
          this.config,
        )) as unknown as Record<string, unknown>;
      case SERVE_STATUS_EXT_METHODS.workspaceProviders:
        return this.buildWorkspaceProvidersStatus(
          this.config,
        ) as unknown as Record<string, unknown>;
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
      case 'rewindSession': {
        const sessionId = params['sessionId'] as string;
        const targetTurnIndex = params['targetTurnIndex'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (
          !Number.isInteger(targetTurnIndex) ||
          (targetTurnIndex as number) < 0
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing targetTurnIndex',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        const historyBeforeRewind = session.captureHistorySnapshot();
        return {
          success: true,
          historyBeforeRewind,
          ...session.rewindToTurn(targetTurnIndex as number),
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
    );
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
        { authMethods: this.pickAuthMethodsForAuthRequired() },
        'Use Qwen Code CLI to authenticate first.',
      );
    }

    try {
      await config.refreshAuth(selectedType, true);
    } catch (e) {
      debugLogger.error(`Authentication failed: ${e}`);
      throw RequestError.authRequired(
        {
          authMethods: this.pickAuthMethodsForAuthRequired(selectedType, e),
        },
        'Authentication failed: ' + (e as Error).message,
      );
    }
  }

  private pickAuthMethodsForAuthRequired(
    selectedType?: AuthType | string,
    error?: unknown,
  ): AuthMethod[] {
    const authMethods = buildAuthMethods();
    const errorMessage = this.extractErrorMessage(error);
    if (
      errorMessage?.includes('qwen-oauth') ||
      errorMessage?.includes('Qwen OAuth')
    ) {
      const qwenOAuthMethods = authMethods.filter(
        (m) => m.id === AuthType.QWEN_OAUTH,
      );
      return qwenOAuthMethods.length ? qwenOAuthMethods : authMethods;
    }

    if (selectedType) {
      const matched = authMethods.filter((m) => m.id === selectedType);
      return matched.length ? matched : authMethods;
    }

    return authMethods;
  }

  private extractErrorMessage(error?: unknown): string | undefined {
    if (error instanceof Error) return error.message;
    if (
      typeof error === 'object' &&
      error != null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return error.message;
    }
    if (typeof error === 'string') return error;
    return undefined;
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
