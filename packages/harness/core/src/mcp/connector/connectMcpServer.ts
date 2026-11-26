/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Connection establishment: build the protocol client, advertise its
// capabilities, and drive the connector's connect and authenticate phases.
// Transport selection and credentials live in the connector; this file only
// owns the MCP handshake and its roots/elicitation wiring.

import { basename } from 'node:path';
import { raceWithAbortSignal } from '../../utils/abort-race.js';
import { pathToFileURL } from 'node:url';
import type {
  ClientCapabilities,
  ConnectOptions,
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
  Request,
  RequestMethod,
  RequestOptions,
  ResultTypeMap,
  StandardSchemaV1,
  Transport,
  VersionNegotiationOptions,
} from '@modelcontextprotocol/client';
import {
  Client,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
} from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import {
  normalizeMcpMarketplaceMetadata,
  type McpMarketplaceMetadata,
} from '@qwen-code/resource';
import { BRAND_MCP_CLIENT_NAME } from '../../config/brand.js';
import { BRAND_CLI_NAME } from '../../config/brand.js';
import { runLogger } from '../../utils/runLogger.js';
import { isAuthenticationError } from '../../utils/errors.js';
import { findAuthRequiredError } from '../authError.js';
import type { Unsubscribe } from '../../utils/workspaceContext.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { McpClientContext } from '../mcpClientContext.js';
import {
  registerElicitationHandlers,
  type McpElicitationHandler,
} from '../elicitation.js';
import { resolveMcpRequestTimeoutMs } from '../tools/mcp-timeouts.js';
import {
  createSSETransportWithAuth,
  getStoredOAuthToken,
} from './oauth/transport.js';
import { hasNetworkTransport } from './httpAuthentication.js';
import { createDefaultMcpConnectorMap } from './defaultConnectorMap.js';
import {
  hasRequestedProtocolVersion,
  pinnedLegacyProtocolVersion,
  pinsModernProtocolVersion,
  resolveProtocolNegotiation,
} from './protocolVersion.js';
import { resolveMcpTransportType } from './transportType.js';
import type { McpConnector, McpConnectorMap } from './types.js';

class LenientJsonSchemaValidator implements jsonSchemaValidator {
  private readonly ajvValidator = new AjvJsonSchemaValidator();

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    try {
      return this.ajvValidator.getValidator<T>(schema);
    } catch (error) {
      runLogger.warn(
        `Failed to compile MCP tool output schema (${
          (schema as Record<string, unknown>)?.['$id'] ?? '<no $id>'
        }): ${error instanceof Error ? error.message : String(error)}. ` +
          'Skipping output validation for this tool.',
      );
      return (input: unknown) => ({
        valid: true as const,
        data: input as T,
        errorMessage: undefined,
      });
    }
  }
}

export interface McpConnectionParams {
  readonly clientVersion: string;
  readonly serverName: string;
  readonly serverKeyId?: string;
  readonly serverConfig: MCPServerConfig;
  readonly debugMode: boolean;
  readonly cliConfig: McpClientContext;
  readonly connector: McpConnector;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * Whether this attempt may run an interactive OAuth flow. Prewarmed
   * user-level servers only probe the connection; a session registration
   * explicitly asks for authentication when the probe parked in AUTH_REQUIRED.
   */
  readonly allowAuthentication?: boolean;
  /**
   * Per-session elicitation wiring. Only session-owned servers (dynamic/agent/
   * SDK-injected) receive one; plugin and disk-configured servers omit it.
   */
  readonly elicitationHandler?: McpElicitationHandler;
  /**
   * Receives the transport as soon as it exists, before the MCP handshake.
   * Lets the owner close a connection attempt that is stopped while it waits
   * (e.g. a stdio child still negotiating OAuth).
   */
  readonly onTransport?: (transport: Transport) => void;
}

const CONNECT_TOTAL_BUDGET_MS = 60_000;

class MarketplaceMcpClient extends Client {
  private marketplaceMetadata?: McpMarketplaceMetadata;

  getMarketplaceMetadata(): McpMarketplaceMetadata | undefined {
    return this.marketplaceMetadata && { ...this.marketplaceMetadata };
  }

  override request<M extends RequestMethod>(
    request: { method: M; params?: Record<string, unknown> },
    options?: RequestOptions,
  ): Promise<ResultTypeMap[M]>;
  override request<T extends StandardSchemaV1>(
    request: Request,
    resultSchema: T,
    options?: RequestOptions,
  ): Promise<StandardSchemaV1.InferOutput<T>>;
  override async request(
    request: Request,
    resultSchemaOrOptions?: StandardSchemaV1 | RequestOptions,
    options?: RequestOptions,
  ): Promise<unknown> {
    const isInitialize =
      (request as { method?: string }).method === 'initialize';
    if (isInitialize) this.marketplaceMetadata = undefined;
    const pending = (
      super.request as (
        request: Request,
        resultSchemaOrOptions?: StandardSchemaV1 | RequestOptions,
        options?: RequestOptions,
      ) => Promise<unknown>
    )(request, resultSchemaOrOptions, options);
    if (!isInitialize) return pending;
    return pending.then((result) => {
      this.marketplaceMetadata = normalizeMcpMarketplaceMetadata(
        (result as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
          'com.qoder/marketplace'
        ],
      );
      return result;
    });
  }
}

/** Visible for testing: the version-negotiation policy for one server config. */
export function protocolNegotiationOptions(
  config: MCPServerConfig,
): { mode: 'auto' | 'legacy'; probe?: { timeoutMs: number } } | undefined {
  // Decide from the connector that will actually be used: an SDK-hosted config
  // may carry a `command` it never spawns itself, and its bridge transport
  // looks like HTTP to the SDK's probe classifier, where a probe timeout is
  // fatal instead of falling back to the legacy handshake.
  const transportType = resolveMcpTransportType(config);
  if (transportType === 'sdk-hosted') return undefined;
  if (transportType === 'stdio' || transportType === 'xcode') {
    // No local probe budget: the SDK falls back to the connect timeout
    // (`MCP_TIMEOUT`, 30s by default), which also covers npx cold starts and
    // stays tunable instead of being pinned below the real startup cost.
    return { mode: 'auto' };
  }
  // SSE and WebSocket stay on the legacy handshake unless the server config
  // asks for a revision explicitly; an explicit revision still overrides this
  // default in resolveProtocolNegotiation.
  if (config.type === 'sse' || config.type === 'ws') return { mode: 'legacy' };
  if (transportType === 'http') return { mode: 'auto' };
  return undefined;
}

function createProtocolClient(connection: McpConnectionParams): MarketplaceMcpClient {
  const request = {
    serverName: connection.serverName,
    config: connection.serverConfig,
  };
  const negotiation = resolveProtocolNegotiation(
    connection.serverName,
    connection.serverConfig,
    protocolNegotiationOptions(connection.serverConfig),
  );
  const legacyProtocolVersion = pinnedLegacyProtocolVersion(
    connection.serverConfig,
  );
  runLogger.log(
    `[mcp] protocol negotiation server=${connection.serverName} requested=${connection.serverConfig.protocolVersion?.trim() || 'auto'} plan=${describeNegotiationPlan(negotiation)} legacyPin=${legacyProtocolVersion ?? 'none'}`,
  );
  return new MarketplaceMcpClient(
    {
      name: BRAND_MCP_CLIENT_NAME,
      title: BRAND_CLI_NAME,
      version: connection.clientVersion,
    },
    {
      // Use a tolerant validator so bad output schemas don't block discovery.
      jsonSchemaValidator: new LenientJsonSchemaValidator(),
      ...(negotiation ? { versionNegotiation: negotiation } : {}),
      ...(legacyProtocolVersion
        ? { supportedProtocolVersions: [legacyProtocolVersion] }
        : {}),
      capabilities: buildClientCapabilities(
        connection.elicitationHandler !== undefined,
        connection.connector.clientExtensions?.(request) ?? [],
        connection.cliConfig.getMcpClientCapabilities?.(),
      ),
    },
  );
}

function wireClientHandlers(
  client: Client,
  connection: McpConnectionParams,
): void {
  registerRootsHandler(client, connection.cliConfig);
  if (connection.elicitationHandler) {
    registerElicitationHandlers(
      client,
      connection.elicitationHandler,
      connection.connector.progressReporter,
    );
  }
  forwardRootChanges(client, connection.cliConfig);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildClientCapabilities(
  supportsElicitation: boolean,
  clientExtensions: readonly string[],
  hostCapabilities: Record<string, unknown> | undefined,
): ClientCapabilities {
  const hostExtensions: Record<string, Record<string, unknown>> = {};
  const declaredExtensions = hostCapabilities?.['extensions'];
  if (isPlainObject(declaredExtensions)) {
    for (const [key, value] of Object.entries(declaredExtensions)) {
      if (isPlainObject(value)) {
        hostExtensions[key] = value;
      }
    }
  }
  const extensions = {
    ...Object.fromEntries(clientExtensions.map((extension) => [extension, {}])),
    ...hostExtensions,
  } as NonNullable<ClientCapabilities['extensions']>;
  return {
    roots: {
      listChanged: true,
    },
    // Only session-owned servers may negotiate elicitation. Plugin and
    // disk-configured servers never advertise the capability.
    ...(supportsElicitation
      ? {
          // Empty object intentionally — declares the capability without
          // listing sub-modes. Sending `{form:{},url:{}}` breaks Java MCP SDK
          // servers (Spring AI) whose Elicitation class has zero fields and
          // fails on unknown properties.
          elicitation: {},
        }
      : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
}

function registerRootsHandler(client: Client, cliConfig: McpClientContext): void {
  client.setRequestHandler('roots/list', async () => {
    const roots = [];
    for (const dir of cliConfig.getRoots?.() ?? []) {
      roots.push({
        uri: pathToFileURL(dir).toString(),
        name: basename(dir),
      });
    }
    return { roots };
  });
}

/**
 * Forwards root changes to the server. The subscription is dropped when the
 * notification fails (the connection is gone) and when the client closes.
 */
function forwardRootChanges(client: Client, cliConfig: McpClientContext): void {
  let unsubscribe: Unsubscribe | undefined = cliConfig.onRootsChanged?.(() => {
    void client
      .notification({ method: 'notifications/roots/list_changed' })
      .catch(() => {
        unsubscribe?.();
        unsubscribe = undefined;
      });
  });
  if (!unsubscribe) return;

  // Be a good steward and don't just bash over onclose.
  const previousClose = client.onclose;
  client.onclose = () => {
    previousClose?.();
    unsubscribe?.();
    unsubscribe = undefined;
  };
}

/**
 * A connect attempt that never finished the transport handshake in time.
 *
 * The SDK's `connect` timeout only covers the `initialize` request; the legacy
 * SSE transport waits for the `endpoint` event inside `start()` with no bound
 * of its own, so a server that accepts the socket but never speaks SSE parks
 * the caller until the underlying fetch gives up minutes later.
 */
class McpConnectTimeoutError extends Error {
  readonly code = 'ERR_MCP_REQUEST_TIMEOUT';

  constructor(serverName: string, timeoutMs: number) {
    super(
      `MCP server '${serverName}' did not finish connecting within ${timeoutMs}ms. ` +
        'Check the configured transport and endpoint.',
    );
    this.name = 'McpConnectTimeoutError';
  }
}

/**
 * One connection attempt plus its transport fallbacks. Everything here is
 * connection-scoped: the caller supplies an already-created protocol client and
 * the connector its owner selected, so this class never chooses a transport.
 */
class McpConnection {
  private httpReturned404 = false;
  private sseError: Error | undefined;
  private client: Client;

  constructor(
    private readonly params: McpConnectionParams,
    private readonly createClient: () => Client,
  ) {
    this.client = createClient();
  }

  get connectedClient(): Client {
    return this.client;
  }

  async establish(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.dial();
    } catch (initialError) {
      this.params.signal?.throwIfAborted();
      const restart = await this.tryLegacyRestart(initialError, startedAt);
      if (restart.kind === 'connected') return;
      await this.recover(
        restart.kind === 'failed' ? restart.error : initialError,
      );
    }
  }

  private get serverName(): string {
    return this.params.serverName;
  }

  private get config(): MCPServerConfig {
    return this.params.serverConfig;
  }

  private get cliConfig(): McpClientContext {
    return this.params.cliConfig;
  }

  private async dial(prior?: ConnectOptions['prior']): Promise<void> {
    const signal = this.params.signal;
    signal?.throwIfAborted();
    const dialStartedAt = Date.now();
    runLogger.log(
      `[mcp] transport connect starting server=${this.serverName} connector=${resolveMcpTransportType(this.config) ?? 'none'} type=${this.config.type ?? 'auto'} endpoint=${describeEndpointForLog(this.config)}`,
    );
    const pending = this.params.connector
      .connect(
        { serverName: this.serverName, config: this.config },
        { debugMode: this.params.debugMode, cliConfig: this.cliConfig, signal },
      )
      .then(async (outcome) => {
        if (signal?.aborted) {
          await outcome.transport.close().catch(() => {});
          signal.throwIfAborted();
        }
        return outcome;
      });
    const { transport } = await raceWithAbortSignal(pending, signal);
    runLogger.log(
      `[mcp] transport ready server=${this.serverName} durationMs=${Date.now() - dialStartedAt}`,
    );
    this.params.onTransport?.(transport);
    await this.connectTransport(transport, prior);
  }

  private async connectTransport(
    transport: Transport,
    prior?: ConnectOptions['prior'],
  ): Promise<void> {
    const timeoutMs = this.params.timeoutMs ?? resolveMcpRequestTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bound the whole handshake, not just the initialize request: the SDK
    // passes `timeout` to `initialize` only, while `transport.start()` (the SSE
    // endpoint wait) can hang for minutes on a mismatched endpoint.
    const deadline = new Promise<never>((_, reject) => {
      if (!(timeoutMs > 0)) return;
      timer = setTimeout(
        () => reject(new McpConnectTimeoutError(this.serverName, timeoutMs)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      this.params.signal?.throwIfAborted();
      const handshakeStartedAt = Date.now();
      runLogger.log(
        `[mcp] handshake started server=${this.serverName} timeoutMs=${timeoutMs} legacyPrior=${prior ? 'yes' : 'no'}`,
      );
      await Promise.race([
        this.client.connect(transport, {
          timeout: timeoutMs,
          ...(this.params.signal ? { signal: this.params.signal } : {}),
          ...(prior ? { prior } : {}),
        }),
        deadline,
      ]);
      const serverInfo = this.client.getServerVersion();
      const capabilities = Object.keys(
        this.client.getServerCapabilities() ?? {},
      );
      runLogger.log(
        `[mcp] handshake completed server=${this.serverName} era=${this.client.getProtocolEra() ?? 'unknown'} serverName=${serverInfo?.name ?? 'unknown'} serverVersion=${serverInfo?.version ?? 'unknown'} capabilities=${capabilities.join(',') || 'none'} durationMs=${Date.now() - handshakeStartedAt}`,
      );
    } catch (error) {
      runLogger.warn(
        `[mcp] handshake failed server=${this.serverName} error=${describeErrorForLog(error)}`,
      );
      // Closing the transport aborts the in-flight start() so a timed-out dial
      // does not leave an open SSE stream behind.
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * App-level fallback for probe failures the SDK cannot recover from on its
   * own: HTTP 500 during `server/discover`, and a stdio probe whose sibling
   * process exits or times out. The failed Client and Transport are discarded
   * and a fresh pair is connected straight to the legacy `initialize`
   * handshake. Cancellation and cleanup failures never restart.
   */
  private async tryLegacyRestart(
    initialError: unknown,
    startedAt: number,
  ): Promise<
    | { kind: 'connected' }
    | { kind: 'not-attempted' }
    | { kind: 'failed'; error: unknown }
  > {
    // An explicitly configured revision must never be downgraded silently.
    if (hasRequestedProtocolVersion(this.config)) {
      return { kind: 'not-attempted' };
    }
    if (!shouldRestartWithLegacyHandshake(initialError, this.config)) {
      return { kind: 'not-attempted' };
    }
    if (this.params.signal?.aborted) {
      return { kind: 'not-attempted' };
    }
    const budget = Math.min(
      this.params.timeoutMs ?? CONNECT_TOTAL_BUDGET_MS,
      CONNECT_TOTAL_BUDGET_MS,
    );
    if (Date.now() - startedAt >= budget) {
      return { kind: 'not-attempted' };
    }
    try {
      await this.client.close();
    } catch (error) {
      runLogger.warn(
        `MCP server '${this.serverName}': failed to close the failed protocol probe: ${describeErrorForLog(error)}`,
      );
      return { kind: 'not-attempted' };
    }
    this.client = this.createClient();
    runLogger.log(
      `MCP server '${this.serverName}': protocol probe failed (${describeProbeFailure(initialError)}), retrying with the legacy initialize handshake.`,
    );
    try {
      await this.dial({ kind: 'legacy' });
      runLogger.log(
        `MCP server '${this.serverName}': connected using the legacy protocol handshake.`,
      );
      return { kind: 'connected' };
    } catch (error) {
      runLogger.warn(
        `MCP server '${this.serverName}': legacy handshake retry failed: ${describeErrorForLog(error)}`,
      );
      return { kind: 'failed', error };
    }
  }

  private async recover(initialError: unknown): Promise<void> {
    let error = initialError;
    if (!this.needsOAuth(initialError)) {
      const outcome = await this.trySseFallback(initialError);
      if (outcome === 'connected') return;
      if (outcome === 'failed' || !this.sseError) throw initialError;
      error = this.sseError;
    }
    if (!this.needsOAuth(error)) throw error;
    if (this.params.allowAuthentication === false) throw error;
    await this.authenticate(error);
  }

  private needsOAuth(error: unknown): boolean {
    return (
      findAuthRequiredError(error) !== undefined &&
      hasNetworkTransport(this.config)
    );
  }

  /**
   * Legacy URL configs without an explicit type may be SSE servers that the
   * Streamable HTTP attempt cannot reach. Only an implicit `url` config is
   * retried, and only for the transport-level statuses a legacy SSE endpoint
   * can produce.
   */
  private async trySseFallback(
    initialError: unknown,
  ): Promise<'connected' | 'auth-required' | 'failed'> {
    if (
      !this.isImplicitLegacyUrl() ||
      pinsModernProtocolVersion(this.config) ||
      !shouldFallbackToLegacySse(initialError)
    ) {
      return 'failed';
    }

    this.httpReturned404 = errorChain(initialError).some(
      (item) => item instanceof SdkHttpError && item.status === 404,
    );
    runLogger.log(
      `MCP server '${this.serverName}': ${
        this.httpReturned404
          ? 'HTTP returned 404, trying SSE transport...'
          : 'HTTP connection failed, attempting SSE fallback...'
      }`,
    );

    try {
      // Use a stored OAuth token when available so authenticated servers can
      // fall back too.
      await this.connectTransport(
        await createSSETransportWithAuth(
          this.serverName,
          this.config,
          await getStoredOAuthToken(this.serverName, this.config),
          this.cliConfig,
        ),
        { kind: 'legacy' },
      );
      runLogger.log(
        `MCP server '${this.serverName}': Successfully connected using SSE transport.`,
      );
      return 'connected';
    } catch (error) {
      this.sseError = error as Error;
      if (isAuthenticationError(error)) {
        runLogger.log(
          `MCP server '${this.serverName}': SSE returned 401, OAuth authentication required.`,
        );
        return 'auth-required';
      }
      runLogger.log(
        `MCP server '${this.serverName}': SSE fallback also failed.`,
      );
      return 'failed';
    }
  }

  private isImplicitLegacyUrl(): boolean {
    return Boolean(this.config.url) && !this.config.type && !this.config.httpUrl;
  }

  private async authenticate(error: unknown): Promise<void> {
    const authenticate = this.params.connector.authenticate;
    if (!authenticate) throw error;
    runLogger.log(
      `[mcp] authentication started server=${this.serverName} endpoint=${describeEndpointForLog(this.config)}`,
    );
    try {
      await authenticate(
        { serverName: this.serverName, config: this.config },
        { debugMode: this.params.debugMode, cliConfig: this.cliConfig },
        {
          error,
          httpReturned404: this.httpReturned404,
          serverKeyId: this.params.serverKeyId,
        },
        (transport) => this.connectTransport(transport),
      );
      runLogger.log(`[mcp] authentication completed server=${this.serverName}`);
    } catch (authError) {
      runLogger.warn(
        `[mcp] authentication failed server=${this.serverName} error=${describeErrorForLog(authError)}`,
      );
      throw authError;
    }
  }
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current =
      (current as { cause?: unknown }).cause ??
      (current as { data?: { cause?: unknown } }).data?.cause;
  }
  return chain;
}

const STDIO_PROBE_FAILURE_CODES = new Set<SdkErrorCode>([
  SdkErrorCode.RequestTimeout,
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.NotConnected,
  SdkErrorCode.SendFailed,
]);

function hasStdioProbeFailureEvidence(error: unknown): boolean {
  return errorChain(error).some(
    (item) =>
      item instanceof SdkError && STDIO_PROBE_FAILURE_CODES.has(item.code),
  );
}

function shouldRestartWithLegacyHandshake(
  error: unknown,
  config: MCPServerConfig,
): boolean {
  if (
    !(error instanceof SdkError) ||
    error.code !== SdkErrorCode.EraNegotiationFailed
  ) {
    return false;
  }
  if (config.command) return hasStdioProbeFailureEvidence(error);
  const isHttp = Boolean(config.url || config.httpUrl);
  return isHttp && error instanceof SdkHttpError && error.status === 500;
}

function shouldFallbackToLegacySse(error: unknown): boolean {
  const chain = errorChain(error);
  if (
    chain.some(
      (item) =>
        item instanceof SdkHttpError &&
        (item.status === 401 ||
          item.status === 403 ||
          item.status === 429 ||
          item.status >= 500),
    )
  ) {
    return false;
  }
  return chain.some(
    (item) =>
      (item instanceof SdkHttpError &&
        [404, 405, 406, 415].includes(item.status)) ||
      (item instanceof SdkError &&
        item.code === SdkErrorCode.ClientHttpUnexpectedContent),
  );
}

function describeProbeFailure(error: unknown): string {
  if (error instanceof SdkHttpError) return `HTTP ${error.status}`;
  if (error instanceof SdkError) {
    const cause = (error as { cause?: unknown }).cause;
    return cause instanceof Error
      ? `${error.code}: ${cause.message}`
      : error.code;
  }
  return describeErrorForLog(error);
}

function describeErrorForLog(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeNegotiationPlan(
  options: VersionNegotiationOptions | undefined,
): string {
  if (!options) return 'none';
  const mode = options.mode ?? 'legacy';
  return typeof mode === 'string' ? mode : `pin:${mode.pin}`;
}

/** Endpoint without query/fragment: they can carry credentials. */
function describeEndpointForLog(config: MCPServerConfig): string {
  const raw = config.httpUrl ?? config.url;
  if (raw !== undefined) {
    try {
      const url = new URL(raw);
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return '<invalid-url>';
    }
  }
  if (config.command) {
    return `command=${config.command} args=${config.args?.length ?? 0}`;
  }
  return 'none';
}

/**
 * Creates a protocol client, wires its session-agnostic handlers and connects it
 * through the owner-selected connector. Transport selection and authentication
 * live in {@link McpConnector}; this function only owns the MCP handshake.
 */
export async function connectToMcpServer(
  connection: McpConnectionParams,
): Promise<Client> {
  runLogger.log(
    `[mcp] connect requested server=${connection.serverName} connector=${resolveMcpTransportType(connection.serverConfig) ?? 'none'} type=${connection.serverConfig.type ?? 'auto'} endpoint=${describeEndpointForLog(connection.serverConfig)} protocolVersion=${connection.serverConfig.protocolVersion?.trim() || 'auto'} timeoutMs=${connection.timeoutMs ?? 'default'}`,
  );
  const state = new McpConnection(connection, () => {
    const client = createProtocolClient(connection);
    wireClientHandlers(client, connection);
    return client;
  });
  await state.establish();
  const client = state.connectedClient as MarketplaceMcpClient;
  const discoverMeta = (
    client.getDiscoverResult() as { _meta?: Record<string, unknown> } | undefined
  )?._meta;
  Object.defineProperty(connection.serverConfig, 'marketplaceMetadata', {
    value:
      client.getMarketplaceMetadata() ??
      normalizeMcpMarketplaceMetadata(discoverMeta?.['com.qoder/marketplace']),
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return client;
}

/**
 * Build the transport for one server by handing its config to the connector the
 * transport type resolves to.
 *
 * The connector map is the override point for how a class of server is reached:
 * swapping an entry changes every connection of that transport type. Defaults to
 * the standard set so callers with no opinion (the `mcp list` probe) do not have
 * to build one.
 *
 * Visible for Testing
 */
export async function createTransport(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  debugMode: boolean,
  cliConfig: McpClientContext,
  connectorMap: McpConnectorMap = createDefaultMcpConnectorMap(),
): Promise<Transport> {
  const transportType = resolveMcpTransportType(mcpServerConfig);
  if (!transportType) {
    throw new Error(
      `Invalid configuration: missing httpUrl (for Streamable HTTP), url (for SSE), and command (for stdio).`,
    );
  }
  const connector = connectorMap.get(transportType);
  if (!connector) {
    throw new Error(
      `MCP server '${mcpServerName}' needs a '${transportType}' connector, which the connector map does not provide`,
    );
  }
  const { transport } = await connector.connect(
    { serverName: mcpServerName, config: mcpServerConfig },
    { debugMode, cliConfig },
  );
  return transport;
}
