/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// How a connection to one kind of MCP server is established.
//
// The runtime resolves a config to a {@link McpTransportType} and looks the
// connector up in a map, so one slot can be replaced without the dispatch code
// changing: the runtime never learns what the substitute does differently.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import type { McpTransportType } from './transportType.js';
import type { McpClientContext } from '../mcpClientContext.js';
import type { McpProgressReporter } from '../client/progress.js';
import type {
  McpAuthenticationFailure,
  McpTransportConnector,
} from './httpAuthentication.js';

export interface McpConnectRequest {
  /** Server name as the runtime knows it, used for diagnostics. */
  readonly serverName: string;
  readonly config: MCPServerConfig;
}

export interface McpConnectorContext {
  readonly debugMode: boolean;
  readonly cliConfig: McpClientContext;
}

export interface McpConnectOutcome {
  readonly transport: Transport;
}

export interface McpConnector {
  connect(
    request: McpConnectRequest,
    ctx: McpConnectorContext,
  ): Promise<McpConnectOutcome>;
  /**
   * Second phase after a handshake was rejected. Runs discovery/authentication
   * and retries through the supplied connect callback. Connectors whose
   * transport has no auth flow omit it.
   */
  authenticate?(
    request: McpConnectRequest,
    ctx: McpConnectorContext,
    failure: McpAuthenticationFailure,
    connectTransport: McpTransportConnector,
  ): Promise<void>;
  /**
   * Protocol extensions this connector wants advertised in the initialize
   * handshake. A connector override point for host-specific extensions, so the
   * client and pool carry no product knowledge.
   */
  clientExtensions?(request: McpConnectRequest): readonly string[];
  /**
   * Receives inbound `notifications/progress` for tool calls made over this
   * connector. Lets a host attach progress reporting without teaching the
   * session-agnostic client about it.
   */
  readonly progressReporter?: McpProgressReporter;
}

export type McpConnectorMap = ReadonlyMap<McpTransportType, McpConnector>;


/**
 * Everything a URL-based connector needs before it can build a transport.
 * Exported so a host connector can supply its own — that is the seam a managed
 * gateway uses to replace the endpoint and the authenticated fetch without the
 * runtime knowing either exists.
 */
export interface McpPreparedHttpConnection {
  /** Config whose `httpUrl`/`url` the transport is built from. */
  readonly config: import('../mcpServerConfig.js').MCPServerConfig;
  readonly transportOptions: McpUrlTransportOptions;
}

/** Options a URL-based transport is built from. */
export type McpUrlTransportOptions =
  | import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransportOptions
  | import('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransportOptions;

/**
 * Everything a URL-based connector needs before it can build a transport.
 * Exported so a host connector can supply its own — that is the seam a managed
 * gateway uses to replace the endpoint and the authenticated fetch without the
 * runtime knowing either exists.
 */
export interface McpPreparedHttpConnection {
  /** Config whose `httpUrl`/`url` the transport is built from. */
  readonly config: MCPServerConfig;
  readonly transportOptions: McpUrlTransportOptions;
}
