/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SSEClientTransportOptions } from '@modelcontextprotocol/sdk/client/sse.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  GetPromptResult,
  JSONRPCMessage,
  Prompt,
  ReadResourceResult,
  Resource,
} from '@modelcontextprotocol/sdk/types.js';
import {
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListRootsRequestSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'shell-quote';
import type { Config, MCPServerConfig } from '../config/config.js';
import { AuthProviderType, isSdkMcpServerConfig } from '../config/config.js';
import { GoogleCredentialProvider } from '../mcp/google-auth-provider.js';
import { ServiceAccountImpersonationProvider } from '../mcp/sa-impersonation-provider.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import type { McpToolAnnotations } from './mcp-tool.js';
import { SdkControlClientTransport } from './sdk-control-client-transport.js';
import { MCPServerStatus, updateMCPServerStatus } from './mcp-status.js';
export {
  addMCPStatusChangeListener,
  getAllMCPServerStatuses,
  getMCPServerStatus,
  MCPServerStatus,
  removeMCPServerStatus,
  removeMCPStatusChangeListener,
  updateMCPServerStatus,
} from './mcp-status.js';

import type { FunctionDeclaration } from '@google/genai';
import { mcpToTool } from '@google/genai';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MCPOAuthProvider } from '../mcp/oauth-provider.js';
import { MCPOAuthTokenStorage } from '../mcp/oauth-token-storage.js';
import { OAuthUtils } from '../mcp/oauth-utils.js';
import type { OAuthCredentials } from '../mcp/token-storage/types.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizePathEnvForWindows } from '../utils/windowsPath.js';
import type {
  Unsubscribe,
  WorkspaceContext,
} from '../utils/workspaceContext.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * Callback type for sending MCP messages to SDK servers via control plane
 */
export type SendSdkMcpMessage = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>;

export const MCP_DEFAULT_TIMEOUT_MSEC = 10 * 60 * 1000; // default to 10 minutes

const debugLogger = createDebugLogger('MCP');

const STREAMABLE_HTTP_GET_SSE_FALLBACK_STATUSES = new Set([400]);
const STREAMABLE_HTTP_GET_SSE_ERROR_BODY_LIMIT = 512;

export function getMcpOAuthDialogInstruction(
  action: 'authenticate' | 're-authenticate',
  mcpServerName: string,
): string {
  return [
    `In interactive Qwen Code sessions, open the /mcp dialog to ${action}`,
    `with MCP server '${mcpServerName}'.`,
    `For headless or SDK usage, configure MCP OAuth with qwen mcp add --oauth-*`,
    `or settings.json, then ${action} once in an interactive session before connecting.`,
  ].join(' ');
}

type SseOAuth401TokenState = 'accepted-token-rejected' | 'unusable' | 'missing';

function getSseOAuth401Message(
  mcpServerName: string,
  tokenState: SseOAuth401TokenState,
): string {
  if (tokenState === 'accepted-token-rejected') {
    return (
      `Stored OAuth token for SSE server '${mcpServerName}' was rejected. ` +
      getMcpOAuthDialogInstruction('re-authenticate', mcpServerName)
    );
  }

  if (tokenState === 'unusable') {
    return (
      `Stored OAuth tokens for SSE server '${mcpServerName}' are expired or could not be refreshed. ` +
      getMcpOAuthDialogInstruction('re-authenticate', mcpServerName)
    );
  }

  return (
    `401 error received for SSE server '${mcpServerName}' without OAuth configuration. ` +
    getMcpOAuthDialogInstruction('authenticate', mcpServerName)
  );
}

async function readResponseBodyExcerpt(
  response: Response,
): Promise<string | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) {
    return undefined;
  }

  const decoder = new TextDecoder();
  let body = '';
  let bytesRead = 0;
  let truncated = false;
  try {
    while (bytesRead < STREAMABLE_HTTP_GET_SSE_ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) {
        body += decoder.decode();
        break;
      }

      const remaining = STREAMABLE_HTTP_GET_SSE_ERROR_BODY_LIMIT - bytesRead;
      if (value.byteLength > remaining) {
        body += decoder.decode(value.subarray(0, remaining), {
          stream: true,
        });
        bytesRead += remaining;
        truncated = true;
        reader.cancel().catch(() => {
          // Best-effort cleanup after collecting the bounded excerpt.
        });
        break;
      }

      body += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }

    if (bytesRead >= STREAMABLE_HTTP_GET_SSE_ERROR_BODY_LIMIT && !truncated) {
      const { done } = await reader.read();
      if (!done) {
        truncated = true;
        reader.cancel().catch(() => {
          // Best-effort cleanup after collecting the bounded excerpt.
        });
      }
    }

    body += decoder.decode();
    const excerpt = body.trim();
    if (!excerpt) {
      return undefined;
    }
    return truncated ||
      excerpt.length > STREAMABLE_HTTP_GET_SSE_ERROR_BODY_LIMIT
      ? `${excerpt.slice(0, STREAMABLE_HTTP_GET_SSE_ERROR_BODY_LIMIT)}...`
      : excerpt;
  } catch {
    return undefined;
  }
}

function isStreamableHttpGetSseRequest(init?: RequestInit): boolean {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    return false;
  }

  const headers = new Headers(init?.headers);
  if (headers.has('last-event-id')) {
    return false;
  }

  const accept = headers.get('accept') ?? '';
  return accept
    .split(',')
    .map((value) => value.split(';')[0].trim().toLowerCase())
    .some((type) => type === 'text/event-stream');
}

/**
 * Wraps fetch to normalize Spring AI-style 400 responses to the SDK's
 * unsupported sentinel for the optional Streamable HTTP GET SSE request.
 *
 * SDK coupling: `StreamableHTTPClientTransport._startOrAuthSse()` treats a
 * 405 response as "GET SSE unsupported" and continues in POST-only mode.
 * If the SDK changes that non-OK handling, update this wrapper in lockstep.
 */
export function createStreamableHttpCompatibilityFetch(
  mcpServerName: string,
  fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (
      !isStreamableHttpGetSseRequest(init) ||
      !STREAMABLE_HTTP_GET_SSE_FALLBACK_STATUSES.has(response.status)
    ) {
      return response;
    }

    const responseBody = await readResponseBodyExcerpt(response);
    await response.body?.cancel().catch(() => {
      // Best-effort body cleanup before returning a synthetic 405.
    });
    debugLogger.warn(
      `MCP server '${mcpServerName}' rejected the optional Streamable HTTP ` +
        `GET SSE stream with HTTP ${response.status}; continuing without ` +
        `the standalone GET stream. POST request streams remain enabled.` +
        (responseBody ? ` Response body: ${JSON.stringify(responseBody)}` : ''),
    );

    return new Response(null, {
      status: 405,
      statusText: 'Method Not Allowed',
    });
  };
}

export type DiscoveredMCPPrompt = Prompt & {
  serverName: string;
  invoke: (params: Record<string, unknown>) => Promise<GetPromptResult>;
};

/**
 * A resource advertised by an MCP server (`resources/list`), tagged with
 * the originating server so the read path (`readMcpResource`) and the
 * `/mcp` view can address it by `(serverName, uri)`. Unlike prompts,
 * resources carry no bound `invoke` closure — they are read on demand by
 * URI via `ToolRegistry.readMcpResource`.
 */
export type DiscoveredMCPResource = Resource & {
  serverName: string;
};

/**
 * Enum representing the overall MCP discovery state
 */
export enum MCPDiscoveryState {
  /** Discovery has not started yet */
  NOT_STARTED = 'not_started',
  /** Discovery is currently in progress */
  IN_PROGRESS = 'in_progress',
  /** Discovery has completed (with or without errors) */
  COMPLETED = 'completed',
}

/**
 * A client for a single MCP server.
 *
 * This class is responsible for connecting to, discovering tools from, and
 * managing the state of a single MCP server.
 */
export class McpClient {
  private client: Client;
  private transport: Transport | undefined;
  private status: MCPServerStatus = MCPServerStatus.DISCONNECTED;
  private isDisconnecting = false;
  /**
   * captures the most recent error
   * delivered to the SDK Client's `onerror` callback. The pool entry's
   *  silent-drop block (the DISCONNECTED-on-active branch inside
   * `PoolEntry.statusChangeListener`) reads this via
   * `getLastTransportError()` to thread the upstream cause (EPIPE,
   * OAuth 401, server crash) into the `'failed'` event's `lastError`
   * string instead of emitting only the synthetic
   * `'transport disconnected (silent transport drop)'` marker. Reset
   * at the top of `connect()` so a successful reconnect clears stale
   * state. No reset on `disconnect()` — McpClient instances are GC'd
   * at pool entry teardown; field staleness has no observable
   * consumer post-disconnect.
   */
  private lastTransportError?: Error;
  private instructions: string | undefined;

  constructor(
    private readonly serverName: string,
    private readonly serverConfig: MCPServerConfig,
    private readonly toolRegistry: ToolRegistry,
    private readonly promptRegistry: PromptRegistry,
    private readonly workspaceContext: WorkspaceContext,
    private readonly debugMode: boolean,
    private readonly sendSdkMcpMessage?: SendSdkMcpMessage,
  ) {
    this.client = new Client({
      name: `qwen-cli-mcp-client-${this.serverName}`,
      version: '0.0.1',
    });
  }

  /**
   * Connects to the MCP server.
   */
  async connect(): Promise<void> {
    this.isDisconnecting = false;
    // clear stale upstream error from
    // any prior connect/disconnect cycle. The silent-drop reader
    // is otherwise satisfied by `undefined` and falls back to the
    // synthetic marker — but a stale error from a previous incarnation
    // would mis-attribute a fresh transport drop to an old cause.
    this.lastTransportError = undefined;
    this.updateStatus(MCPServerStatus.CONNECTING);
    try {
      this.transport = await this.createTransport();

      this.client.onerror = (error) => {
        if (this.isDisconnecting) {
          return;
        }
        // capture the upstream error
        // BEFORE the synchronous `updateStatus(DISCONNECTED)` cascades
        // to PoolEntry's statusChangeListener. The listener's
        // silent-drop block reads `lastTransportError` inline; setting
        // it ahead of `updateStatus` guarantees the field is populated
        // by the time the listener fires.
        this.lastTransportError = error;
        debugLogger.error(`MCP ERROR (${this.serverName}):`, error.toString());
        this.updateStatus(MCPServerStatus.DISCONNECTED);
      };

      this.client.registerCapabilities({
        roots: {},
      });

      this.client.setRequestHandler(ListRootsRequestSchema, async () => {
        const roots = [];
        for (const dir of this.workspaceContext.getDirectories()) {
          roots.push({
            uri: pathToFileURL(dir).toString(),
            name: basename(dir),
          });
        }
        return {
          roots,
        };
      });

      await this.client.connect(this.transport, {
        timeout: this.serverConfig.timeout,
      });
      this.instructions = this.client.getInstructions();

      this.updateStatus(MCPServerStatus.CONNECTED);
    } catch (error) {
      this.instructions = undefined;
      this.updateStatus(MCPServerStatus.DISCONNECTED);
      throw error;
    }
  }

  /**
   * Discovers tools and prompts from the MCP server.
   *
   * On error, the client's status is flipped to DISCONNECTED before the
   * error is re-thrown. Without this, a server that connects successfully
   * but then crashes (or returns no tools, or whose `tools/list` call
   * rejects) would remain `CONNECTED` in the global status registry, and
   * `Config.getFailedMcpServerNames()` — which filters by
   * `status !== CONNECTED` — would silently omit it from the
   * non-interactive failure banner. The caller (manager) still catches
   * and logs; we just need the status registry to reflect reality.
   */
  async discover(cliConfig: Config): Promise<void> {
    // legacy
    // `discover()` path (used by non-pool sessions and any direct
    // McpClient consumers) MUST apply config filters at discovery
    // time — pre-PR `this.discoverTools(cliConfig)` defaulted
    // `applyConfigFilters` to `true`, so `trust: true` server config
    // → tool's trust set; `includeTools`/`excludeTools` filtered out
    // disallowed tools. The refactor routed `discover()` through
    // `discoverAndReturn` which used to hardcode
    // `{ applyConfigFilters: false }` (matching pool semantics where
    // `SessionMcpView.applyTools` is the authoritative filter), but
    // that broke the legacy path: trust silently became `undefined`
    // (operators saw unexpected permission prompts) and include/
    // exclude filters were ignored. Now `discoverAndReturn` defaults
    // to applying filters; pool callers explicitly opt out.
    const { tools, prompts, resources } =
      await this.discoverAndReturn(cliConfig);
    for (const tool of tools) {
      this.toolRegistry.registerTool(tool);
    }
    for (const prompt of prompts) {
      this.promptRegistry.registerPrompt(prompt);
    }
    // Resources are registered via the Config-owned `ResourceRegistry`
    // rather than a constructor-injected field. `this.promptRegistry` is
    // already `cliConfig.getPromptRegistry()` on this non-pool path, so
    // this is the same single global registry — fetching it here avoids
    // threading a 4th registry through all ~20 `new McpClient(...)` sites.
    //
    // Clear-then-register makes re-discovery (health-monitor reconnect,
    // incremental settings-change discovery) idempotent: a resource the
    // server dropped between discoveries must not linger in the registry.
    // Mirrors `SessionMcpView.applyResources`' remove-then-register on the
    // pool path.
    //
    // Guard on `resources.length > 0`: `listMcpResources` swallows ALL errors
    // (including transient network failures / timeouts) and returns [], so an
    // unconditional clear would silently purge a server's resources whenever a
    // `resources/list` call transiently fails while tools/prompts succeed. We
    // only replace the set when we actually got one back. (Trade-off: a server
    // that legitimately drops to zero resources keeps the stale set until a
    // non-empty discovery — far less harmful than wiping good resources.)
    const resourceRegistry = cliConfig.getResourceRegistry();
    if (resources.length > 0) {
      resourceRegistry.removeResourcesByServer(this.serverName);
      for (const resource of resources) {
        resourceRegistry.registerResource(resource);
      }
    }
  }

  /**
   * Pure discovery — returns tools and prompts WITHOUT registering them.
   *
   * pool path: a single shared `McpClient` produces this
   * snapshot once; per-session `SessionMcpView` instances each
   * register a filtered/decorated copy into their own registries.
   *
   * Behavior mirrors `discover()` for error handling: status flips to
   * DISCONNECTED on any failure (so the global status registry +
   * `getFailedMcpServerNames()` reflect reality), then re-throws.
   *
   * Returns the same combined "no prompts or tools" error that `discover()`
   * raised previously, so callers that distinguish "server up but empty" from
   * "server down" still get the right signal.
   *
   * @param opts.applyConfigFilters Whether to apply `includeTools` /
   *   `excludeTools` filtering and set the `trust` field on returned
   *   tools at discovery time. Defaults to `true` (legacy `discover()`
   *   semantics). Pool callers pass `false` because per-session
   *   `SessionMcpView.applyTools` is the authoritative filter
   *   (otherwise pool-mode trust + filtering would apply twice
   *   inconsistently across sessions).
   */
  async discoverAndReturn(
    cliConfig: Config,
    opts?: { applyConfigFilters?: boolean },
  ): Promise<{
    tools: DiscoveredMCPTool[];
    prompts: DiscoveredMCPPrompt[];
    resources: DiscoveredMCPResource[];
  }> {
    if (this.status !== MCPServerStatus.CONNECTED) {
      throw new Error('Client is not connected.');
    }

    try {
      // Prompts, resources, and tools are independent reads with no data
      // dependency; run them concurrently (the SDK client multiplexes
      // requests by JSON-RPC id) to save round-trips per server at startup.
      // Each helper swallows its own errors and returns [], so Promise.all
      // never rejects here.
      const [prompts, resources, tools] = await Promise.all([
        listMcpPrompts(this.serverName, this.client),
        listMcpResources(this.serverName, this.client),
        discoverTools(
          this.serverName,
          this.serverConfig,
          this.client,
          cliConfig,
          { applyConfigFilters: opts?.applyConfigFilters ?? true },
        ),
      ]);

      if (
        prompts.length === 0 &&
        tools.length === 0 &&
        resources.length === 0
      ) {
        throw new Error('No prompts, tools, or resources found on the server.');
      }

      return { tools, prompts, resources };
    } catch (error) {
      this.updateStatus(MCPServerStatus.DISCONNECTED);
      throw error;
    }
  }

  /**
   * Disconnects from the MCP server.
   *
   * The intentional DISCONNECTED status update must reach the global
   * registry — `getFailedMcpServerNames()` filters on `status !== CONNECTED`
   * and the Footer's MCP health pill subscribes to the registry. Going
   * through `updateStatus()` would have it swallowed by the
   * `isDisconnecting` guard whose only purpose is to suppress LATE writes
   * from a stale `connect()` catch. We therefore write the local field and
   * the global registry directly, then flip `isDisconnecting = true` to
   * shut down propagation from any in-flight `connect()` / `discover()`
   * whose catch will fire after the transport has been torn down.
   */
  async disconnect(): Promise<void> {
    // Set the local status BEFORE flipping `isDisconnecting`. A concurrent
    // `discover()` reading `this.status` would otherwise see the stale
    // CONNECTED value and try to register tools that we're about to drop.
    this.status = MCPServerStatus.DISCONNECTED;
    updateMCPServerStatus(this.serverName, MCPServerStatus.DISCONNECTED);
    this.isDisconnecting = true;
    if (this.transport) {
      await this.transport.close();
    }
    this.client.close();
    this.instructions = undefined;
  }

  /**
   * Returns the current status of the client.
   */
  getStatus(): MCPServerStatus {
    return this.status;
  }

  /**
   * The OS pid of the spawned MCP child process, if this is a stdio
   * transport and the child is currently alive. Returns `undefined`
   * for remote transports (sse / http / websocket) and for stdio
   * transports that have not yet connected or have already exited.
   *
   * `PoolEntry.forceShutdown` reads this to enumerate
   * descendant pids (via `listDescendantPids`) before calling
   * `client.disconnect()`, so wrapper processes like
   * `npx @modelcontextprotocol/server-X` and `uvx ...` don't leak.
   */
  getTransportPid(): number | undefined {
    const t = this.transport as { pid?: number | null } | undefined;
    if (!t || typeof t.pid !== 'number' || t.pid <= 0) return undefined;
    return t.pid;
  }

  /**
   * expose the most recent SDK Client
   * `onerror` payload so PoolEntry's silent-drop block can thread
   * the upstream cause (EPIPE, OAuth 401, server-side crash) into the
   * `'failed'` event's `lastError` string. Returns `undefined` if no
   * error has been observed since the last `connect()`. Caller falls
   * back to the synthetic marker on `undefined`. Population site: the
   * `client.onerror` arrow inside `connect()` (this file). Consumer:
   * the silent-drop block inside `PoolEntry.statusChangeListener`.
   */
  getLastTransportError(): Error | undefined {
    return this.lastTransportError;
  }

  getInstructions(): string | undefined {
    return this.instructions;
  }

  async readResource(
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    if (this.status !== MCPServerStatus.CONNECTED) {
      throw new Error('Client is not connected.');
    }

    // No `getServerCapabilities()?.resources` precheck, to match the lenient
    // `listMcpResources` discovery path: a server that answers `resources/list`
    // but under-declares the `resources` capability would otherwise have its
    // resources discovered, listed in `/mcp`, and offered in `@server:`
    // completion, yet fail on read with a misleading "does not support
    // resources" error. The underlying `request` is the raw `Protocol.request`
    // (no capability assertion); a server that genuinely lacks resources
    // answers `-32601`, which surfaces naturally to the caller.
    return this.client.request(
      { method: 'resources/read', params: { uri } },
      ReadResourceResultSchema,
      options,
    );
  }

  private updateStatus(status: MCPServerStatus): void {
    this.status = status;
    // Once disconnect has begun, don't propagate further status changes to
    // the global registry. An in-flight `connect()` whose catch block fires
    // after `disableMcpServer` has already removed the entry would otherwise
    // silently resurrect the server and the Footer's MCP health pill would
    // continue to count it as offline.
    if (this.isDisconnecting) {
      return;
    }
    updateMCPServerStatus(this.serverName, status);
  }

  private async createTransport(): Promise<Transport> {
    return createTransport(
      this.serverName,
      this.serverConfig,
      this.debugMode,
      this.sendSdkMcpMessage,
    );
  }
}

/**
 * Track the overall MCP discovery state
 */
let mcpDiscoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;

/**
 * Map to track which MCP servers have been discovered to require OAuth
 */
export const mcpServerRequiresOAuth: Map<string, boolean> = new Map();

/**
 * Get the current MCP discovery state
 */
export function getMCPDiscoveryState(): MCPDiscoveryState {
  return mcpDiscoveryState;
}

/**
 * expose a setter so
 * `McpClientManager.discoverAllMcpToolsViaPool` can update the
 * module-global `mcpDiscoveryState`. Pre-fix the pool path only
 * updated the manager-local state, leaving the global at
 * `NOT_STARTED` while pool discovery was running or already
 * complete — `GET /workspace/mcp` and the MCP preflight cell read
 * the global and reported `not_started` for a workspace whose
 * discovery had finished. Per-session managers don't have the
 * concept of "ALL workspace discovery complete" anymore in pool
 * mode, so the pool path becomes the canonical writer when active.
 */
export function setMCPDiscoveryState(state: MCPDiscoveryState): void {
  mcpDiscoveryState = state;
}

/**
 * Extract WWW-Authenticate header from error message string.
 * This is a more robust approach than regex matching.
 *
 * @param errorString The error message string
 * @returns The www-authenticate header value if found, null otherwise
 */
function extractWWWAuthenticateHeader(errorString: string): string | null {
  // Try multiple patterns to extract the header
  const patterns = [
    /www-authenticate:\s*([^\n\r]+)/i,
    /WWW-Authenticate:\s*([^\n\r]+)/i,
    /"www-authenticate":\s*"([^"]+)"/i,
    /'www-authenticate':\s*'([^']+)'/i,
  ];

  for (const pattern of patterns) {
    const match = errorString.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Handle automatic OAuth discovery and authentication for a server.
 *
 * @param mcpServerName The name of the MCP server
 * @param mcpServerConfig The MCP server configuration
 * @param wwwAuthenticate The www-authenticate header value
 * @returns True if OAuth was successfully configured and authenticated, false otherwise
 */
async function handleAutomaticOAuth(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  wwwAuthenticate: string,
): Promise<boolean> {
  try {
    debugLogger.info(`'${mcpServerName}' requires OAuth authentication`);

    // Always try to parse the resource metadata URI from the www-authenticate header
    let oauthConfig;
    const resourceMetadataUri =
      OAuthUtils.parseWWWAuthenticateHeader(wwwAuthenticate);
    if (resourceMetadataUri) {
      oauthConfig = await OAuthUtils.discoverOAuthConfig(resourceMetadataUri);
    } else if (hasNetworkTransport(mcpServerConfig)) {
      // Fallback: try to discover OAuth config from the base URL
      const serverUrl = new URL(
        mcpServerConfig.httpUrl || mcpServerConfig.url!,
      );
      const baseUrl = `${serverUrl.protocol}//${serverUrl.host}`;
      oauthConfig = await OAuthUtils.discoverOAuthConfig(baseUrl);
    }

    if (!oauthConfig) {
      debugLogger.error(
        `Could not configure OAuth for server '${mcpServerName}'. ` +
          getMcpOAuthDialogInstruction('authenticate', mcpServerName),
      );
      return false;
    }

    // OAuth configuration discovered - proceed with authentication

    // Create OAuth configuration for authentication
    const oauthAuthConfig = {
      enabled: true,
      authorizationUrl: oauthConfig.authorizationUrl,
      tokenUrl: oauthConfig.tokenUrl,
      scopes: oauthConfig.scopes || [],
    };

    // Perform OAuth authentication
    // Pass the server URL for proper discovery
    const serverUrl = mcpServerConfig.httpUrl || mcpServerConfig.url;
    debugLogger.info(
      `Starting OAuth authentication for server '${mcpServerName}'...`,
    );
    const authProvider = new MCPOAuthProvider(new MCPOAuthTokenStorage());
    await authProvider.authenticate(mcpServerName, oauthAuthConfig, serverUrl);

    debugLogger.info(
      `OAuth authentication successful for server '${mcpServerName}'`,
    );
    return true;
  } catch (error) {
    debugLogger.error(
      `Failed to handle automatic OAuth for server '${mcpServerName}': ${getErrorMessage(error)}`,
    );
    return false;
  }
}

/**
 * Create a transport with OAuth token for the given server configuration.
 *
 * @param mcpServerName The name of the MCP server
 * @param mcpServerConfig The MCP server configuration
 * @param accessToken The OAuth access token
 * @returns The transport with OAuth token, or null if creation fails
 */
async function createTransportWithOAuth(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  accessToken: string,
): Promise<StreamableHTTPClientTransport | SSEClientTransport | null> {
  try {
    if (mcpServerConfig.httpUrl) {
      // Create HTTP transport with OAuth token
      const oauthTransportOptions: StreamableHTTPClientTransportOptions = {
        fetch: createStreamableHttpCompatibilityFetch(mcpServerName),
        requestInit: {
          headers: {
            ...mcpServerConfig.headers,
            Authorization: `Bearer ${accessToken}`,
          },
        },
      };

      return new StreamableHTTPClientTransport(
        new URL(mcpServerConfig.httpUrl),
        oauthTransportOptions,
      );
    } else if (mcpServerConfig.url) {
      // Create SSE transport with OAuth token in Authorization header
      return new SSEClientTransport(new URL(mcpServerConfig.url), {
        requestInit: {
          headers: {
            ...mcpServerConfig.headers,
            Authorization: `Bearer ${accessToken}`,
          },
        },
      });
    }

    return null;
  } catch (error) {
    debugLogger.error(
      `Failed to create OAuth transport for server '${mcpServerName}': ${getErrorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Discovers tools from all configured MCP servers and registers them with the tool registry.
 * It orchestrates the connection and discovery process for each server defined in the
 * configuration, as well as any server specified via a command-line argument.
 *
 * @param mcpServers A record of named MCP server configurations.
 * @param mcpServerCommand An optional command string for a dynamically specified MCP server.
 * @param toolRegistry The central registry where discovered tools will be registered.
 * @returns A promise that resolves when the discovery process has been attempted for all servers.
 */

export async function discoverMcpTools(
  mcpServers: Record<string, MCPServerConfig>,
  mcpServerCommand: string | undefined,
  toolRegistry: ToolRegistry,
  promptRegistry: PromptRegistry,
  debugMode: boolean,
  workspaceContext: WorkspaceContext,
  cliConfig: Config,
): Promise<void> {
  mcpDiscoveryState = MCPDiscoveryState.IN_PROGRESS;
  try {
    mcpServers = populateMcpServerCommand(mcpServers, mcpServerCommand);

    const discoveryPromises = Object.entries(mcpServers).map(
      ([mcpServerName, mcpServerConfig]) =>
        connectAndDiscover(
          mcpServerName,
          mcpServerConfig,
          toolRegistry,
          promptRegistry,
          debugMode,
          workspaceContext,
          cliConfig,
        ),
    );
    await Promise.all(discoveryPromises);
  } finally {
    mcpDiscoveryState = MCPDiscoveryState.COMPLETED;
  }
}

/** Visible for Testing */
export function populateMcpServerCommand(
  mcpServers: Record<string, MCPServerConfig>,
  mcpServerCommand: string | undefined,
): Record<string, MCPServerConfig> {
  if (mcpServerCommand) {
    const cmd = mcpServerCommand;
    const args = parse(cmd, process.env) as string[];
    if (args.some((arg) => typeof arg !== 'string')) {
      throw new Error('failed to parse mcpServerCommand: ' + cmd);
    }
    // use generic server name 'mcp'
    mcpServers['mcp'] = {
      command: args[0],
      args: args.slice(1),
    };
  }
  return mcpServers;
}

/**
 * Connects to an MCP server and discovers available tools, registering them with the tool registry.
 * This function handles the complete lifecycle of connecting to a server, discovering tools,
 * and cleaning up resources if no tools are found.
 *
 * @param mcpServerName The name identifier for this MCP server
 * @param mcpServerConfig Configuration object containing connection details
 * @param toolRegistry The registry to register discovered tools with
 * @param sendSdkMcpMessage Optional callback for SDK MCP servers to route messages via control plane.
 * @returns Promise that resolves when discovery is complete
 */
export async function connectAndDiscover(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  toolRegistry: ToolRegistry,
  promptRegistry: PromptRegistry,
  debugMode: boolean,
  workspaceContext: WorkspaceContext,
  cliConfig: Config,
  sendSdkMcpMessage?: SendSdkMcpMessage,
): Promise<void> {
  updateMCPServerStatus(mcpServerName, MCPServerStatus.CONNECTING);

  let mcpClient: Client | undefined;
  try {
    mcpClient = await connectToMcpServer(
      mcpServerName,
      mcpServerConfig,
      debugMode,
      workspaceContext,
      sendSdkMcpMessage,
    );

    mcpClient.onerror = (error) => {
      debugLogger.error(`MCP ERROR (${mcpServerName}):`, error.toString());
      updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
    };

    // Attempt to discover prompts, resources, and tools
    const prompts = await discoverPrompts(
      mcpServerName,
      mcpClient,
      promptRegistry,
    );
    const resources = await discoverResources(
      mcpServerName,
      mcpClient,
      cliConfig.getResourceRegistry(),
    );
    const tools = await discoverTools(
      mcpServerName,
      mcpServerConfig,
      mcpClient,
      cliConfig,
    );

    // If we found no prompts, resources, or tools, it's a failed discovery
    if (prompts.length === 0 && resources.length === 0 && tools.length === 0) {
      throw new Error('No prompts, tools, or resources found on the server.');
    }

    // If we found anything, the server is connected
    updateMCPServerStatus(mcpServerName, MCPServerStatus.CONNECTED);
    // A successful connect proves authentication works now — clear the sticky
    // 401 marker so later unrelated outages aren't mislabeled as auth failures.
    mcpServerRequiresOAuth.delete(mcpServerName);

    // Register any discovered tools
    for (const tool of tools) {
      toolRegistry.registerTool(tool);
    }
  } catch (error) {
    if (mcpClient) {
      mcpClient.close();
    }
    debugLogger.error(
      `Error connecting to MCP server '${mcpServerName}': ${getErrorMessage(
        error,
      )}`,
    );
    updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
  }
}

/**
 * Discovers and sanitizes tools from a connected MCP client.
 * It retrieves function declarations from the client, filters out disabled tools,
 * generates valid names for them, and wraps them in `DiscoveredMCPTool` instances.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpServerConfig The configuration for the MCP server.
 * @param mcpClient The active MCP client instance.
 * @returns A promise that resolves to an array of discovered and enabled tools.
 * @throws An error if no enabled tools are found or if the server provides invalid function declarations.
 */
export async function discoverTools(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  mcpClient: Client,
  cliConfig: Config,
  opts?: { applyConfigFilters?: boolean },
): Promise<DiscoveredMCPTool[]> {
  try {
    const mcpCallableTool = mcpToTool(mcpClient, {
      timeout: mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
    });
    const tool = await mcpCallableTool.tool();

    if (!Array.isArray(tool.functionDeclarations)) {
      // This is a valid case for a prompt-only server
      return [];
    }

    // Fetch raw tool list from MCP client to get annotations (readOnlyHint, etc.)
    // that are not preserved by mcpToTool's functionDeclarations conversion.
    const annotationsMap = new Map<string, McpToolAnnotations>();
    try {
      const listToolsResult = await mcpClient.listTools();
      for (const mcpTool of listToolsResult.tools) {
        if (mcpTool.annotations) {
          annotationsMap.set(mcpTool.name, mcpTool.annotations);
        }
      }
    } catch {
      // If listTools fails, proceed without annotations — non-critical
      debugLogger.error(
        `Failed to fetch tool annotations from MCP server '${mcpServerName}'`,
      );
    }

    const mcpTimeout = mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC;
    const applyConfigFilters = opts?.applyConfigFilters ?? true;
    const discoveredTools: DiscoveredMCPTool[] = [];
    for (const funcDecl of tool.functionDeclarations) {
      try {
        if (!funcDecl.name) {
          // emit the
          // malformed-funcDecl warning inline rather than calling
          // `isEnabled` solely for its side effect. Pre-fix
          // `isEnabled(funcDecl, ...)` was invoked just to trigger
          // the warn log inside it (return value ignored), which
          // misuses isEnabled as a logging helper. The warning text
          // is the same as the one in isEnabled (line 1618-1620);
          // keeping it here keeps the call site readable and lets
          // isEnabled stay a pure predicate.
          debugLogger.warn(
            `Discovered a function declaration without a name from MCP server '${mcpServerName}'. Skipping.`,
          );
          continue;
        }

        if (
          applyConfigFilters &&
          !isEnabled(funcDecl, mcpServerName, mcpServerConfig)
        ) {
          continue;
        }

        discoveredTools.push(
          new DiscoveredMCPTool(
            mcpCallableTool,
            mcpServerName,
            funcDecl.name!,
            funcDecl.description ?? '',
            funcDecl.parametersJsonSchema ?? { type: 'object', properties: {} },
            applyConfigFilters ? mcpServerConfig.trust : undefined,
            undefined,
            cliConfig,
            mcpClient, // raw MCP Client for direct callTool with progress
            mcpTimeout,
            annotationsMap.get(funcDecl.name!),
          ),
        );
      } catch (error) {
        debugLogger.error(
          `Error discovering tool: '${
            funcDecl.name
          }' from MCP server '${mcpServerName}': ${(error as Error).message}`,
        );
      }
    }
    return discoveredTools;
  } catch (error) {
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error discovering tools from ${mcpServerName}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    return [];
  }
}

/**
 * True when an MCP request failed because the method is not implemented.
 * JSON-RPC guarantees the numeric code (`-32601`), so that is the primary,
 * precise check. The message fallback (for transports that drop the code)
 * keeps the original case-sensitive exact substring `'Method not found'` —
 * deliberately NOT a broad `/method not found/i`, which would also swallow
 * unrelated errors like "Error in method not found handler: ...".
 */
function isMethodNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32601) return true;
  return error instanceof Error && error.message.includes('Method not found');
}

/**
 * Pure prompt listing. Asks the MCP server for its prompts and returns
 * enriched `DiscoveredMCPPrompt[]` (with `serverName` + bound `invoke`)
 * WITHOUT registering them anywhere. pool uses this so a single
 * shared transport can produce the snapshot once and let each session's
 * `SessionMcpView` register into its own registry.
 *
 * Returns `[]` on protocol errors or when the server has no prompts —
 * matches `discoverPrompts` swallow-and-continue behavior.
 *
 * We deliberately do NOT gate on `getServerCapabilities()?.prompts`. A
 * non-trivial number of real MCP servers implement `prompts/list` but
 * under-declare (or omit) the `prompts` capability in their `initialize`
 * response; gating on the declared capability made those servers' prompts
 * silently invisible in qwen-code (no `/`-menu entry) while lenient
 * clients still surfaced them. The underlying `mcpClient.request` is the
 * raw `Protocol.request` (the SDK only asserts capabilities for its typed
 * `listPrompts()` helper, which we don't use), so attempting the call is
 * safe: a server that truly lacks prompts answers `-32601 Method not
 * found`, which the catch below swallows silently.
 */
export async function listMcpPrompts(
  mcpServerName: string,
  mcpClient: Client,
): Promise<DiscoveredMCPPrompt[]> {
  try {
    const response = await mcpClient.request(
      { method: 'prompts/list', params: {} },
      ListPromptsResultSchema,
    );

    return response.prompts.map((prompt) => ({
      ...prompt,
      serverName: mcpServerName,
      invoke: (params: Record<string, unknown>) =>
        invokeMcpPrompt(mcpServerName, mcpClient, prompt.name, params),
    }));
  } catch (error) {
    // It's okay if this fails, not all servers will have prompts.
    // Don't log an error if the method is not found, which is a common case.
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error discovering prompts from ${mcpServerName}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    return [];
  }
}

/**
 * Discovers prompts AND registers them into the supplied PromptRegistry.
 * Thin wrapper over `listMcpPrompts` that preserves the historical
 * `Promise<Prompt[]>` signature (used by `connectAndDiscover`, standalone
 * qwen, and existing tests). New code should prefer `listMcpPrompts`
 * for testability.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpClient The active MCP client instance.
 * @param promptRegistry The registry to register discovered prompts into.
 */
export async function discoverPrompts(
  mcpServerName: string,
  mcpClient: Client,
  promptRegistry: PromptRegistry,
): Promise<Prompt[]> {
  const enriched = await listMcpPrompts(mcpServerName, mcpClient);
  for (const prompt of enriched) {
    promptRegistry.registerPrompt(prompt);
  }
  // Preserve historical return type: raw Prompt (without serverName/invoke).
  // Callers only ever inspected `length`, but the type contract is preserved.
  return enriched.map(({ serverName: _s, invoke: _i, ...rest }) => rest);
}

/**
 * Invokes a prompt on a connected MCP client.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpClient The active MCP client instance.
 * @param promptName The name of the prompt to invoke.
 * @param promptParams The parameters to pass to the prompt.
 * @returns A promise that resolves to the result of the prompt invocation.
 */
export async function invokeMcpPrompt(
  mcpServerName: string,
  mcpClient: Client,
  promptName: string,
  promptParams: Record<string, unknown>,
): Promise<GetPromptResult> {
  try {
    const response = await mcpClient.request(
      {
        method: 'prompts/get',
        params: {
          name: promptName,
          arguments: promptParams,
        },
      },
      GetPromptResultSchema,
    );

    return response;
  } catch (error) {
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error invoking prompt '${promptName}' from ${mcpServerName} ${promptParams}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    throw error;
  }
}

/**
 * Lists resources advertised by an MCP server (`resources/list`) WITHOUT
 * registering them anywhere — the pool uses this so a single shared
 * transport can produce the snapshot once and let each session register
 * into its own registry. Mirrors `listMcpPrompts`.
 *
 * As with prompts, we do NOT gate on `getServerCapabilities()?.resources`:
 * some servers expose resources but under-declare the capability, and the
 * raw `mcpClient.request` does not assert capabilities. A server with no
 * resources answers `-32601 Method not found`, swallowed below.
 *
 * Note: cursor pagination is not followed (matching `listMcpPrompts`);
 * only the first page of resources is returned. Servers that paginate
 * their resource list would have later pages omitted — acceptable parity
 * with the prompt path and rare in practice.
 */
export async function listMcpResources(
  mcpServerName: string,
  mcpClient: Client,
): Promise<DiscoveredMCPResource[]> {
  try {
    const response = await mcpClient.request(
      { method: 'resources/list', params: {} },
      ListResourcesResultSchema,
    );

    return response.resources.map((resource) => ({
      ...resource,
      serverName: mcpServerName,
    }));
  } catch (error) {
    // It's okay if this fails; not all servers expose resources. Don't log
    // when the method is simply absent (the common case for tool-only
    // servers).
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error discovering resources from ${mcpServerName}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    return [];
  }
}

/**
 * Discovers resources AND registers them into the supplied
 * `ResourceRegistry`. Thin wrapper over `listMcpResources`, mirroring
 * `discoverPrompts`.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpClient The active MCP client instance.
 * @param resourceRegistry The registry to register discovered resources into.
 */
export async function discoverResources(
  mcpServerName: string,
  mcpClient: Client,
  resourceRegistry: ResourceRegistry,
): Promise<DiscoveredMCPResource[]> {
  const resources = await listMcpResources(mcpServerName, mcpClient);
  for (const resource of resources) {
    resourceRegistry.registerResource(resource);
  }
  return resources;
}

/**
 * @visiblefortesting
 * Checks if the MCP server configuration has a network transport URL (SSE or HTTP).
 * @param config The MCP server configuration.
 * @returns True if a `url` or `httpUrl` is present, false otherwise.
 */
export function hasNetworkTransport(config: MCPServerConfig): boolean {
  return !!(config.url || config.httpUrl);
}

/**
 * Creates and connects an MCP client to a server based on the provided configuration.
 * It determines the appropriate transport (Stdio, SSE, or Streamable HTTP) and
 * establishes a connection. It also applies a patch to handle request timeouts.
 *
 * @param mcpServerName The name of the MCP server, used for logging and identification.
 * @param mcpServerConfig The configuration specifying how to connect to the server.
 * @param sendSdkMcpMessage Optional callback for SDK MCP servers to route messages via control plane.
 * @returns A promise that resolves to a connected MCP `Client` instance.
 * @throws An error if the connection fails or the configuration is invalid.
 */
export async function connectToMcpServer(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  debugMode: boolean,
  workspaceContext: WorkspaceContext,
  sendSdkMcpMessage?: SendSdkMcpMessage,
): Promise<Client> {
  const mcpClient = new Client({
    name: 'qwen-code-mcp-client',
    version: '0.0.1',
  });

  mcpClient.registerCapabilities({
    roots: {
      listChanged: true,
    },
  });

  mcpClient.setRequestHandler(ListRootsRequestSchema, async () => {
    const roots = [];
    for (const dir of workspaceContext.getDirectories()) {
      roots.push({
        uri: pathToFileURL(dir).toString(),
        name: basename(dir),
      });
    }
    return {
      roots,
    };
  });

  let unlistenDirectories: Unsubscribe | undefined =
    workspaceContext.onDirectoriesChanged(async () => {
      try {
        await mcpClient.notification({
          method: 'notifications/roots/list_changed',
        });
      } catch (_) {
        // If this fails, its almost certainly because the connection was closed
        // and we should just stop listening for future directory changes.
        unlistenDirectories?.();
        unlistenDirectories = undefined;
      }
    });

  // Attempt to pro-actively unsubscribe if the mcp client closes. This API is
  // very brittle though so we don't have any guarantees, hence the try/catch
  // above as well.
  //
  // Be a good steward and don't just bash over onclose.
  const oldOnClose = mcpClient.onclose;
  mcpClient.onclose = () => {
    oldOnClose?.();
    unlistenDirectories?.();
    unlistenDirectories = undefined;
  };

  // Snapshot credentials before createTransport. Its internal getValidToken
  // call may refresh or purge stored tokens, so the later 401 handler needs
  // this pre-check to distinguish "had credentials, now unusable" from
  // "never had OAuth configuration."
  let hadStoredSseOAuthCredentials = false;

  if (
    mcpServerConfig.url &&
    !mcpServerConfig.httpUrl &&
    !mcpServerConfig.oauth?.enabled
  ) {
    const tokenStorage = new MCPOAuthTokenStorage();
    try {
      hadStoredSseOAuthCredentials = Boolean(
        await tokenStorage.getCredentials(mcpServerName),
      );
    } catch (error) {
      debugLogger.warn(
        `Failed to pre-read stored OAuth credentials for SSE server '${mcpServerName}': ${getErrorMessage(error)}`,
      );
    }
  }

  try {
    const transport = await createTransport(
      mcpServerName,
      mcpServerConfig,
      debugMode,
      sendSdkMcpMessage,
    );
    try {
      await mcpClient.connect(transport, {
        timeout: mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
      });
      return mcpClient;
    } catch (error) {
      unlistenDirectories?.();
      unlistenDirectories = undefined;
      await transport.close();
      throw error;
    }
  } catch (error) {
    unlistenDirectories?.();
    unlistenDirectories = undefined;
    // Check if this is a 401 error that might indicate OAuth is required
    const errorString = String(error);
    if (errorString.includes('401') && hasNetworkTransport(mcpServerConfig)) {
      mcpServerRequiresOAuth.set(mcpServerName, true);
      // Only trigger automatic OAuth discovery for HTTP servers or when OAuth is explicitly configured
      // For SSE servers, we should not trigger new OAuth flows automatically
      const shouldTriggerOAuth =
        mcpServerConfig.httpUrl || mcpServerConfig.oauth?.enabled;

      if (!shouldTriggerOAuth) {
        // For SSE servers without explicit OAuth config, report whether
        // the 401 came after trying stored credentials or without any OAuth setup.
        const tokenStorage = new MCPOAuthTokenStorage();
        let credentials: OAuthCredentials | null = null;
        try {
          credentials = await tokenStorage.getCredentials(mcpServerName);
        } catch (credentialError) {
          debugLogger.error(
            `Failed to re-read stored OAuth credentials for SSE server '${mcpServerName}' after 401: ${getErrorMessage(credentialError)}`,
          );
        }
        let tokenState: SseOAuth401TokenState =
          credentials || hadStoredSseOAuthCredentials ? 'unusable' : 'missing';
        if (credentials) {
          const authProvider = new MCPOAuthProvider(tokenStorage);
          try {
            tokenState = (await authProvider.getValidToken(mcpServerName, {
              // Pass client ID if available
              clientId: credentials.clientId,
            }))
              ? 'accepted-token-rejected'
              : 'unusable';
          } catch (tokenError) {
            debugLogger.error(
              `Failed to validate stored OAuth token for SSE server '${mcpServerName}': ${getErrorMessage(tokenError)}`,
            );
            tokenState = 'unusable';
          }
        }
        const oauthMessage = getSseOAuth401Message(mcpServerName, tokenState);
        debugLogger.warn(oauthMessage);
        throw new Error(oauthMessage);
      }

      // Try to extract www-authenticate header from the error
      let wwwAuthenticate = extractWWWAuthenticateHeader(errorString);

      // If we didn't get the header from the error string, try to get it from the server
      if (!wwwAuthenticate && hasNetworkTransport(mcpServerConfig)) {
        debugLogger.debug(
          `No www-authenticate header in error, trying to fetch it from server...`,
        );
        try {
          const urlToFetch = mcpServerConfig.httpUrl || mcpServerConfig.url!;
          const response = await fetch(urlToFetch, {
            method: 'HEAD',
            headers: {
              Accept: mcpServerConfig.httpUrl
                ? 'application/json'
                : 'text/event-stream',
            },
            signal: AbortSignal.timeout(5000),
          });

          if (response.status === 401) {
            wwwAuthenticate = response.headers.get('www-authenticate');
            if (wwwAuthenticate) {
              debugLogger.debug(
                `Found www-authenticate header from server: ${wwwAuthenticate}`,
              );
            }
          }
        } catch (fetchError) {
          debugLogger.debug(
            `Failed to fetch www-authenticate header: ${getErrorMessage(
              fetchError,
            )}`,
          );
        }
      }

      if (wwwAuthenticate) {
        debugLogger.debug(
          `Received 401 with www-authenticate header: ${wwwAuthenticate}`,
        );

        // Try automatic OAuth discovery and authentication
        const oauthSuccess = await handleAutomaticOAuth(
          mcpServerName,
          mcpServerConfig,
          wwwAuthenticate,
        );
        if (oauthSuccess) {
          // Retry connection with OAuth token
          debugLogger.info(
            `Retrying connection to '${mcpServerName}' with OAuth token...`,
          );

          // Get the valid token - we need to create a proper OAuth config
          // The token should already be available from the authentication process
          const tokenStorage = new MCPOAuthTokenStorage();
          const credentials = await tokenStorage.getCredentials(mcpServerName);
          if (credentials) {
            const authProvider = new MCPOAuthProvider(tokenStorage);
            const accessToken = await authProvider.getValidToken(
              mcpServerName,
              {
                // Pass client ID if available
                clientId: credentials.clientId,
              },
            );

            if (accessToken) {
              // Create transport with OAuth token
              const oauthTransport = await createTransportWithOAuth(
                mcpServerName,
                mcpServerConfig,
                accessToken,
              );
              if (oauthTransport) {
                try {
                  await mcpClient.connect(oauthTransport, {
                    timeout:
                      mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
                  });
                  // Connection successful with OAuth
                  return mcpClient;
                } catch (retryError) {
                  debugLogger.error(
                    `Failed to connect with OAuth token: ${getErrorMessage(
                      retryError,
                    )}`,
                  );
                  throw retryError;
                }
              } else {
                debugLogger.error(
                  `Failed to create OAuth transport for server '${mcpServerName}'`,
                );
                throw new Error(
                  `Failed to create OAuth transport for server '${mcpServerName}'`,
                );
              }
            } else {
              debugLogger.error(
                `Failed to get OAuth token for server '${mcpServerName}'`,
              );
              throw new Error(
                `Failed to get OAuth token for server '${mcpServerName}'`,
              );
            }
          } else {
            debugLogger.error(
              `Failed to get credentials for server '${mcpServerName}' after successful OAuth authentication`,
            );
            throw new Error(
              `Failed to get credentials for server '${mcpServerName}' after successful OAuth authentication`,
            );
          }
        } else {
          const oauthMessage =
            `Failed to handle automatic OAuth for server '${mcpServerName}'. ` +
            getMcpOAuthDialogInstruction('authenticate', mcpServerName);
          debugLogger.error(oauthMessage);
          throw new Error(oauthMessage);
        }
      } else {
        // No www-authenticate header found, but we got a 401
        // For HTTP servers and explicitly configured OAuth, try to discover
        // OAuth configuration from the base URL. SSE servers without explicit
        // OAuth are handled above before this branch.
        debugLogger.info(
          `Attempting OAuth discovery for '${mcpServerName}'...`,
        );

        if (hasNetworkTransport(mcpServerConfig)) {
          const serverUrl = new URL(
            mcpServerConfig.httpUrl || mcpServerConfig.url!,
          );
          const baseUrl = `${serverUrl.protocol}//${serverUrl.host}`;

          let oauthConfig: Awaited<
            ReturnType<typeof OAuthUtils.discoverOAuthConfig>
          >;
          try {
            // Try to discover OAuth configuration from the base URL
            oauthConfig = await OAuthUtils.discoverOAuthConfig(baseUrl);
          } catch (discoveryError) {
            const oauthMessage =
              `OAuth discovery failed for server '${mcpServerName}'. ` +
              getMcpOAuthDialogInstruction('authenticate', mcpServerName) +
              ` Original error: ${getErrorMessage(discoveryError)}`;
            debugLogger.error(oauthMessage);
            throw new Error(oauthMessage, { cause: discoveryError });
          }

          if (oauthConfig) {
            debugLogger.info(
              `Discovered OAuth configuration from base URL for server '${mcpServerName}'`,
            );

            // Create OAuth configuration for authentication
            const oauthAuthConfig = {
              enabled: true,
              authorizationUrl: oauthConfig.authorizationUrl,
              tokenUrl: oauthConfig.tokenUrl,
              scopes: oauthConfig.scopes || [],
            };

            // Perform OAuth authentication
            // Pass the server URL for proper discovery
            const authServerUrl =
              mcpServerConfig.httpUrl || mcpServerConfig.url;
            debugLogger.info(
              `Starting OAuth authentication for server '${mcpServerName}'...`,
            );
            const authProvider = new MCPOAuthProvider(
              new MCPOAuthTokenStorage(),
            );
            await authProvider.authenticate(
              mcpServerName,
              oauthAuthConfig,
              authServerUrl,
            );

            // Retry connection with OAuth token
            const tokenStorage = new MCPOAuthTokenStorage();
            const credentials =
              await tokenStorage.getCredentials(mcpServerName);
            if (credentials) {
              const authProvider = new MCPOAuthProvider(tokenStorage);
              const accessToken = await authProvider.getValidToken(
                mcpServerName,
                {
                  // Pass client ID if available
                  clientId: credentials.clientId,
                },
              );
              if (accessToken) {
                // Create transport with OAuth token
                const oauthTransport = await createTransportWithOAuth(
                  mcpServerName,
                  mcpServerConfig,
                  accessToken,
                );
                if (oauthTransport) {
                  try {
                    await mcpClient.connect(oauthTransport, {
                      timeout:
                        mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
                    });
                    // Connection successful with OAuth
                    return mcpClient;
                  } catch (retryError) {
                    debugLogger.error(
                      `Failed to connect with OAuth token: ${getErrorMessage(
                        retryError,
                      )}`,
                    );
                    throw retryError;
                  }
                } else {
                  debugLogger.error(
                    `Failed to create OAuth transport for server '${mcpServerName}'`,
                  );
                  throw new Error(
                    `Failed to create OAuth transport for server '${mcpServerName}'`,
                  );
                }
              } else {
                debugLogger.error(
                  `Failed to get OAuth token for server '${mcpServerName}'`,
                );
                throw new Error(
                  `Failed to get OAuth token for server '${mcpServerName}'`,
                );
              }
            } else {
              debugLogger.error(
                `Failed to get stored credentials for server '${mcpServerName}'`,
              );
              throw new Error(
                `Failed to get stored credentials for server '${mcpServerName}'`,
              );
            }
          } else {
            debugLogger.error(
              `Could not configure OAuth for server '${mcpServerName}'. ` +
                getMcpOAuthDialogInstruction('authenticate', mcpServerName),
            );
            throw new Error(
              `OAuth configuration failed for server '${mcpServerName}'. ` +
                getMcpOAuthDialogInstruction('authenticate', mcpServerName),
            );
          }
        } else {
          debugLogger.error(
            `'${mcpServerName}' requires authentication but no OAuth configuration found`,
          );
          throw new Error(
            `MCP server '${mcpServerName}' requires authentication. ` +
              getMcpOAuthDialogInstruction('authenticate', mcpServerName),
          );
        }
      }
    } else {
      // Handle other connection errors
      // Create a concise error message
      const errorMessage = (error as Error).message || String(error);
      const isNetworkError =
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('ECONNREFUSED');

      let conciseError: string;
      if (isNetworkError) {
        conciseError = `Cannot connect to '${mcpServerName}' - server may be down or URL incorrect`;
      } else {
        conciseError = `Connection failed for '${mcpServerName}': ${errorMessage}`;
      }

      if (process.env['SANDBOX']) {
        conciseError += ` (check sandbox availability)`;
      }

      throw new Error(conciseError);
    }
  }
}

/** Visible for Testing */
export async function createTransport(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  debugMode: boolean,
  sendSdkMcpMessage?: SendSdkMcpMessage,
): Promise<Transport> {
  if (isSdkMcpServerConfig(mcpServerConfig)) {
    if (!sendSdkMcpMessage) {
      throw new Error(
        `SDK MCP server '${mcpServerName}' requires sendSdkMcpMessage callback`,
      );
    }
    return new SdkControlClientTransport({
      serverName: mcpServerName,
      sendMcpMessage: sendSdkMcpMessage,
      debugMode,
    });
  }

  if (
    mcpServerConfig.authProviderType ===
    AuthProviderType.SERVICE_ACCOUNT_IMPERSONATION
  ) {
    const provider = new ServiceAccountImpersonationProvider(mcpServerConfig);
    const transportOptions:
      | StreamableHTTPClientTransportOptions
      | SSEClientTransportOptions = {
      authProvider: provider,
    };

    if (mcpServerConfig.httpUrl) {
      (transportOptions as StreamableHTTPClientTransportOptions).fetch =
        createStreamableHttpCompatibilityFetch(mcpServerName);
      return new StreamableHTTPClientTransport(
        new URL(mcpServerConfig.httpUrl),
        transportOptions,
      );
    } else if (mcpServerConfig.url) {
      // Default to SSE if only url is provided
      return new SSEClientTransport(
        new URL(mcpServerConfig.url),
        transportOptions,
      );
    }
    throw new Error(
      'No URL configured for ServiceAccountImpersonation MCP Server',
    );
  }

  if (
    mcpServerConfig.authProviderType === AuthProviderType.GOOGLE_CREDENTIALS
  ) {
    const provider = new GoogleCredentialProvider(mcpServerConfig);
    const transportOptions:
      | StreamableHTTPClientTransportOptions
      | SSEClientTransportOptions = {
      authProvider: provider,
    };
    if (mcpServerConfig.httpUrl) {
      (transportOptions as StreamableHTTPClientTransportOptions).fetch =
        createStreamableHttpCompatibilityFetch(mcpServerName);
      return new StreamableHTTPClientTransport(
        new URL(mcpServerConfig.httpUrl),
        transportOptions,
      );
    } else if (mcpServerConfig.url) {
      return new SSEClientTransport(
        new URL(mcpServerConfig.url),
        transportOptions,
      );
    }
    throw new Error('No URL configured for Google Credentials MCP server');
  }

  // Check if we have OAuth configuration or stored tokens
  let accessToken: string | null = null;
  let hasOAuthConfig = mcpServerConfig.oauth?.enabled;

  if (hasOAuthConfig && mcpServerConfig.oauth) {
    const tokenStorage = new MCPOAuthTokenStorage();
    const authProvider = new MCPOAuthProvider(tokenStorage);
    accessToken = await authProvider.getValidToken(
      mcpServerName,
      mcpServerConfig.oauth,
    );

    if (!accessToken) {
      debugLogger.error(
        `The MCP server '${mcpServerName}' requires OAuth authentication. ` +
          getMcpOAuthDialogInstruction('authenticate', mcpServerName),
      );
      throw new Error(
        `The MCP server '${mcpServerName}' requires OAuth authentication. ` +
          getMcpOAuthDialogInstruction('authenticate', mcpServerName),
      );
    }
  } else {
    // Check if we have stored OAuth tokens for this server (from previous authentication)
    const tokenStorage = new MCPOAuthTokenStorage();
    const credentials = await tokenStorage.getCredentials(mcpServerName);
    if (credentials) {
      const authProvider = new MCPOAuthProvider(tokenStorage);
      accessToken = await authProvider.getValidToken(mcpServerName, {
        // Pass client ID if available
        clientId: credentials.clientId,
      });

      if (accessToken) {
        hasOAuthConfig = true;
        debugLogger.debug(
          `Found stored OAuth token for server '${mcpServerName}'`,
        );
      } else {
        debugLogger.warn(
          `Stored OAuth credentials exist for server '${mcpServerName}' but no valid token could be obtained. Transport will be created without authentication; expect a 401.`,
        );
      }
    }
  }

  if (mcpServerConfig.httpUrl) {
    const transportOptions: StreamableHTTPClientTransportOptions = {
      fetch: createStreamableHttpCompatibilityFetch(mcpServerName),
    };

    // Set up headers with OAuth token if available
    if (hasOAuthConfig && accessToken) {
      transportOptions.requestInit = {
        headers: {
          ...mcpServerConfig.headers,
          Authorization: `Bearer ${accessToken}`,
        },
      };
    } else if (mcpServerConfig.headers) {
      transportOptions.requestInit = {
        headers: mcpServerConfig.headers,
      };
    }

    return new StreamableHTTPClientTransport(
      new URL(mcpServerConfig.httpUrl),
      transportOptions,
    );
  }

  if (mcpServerConfig.url) {
    const transportOptions: SSEClientTransportOptions = {};

    // Set up headers with OAuth token if available
    if (hasOAuthConfig && accessToken) {
      transportOptions.requestInit = {
        headers: {
          ...mcpServerConfig.headers,
          Authorization: `Bearer ${accessToken}`,
        },
      };
    } else if (mcpServerConfig.headers) {
      transportOptions.requestInit = {
        headers: mcpServerConfig.headers,
      };
    }

    return new SSEClientTransport(
      new URL(mcpServerConfig.url),
      transportOptions,
    );
  }

  if (mcpServerConfig.command) {
    if (mcpServerConfig.cwd && !existsSync(mcpServerConfig.cwd)) {
      throw new Error(
        `MCP server '${mcpServerName}': configured cwd does not exist: ${mcpServerConfig.cwd}`,
      );
    }

    // Normalize process.env PATH first (merge PATH+Path → single PATH on
    // Windows), then apply server-specific overrides on top so that a server
    // config providing its own PATH fully replaces the parent value instead of
    // being merged with a stale case-variant.
    const env = {
      ...normalizePathEnvForWindows({ ...process.env }),
      ...(mcpServerConfig.env || {}),
    };

    const transport = new StdioClientTransport({
      command: mcpServerConfig.command,
      args: mcpServerConfig.args || [],
      env: env as Record<string, string>,
      cwd: mcpServerConfig.cwd,
      stderr: 'pipe',
    });
    if (debugMode) {
      transport.stderr!.on('data', (data) => {
        const stderrStr = data.toString().trim();
        debugLogger.debug(`MCP STDERR (${mcpServerName}):`, stderrStr);
      });
    }
    return transport;
  }

  throw new Error(
    `Invalid configuration: missing httpUrl (for Streamable HTTP), url (for SSE), and command (for stdio).`,
  );
}

/** Visible for testing */
export function isEnabled(
  funcDecl: FunctionDeclaration,
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
): boolean {
  if (!funcDecl.name) {
    debugLogger.warn(
      `Discovered a function declaration without a name from MCP server '${mcpServerName}'. Skipping.`,
    );
    return false;
  }
  const { includeTools, excludeTools } = mcpServerConfig;

  // excludeTools takes precedence over includeTools
  if (excludeTools && excludeTools.includes(funcDecl.name)) {
    return false;
  }

  return (
    !includeTools ||
    includeTools.some(
      (tool) => tool === funcDecl.name || tool.startsWith(`${funcDecl.name}(`),
    )
  );
}
