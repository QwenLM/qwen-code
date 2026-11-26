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

import type {
  Client,
  McpSubscription,
  ServerCapabilities,
} from '@modelcontextprotocol/client';
import type { Transport  } from '@modelcontextprotocol/client';
import { SdkHttpError, SseError } from '@modelcontextprotocol/client';
import { ReadResourceResultSchema } from '@modelcontextprotocol/core';
import { type GetPromptResult, type ListResourcesResult, type ReadResourceResult, type Resource } from '@modelcontextprotocol/client';

import type { MCPServerConfig } from '../mcpServerConfig.js';
import { runLogger } from '../../utils/runLogger.js';
import { getMcpErrorMessage } from '../errors.js';
import type { McpAuthorizationRequiredError } from '../authorization.js';
import {
  findAuthRequiredError,
  findAuthorizationActionError,
} from '../authError.js';
import type { McpConnector } from '../connector/types.js';
import { connectToMcpServer } from '../connector/connectMcpServer.js';
import { mcpServerKeyId, type McpServerKey } from '../server-key.js';
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
import {
  mcpClientRequiresOAuth,
  mcpServerRequiresOAuth,
} from '../oauthState.js';
import { resolveMcpRequestTimeoutMs } from '../tools/mcp-timeouts.js';
import { mcpModelContext } from '../tools/mcp-model-context.js';
import { raceWithAbortSignal } from '../../utils/abort-race.js';
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

export type McpClientTransportType =
  | 'sse'
  | 'streamable_http'
  | 'websocket'
  | 'stdio'
  | 'unknown';

export function inferMcpTransportType(
  config: MCPServerConfig,
): McpClientTransportType {
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

export type McpCallToolResult = Awaited<ReturnType<Client['callTool']>>;

export type CallToolParams = {
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

const RESERVED_REQUEST_META_KEYS = new Set([
  'progressToken',
  'io.modelcontextprotocol/related-task',
]);

function sanitizeRequestMeta(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const entries = Object.entries(meta).filter(
    ([key]) => !RESERVED_REQUEST_META_KEYS.has(key),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isSessionInvalidError(error: unknown): boolean {
  if (error instanceof SdkHttpError) return error.status === 404;
  if ((error as { code?: unknown }).code === 404) return true;
  // Legacy SSE reports a rejected POST as a plain Error carrying the status
  // and the response body. A retired session and a stream that reconnected
  // without running initialize are both rejected before the request executes;
  // other 400s stay ordinary failures.
  const message = getMcpErrorMessage(error);
  if (!message.includes('Error POSTing to endpoint (HTTP 400)')) return false;
  return (
    message.includes('No active SSE session for sessionId=') ||
    message.includes('Server not initialized') ||
    /"code"\s*:\s*-32002\b/.test(message)
  );
}

/**
 * A failed `tools/list` is not an empty catalog. While the connection stays
 * up, re-discover on this backoff so a transient upstream failure heals.
 */
const TOOL_DISCOVERY_RETRY_DELAYS_MS = [
  5_000, 20_000, 60_000, 180_000, 300_000,
] as const;

/** Point-in-time protocol facts for one connected server. */
export interface McpConnectionInfo {
  readonly source: 'initialize' | 'discover';
  readonly capabilities: ServerCapabilities;
  readonly raw: Record<string, unknown>;
}

export class McpClient implements McpToolCaller {
  private readonly serverKey: McpServerKey;
  private readonly oauthStateKey: string;
  private readonly serverName: string;
  private readonly serverConfig: MCPServerConfig;
  private readonly clientVersion: string;
  private readonly debugMode: boolean;
  private readonly hostContext: McpClientContext;
  private readonly listener: McpClientListener;
  private callMetadataProvider: McpClientCallMetadataProvider | undefined;
  private readonly requestMetaProvider:
    | (() => Record<string, unknown> | undefined)
    | undefined;
  private readonly elicitationHandler: McpElicitationHandler | undefined;

  private client: Client | undefined;
  private status: MCPServerStatus = MCPServerStatus.DISCONNECTED;
  private statusChangedAt = Date.now();
  private intentionalDisconnect = false;
  private connectAbortController: AbortController | undefined;
  /** Shared by every caller while one handshake is in flight. */
  private connectPromise: Promise<void> | undefined;
  /** The transport of the attempt in flight, closable while it is starting. */
  private connectingTransport: Transport | undefined;
  /** Bumped by every attempt and by disconnect; stale attempts stand down. */
  private connectGeneration = 0;
  /** Orders this client's outward events; status must not overtake an attempt. */
  private emitQueue: Promise<void> = Promise.resolve();
  private lastStatusEvent:
    | { status: MCPServerStatus; reason: string | undefined; generation: number }
    | undefined;
  /** Remembered so a dropped network connection can be re-established lazily. */
  private connector: McpConnector | undefined;
  private reconnectPromise: Promise<void> | undefined;
  /** One session rebuild at a time; callers share the in-flight attempt. */
  private sessionRecovery: Promise<boolean> | undefined;
  private subscription: McpSubscription | undefined;
  private subscriptionRetryTimer: NodeJS.Timeout | undefined;
  /** Set when the connection parked for host-brokered authorization. */
  private authorizationError: McpAuthorizationRequiredError | undefined;
  /** The error from the most recent failed connect, for diagnostics/UI. */
  private lastConnectError: unknown;

  private tools: DiscoveredMCPTool[] = [];
  /** Why the last tool discovery failed, if it did. */
  private toolDiscoveryError: unknown;
  /** Bounded re-discovery after a failed `tools/list`; success clears it. */
  private toolDiscoveryRetryTimer: NodeJS.Timeout | undefined;
  private toolDiscoveryRetryAttempt = 0;
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
    this.oauthStateKey = mcpServerKeyId(init.serverKey);
    this.serverName = init.serverName;
    this.serverConfig = init.serverConfig;
    this.clientVersion = init.clientVersion;
    this.debugMode = init.debugMode;
    this.hostContext = init.hostContext;
    this.listener = init.listener;
    this.callMetadataProvider = init.callMetadataProvider;
    this.requestMetaProvider = init.requestMetaProvider;
    this.elicitationHandler = init.elicitationHandler;
    runLogger.log(
      `[mcp-client] created server=${this.serverName} source=${this.serverKey.source} transport=${inferMcpTransportType(this.serverConfig)}`,
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

  /** The attempt generation current listeners must compare events against. */
  getConnectGeneration(): number {
    return this.connectGeneration;
  }

  isConnected(): boolean {
    return this.status === MCPServerStatus.CONNECTED && this.client !== undefined;
  }

  getInstructions(): string | undefined {
    return this.client?.getInstructions();
  }

  /** Raw initialize result captured by the client; undefined until initialized. */
  getInitializeResult(): Record<string, unknown> | undefined {
    const client = this.client as
      | { getInitializeResult?: () => Record<string, unknown> | undefined }
      | undefined;
    return client?.getInitializeResult?.();
  }

  getServerInfo(): McpConnectionInfo | undefined {
    if (!this.client) return undefined;
    const era = this.client.getProtocolEra();
    const capabilities = this.client.getServerCapabilities() ?? {};
    const raw =
      era === 'modern'
        ? (this.client.getDiscoverResult() as
            | Record<string, unknown>
            | undefined)
        : {
            protocolVersion: this.client.getNegotiatedProtocolVersion(),
            capabilities,
            serverInfo: this.client.getServerVersion(),
            instructions: this.client.getInstructions(),
          };
    return {
      source: era === 'modern' ? 'discover' : 'initialize',
      capabilities,
      raw: raw ?? {},
    };
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

  /** Why the last tool discovery failed; undefine once one succeeds. */
  getToolDiscoveryError(): unknown {
    return this.toolDiscoveryError;
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
    const generation = ++this.connectGeneration;
    const transport = inferMcpTransportType(this.serverConfig);
    // An action belongs to one connection attempt; a new attempt must not let
    // callers read the previous attempt's authorization.
    this.authorizationError = undefined;
    this.intentionalDisconnect = false;
    // A new connection starts with a fresh discovery-retry budget.
    this.clearToolDiscoveryRetry();
    this.toolDiscoveryRetryAttempt = 0;
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
        serverKeyId: this.oauthStateKey,
        serverConfig: this.serverConfig,
        debugMode: this.debugMode,
        cliConfig: this.hostContext,
        connector,
        timeoutMs: resolveMcpRequestTimeoutMs(),
        signal: request.signal ?? this.connectAbortController.signal,
        allowAuthentication: request.allowAuthentication,
        elicitationHandler: this.elicitationHandler,
        onTransport: (transport) => {
          if (generation === this.connectGeneration) {
            this.connectingTransport = transport;
          }
        },
      });
      if (generation !== this.connectGeneration || this.intentionalDisconnect) {
        // A disconnect (or a newer attempt) owns the state now; never let this
        // attempt resurrect a connection it no longer owns.
        await client.close().catch(() => {});
        throw new Error(
          `MCP server '${this.serverName}' connection attempt was superseded`,
        );
      }
      this.connectingTransport = undefined;
      this.client = client;
      this.authorizationError = undefined;
      this.lastConnectError = undefined;
      this.wrapClientLifetimeHandlers(client);
      this.registerNotificationHandlers(client);
      this.setStatus(MCPServerStatus.CONNECTED);
      void this.openModernSubscription(client);
      runLogger.log(
        `[mcp-client] connect completed server=${this.serverName} transport=${transport} durationMs=${Date.now() - startedAt}`,
      );
    } catch (error) {
      const failed = this.client;
      this.client = undefined;
      this.closeSubscription();
      this.lastConnectError = error;
      if (failed) {
        await failed.close().catch(() => {});
      }
      if (generation !== this.connectGeneration) {
        // The attempt was stopped or replaced; its state is not ours to write.
        throw error;
      }
      const authorizationAction = findAuthorizationActionError(error);
      const authRequiredError = authorizationAction ?? findAuthRequiredError(error);
      if (
        authRequiredError !== undefined ||
        mcpClientRequiresOAuth.has(this.oauthStateKey)
      ) {
        if (authorizationAction) {
          this.authorizationError = authorizationAction;
          runLogger.log(
            `[mcp-client] authorization action captured server=${this.serverName}`,
          );
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
    this.closeSubscription();
    this.clearToolDiscoveryRetry();
    this.toolDiscoveryRetryAttempt = 0;
    // A stopped attempt must not finish later and resurrect the connection.
    this.connectGeneration += 1;
    this.intentionalDisconnect = true;
    this.connectAbortController?.abort();
    const connecting = this.connectingTransport;
    this.connectingTransport = undefined;
    // A new connect may start immediately; the old attempt stands down.
    this.connectPromise = undefined;
    if (connecting) {
      await connecting.close().catch((error: unknown) => {
        runLogger.debug(
          `[mcp-client] closing connecting transport failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
        );
      });
    }
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
    this.clearToolDiscoveryRetry();
    runLogger.log(
      `[mcp-client] abort connection server=${this.serverName} reason=${reason}`,
    );
    const client = this.client;
    this.client = undefined;
    this.setStatus(MCPServerStatus.DISCONNECTED, reason);
    void client?.close().catch(() => {});
  }

  /**
   * Lazily re-establishes a dropped network connection (before a tool call)
   * and refreshes the catalog. A stdio connection is not lazily
   * recoverable — a spawned process that died stays dead until an explicit
   * restart — and an AUTH_REQUIRED server stays parked until authorized.
   */
  async ensureConnected(): Promise<void> {
    if (this.status === MCPServerStatus.CONNECTED && this.client) return;
    if (this.reconnectPromise) return this.reconnectPromise;
    if (this.intentionalDisconnect) {
      throw new Error(`MCP server '${this.serverName}' was disconnected`);
    }
    if (
      this.status !== MCPServerStatus.DISCONNECTED ||
      !this.connector ||
      !this.isNetworkTransport()
    ) {
      throw new Error(`MCP server '${this.serverName}' is not connected`);
    }
    const startedAt = Date.now();
    runLogger.log(
      `[mcp-client] lazy reconnect started server=${this.serverName} transport=${inferMcpTransportType(this.serverConfig)}`,
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
   * Recovers a dropped connection on behalf of one call. Cancelling the call or
   * reaching the deadline ends only this wait; the reconnect itself is shared.
   */
  async recoverConnection(signal?: AbortSignal): Promise<void> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException(
            'MCP connection recovery timed out.',
            'TimeoutError',
          ),
        ),
      resolveMcpRequestTimeoutMs(),
    );
    try {
      await raceWithAbortSignal(
        // The connection outlives the call, so it must not capture the call's model context.
        mcpModelContext.exit(() => this.ensureConnected()),
        signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
      );
    } finally {
      clearTimeout(timer);
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
    this.toolDiscoveryError = undefined;
    const tools = await discoverTools(
      this.serverName,
      this.serverConfig,
      this.client!,
      this,
      this.hostContext,
      {
        signal: request.signal ?? this.connectAbortController?.signal,
        progressReporter: this.connector?.progressReporter,
        onError: (error) => {
          this.toolDiscoveryError = error;
        },
      },
    );
    if (this.toolDiscoveryError === undefined) {
      this.tools = tools;
      this.toolDiscoveryRetryAttempt = 0;
      this.clearToolDiscoveryRetry();
    } else {
      // Keep the catalog the session already has; ask again on the backoff.
      this.scheduleToolDiscoveryRetry();
    }
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

  /**
   * One `resources/list` page, as the server returned it: `nextCursor` is
   * passed back for the next page. Unlike {@link listResources} this does not
   * walk the whole catalog or touch the cached one.
   */
  async listResourcesPage(cursor?: string): Promise<ListResourcesResult> {
    this.assertConnected();
    return this.client!.listResources(cursor ? { cursor } : {}, {
      timeout: resolveMcpRequestTimeoutMs(),
    });
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
  private isNetworkTransport(): boolean {
    return !!(
      this.serverConfig.url ||
      this.serverConfig.httpUrl ||
      this.serverConfig.type === 'http' ||
      this.serverConfig.type === 'sse' ||
      this.serverConfig.type === 'ws'
    );
  }

  /**
   * The server retired the session: a 404 on a request that carried the
   * session id, or a legacy SSE POST rejected before execution. Drop the
   * connection and rebuild it once; a retry of the current request is the
   * caller's decision.
   */
  private recoverExpiredSession(): Promise<boolean> {
    if (this.sessionRecovery) return this.sessionRecovery;
    const run = this.rebuildSession().finally(() => {
      if (this.sessionRecovery === run) this.sessionRecovery = undefined;
    });
    this.sessionRecovery = run;
    return run;
  }

  private async rebuildSession(): Promise<boolean> {
    if (!this.connector || !this.isNetworkTransport()) return false;
    const stale = this.client;
    this.client = undefined;
    this.closeSubscription();
    this.setStatus(MCPServerStatus.DISCONNECTED, 'session_expired');
    await stale?.close().catch((error: unknown) => {
      runLogger.debug(
        `[mcp-client] closing expired session failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    });
    try {
      await this.ensureConnected();
      runLogger.log(
        `[mcp-client] session recovered server=${this.serverName}`,
      );
      return true;
    } catch (error) {
      runLogger.warn(
        `[mcp-client] session recovery failed server=${this.serverName}: ${getMcpErrorMessage(error)}`,
      );
      return false;
    }
  }

  async callMcpTool(
    params: CallToolParams,
    options?: {
      timeout?: number;
      signal?: AbortSignal;
      /** Per-request `_meta`; overrides the session-level provider. */
      requestMeta?: Record<string, unknown>;
    },
  ): Promise<McpCallToolResult> {
    // A rebuild already in flight owns the connection state; wait for it
    // instead of reporting the transient gap as "not connected".
    if (this.sessionRecovery) await this.sessionRecovery;
    if (!this.isConnected()) await this.recoverConnection(options?.signal);
    const client = this.client;
    if (!client || this.status !== MCPServerStatus.CONNECTED) {
      throw new Error(`MCP server '${this.serverName}' is not connected`);
    }
    const startedAt = Date.now();
    runLogger.log(
      `[mcp-client] tool call started server=${this.serverName} tool=${params.name}`,
    );
    const { requestMeta: explicitRequestMeta, ...callOptions } = options ?? {};
    let effectiveParams: CallToolParams | undefined;
    try {
      const contributed = this.callMetadataProvider
        ? await this.callMetadataProvider(this)
        : undefined;
      effectiveParams = this.applyCallMetadata(
        params,
        contributed,
        explicitRequestMeta ?? this.requestMetaProvider?.(),
      );
      const result = await client.callTool(
        effectiveParams,
        callOptions,
      );
      runLogger.log(
        `[mcp-client] tool call completed server=${this.serverName} tool=${params.name} isError=${result.isError === true} durationMs=${Date.now() - startedAt}`,
      );
      return result;
    } catch (error) {
      runLogger.log(
        `[mcp-client] tool call failed server=${this.serverName} tool=${params.name} durationMs=${Date.now() - startedAt}`,
      );
      // A session-invalid rejection means the request did not run: rebuild the
      // connection and retry this request at most once.
      if (
        effectiveParams &&
        isSessionInvalidError(error) &&
        (await this.recoverExpiredSession())
      ) {
        const refreshed = this.client;
        if (refreshed) {
          return refreshed.callTool(effectiveParams, callOptions);
        }
      }
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
    options?: {
      signal?: AbortSignal;
      /** Per-request `_meta`; overrides the session-level provider. */
      requestMeta?: Record<string, unknown>;
    },
  ): Promise<ReadResourceResult> {
    this.assertConnected();
    const startedAt = Date.now();
    const { requestMeta: explicitRequestMeta, ...callOptions } = options ?? {};
    const requestMeta = sanitizeRequestMeta(
      explicitRequestMeta ?? this.requestMetaProvider?.(),
    );
    // Context-bearing reads may be personalized by the server, so the shared
    // per-connection cache must not serve or store them.
    const cached = requestMeta ? undefined : this.resourceDetails.get(uri);
    if (cached) {
      runLogger.log(
        `[mcp-client] resource served from cache server=${this.serverName} uri=${uri}`,
      );
      return cached;
    }
    try {
      const result = await this.client!.request(
        {
          method: 'resources/read',
          params: { uri, ...(requestMeta ? { _meta: requestMeta } : {}) },
        },
        ReadResourceResultSchema,
        { timeout: resolveMcpRequestTimeoutMs(), ...callOptions },
      );
      if (!requestMeta) this.resourceDetails.set(uri, result);
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
    requestMeta: Record<string, unknown> | undefined,
  ): CallToolParams {
    const sessionMeta = sanitizeRequestMeta(requestMeta);
    if (!sessionMeta && (!contributed || Object.keys(contributed).length === 0))
      return params;
    return {
      ...params,
      _meta: { ...params._meta, ...sessionMeta, ...contributed },
    };
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
      this.closeSubscription();
      this.clearToolDiscoveryRetry();
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
      // The legacy SSE transport reconnects its own EventSource, which gives
      // the server a new session id without re-running initialize. Rebuild the
      // MCP session instead of sending requests over the uninitialized stream.
      if (
        error instanceof SseError &&
        this.serverConfig.type === 'sse' &&
        this.client === client &&
        this.status === MCPServerStatus.CONNECTED &&
        !this.intentionalDisconnect
      ) {
        runLogger.log(
          `[mcp-client] SSE stream lost server=${this.serverName}; rebuilding session`,
        );
        void this.recoverExpiredSession();
      }
    };
  }

  private registerNotificationHandlers(client: Client): void {
    const capabilities = client.getServerCapabilities();
    if (capabilities?.tools) {
      client.setNotificationHandler(
        'notifications/tools/list_changed',
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
        'notifications/resources/list_changed',
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
        'notifications/prompts/list_changed',
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
        'notifications/progress',
        async (notification) => {
          this.connector?.progressReporter?.handleProgress?.({
            params: notification.params,
          });
        },
      );
    }
  }

  /**
   * 2026-07-28 servers only deliver list_changed on a subscriptions/listen
   * stream the client opened; legacy connections keep unsolicited delivery.
   */
  private async openModernSubscription(client: Client): Promise<void> {
    if (client.getProtocolEra() !== 'modern') return;
    const capabilities = client.getServerCapabilities();
    const filter = {
      ...(capabilities?.tools ? { toolsListChanged: true } : {}),
      ...(capabilities?.prompts ? { promptsListChanged: true } : {}),
      ...(capabilities?.resources ? { resourcesListChanged: true } : {}),
    };
    if (Object.keys(filter).length === 0) return;

    try {
      const subscription = await client.listen(filter);
      if (this.client !== client || !this.isConnected()) {
        await subscription.close().catch(() => {});
        return;
      }
      this.closeSubscription();
      this.subscription = subscription;
      void subscription.closed.then((reason) => {
        if (this.subscription === subscription) {
          this.subscription = undefined;
        }
        if (
          reason === 'remote' &&
          this.client === client &&
          this.isConnected()
        ) {
          this.scheduleSubscriptionRetry(client);
        }
      });
    } catch (error) {
      runLogger.warn(
        `[mcp-client] subscriptions/listen failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    }
  }

  private scheduleSubscriptionRetry(client: Client): void {
    if (this.subscriptionRetryTimer) return;
    const timer = setTimeout(() => {
      this.subscriptionRetryTimer = undefined;
      if (this.client === client && this.isConnected()) {
        void this.openModernSubscription(client);
      }
    }, 1_000);
    timer.unref?.();
    this.subscriptionRetryTimer = timer;
  }

  private closeSubscription(): void {
    if (this.subscriptionRetryTimer) {
      clearTimeout(this.subscriptionRetryTimer);
      this.subscriptionRetryTimer = undefined;
    }
    const subscription = this.subscription;
    this.subscription = undefined;
    void subscription?.close().catch((error: unknown) => {
      runLogger.debug(
        `[mcp-client] subscription close failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    });
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
        this.toolDiscoveryError = undefined;
        const tools = await discoverTools(
          this.serverName,
          this.serverConfig,
          this.client!,
          this,
          this.hostContext,
          {
            progressReporter: this.connector?.progressReporter,
            onError: (error) => {
              this.toolDiscoveryError = error;
            },
          },
        );
        if (this.toolDiscoveryError !== undefined) {
          // A failed refresh must not erase the catalog the session already
          // has; ask again on the backoff.
          this.scheduleToolDiscoveryRetry();
          break;
        }
        this.tools = tools;
        this.toolDiscoveryRetryAttempt = 0;
        this.clearToolDiscoveryRetry();
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
        await this.emit({
          type: 'tools',
          tools,
          generation: this.connectGeneration,
        });
      } while (this.pendingToolRefresh);
    } catch (error) {
      runLogger.debug(
        `[mcp-client] tool refresh failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    } finally {
      this.refreshingTools = false;
    }
  }

  /**
   * Re-discovers tools after a failed `tools/list` while the connection is
   * still up. A server that recovers on its own sends no list_changed, so this
   * is what brings its tools back to an open session.
   */
  private scheduleToolDiscoveryRetry(): void {
    if (this.toolDiscoveryRetryTimer || !this.isConnected()) return;
    const delay = TOOL_DISCOVERY_RETRY_DELAYS_MS[this.toolDiscoveryRetryAttempt];
    if (delay === undefined) return;
    const generation = this.connectGeneration;
    runLogger.log(
      `[mcp-client] tool discovery retry scheduled server=${this.serverName} attempt=${this.toolDiscoveryRetryAttempt + 1}/${TOOL_DISCOVERY_RETRY_DELAYS_MS.length} delayMs=${delay}`,
    );
    const timer = setTimeout(() => {
      this.toolDiscoveryRetryTimer = undefined;
      if (generation !== this.connectGeneration || !this.isConnected()) return;
      this.toolDiscoveryRetryAttempt += 1;
      runLogger.log(
        `[mcp-client] tool discovery retry started server=${this.serverName} attempt=${this.toolDiscoveryRetryAttempt}/${TOOL_DISCOVERY_RETRY_DELAYS_MS.length}`,
      );
      void this.refreshTools();
    }, delay);
    timer.unref?.();
    this.toolDiscoveryRetryTimer = timer;
  }

  private clearToolDiscoveryRetry(): void {
    if (!this.toolDiscoveryRetryTimer) return;
    clearTimeout(this.toolDiscoveryRetryTimer);
    this.toolDiscoveryRetryTimer = undefined;
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
        await this.emit({
          type: 'prompts',
          prompts,
          generation: this.connectGeneration,
        });
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
        await this.emit({
          type: 'resources',
          resources,
          generation: this.connectGeneration,
        });
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
    const generation = this.connectGeneration;
    if (
      this.status === status &&
      this.lastStatusEvent?.status === status &&
      this.lastStatusEvent.reason === reason &&
      this.lastStatusEvent.generation === generation
    ) {
      return;
    }
    this.lastStatusEvent = { status, reason, generation };
    const previousStatus = this.status;
    const now = Date.now();
    const previousDurationMs = now - this.statusChangedAt;
    this.status = status;
    this.statusChangedAt = now;
    if (status === MCPServerStatus.CONNECTED) {
      mcpServerRequiresOAuth.delete(this.serverName);
      mcpClientRequiresOAuth.delete(this.oauthStateKey);
    } else if (status === MCPServerStatus.AUTH_REQUIRED) {
      mcpServerRequiresOAuth.set(this.serverName, true);
      mcpClientRequiresOAuth.set(this.oauthStateKey, true);
    }
    runLogger.log(
      `[mcp-client] state server=${this.serverName} ${previousStatus}->${status}${
        reason ? ` reason=${reason}` : ''
      } previousStateDurationMs=${previousDurationMs}`,
    );
    this.onStatusChanged(previousStatus, status, reason);
    void this.emit({
      type: 'status',
      status,
      generation,
      ...(reason ? { reason } : {}),
    });
  }

  /** Synchronous host extension, after deduplication and before queued listeners. */
  protected onStatusChanged(
    _previousStatus: MCPServerStatus,
    _status: MCPServerStatus,
    _reason?: string,
  ): void {}

  private emit(event: McpClientEvent): Promise<void> {
    const queued = this.emitQueue
      .catch(() => undefined)
      .then(() => this.dispatch(event));
    this.emitQueue = queued;
    return queued;
  }

  private async dispatch(event: McpClientEvent): Promise<void> {
    try {
      await this.listener(event);
    } catch (error) {
      runLogger.debug(
        `[mcp-client] listener failed for '${this.serverName}': ${getMcpErrorMessage(error)}`,
      );
    }
  }
}
