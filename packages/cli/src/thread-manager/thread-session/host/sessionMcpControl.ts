/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话内的 MCP 控制通道：认领 8 个 `mcp_*` subtype，返回 `McpControlResult`，由宿主
 * 编成帧——会话不写 wire 帧。
 *
 * `ok:false` 的 `error` 文案直接进回包帧，是 wire 契约，改动即破坏宿主侧解析。
 * 控制请求并发派发，`handle` 不得靠替换可变 sink 出结果，否则在途请求之间会串话。
 */
import {
  type Config,
  type OAuthToken,
  type McpOAuthBrowserOpenMeta,
  type McpOAuthBrowserOpenResult,
  type McpOAuthBrowserOpener,
  type MCPServerConfig,
  MCPServerStatus,
  MCPOAuthProvider,
  MCPOAuthTokenStorage,
  mcpServerRequiresOAuth,
  setMcpOAuthBrowserOpener,
  normalizeMcpServerConfigs,
  McpAuthorizationPreparationError,
  type McpAuthorizationPreparation,
} from '@qwen-code/core';

import { McpServerEnablementManager } from '../../../config/mcp/mcpServerEnablement.js';

// ---------------------------------------------------------------------------
// 进程级 OAuth opener 路由
// ---------------------------------------------------------------------------

/**
 * core 的 OAuth browser opener 是进程级单槽（install 覆盖、dispose 置 null）：
 * 多会话必须按会话隔离 install/dispose，否则会话之间互相顶掉。
 *
 * 这里用注册表 + 只装一次 + 空了才清；分发按注册顺序，不认领的模块抛错后问下一个。
 * 同名 server 并发发起 OAuth 时先注册者胜——meta 里没有会话归属。
 */
const oauthOpenerRegistrations = new Map<symbol, McpOAuthBrowserOpener>();

function registerOAuthOpener(opener: McpOAuthBrowserOpener): symbol {
  const key = Symbol('mcp-oauth-opener');
  oauthOpenerRegistrations.set(key, opener);
  if (oauthOpenerRegistrations.size === 1) {
    setMcpOAuthBrowserOpener(dispatchOAuthOpen);
  }
  return key;
}

function unregisterOAuthOpener(key: symbol | undefined): void {
  if (key === undefined) return;
  oauthOpenerRegistrations.delete(key);
  if (oauthOpenerRegistrations.size === 0) {
    setMcpOAuthBrowserOpener(null);
  }
}

async function dispatchOAuthOpen(
  authUrl: string,
  meta: McpOAuthBrowserOpenMeta,
): Promise<void | McpOAuthBrowserOpenResult> {
  let lastError: unknown;
  for (const opener of oauthOpenerRegistrations.values()) {
    try {
      return await opener(authUrl, meta);
    } catch (error) {
      lastError = error;
    }
  }
  // 没有任何会话认领这次 OAuth：把最后一次的拒绝原因抛回去，core 会 fallback 到
  // 默认浏览器启动器（opener 抛错即 fallback）。
  throw lastError instanceof Error
    ? lastError
    : new Error('no MCP OAuth flow is in progress');
}

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
 * 能力结果：handler 返回本结果，由调用方决定怎么编码回包。
 *
 * `ok:true` 无 `response` 即无 payload 的成功回包；`ok:false` 的 `error` 是 wire
 * 契约。`code` 可选，当前八个 handler 都不产生，带上时由调用方决定是否入帧。
 */
export type McpControlResult =
  | { ok: true; response?: Record<string, unknown> }
  | { ok: false; error: string; code?: string };

export interface McpControlModule {
  /** 注册 OAuth opener 并完成会话级初始化。 */
  install(): void;
  /** 认领该 subtype 吗？不认领回 undefined，调用方据此走自己的兜底。 */
  handle(
    subtype: string,
    request: Record<string, unknown>,
  ): Promise<McpControlResult | undefined>;
  /** 全部拆除；`install()` 没跑过也可安全调用。 */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMcpControlModule(
  deps: McpControlModuleDeps,
): McpControlModule {
  const { config, runLogger } = deps;

  // 每个 server 一条 pull-flow 状态，供宿主驱动的 `mcp_authenticate` +
  // `mcp_oauth_callback_url` 配对使用。OAuth opener 只认已有匹配 pull-flow 的尝试。
  interface PullFlowState {
    authUrlDeferred: Deferred<string>;
    openerResultDeferred: Deferred<McpOAuthBrowserOpenResult | void>;
    authenticatePromise: Promise<OAuthToken>;
  }
  const pullFlows = new Map<string, PullFlowState>();

  let oauthOpenerKey: symbol | undefined;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function install(): void {
    const mcpManager = config.getMcpClientManager?.() as
      | { setAuthPseudoToolsEnabled?: (enabled: boolean) => void }
      | undefined;
    mcpManager?.setAuthPseudoToolsEnabled?.(false);

    // SDK 驱动的 OAuth 严格由宿主发起：只有已等待该 server 的 pull-flow 才放行，
    // 否则抛错——这正是进程级路由判断「该问下一个会话」的信号。
    if (oauthOpenerKey === undefined) {
      oauthOpenerKey = registerOAuthOpener(async (authUrl, meta) => {
        const pull = meta.serverName
          ? pullFlows.get(meta.serverName)
          : undefined;
        if (pull) {
          pull.authUrlDeferred.resolve(authUrl);
          return pull.openerResultDeferred.promise;
        }
        throw new Error(
          `MCP OAuth required for "${meta.serverName ?? '<unknown>'}" but no host-driven flow is in progress. Call mcpAuthenticate() first.`,
        );
      });
    }
  }

  function dispose(): void {
    // 只注销自己那一份；全局槽在注册表空了之后才清，不误伤其他会话。
    unregisterOAuthOpener(oauthOpenerKey);
    oauthOpenerKey = undefined;
    // 中止在途 pull flow，避免其后台 authenticate() 越过会话结束泄漏。
    for (const [, pull] of pullFlows) {
      pull.openerResultDeferred.reject(new Error('Session ended'));
      pull.authUrlDeferred.reject(new Error('Session ended'));
    }
    pullFlows.clear();
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * `mcp_set_servers`：替换 CLI 的动态 MCP server 集合并重启全部连接，返回
   * `{added, removed, errors}` 供宿主展示差异。入站的 `scope` / `plugin` 元数据丢弃，
   * 由 setter 统一打 `scope: 'dynamic'`；磁盘配置的 server 不经过这条路径。
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

    // 只和动态集合做 diff：磁盘 / 插件 server 由另一条路径持有，报成增删会让
    // mcp_status → mcp_set_servers 往返误报。
    const previousNames = new Set(Object.keys(config.getDynamicMcpServers()));
    const nextServers: Record<string, MCPServerConfig> = {};
    const errors: Record<string, string> = {};

    for (const [name, rawCfg] of Object.entries(serversInput)) {
      if (!isNonNullObject(rawCfg)) {
        errors[name] = 'Config must be an object';
        continue;
      }
      // SDK 侧 server 由 initialize 注册、CLI 重启不了，静默丢弃，避免宿主整表
      // 回传时把自己的 SDK bridge 清掉。
      if (rawCfg['type'] === 'sdk') {
        continue;
      }
      // 接受宿主传入的任意进程传输配置：入站 `scope` / `plugin` 是缓存键与传输敏感
      // 元数据，丢弃；同名动态条目覆盖磁盘 client 是有意为之，由下游企业白名单治理。
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

  /** `mcp_reconnect`：重启单个 server。 */
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

  /** `mcp_toggle`：会话级禁用 / 恢复 server，不写持久配置。 */
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

  /** `mcp_status`：每个已配置 server 一条，含连接状态与已发现工具。 */
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
      const { toolOverrides: _toolOverrides, ...statusConfig } = serverCfg;
      const client = mcpManager.getClientByName(name);
      const rawStatus =
        client?.getStatus?.() ??
        ((serverCfg as { type?: string }).type === 'sdk' &&
        mcpManager.hasSdkClient?.(name)
          ? MCPServerStatus.CONNECTED
          : MCPServerStatus.DISCONNECTED);
      const status = getStructuredMcpStatus(name, rawStatus);
      const lastError = mcpManager.getLastError?.(name);
      const tools =
        registry?.getToolsByServer?.(name)?.map((t) => {
          const annotations = getToolStatusAnnotations(t);
          return {
            name: t.name,
            description: t.description,
            ...(annotations ? { annotations } : {}),
          };
        }) ?? [];

      servers.push({
        name,
        status,
        config: statusConfig,
        tools,
        ...(lastError ? { error: lastError } : {}),
      });
    }

    return { ok: true, response: { servers } };
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
      status !== 'disabled'
    ) {
      return 'needs-auth';
    }
    return status;
  }

  /**
   * `mcp_inject_token`：把宿主在带外拿到的 OAuth token 写进 CLI 的 token 存储，
   * 并重启 server 让新凭据在下次连接时生效。
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
      // 没有配置时，legacy key 可能在 server 被加回后隐藏这个 token。
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
      // 与交互式登录写同样的字段，后续刷新才有依据。
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
   * `mcp_authenticate`：宿主驱动的 OAuth 入口，尽早返回 `authUrl` 供宿主打开；流程
   * 保持 pending，直到浏览器命中本地回调 server 或宿主提交回调 URL。回包在 handler
   * 返回前决定，终态由 `mcp_oauth_callback_url` 作答，不会双回应。
   */
  async function handleMcpAuthenticate(
    request: Record<string, unknown>,
  ): Promise<McpControlResult> {
    const serverName = asStringProp(request, 'serverName');
    if (!serverName) {
      return { ok: false, error: '`serverName` is required' };
    }

    if (pullFlows.has(serverName)) {
      return {
        ok: false,
        error: `MCP OAuth flow already in progress for "${serverName}"`,
      };
    }

    const manager = config.getMcpClientManager?.();
    const servers = manager?.getMcpServers() ?? config.getMcpServers?.() ?? {};
    const serverCfg = servers[serverName];
    if (!serverCfg) {
      return { ok: false, error: `unknown MCP server "${serverName}"` };
    }

    if (manager) {
      let preparation: McpAuthorizationPreparation | undefined;
      try {
        preparation = await manager.prepareMcpAuthorization(serverName);
      } catch (error) {
        if (
          !(error instanceof McpAuthorizationPreparationError) ||
          error.kind !== 'unsupported'
        ) {
          return {
            ok: false,
            error:
              'MCP authorization could not be prepared. Retry authentication explicitly if the server is enabled.',
          };
        }
      }
      if (preparation && preparation.kind === 'connected') {
        return { ok: true, response: { requiresUserAction: false } };
      }
      if (preparation) {
        const action = preparation.action;
        const authorization = manager.authorizeMcpServer(serverName, {
          confirmOpenUrl: async () => 'accepted',
          // 用户代理交互全归宿主，CLI 只轮询。
          openUrl: async () => undefined,
        });
        // 后台授权只记日志、不写回包：本请求的成功回包在下面同步给出，最终状态由
        // 宿主轮询 mcp_status 观察。
        void authorization
          .then((outcome) => {
            runLogger.log(
              `[StructuredIO] MCP authorization for "${serverName}" finished (${outcome.state}${outcome.state === 'failed' ? `: ${outcome.failure.kind}` : ''})`,
              { sessionId: config.getSessionId?.() },
            );
          })
          .catch(() => {
            runLogger.warn(
              `[StructuredIO] MCP authorization for "${serverName}" failed:`,
              'Authorization failed.',
              { sessionId: config.getSessionId?.() },
            );
          });
        return {
          ok: true,
          response: {
            authUrl: action.url.href,
            requiresUserAction: true,
          },
        };
      }
    }

    const serverUrl = serverCfg.url ?? serverCfg.httpUrl;
    const baseOauthConfig = serverCfg.oauth ?? { enabled: true };
    const redirectUri = asStringProp(request, 'redirectUri');
    const oauthConfig = redirectUri
      ? { ...baseOauthConfig, redirectUri }
      : baseOauthConfig;

    const authUrlDeferred = createDeferred<string>();
    const openerResultDeferred =
      createDeferred<McpOAuthBrowserOpenResult | void>();

    const provider = new MCPOAuthProvider(
      MCPOAuthTokenStorage.forServer(serverName, serverCfg),
    );
    const authenticatePromise = provider
      .authenticate(serverName, oauthConfig, serverUrl, {
        // 宿主驱动用户代理步骤，跳过交互式同意提示：宿主 UI 本身就是同意信号。
        skipConsent: true,
      })
      .finally(() => {
        pullFlows.delete(serverName);
      });
    // 失败只通过 callback-url / clear-auth 的回包呈现，没有别处 await 这个 promise。
    authenticatePromise.catch(() => {});

    pullFlows.set(serverName, {
      authUrlDeferred,
      openerResultDeferred,
      authenticatePromise,
    });

    try {
      // 两个竞速结果：先拿到 authUrl → 需要用户代理步骤，保留 pull-flow 等
      // `mcp_oauth_callback_url` 完成；authenticate 先完成 → 静默成功，无需用户操作。
      const winner: { kind: 'url'; authUrl: string } | { kind: 'silent' } =
        await Promise.race([
          authUrlDeferred.promise.then((authUrl) => ({
            kind: 'url' as const,
            authUrl,
          })),
          authenticatePromise.then(() => ({ kind: 'silent' as const })),
        ]);

      if (winner.kind === 'silent') {
        return { ok: true, response: { requiresUserAction: false } };
      }
      return {
        ok: true,
        response: {
          authUrl: winner.authUrl,
          requiresUserAction: true,
        },
      };
    } catch (err) {
      pullFlows.delete(serverName);
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * `mcp_oauth_callback_url`：宿主提交 `mcp_authenticate` 流里粘贴回来的回调 URL，
   * 放行等待中的 authenticate()，由它换 token、保存并重连 server。
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

    const pull = pullFlows.get(serverName);
    if (!pull) {
      return {
        ok: false,
        error: `no OAuth flow in progress for "${serverName}"`,
      };
    }

    pull.openerResultDeferred.resolve({ callbackUrl });

    try {
      await pull.authenticatePromise;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // token 已存好；尽力重连，让 server 立刻用上新凭据。
    const mcpManager = config.getMcpClientManager?.();
    if (mcpManager?.getMcpServers()[serverName]) {
      try {
        await mcpManager.restartServer(serverName);
      } catch (err) {
        runLogger.warn(
          `[StructuredIO] Token saved for "${serverName}" but reconnect failed:`,
          err,
          { sessionId: config.getSessionId?.() },
        );
      }
    }

    return { ok: true };
  }

  /** `mcp_clear_auth`：删除已存的 OAuth 凭据并强制重连，对应宿主的「退出登录」。 */
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
        // server 已从会话移除，身份未知，按名字清掉其名下全部存储。
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
   * 会话入口：认领 8 个 `mcp_*` subtype，其余回 undefined 表示不认领。
   * 绝不临时替换可变 sink——控制请求并发派发，会在途请求之间串话。
   */
  async function handle(
    subtype: string,
    request: Record<string, unknown>,
  ): Promise<McpControlResult | undefined> {
    const result = await routeMcpControl(subtype, request);
    if (result !== undefined) {
      // 请求体与 token / callbackUrl 等字段刻意不打：只记 subtype 与结果，
      // error 文案本身是回包契约，不含凭据。
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
      case 'mcp_inject_token':
        return handleMcpInjectToken(request);
      case 'mcp_authenticate':
        return handleMcpAuthenticate(request);
      case 'mcp_oauth_callback_url':
        return handleMcpOAuthCallbackUrl(request);
      case 'mcp_clear_auth':
        return handleMcpClearAuth(request);
      default:
        return undefined;
    }
  }

  return { install, handle, dispose };
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

// ---------------------------------------------------------------------------
// Deferred — 最小可外部结算的 Promise 包装
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 吞掉未处理的 rejection：dispose 会 reject，而并非每个调用方都 await 它。
  promise.catch(() => {});
  return { promise, resolve, reject: reject as (error: Error) => void };
}
