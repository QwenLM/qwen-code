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
import { pathToFileURL } from 'node:url';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { SchemaCompatibleMcpClient } from '../schema-compatible-client.js';
import type {
  jsonSchemaValidator,
  JsonSchemaType,
  JsonSchemaValidator,
} from '@modelcontextprotocol/sdk/validation/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListRootsRequestSchema,
  type ClientCapabilities,
} from '@modelcontextprotocol/sdk/types.js';
import { BRAND_MCP_CLIENT_NAME } from '../../config/brand.js';
import { BRAND_CLI_NAME } from '../../config/brand.js';
import { runLogger } from '../../utils/runLogger.js';
import { isAuthenticationError } from '../../utils/errors.js';
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
}

function createProtocolClient(clientVersion: string): Client {
  return new SchemaCompatibleMcpClient(
    {
      name: BRAND_MCP_CLIENT_NAME,
      title: BRAND_CLI_NAME,
      version: clientVersion,
    },
    {
      // Use a tolerant validator so bad output schemas don't block discovery.
      jsonSchemaValidator: new LenientJsonSchemaValidator(),
    },
  );
}

function buildClientCapabilities(
  supportsElicitation: boolean,
  clientExtensions: readonly string[],
): ClientCapabilities {
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
    ...(clientExtensions.length > 0
      ? {
          extensions: Object.fromEntries(
            clientExtensions.map((extension) => [extension, {}]),
          ),
        }
      : {}),
  };
}

function registerRootsHandler(client: Client, cliConfig: McpClientContext): void {
  client.setRequestHandler(ListRootsRequestSchema, async () => {
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

  constructor(
    private readonly client: Client,
    private readonly params: McpConnectionParams,
  ) {}

  async establish(): Promise<void> {
    try {
      await this.dial();
    } catch (initialError) {
      await this.recover(initialError);
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

  private async dial(): Promise<void> {
    const { transport } = await this.params.connector.connect(
      { serverName: this.serverName, config: this.config },
      { debugMode: this.params.debugMode, cliConfig: this.cliConfig },
    );
    await this.connectTransport(transport);
  }

  private async connectTransport(transport: Transport): Promise<void> {
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
      await Promise.race([
        this.client.connect(transport, {
          timeout: timeoutMs,
          ...(this.params.signal ? { signal: this.params.signal } : {}),
        }),
        deadline,
      ]);
    } catch (error) {
      // Closing the transport aborts the in-flight start() so a timed-out dial
      // does not leave an open SSE stream behind.
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
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
    return isAuthenticationError(error) && hasNetworkTransport(this.config);
  }

  /**
   * Legacy URL configs without an explicit type may be SSE servers that the
   * Streamable HTTP attempt cannot reach. Only an implicit `url` config is
   * retried, and only when the first attempt did not already ask for OAuth.
   */
  private async trySseFallback(
    initialError: unknown,
  ): Promise<'connected' | 'auth-required' | 'failed'> {
    if (!this.config.url || this.config.type || this.config.httpUrl) {
      return 'failed';
    }

    this.httpReturned404 = String(initialError).includes('404');
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

  private async authenticate(error: unknown): Promise<void> {
    const authenticate = this.params.connector.authenticate;
    if (!authenticate) throw error;
    await authenticate(
      { serverName: this.serverName, config: this.config },
      { debugMode: this.params.debugMode, cliConfig: this.cliConfig },
      { error, httpReturned404: this.httpReturned404 },
      (transport) => this.connectTransport(transport),
    );
  }
}

/**
 * Creates a protocol client, wires its session-agnostic handlers and connects it
 * through the owner-selected connector. Transport selection and authentication
 * live in {@link McpConnector}; this function only owns the MCP handshake.
 */
export async function connectToMcpServer(
  connection: McpConnectionParams,
): Promise<Client> {
  const mcpClient = createProtocolClient(connection.clientVersion);
  const request = {
    serverName: connection.serverName,
    config: connection.serverConfig,
  };
  mcpClient.registerCapabilities(
    buildClientCapabilities(
      connection.elicitationHandler !== undefined,
      connection.connector.clientExtensions?.(request) ?? [],
    ),
  );
  registerRootsHandler(mcpClient, connection.cliConfig);
  if (connection.elicitationHandler) {
    registerElicitationHandlers(
      mcpClient,
      connection.elicitationHandler,
      connection.connector.progressReporter,
    );
  }
  forwardRootChanges(mcpClient, connection.cliConfig);

  await new McpConnection(mcpClient, connection).establish();
  return mcpClient;
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
