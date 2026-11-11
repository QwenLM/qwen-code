/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Session-agnostic MCP connection.
//
// One McpClient owns exactly one transport connection to one MCP server and is
// safe to share across sessions in a process: it holds no session id, no
// elicitation bridge, and writes to no registry. It connects, discovers and
// caches tools/prompts/resources, invokes them, refreshes on `list_changed`, and
// reports every change outward through a single listener. Deciding which tools a
// session may see, gating servers, writing registries, and elicitation are the
// SessionMcpManager's job — this class is only the connection and its catalog.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type GetPromptResult,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';

import type { MCPServerConfig } from '../mcpServerConfig.js';
import { runLogger } from '../../utils/runLogger.js';
import { getMcpErrorMessage } from '../errors.js';
import {
  isAuthenticationError,
  UnauthorizedError,
} from '../../utils/errors.js';


import { McpAuthorizationRequiredError } from '../authorization.js';
import type { McpConnector } from '../connector/types.js';
import { connectToMcpServer } from '../connector/connectMcpServer.js';
import type { McpServerKey } from '../server-key.js';
import {
  discoverTools,
  type DiscoveredMCPTool,
  type McpToolCaller,
} from '../tools/mcp-tool.js';
import {
  discoverPrompts,
  invokeMcpPrompt,
  type DiscoveredMCPPrompt,
} from '../tools/mcp-prompt.js';
import { discoverResources } from '../tools/mcp-resource.js';
import type { McpClientContext } from '../mcpClientContext.js';
import type { McpElicitationHandler } from '../elicitation.js';
import { mcpServerRequiresOAuth } from '../oauthState.js';
import { resolveMcpRequestTimeoutMs } from '../tools/mcp-timeouts.js';
import type {
  McpClientCallMetadataProvider,
  McpClientConnectRequest,
  McpClientEvent,
  McpClientInit,
  McpClientListener,
} from './types.js';

/**
 * Enum representing the connection status of an MCP server.
 */
export enum MCPServerStatus {
  /** Server is disconnected or experiencing errors */
  DISCONNECTED = 'disconnected',
  /** Server is actively disconnecting */
  DISCONNECTING = 'disconnecting',
  /** Server is in the process of connecting */
  CONNECTING = 'connecting',
  /** Server is connected and ready to use */
  CONNECTED = 'connected',
  /** Server needs authorization before it can connect; parked, not failed. */
  AUTH_REQUIRED = 'auth_required',
  /** Server is blocked by the settings allow/exclude lists. */
  BLOCKED = 'blocked',
  /** Server is disabled by settings or session enablement. */
  DISABLED = 'disabled',
}

export type McpTransportTelemetryType =
  | 'sse'
  | 'streamable_http'
  | 'websocket'
  | 'stdio'
  | 'unknown';

export function inferMcpTransportTelemetryType(
  config: MCPServerConfig,
): McpTransportTelemetryType {
  const type =
    config.type ??
    (config.httpUrl
      ? 'http'
      : config.command
        ? 'stdio'
        : config.url
          ? 'http'
          : 'unknown');

  switch (type) {
    case 'sse':
      return 'sse';
    case 'ws':
      return 'websocket';
    case 'stdio':
      return 'stdio';
    case 'http':
      return 'streamable_http';
    default:
      return 'unknown';
  }
}

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

type CallToolParams = {
  name: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

function catalogDelta(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  return {
    added: next.filter((name) => !previousSet.has(name)),
    removed: previous.filter((name) => !nextSet.has(name)),
  };
}

function formatNames(names: readonly string[], limit = 10): string {
  if (names.length === 0) return '';
  const visible = names.slice(0, limit).join(',');
  return names.length > limit ? `${visible},…(+${names.length - limit})` : visible;
}

/**
 * Whether a connection failure is really "needs authorization". These park the
 * server in AUTH_REQUIRED instead of failing it, so the pool can reconnect once
 * the user completes the auth flow.
 */
function isAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    error instanceof McpAuthorizationRequiredError ||
    isAuthenticationError(error)
  );
}

export class McpClient implements McpToolCaller {
  private readonly serverKey: McpServerKey;
  private readonly serverName: string;
  private readonly serverConfig: MCPServerConfig;
  private readonly clientVersion: string;
  private readonly debugMode: boolean;
  private readonly hostContext: McpClientContext;
  private readonly listener: McpClientListener;
  private callMetadataProvider: McpClientCallMetadataProvider | undefined;
  private readonly elicitationHandler: McpElicitationHandler | undefined;

  private client: Client | undefined;
  private status: MCPServerStatus = MCPServerStatus.DISCONNECTED;
  private statusChangedAt = Date.now();
  private intentionalDisconnect = false;
  private connectAbortController: AbortController | undefined;
  /** Shared by every caller while one handshake is in flight. */
  private connectPromise: Promise<void> | undefined;
  /** Remembered so a dropped network connection can be re-established lazily. */
  private connector: McpConnector | undefined;
  private reconnectPromise: Promise<void> | undefined;
  /** Set when the connection parked for host-brokered authorization. */
  private authorizationError: McpAuthorizationRequiredError | undefined;
  /** The error from the most recent failed connect, for diagnostics/UI. */
  private lastConnectError: unknown;

  private tools: DiscoveredMCPTool[] = [];
  private promptList: DiscoveredMCPPrompt[] = [];
  private readonly promptDetails = new Map<string, GetPromptResult>();
  private resourceList: Resource[] = [];
  private readonly resourceDetails = new Map<string, ReadResourceResult>();

  private refreshingTools = false;
  private pendingToolRefresh = false;
  private refreshingPrompts = false;
  private pendingPromptRefresh = false;
  private refreshingResources = false;
  private pendingResourceRefresh = false;

  constructor(init: McpClientInit) {
    this.serverKey = init.serverKey;
    this.serverName = init.serverName;
    this.serverConfig = init.serverConfig;
    this.clientVersion = init.clientVersion;
    this.debugMode = init.debugMode;
    this.hostContext = init.hostContext;
    this.listener = init.listener;
    this.callMetadataProvider = init.callMetadataProvider;
    this.elicitationHandler = init.elicitationHandler;
    runLogger.log(
      `[mcp-client] created server=${this.serverName} source=${this.serverKey.source} transport=${inferMcpTransportTelemetryType(this.serverConfig)}`,
    );
  }

  // ── identity / status accessors ──────────────────────────────────────────

  getServerKey(): McpServerKey {
    return this.serverKey;
  }

  getServerName(): string {
    return this.serverName;
  }

  getServerConfig(): MCPServerConfig {
    return this.serverConfig;
  }

  getStatus(): MCPServerStatus {
    return this.status;
  }

  isConnected(): boolean {
    return this.status === MCPServerStatus.CONNECTED && this.client !== undefined;
  }

  getInstructions(): string | undefined {
    return this.client?.getInstructions();
  }

  /** The authorization error that parked this connection, if any. */
  getAuthorizationRequiredError():
    | McpAuthorizationRequiredError
    | undefined {
    return this.authorizationError;
  }

  /** The error from the most recent failed connect, for diagnostics/UI. */
  getLastConnectError(): unknown {
    return this.lastConnectError;
  }

  getDiscoveredTools(): readonly DiscoveredMCPTool[] {
    return this.tools;
  }

  getDiscoveredPrompts(): readonly DiscoveredMCPPrompt[] {
    return this.promptList;
  }

  getDiscoveredResources(): readonly Resource[] {
    return this.resourceList;
  }

  supportsExtension(extensionId: string): boolean {
    const extensions = this.client?.getServerCapabilities()?.extensions as
      | Record<string, unknown>
      | undefined;
    return extensions
      ? Object.prototype.hasOwnProperty.call(extensions, extensionId)
      : false;
  }

  setCallMetadataProvider(
    provider: McpClientCallMetadataProvider | undefined,
  ): void {
    this.callMetadataProvider = provider;
  }

  // ── connection lifecycle ─────────────────────────────────────────────────

  /**
   * Establishes the connection through the supplied connector. The connector is
   * resolved by the owner (which knows the transport-type → connector map); this
   * class only drives one server's connection.
   *
   * Concurrent callers share one in-flight attempt: sessions pool the same
   * client, so a second session registering the same server must await the
   * connection rather than start a competing handshake.
   */
  async connect(
    connector: McpConnector,
    request: McpClientConnectRequest = {},
  ): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.status !== MCPServerStatus.DISCONNECTED) {
      throw new Error(
        `Can only connect when the client is disconnected, current state is ${this.status}`,
      );
    }
    const attempt = this.connectInternal(connector, request);
    this.connectPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.connectPromise === attempt) this.connectPromise = undefined;
    }
  }

  private async connectInternal(
    connector: McpConnector,
    request: McpClientConnectRequest,
  ): Promise<void> {
    const startedAt = Date.now();
    const transport = inferMcpTransportTelemetryType(this.serverConfig);
    this.intentionalDisconnect = false;
    this.connector = connector;
    this.setStatus(MCPServerStatus.CONNECTING);
    this.connectAbortController = new AbortController();
    runLogger.log(
      `[mcp-client] connect started server=${this.serverName} transport=${transport} allowAuthentication=${request.allowAuthentication !== false}`,
    );

    try {
      const client = await connectToMcpServer({
        clientVersion: this.clientVersion,
        serverName: this.serverName,
        serverConfig: this.serverConfig,
        debugMode: this.debugMode,
        cliConfig: this.hostContext,
        connector,
        timeoutMs: resolveMcpRequestTimeoutMs(),
        signal: request.signal ?? this.connectAbortController.signal,
        allowAuthentication: request.allowAuthentication,
        elicitationHandler: this.elicitationHandler,
      });
      this.client = client;
      this.authorizationError = undefined;
      this.lastConnectError = undefined;
      this.wrapClientLifetimeHandlers(client);
      this.registerNotificationHandlers(client);
      this.setStatus(MCPServerStatus.CONNECTED);
      runLogger.log(
        `[mcp-client] connect completed server=${this.serverName} transport=${transport} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error) {
      const failed = this.client;
      this.client = undefined;
      this.lastConnectError = error;
      if (failed) {
        await failed.close().catch(() => {});
      }
      if (
        isAuthRequiredError(error) ||
        mcpServerRequiresOAuth.has(this.serverName)
      ) {
        if (error instanceof McpAuthorizationRequiredError) {
          this.authorizationError = error;
        }
        // Park rather than fail: a 401 that still cannot complete OAuth (or an
        // auth attempt that failed later) must keep the server in AUTH_REQUIRED
        // so the session can mint the authenticate pseudo-tool.
        this.setStatus(MCPServerStatus.AUTH_REQUIRED, 'auth_required');
        runLogger.log(
          `[mcp-client] connect parked server=${this.serverName} transport=${transport} reason=auth_required durationMs=${Date.now() - startedAt}`,
        );
        return;
      }
      this.setStatus(MCPServerStatus.DISCONNECTED, 'connect_failed');
      runLogger.log(
        `[mcp-client] connect failed server=${this.serverName} transport=${transport} durationMs=${Date.now() - startedAt}`,
      );
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const startedAt = Date.now();
    const previousStatus = this.status;
    this.intentionalDisconnect = true;
    this.connectAbortController?.abort();
    const client = this.client;
    this.client = undefined;
    runLogger.log(
      `[mcp-client] disconnect started server=${this.serverName} status=${previousStatus}`,
    );
    if (
      this.status === MCPServerStatus.CONNECTED ||
      this.status === MCPServerStatus.CONNECTING
    ) {
      this.setStatus(MCPServerStatus.DISCONNECTING, 'user_disabled');
    }
    if (client) {
      try {
        await client.close();
      } catch (error) {
        runLogger.debug(
          `[mcp-client] close failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
        );
      }
    }
    this.setStatus(MCPServerStatus.DISCONNECTED, 'user_disabled');
    runLogger.log(
      `[mcp-client] disconnect completed server=${this.serverName} durationMs=${Date.now() - startedAt}`,
    );
  }

  /**
   * Drops a live connection without marking it intentionally disconnected, so
   * the owner may reconnect it later. Used when a delivery on the connection
   * failed and the socket can no longer be trusted.
   */
  abortConnection(reason: string): void {
    if (this.status !== MCPServerStatus.CONNECTED) return;
    runLogger.log(
      `[mcp-client] abort connection server=${this.serverName} reason=${reason}`,
    );
    const client = this.client;
    this.client = undefined;
    this.setStatus(MCPServerStatus.DISCONNECTED, reason);
    void client?.close().catch(() => {});
  }

  /**
   * Lazily re-establishes a dropped network connection (e.g. before a deferred
   * lazy tool call) and refreshes the catalog. A stdio connection is not lazily
   * recoverable — a spawned process that died stays dead until an explicit
   * restart — and an AUTH_REQUIRED server stays parked until authorized.
   */
  async ensureConnected(): Promise<void> {
    if (this.status === MCPServerStatus.CONNECTED && this.client) return;
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this.intentionalDisconnect) {
      throw new Error(`MCP server '${this.serverName}' was disconnected`);
    }
    const network = !!(
      this.serverConfig.url ||
      this.serverConfig.httpUrl ||
      this.serverConfig.type === 'http' ||
      this.serverConfig.type === 'sse' ||
      this.serverConfig.type === 'ws'
    );
    if (
      this.status !== MCPServerStatus.DISCONNECTED ||
      !this.connector ||
      !network
    ) {
      throw new Error(`MCP server '${this.serverName}' is not connected`);
    }
    const startedAt = Date.now();
    runLogger.log(
      `[mcp-client] lazy reconnect started server=${this.serverName} transport=${inferMcpTransportTelemetryType(this.serverConfig)}`,
    );
    const reconnect = this.connect(this.connector).then(async () => {
      if (this.isConnected()) await this.discover();
    });
    this.reconnectPromise = reconnect;
    try {
      await reconnect;
      runLogger.log(
        `[mcp-client] lazy reconnect completed server=${this.serverName} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error) {
      runLogger.log(
        `[mcp-client] lazy reconnect failed server=${this.serverName} durationMs=${Date.now() - startedAt}`,
      );
      throw error;
    } finally {
      if (this.reconnectPromise === reconnect) {
        this.reconnectPromise = undefined;
      }
    }
  }

  /**
   * Sends a protocol notification on the live connection. The SDK notification
   * API takes no AbortSignal, so a timeout drops the connection rather than
   * leaving the caller wedged. The error is surfaced verbatim; callers that push
   * credentials are responsible for sanitizing before propagating.
   */
  async sendNotification(method: string, params: unknown): Promise<void> {
    const client = this.client;
    if (!client || this.status !== MCPServerStatus.CONNECTED) {
      throw new Error(
        `Cannot send '${method}' to '${this.serverName}': not connected`,
      );
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.notification({
          method,
          params,
        } as Parameters<Client['notification']>[0]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`notification '${method}' timed out`)),
            resolveMcpRequestTimeoutMs(),
          );
        }),
      ]);
    } catch (error) {
      this.abortConnection(`notification '${method}' failed`);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ── discovery + cache ────────────────────────────────────────────────────

  /** Discovers and caches all three catalogs, then announces each. */
  async discover(request: { signal?: AbortSignal } = {}): Promise<void> {
    await this.listPrompts(request);
    await this.discoverTools(request);
    await this.listResources(request);
  }

  async discoverTools(
    request: { signal?: AbortSignal } = {},
  ): Promise<readonly DiscoveredMCPTool[]> {
    this.assertConnected();
    const startedAt = Date.now();
    const tools = await discoverTools(
      this.serverName,
      this.serverConfig,
      this.client!,
      this,
      this.hostContext,
      {
        signal: request.signal ?? this.connectAbortController?.signal,
        progressReporter: this.connector?.progressReporter,
      },
    );
    this.tools = tools;
    runLogger.log(
      `[mcp-client] tools listed server=${this.serverName} count=${tools.length} durationMs=${Date.now() - startedAt}`,
    );
    return tools;
  }

  async listPrompts(
    request: { signal?: AbortSignal } = {},
  ): Promise<readonly DiscoveredMCPPrompt[]> {
    this.assertConnected();
    const startedAt = Date.now();
    const prompts = await discoverPrompts(
      this.serverName,
      this.client!,
      this.hostContext,
      { signal: request.signal ?? this.connectAbortController?.signal },
    );
    this.promptList = prompts;
    this.promptDetails.clear();
    runLogger.log(
      `[mcp-client] prompts listed server=${this.serverName} count=${prompts.length} durationMs=${Date.now() - startedAt}`,
    );
    return prompts;
  }

  async listResources(
    request: { signal?: AbortSignal } = {},
  ): Promise<readonly Resource[]> {
    this.assertConnected();
    const startedAt = Date.now();
    const resources = await discoverResources(
      this.serverName,
      this.client!,
      this.hostContext,
      { signal: request.signal ?? this.connectAbortController?.signal },
    );
    this.resourceList = resources;
    this.resourceDetails.clear();
    runLogger.log(
      `[mcp-client] resources listed server=${this.serverName} count=${resources.length} durationMs=${Date.now() - startedAt}`,
    );
    return resources;
  }

  // ── invocation ───────────────────────────────────────────────────────────

  /**
   * Tool-call entry point and the {@link McpToolCaller} the discovered tools
   * call back through. Merges any contributed `_meta` (contributed keys win, so
   * a tool argument cannot spoof the provider's namespace).
   */
  async callMcpTool(
    params: CallToolParams,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<CallToolResult> {
    const client = this.client;
    if (!client || this.status !== MCPServerStatus.CONNECTED) {
      throw new Error(`MCP server '${this.serverName}' is not connected`);
    }
    const startedAt = Date.now();
    runLogger.log(
      `[mcp-client] tool call started server=${this.serverName} tool=${params.name}`,
    );
    try {
      const contributed = this.callMetadataProvider
        ? await this.callMetadataProvider(this)
        : undefined;
      const effectiveParams = this.applyCallMetadata(params, contributed);
      const result = await client.callTool(effectiveParams, undefined, options);
      runLogger.log(
        `[mcp-client] tool call completed server=${this.serverName} tool=${params.name} isError=${result.isError === true} durationMs=${Date.now() - startedAt}`,
      );
      return result;
    } catch (error) {
      runLogger.log(
        `[mcp-client] tool call failed server=${this.serverName} tool=${params.name} durationMs=${Date.now() - startedAt}`,
      );
      throw error;
    }
  }

  async getPrompt(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<GetPromptResult> {
    this.assertConnected();
    const cacheKey = JSON.stringify([name, args]);
    const cached = this.promptDetails.get(cacheKey);
    if (cached) {
      runLogger.log(
        `[mcp-client] prompt served from cache server=${this.serverName} prompt=${name}`,
      );
      return cached;
    }
    const result = await invokeMcpPrompt(
      this.serverName,
      this.client!,
      name,
      args,
      this.hostContext,
    );
    this.promptDetails.set(cacheKey, result);
    return result;
  }

  async getResource(
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    this.assertConnected();
    const startedAt = Date.now();
    const cached = this.resourceDetails.get(uri);
    if (cached) {
      runLogger.log(
        `[mcp-client] resource served from cache server=${this.serverName} uri=${uri}`,
      );
      return cached;
    }
    try {
      const result = await this.client!.request(
        { method: 'resources/read', params: { uri } },
        ReadResourceResultSchema,
        { timeout: resolveMcpRequestTimeoutMs(), ...options },
      );
      this.resourceDetails.set(uri, result);
      runLogger.log(
        `[mcp-client] resource read server=${this.serverName} uri=${uri} durationMs=${Date.now() - startedAt}`,
      );
      return result;
    } catch (error) {
      runLogger.log(
        `[mcp-client] resource read failed server=${this.serverName} uri=${uri} durationMs=${Date.now() - startedAt}`,
      );
      throw error;
    }
  }

  /** Alias for {@link getResource} — the session-facing read verb. */
  async readResource(
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    return this.getResource(uri, options);
  }

  // ── internals ────────────────────────────────────────────────────────────

  private applyCallMetadata(
    params: CallToolParams,
    contributed: Record<string, unknown> | undefined,
  ): CallToolParams {
    if (!contributed || Object.keys(contributed).length === 0) return params;
    return { ...params, _meta: { ...params._meta, ...contributed } };
  }

  private assertConnected(): void {
    if (this.status !== MCPServerStatus.CONNECTED || !this.client) {
      throw new Error(`MCP server '${this.serverName}' is not connected`);
    }
  }

  private wrapClientLifetimeHandlers(client: Client): void {
    const previousClose = client.onclose;
    client.onclose = () => {
      previousClose?.();
      if (
        !this.intentionalDisconnect &&
        (this.status === MCPServerStatus.CONNECTED ||
          this.status === MCPServerStatus.CONNECTING)
      ) {
        this.client = undefined;
        this.setStatus(MCPServerStatus.DISCONNECTED, 'network');
      }
    };
    const previousError = client.onerror;
    client.onerror = (error: Error) => {
      previousError?.(error);
      runLogger.debug(
        `[mcp-client] transport error on '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    };
  }

  private registerNotificationHandlers(client: Client): void {
    const capabilities = client.getServerCapabilities();
    if (capabilities?.tools) {
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        async () => {
          runLogger.log(
            `[mcp-client] tools/list_changed received server=${this.serverName}`,
          );
          await this.refreshTools();
        },
      );
    }
    if (capabilities?.resources) {
      client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        async () => {
          runLogger.log(
            `[mcp-client] resources/list_changed received server=${this.serverName}`,
          );
          await this.refreshResources();
        },
      );
    }
    if (capabilities?.prompts) {
      client.setNotificationHandler(
        PromptListChangedNotificationSchema,
        async () => {
          runLogger.log(
            `[mcp-client] prompts/list_changed received server=${this.serverName}`,
          );
          await this.refreshPrompts();
        },
      );
    }
    if (this.connector?.progressReporter) {
      client.setNotificationHandler(
        ProgressNotificationSchema,
        async (notification) => {
          this.connector?.progressReporter?.handleProgress?.(notification);
        },
      );
    }
  }

  private async refreshTools(): Promise<void> {
    if (this.refreshingTools) {
      this.pendingToolRefresh = true;
      return;
    }
    this.refreshingTools = true;
    try {
      do {
        this.pendingToolRefresh = false;
        if (!this.isConnected()) break;
        const previous = this.tools.map((tool) => tool.serverToolName);
        const tools = await discoverTools(
          this.serverName,
          this.serverConfig,
          this.client!,
          this,
          this.hostContext,
          { progressReporter: this.connector?.progressReporter },
        );
        this.tools = tools;
        const delta = catalogDelta(
          previous,
          tools.map((tool) => tool.serverToolName),
        );
        runLogger.log(
          `[mcp-client] tools changed server=${this.serverName} count=${tools.length} added=${delta.added.length} removed=${delta.removed.length}${
            delta.added.length > 0
              ? ` addedNames=${formatNames(delta.added)}`
              : ''
          }${
            delta.removed.length > 0
              ? ` removedNames=${formatNames(delta.removed)}`
              : ''
          }`,
        );
        await this.emit({ type: 'tools', tools });
      } while (this.pendingToolRefresh);
    } catch (error) {
      runLogger.debug(
        `[mcp-client] tool refresh failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    } finally {
      this.refreshingTools = false;
    }
  }

  private async refreshPrompts(): Promise<void> {
    if (this.refreshingPrompts) {
      this.pendingPromptRefresh = true;
      return;
    }
    this.refreshingPrompts = true;
    try {
      do {
        this.pendingPromptRefresh = false;
        if (!this.isConnected()) break;
        const previous = this.promptList.map((prompt) => prompt.name);
        const prompts = await discoverPrompts(
          this.serverName,
          this.client!,
          this.hostContext,
        );
        this.promptList = prompts;
        this.promptDetails.clear();
        const delta = catalogDelta(
          previous,
          prompts.map((prompt) => prompt.name),
        );
        runLogger.log(
          `[mcp-client] prompts changed server=${this.serverName} count=${prompts.length} added=${delta.added.length} removed=${delta.removed.length}`,
        );
        await this.emit({ type: 'prompts', prompts });
      } while (this.pendingPromptRefresh);
    } catch (error) {
      runLogger.debug(
        `[mcp-client] prompt refresh failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    } finally {
      this.refreshingPrompts = false;
    }
  }

  private async refreshResources(): Promise<void> {
    if (this.refreshingResources) {
      this.pendingResourceRefresh = true;
      return;
    }
    this.refreshingResources = true;
    try {
      do {
        this.pendingResourceRefresh = false;
        if (!this.isConnected()) break;
        const previous = this.resourceList.map((resource) => resource.uri);
        const resources = await discoverResources(
          this.serverName,
          this.client!,
          this.hostContext,
        );
        this.resourceList = resources;
        this.resourceDetails.clear();
        const delta = catalogDelta(
          previous,
          resources.map((resource) => resource.uri),
        );
        runLogger.log(
          `[mcp-client] resources changed server=${this.serverName} count=${resources.length} added=${delta.added.length} removed=${delta.removed.length}`,
        );
        await this.emit({ type: 'resources', resources });
      } while (this.pendingResourceRefresh);
    } catch (error) {
      runLogger.debug(
        `[mcp-client] resource refresh failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    } finally {
      this.refreshingResources = false;
    }
  }

  private setStatus(status: MCPServerStatus, reason?: string): void {
    if (this.status === status) return;
    const previousStatus = this.status;
    const now = Date.now();
    const previousDurationMs = now - this.statusChangedAt;
    this.status = status;
    this.statusChangedAt = now;
    if (status === MCPServerStatus.CONNECTED) {
      mcpServerRequiresOAuth.delete(this.serverName);
    } else if (status === MCPServerStatus.AUTH_REQUIRED) {
      mcpServerRequiresOAuth.set(this.serverName, true);
    }
    runLogger.log(
      `[mcp-client] state server=${this.serverName} ${previousStatus}->${status}${
        reason ? ` reason=${reason}` : ''
      } previousStateDurationMs=${previousDurationMs}`,
    );

    void this.emit({
      type: 'status',
      status,
      ...(reason ? { reason } : {}),
    });
  }

  private async emit(event: McpClientEvent): Promise<void> {
    try {
      await this.listener(event);
    } catch (error) {
      runLogger.debug(
        `[mcp-client] listener failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    }
  }
}
