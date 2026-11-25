/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedMcpRefreshTarget } from '@qwen-code/core';


/**
 * 会话链的 MCP 控制通道。
 *
 * 派生自 `packages/cli/src/structuredIOMcpControl.ts` 在本轮解耦期间的形态（八个
 * per-method handler 全部返回 `McpControlResult`、`handle()` 做派发），并**去掉了 worker
 * 专用的那一半**：`tryHandle()` 与它依赖的 `writeControlResponse` sink。会话链的回包一律
 * 走能力返回值，由宿主（`sdk/qoderSdkServer.ts`）编码成帧——会话绝不自己构造 wire 帧，所以
 * 那个 sink 在这里没有存在理由。
 *
 * **为什么是手工维护而不是生成器产出**：cli 那份已回退到本轮解耦之前的形态（只有
 * `tryHandle`），两边不再是「同一份源码 + 机械变换」的关系，生成器的字节相等前提不成立。
 * 守约方式换成两侧各自的测试：worker 侧 `structuredIOMcpControl.test.ts` 钉 `tryHandle`
 * 的帧形状，会话侧 `handlers/mcpHandlers` 的用例钉 `handle` 的返回值。
 *
 * ⚠️ 因此 **错误文案是两份必须手工同步的 wire 契约**（`ok:false` 的 `error` 字段直接进
 * 回包帧）。改任一侧的文案，另一侧必须跟着改。见
 * `docs/design/2026-09-20-thread-manager-decoupling.md` 的待决项。
 *
 * 控制请求是并发派发的（不再有队列串行化），所以 `handle` 绝不靠临时替换
 * writeControlResponse sink 来实现——可变 sink 会在两个在途请求之间串话。
 */
import { isDeepStrictEqual } from 'node:util';
import {
  type Config,
  type OAuthToken,
  type MCPServerConfig,
  MCPServerStatus,
  MCPOAuthTokenStorage,
  mcpServerRequiresOAuth,
  normalizeMcpServerConfigs,
  isMcpAppToolVisible,
  refreshActivePlugins,
} from '@qwen-code/core';

import { refreshMcpServersFromDisk } from '../../config/config.js';
import { McpServerEnablementManager } from '../../config/mcp/mcpServerEnablement.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpControlModuleDeps {
  config: Config;
  runLogger: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
}

/**
 * 能力结果：handler 不再自己写回包帧，而是返回本结果，由调用方决定怎么编码。
 *
 * - `ok: true` 且 `response` 缺省 = 旧的 `writeControlResponse(id, 'success')`
 *   （无 payload 的成功回包）；带 `response` = 旧的三参成功回包。
 * - `ok: false` 的 `error` 文案是 wire 契约，与旧错误回包逐字一致；`code` 可选——
 *   今天八个 handler 都不产生 code（旧错误帧只带 `{error}`），带上时由调用方决定
 *   是否入帧。
 */
export type McpControlResult =
  | { ok: true; response?: Record<string, unknown> }
  | { ok: false; error: string; code?: string };

export interface McpControlModule {
  /** 认领该 subtype 吗？不认领回 undefined，调用方据此走自己的兜底。 */
  handle(
    subtype: string,
    request: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpControlResult | undefined>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpControlModule(
  deps: McpControlModuleDeps,
): McpControlModule {
  const { config, runLogger } = deps;

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * `mcp_set_servers` — replace the cli's dynamic MCP server bucket and
   * restart all connections. Returns `{added, removed, errors}` so the host
   * can display diffs (as a result the caller encodes, not a frame written
   * here). CC-aligned: accepts any process-transport config and
   * internally stamps `scope: 'dynamic'`. Disk-backed servers are never
   * touched by this path — see docs/design/mcp-source-model.md.
   */
  async function handleMcpSetServers(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }

    const serversInput = request['servers'];
    if (!isNonNullObject(serversInput)) {
      return {
        ok: false,
        error: '`servers` must be an object keyed by server name',
      };
    }

    if (Object.keys(serversInput).some((name) => name.startsWith('enterprise_'))) {
      return { ok: false, error: 'The enterprise_ MCP namespace is reserved.' };
    }

    // Diff against the dynamic bucket only — disk/plugin servers are owned
    // by another path and must not be reported as added/removed here. This
    // also makes mcp_status → mcp_set_servers round-trips safe: disk
    // entries are not in the baseline so they can't be reported as missing.
    const previousNames = new Set(Object.keys(config.getDynamicMcpServers()));
    const nextServers: Record<string, MCPServerConfig> = {};
    const errors: Record<string, string> = {};

    for (const [name, rawCfg] of Object.entries(serversInput)) {
      if (!isNonNullObject(rawCfg)) {
        errors[name] = 'Config must be an object';
        continue;
      }
      // SDK-hosted servers are owned by the SDK process and registered via
      // the initialize handshake — they aren't restartable from the CLI
      // side and aren't valid in `mcp_set_servers`. Drop them quietly so
      // hosts that round-trip the full server list don't accidentally
      // wipe their SDK bridges.
      if (rawCfg['type'] === 'sdk') {
        continue;
      }
      // CC-aligned accept-and-stamp: accept any process-transport config
      // from the host; explicitly drop inbound `scope` / `plugin` metadata
      // (cache-key + transport sensitive); the setter forces
      // `scope: 'dynamic'`. Overlay semantics (same-name dynamic entry
      // shadows the disk runtime client) are intentional and governed by
      // enterprise allowlist downstream.
      const {
        plugin: _ignoredPlugin,
        scope: _ignoredScope,
        ...sanitized
      } = rawCfg;
      try {
        mcpManager.validateMcpServerConfig?.(
          sanitized as unknown as MCPServerConfig,
        );
      } catch (error) {
        errors[name] =
          error instanceof Error
            ? error.message
            : 'Invalid MCP server configuration';
        continue;
      }
      nextServers[name] = sanitized as unknown as MCPServerConfig;
    }

    config.setDynamicMcpServers(normalizeMcpServerConfigs(nextServers));

    try {
      await mcpManager.restart();
    } catch (err) {
      return {
        ok: false,
        error: `Failed to restart MCP servers: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const nextNames = new Set(Object.keys(nextServers));
    const added = [...nextNames].filter((n) => !previousNames.has(n));
    const removed = [...previousNames].filter((n) => !nextNames.has(n));

    // server 配置正文刻意不打：里面可能含 url 凭据与 headers，只记名单与计数。
    runLogger.log('[thread-session] mcp_set_servers applied', {
      sessionId: config.getSessionId?.(),
      added,
      removed,
      errorCount: Object.keys(errors).length,
    });

    return { ok: true, response: { added, removed, errors } };
  }

  /** `mcp_reconnect` — restart a single server. */
  async function handleMcpReconnect(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }

    const serverName = asStringProp(request, 'serverName');
    if (!serverName) {
      return { ok: false, error: '`serverName` is required' };
    }

    try {
      await mcpManager.restartServer(serverName);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * `mcp_toggle` — session-disable (or re-enable) a server without touching
   * persistent settings.
   */
  async function handleMcpToggle(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }

    const serverName = asStringProp(request, 'serverName');
    if (!serverName) {
      return { ok: false, error: '`serverName` is required' };
    }
    const enabled = request['enabled'];
    if (typeof enabled !== 'boolean') {
      return { ok: false, error: '`enabled` must be a boolean' };
    }

    const managed = config.getManagedMcpServer(serverName);
    if (managed) {
      if (!managed.userVisible)
        return { ok: false, error: 'MCP server is not available in this session' };
      try {
        if (enabled) await mcpManager.enableMcpServer(serverName);
        else await mcpManager.disableMcpServer(serverName);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const enablement = McpServerEnablementManager.getInstance();
    if (enabled) {
      enablement.clearSessionDisable(serverName);
    } else {
      enablement.disableForSession(serverName);
    }

    try {
      await mcpManager.restartServer(serverName);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * `mcp_status` — return one entry per configured MCP server with its
   * connection state and discovered tools.
   */
  async function handleMcpStatus(): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return { ok: true, response: { servers: [] } };
    }

    const registry = config.getToolRegistry();
    const servers: Array<Record<string, unknown>> = [];

    for (const [name, serverCfg] of Object.entries(
      mcpManager.getMcpServers(),
    )) {
      if (config.getManagedMcpServer(name)?.userVisible === false) continue;
      const { toolOverrides: _toolOverrides, ...statusConfig } = serverCfg;
      const enabled = mcpManager.isServerEnabled(name);
      const allowed = enabled && mcpManager.canUseMcpServer(name);
      const rawStatus = !enabled
        ? MCPServerStatus.DISABLED
        : !allowed
          ? mcpManager.getMcpServerDenyMessage(name)
            ? MCPServerStatus.BLOCKED
            : MCPServerStatus.DISCONNECTED
          : serverCfg.type === 'sdk' && mcpManager.hasSdkClient(name)
            ? MCPServerStatus.CONNECTED
            : mcpManager.getServerStatus(name);
      const status = getStructuredMcpStatus(name, rawStatus);
      const lastError = mcpManager.getLastError?.(name);
      const authState = mcpManager.getAuthorizationState?.(name);
      const authorization = mcpManager.getAuthorizationOutcome?.(name);
      // All discovered tools, not only the model-injected ones: the app needs
      // app-only tools and their _meta (ui.resourceUri, visibility).
      const discovered = (mcpManager.getAllDiscoveredMcpTools?.() ?? []).filter(
        (entry) => entry.serverName === name,
      );
      const tools =
        discovered.length > 0
          ? discovered.map((entry) => {
              const t = entry.tool;
              const annotations = getToolStatusAnnotations(t);
              const meta = (t as { _meta?: unknown })._meta;
              return {
                name: t.name,
                description: t.description,
                ...(annotations ? { annotations } : {}),
                ...(meta ? { _meta: meta } : {}),
              };
            })
          : (registry?.getToolsByServer?.(name)?.map((t) => {
              const annotations = getToolStatusAnnotations(t);
              const meta = (t as { _meta?: unknown })._meta;
              return {
                name: t.name,
                description: t.description,
                ...(annotations ? { annotations } : {}),
                ...(meta ? { _meta: meta } : {}),
              };
            }) ?? []);

      servers.push({
        name,
        status,
        config: statusConfig,
        tools: allowed ? tools : [],
        ...(lastError ? { error: lastError } : {}),
        ...(authState ? { authState } : {}),
        ...(authorization?.state === 'failed'
          ? {
              authFailure: {
                kind: authorization.failure.kind,
                message: authorization.failure.userMessage,
              },
            }
          : {}),
        ...(authorization && 'canRetryAuthorization' in authorization
          ? { canRetryAuthorization: authorization.canRetryAuthorization }
          : {}),
      });
    }

    return { ok: true, response: { servers } };
  }

  /** `mcp_get_server_info` — raw initialize result for one server. */
  async function handleMcpGetServerInfo(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) return { ok: false, error: '`serverName` is required' };
    return {
      ok: true,
      response: {
        serverName,
        info: mcpManager.getServerInfo(serverName) ?? null,
      },
    };
  }

  /** `mcp_get_server_tools` — full discovered tool definitions for one server. */
  async function handleMcpGetServerTools(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) return { ok: false, error: '`serverName` is required' };
    const result = mcpManager.getServerTools(serverName);
    if (!result) {
      return { ok: false, error: `Unknown MCP server "${serverName}"` };
    }
    return { ok: true, response: result as unknown as Record<string, unknown> };
  }

  /**
   * `mcp_cancel_authorization` — stops a host-brokered authorization or a
   * host-driven pull flow the session started.
   */
  async function handleMcpCancelAuthorization(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) return { ok: false, error: '`serverName` is required' };

    const mcpManager = config.getMcpClientManager?.();
    const cancelled = mcpManager?.cancelAuthorization?.(serverName) === true;
    const hostCancelled =
      mcpManager?.cancelHostAuthorization?.(serverName) === true;

    return {
      ok: true,
      response:
        cancelled || hostCancelled
          ? { cancelled: true }
          : { cancelled: false, reason: 'not_in_progress' },
    };
  }

  /**
   * `mcp_list_resources` — one page of a server's resource catalog. `cursor`
   * is optional and only continues a long catalog; callers that already know
   * the URI call `mcp_read_resource` directly.
   */
  async function handleMcpListResources(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) return { ok: false, error: '`serverName` is required' };
    const cursor = asStringProp(request, 'cursor') || undefined;
    try {
      const result = await mcpManager.listResources(serverName, cursor);
      return { ok: true, response: result as unknown as Record<string, unknown> };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * `mcp_read_resource` — the host's Apps surface reads a resource from the
   * same server instance the session used.
   */
  async function handleMcpReadResource(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) return { ok: false, error: '`serverName` is required' };
    const uri = asStringProp(request, 'uri');
    if (!uri) return { ok: false, error: '`uri` is required' };
    try {
      const result = signal
        ? await mcpManager.readResource(serverName, uri, { signal })
        : await mcpManager.readResource(serverName, uri);
      return { ok: true, response: result as unknown as Record<string, unknown> };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * `mcp_call_tool` — a tool call from the Apps surface, on the session's own
   * connection. Only tools declared visible to apps may be called this way.
   */
  async function handleMcpCallTool(
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) return { ok: false, error: '`serverName` is required' };
    const toolName = asStringProp(request, 'toolName');
    if (!toolName) return { ok: false, error: '`toolName` is required' };
    const entry = mcpManager
      .getAllDiscoveredMcpTools?.()
      .find(
        (candidate) =>
          candidate.serverName === serverName &&
          (candidate.toolName === toolName ||
            candidate.qualifiedName === toolName),
      );
    if (!entry) {
      return {
        ok: false,
        error: `Unknown tool "${toolName}" on server "${serverName}"`,
      };
    }
    if (!isMcpAppToolVisible(entry.tool, 'app')) {
      return {
        ok: false,
        error: `Tool "${toolName}" is not available to apps`,
      };
    }
    const args = isNonNullObject(request['arguments'])
      ? (request['arguments'] as Record<string, unknown>)
      : {};
    try {
      const params = {
        name: entry.toolName,
        arguments: args,
      };
      const result = signal
        ? await mcpManager.callTool(serverName, params, { signal })
        : await mcpManager.callTool(serverName, params);
      return { ok: true, response: result as unknown as Record<string, unknown> };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  function getToolStatusAnnotations(tool: {
    isReadOnly?: boolean;
    isDestructive?: () => boolean;
    isOpenWorld?: () => boolean;
    toolAnnotations?: Record<string, unknown>;
  }): Record<string, boolean> | undefined {
    const raw =
      tool.toolAnnotations && typeof tool.toolAnnotations === 'object'
        ? tool.toolAnnotations
        : undefined;
    const annotations: Record<string, boolean> = {};

    if (hasOwn(raw, 'readOnlyHint')) {
      annotations['readOnly'] = raw['readOnlyHint'] === true;
    } else if (tool.isReadOnly === true) {
      annotations['readOnly'] = true;
    }

    if (hasOwn(raw, 'destructiveHint')) {
      annotations['destructive'] = raw['destructiveHint'] === true;
    } else if (tool.isDestructive?.() === true) {
      annotations['destructive'] = true;
    }

    if (hasOwn(raw, 'openWorldHint')) {
      annotations['openWorld'] = raw['openWorldHint'] === true;
    } else if (tool.isOpenWorld?.() === true) {
      annotations['openWorld'] = true;
    }

    return Object.keys(annotations).length > 0 ? annotations : undefined;
  }

  function hasOwn(
    obj: Record<string, unknown> | undefined,
    key: string,
  ): obj is Record<string, unknown> {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function getStructuredMcpStatus(serverName: string, status: string): string {
    if (
      mcpServerRequiresOAuth.has(serverName) &&
      status !== MCPServerStatus.CONNECTED &&
      status !== MCPServerStatus.DISABLED &&
      status !== MCPServerStatus.BLOCKED
    ) {
      return 'needs-auth';
    }
    return status;
  }

  /**
   * `mcp_inject_token` — write an OAuth token the host obtained out-of-band
   * into the cli's token storage, then restart the server so the new
   * credential picks up on next connect.
   */
  async function handleMcpInjectToken(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const mcpManager = config.getMcpClientManager?.();
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) {
      return { ok: false, error: '`serverName` is required' };
    }
    const servers =
      mcpManager?.getMcpServers() ?? config.getMcpServers?.() ?? {};
    const serverConfig = servers[serverName];
    if (!serverConfig) {
      // Without config, the legacy key may hide this token once a server is added.
      return { ok: false, error: `unknown MCP server "${serverName}"` };
    }
    const rawToken = request['token'];
    if (!isNonNullObject(rawToken)) {
      return { ok: false, error: '`token` must be an object' };
    }
    const accessToken = asStringProp(rawToken, 'accessToken');
    if (!accessToken) {
      return { ok: false, error: '`token.accessToken` is required' };
    }

    const token: OAuthToken = {
      accessToken,
      tokenType: asStringProp(rawToken, 'tokenType') ?? 'Bearer',
      refreshToken: asStringProp(rawToken, 'refreshToken'),
      scope: asStringProp(rawToken, 'scope'),
      expiresAt: isNumberProp(rawToken, 'expiresAt'),
    };

    if (mcpManager) {
      try {
        const result = await mcpManager.storeAuthorizationToken(
          serverName,
          token,
          serverConfig,
        );
        if (result === 'host-owned') {
          return {
            ok: false,
            error:
              'MCP authorization for this server is owned by the host; token injection is not supported.',
          };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `Failed to save token: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
      // Save the same fields an interactive sign-in does, as far as the
      // server's config knows them, so a later refresh has what it needs.
      const storage = MCPOAuthTokenStorage.forServer(
        serverName,
        serverConfig,
      );
      const existing = await storage.getCredentials(serverName);
      await storage.saveToken(
        serverName,
        token,
        serverConfig.oauth?.clientId ?? existing?.clientId,
        serverConfig.oauth?.tokenUrl ?? existing?.tokenUrl,
        serverConfig.httpUrl ?? serverConfig.url,
        serverConfig.oauth?.resource ?? existing?.resource,
      );
    } catch (err) {
      return {
        ok: false,
        error: `Failed to save token: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return { ok: true };
  }

  /**
   * `mcp_authenticate` — host-driven entry point. The session manager owns
   * the pull flow and returns the URL to open, or completes silently.
   */
  async function handleMcpAuthenticate(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) {
      return { ok: false, error: '`serverName` is required' };
    }

    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: 'MCP client manager is not available in this session',
      };
    }
    try {
      const start = await mcpManager.authenticateWithHost(serverName, {
        redirectUri: asStringProp(request, 'redirectUri'),
      });
      return {
        ok: true,
        response: {
          ...(start.authUrl !== undefined ? { authUrl: start.authUrl } : {}),
          requiresUserAction: start.requiresUserAction,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * `mcp_oauth_callback_url` — host submits the pasted callback URL for a
   * flow previously started with `mcp_authenticate`.
   */
  async function handleMcpOAuthCallbackUrl(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const serverName = asStringProp(request, 'serverName');
    const callbackUrl = asStringProp(request, 'callbackUrl');
    if (!serverName || !callbackUrl) {
      return {
        ok: false,
        error: '`serverName` and `callbackUrl` are required',
      };
    }

    const mcpManager = config.getMcpClientManager?.();
    if (!mcpManager) {
      return {
        ok: false,
        error: `no OAuth flow in progress for "${serverName}"`,
      };
    }
    try {
      await mcpManager.submitHostAuthCallback(serverName, callbackUrl);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * `mcp_clear_auth` — delete stored OAuth credentials and force a
   * reconnect. Host equivalent of a "sign out" action.
   */
  async function handleMcpClearAuth(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) {
      return { ok: false, error: '`serverName` is required' };
    }

    const mcpManager = config.getMcpClientManager?.();
    const serverConfig =
      mcpManager?.getMcpServers()[serverName] ??
      config.getMcpServers?.()?.[serverName];
    if (mcpManager) {
      try {
        const result = await mcpManager.clearAuthorization(
          serverName,
          serverConfig,
        );
        if (result === 'host-owned') {
          return {
            ok: false,
            error:
              'MCP authorization for this server is owned by the host; local OAuth credentials cannot be cleared.',
          };
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `Failed to delete credentials: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
      if (serverConfig) {
        await MCPOAuthTokenStorage.forServer(
          serverName,
          serverConfig,
        ).deleteCredentials(serverName);
      } else {
        // Already removed from the session: its identity is unknown, so
        // everything stored under the name goes.
        await MCPOAuthTokenStorage.deleteCredentialsByServerName(serverName);
      }
    } catch (err) {
      return {
        ok: false,
        error: `Failed to delete credentials: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return { ok: true };
  }

  /**
   * 进程内 thread 会话路径的入口：认领 8 个 `mcp_*` subtype，返回 handler 的结果；
   * 其它 subtype 回 undefined 表示不认领。绝不临时替换 writeControlResponse sink——
   * 控制请求是并发派发的，可变 sink 会在两个在途请求之间串话（见文件头注）。
   */
  function handleMcpReload(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    return reloadSessionMcpServers(config, {
      plugins: request['plugins'] === true,
      serverNames: asStringArray(request['serverNames']),
    });
  }

  async function handle(
    subtype: string,
    request: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpControlResult | undefined> {
    const result = await routeMcpControl(subtype, request, options);
    if (result !== undefined) {
      // 请求体与 token / callbackUrl 等字段刻意不打：只记 subtype 与结果，
      // error 文案本身就是回包的 wire 契约，不含凭据。
      runLogger.log('[thread-session] mcp control request handled', {
        sessionId: config.getSessionId?.(),
        subtype,
        ok: result.ok,
        ...(result.ok ? {} : { error: result.error }),
      });
    }
    return result;
  }

  async function routeMcpControl(
    subtype: string,
    request: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<McpControlResult | undefined> {
    switch (subtype) {
      case 'mcp_set_servers':
        return handleMcpSetServers(request);
      case 'mcp_reconnect':
        return handleMcpReconnect(request);
      case 'mcp_toggle':
        return handleMcpToggle(request);
      case 'mcp_status':
        return handleMcpStatus();
      case 'mcp_get_server_info':
        return handleMcpGetServerInfo(request);
      case 'mcp_get_server_tools':
        return handleMcpGetServerTools(request);
      case 'mcp_cancel_authorization':
        return handleMcpCancelAuthorization(request);
      case 'mcp_list_resources':
        return handleMcpListResources(request);
      case 'mcp_read_resource':
        return handleMcpReadResource(request, options?.signal);
      case 'mcp_call_tool':
        return handleMcpCallTool(request, options?.signal);
      case 'mcp_inject_token':
        return handleMcpInjectToken(request);
      case 'mcp_authenticate':
        return handleMcpAuthenticate(request);
      case 'mcp_oauth_callback_url':
        return handleMcpOAuthCallbackUrl(request);
      case 'mcp_clear_auth':
        return handleMcpClearAuth(request);
      case 'mcp_reload':
        return handleMcpReload(request);
      default:
        return undefined;
    }
  }

  return { handle };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonNullObject(val: unknown): val is Record<string, unknown> {
  return (
    val !== null && val !== undefined && Object.getPrototypeOf(val) !== null
  );
}

function isNumberProp(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const val = obj[key];
  return typeof val === 'number' ? val : undefined;
}

function asStringProp(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

function asStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  const names = val.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return names.length > 0 ? names : undefined;
}

/**
 * `mcp_reload` — re-read a session's MCP sources from disk (user and project
 * settings, `.mcp.json`) and register only what changed: added servers connect,
 * removed ones are released, unchanged ones keep their pooled connection.
 * `plugins: true` also reloads the session's plugins so plugin-declared servers
 * follow. Unlike `/mcp reload`, nothing unchanged is reconnected. Project
 * servers never approved are reported as `pending`.
 *
 * Needs only the session's Config, so it works before the session's control
 * module exists (that is installed with the query runner, on the first turn).
 */
export async function reloadSessionMcpServers(
  config: Config,
  options: {
    readonly plugins?: boolean;
    /** Re-evaluate only these servers; every other server is left untouched. */
    readonly serverNames?: readonly string[];
  } = {},
  enterprise?: { targets?: readonly ManagedMcpRefreshTarget[]; assertCurrent: () => void },
): Promise<McpControlResult> {
  const mcpManager = config.getMcpClientManager?.();
  if (!mcpManager) {
    return {
      ok: false,
      error: 'MCP client manager is not available in this session',
    };
  }
  let before: Record<string, MCPServerConfig> = {};
  let nameTargets: Set<string> | undefined;
  let pending: string[] = [];
  try {
    const names = await config.reloadManagedMcpServers({
      serverNames: options.serverNames,
      ...(enterprise ? { managedTargets: enterprise.targets, assertCurrent: enterprise.assertCurrent } : {}),
      beforeReload: async () => {
        before = config.getMcpServers() ?? {};
        if (!enterprise && options.serverNames?.length) {
          const unknown = options.serverNames.find((name) => !(name in before));
          if (unknown) throw new Error(`Unknown MCP server "${unknown}"`);
        }
        pending = Object.keys(refreshMcpServersFromDisk(config, config.getSessionArtifactProjectRoot()).pending);
        if (options.plugins === true) {
          await refreshActivePlugins({ config, reason: 'reload-command', emitToFeed: false });
        }
      },
    });
    if (names?.length === 0) return { ok: true, response: { skipped: 'not_applicable' } };
    nameTargets = names ? new Set(names) : undefined;
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reload MCP servers: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    ok: true,
    response: {
      ...filterServerDiff(
        diffServerConfigs(before, config.getMcpServers() ?? {}),
        nameTargets,
      ),
      pending:
        nameTargets === undefined
          ? pending
          : pending.filter((name) => nameTargets.has(name)),
    },
  };
}

function filterServerDiff(
  diff: { added: string[]; removed: string[]; changed: string[] },
  targets: Set<string> | undefined,
): { added: string[]; removed: string[]; changed: string[] } {
  if (targets === undefined) return diff;
  const keep = (name: string) => targets.has(name);
  return {
    added: diff.added.filter(keep),
    removed: diff.removed.filter(keep),
    changed: diff.changed.filter(keep),
  };
}

/** Names added, removed or changed between two server maps (`scope` ignored). */
function diffServerConfigs(
  before: Record<string, MCPServerConfig>,
  after: Record<string, MCPServerConfig>,
): { added: string[]; removed: string[]; changed: string[] } {
  const strip = ({ scope: _scope, ...rest }: MCPServerConfig) => rest;
  return {
    added: Object.keys(after).filter((name) => !(name in before)),
    removed: Object.keys(before).filter((name) => !(name in after)),
    changed: Object.keys(after).filter(
      (name) =>
        name in before &&
        !isDeepStrictEqual(strip(before[name]), strip(after[name])),
    ),
  };
}
