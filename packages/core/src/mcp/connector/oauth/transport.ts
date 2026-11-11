/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Building a transport that already carries an OAuth access token: the retry
// path after a 401, and the SSE variant of it.

import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/sse.js';
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from '../../mcpServerConfig.js';
import { MCPOAuthTokenStorage } from '../../oauth-token-storage.js';
import { getMcpErrorMessage } from '../../errors.js';
import type { McpClientContext } from '../../mcpClientContext.js';
import { getMcpHeadersFromHelper } from '../transport/headers-helper.js';
import {
  createMcpTransportFetch,
  createTransportRequestInit,
} from '../transport/support.js';
import { createUrlTransport } from '../transport/url.js';
import { MCPOAuthProvider } from './provider.js';

/**
 * Create a transport with OAuth token for the given server configuration.
 *
 * @param mcpServerName The name of the MCP server
 * @param mcpServerConfig The MCP server configuration
 * @param accessToken The OAuth access token
 * @param cliConfig The CLI configuration providing sanitization and diagnostic reporting
 * @returns The transport with OAuth token, or null if creation fails
 */
export async function createTransportWithOAuth(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  accessToken: string,
  cliConfig: McpClientContext,
): Promise<Transport | null> {
  try {
    const dynamicHeaders =
      (await getMcpHeadersFromHelper(
        mcpServerName,
        mcpServerConfig,
        cliConfig,
      )) || {};
    const headers: Record<string, string> = {
      ...dynamicHeaders,
      Authorization: `Bearer ${accessToken}`,
    };
    const transportOptions:
      | StreamableHTTPClientTransportOptions
      | SSEClientTransportOptions = {
      requestInit: createTransportRequestInit(
        mcpServerConfig,
        headers,
        cliConfig.sanitizationConfig,
      ),
      fetch: createMcpTransportFetch(mcpServerConfig),
    };

    return createUrlTransport(mcpServerName, mcpServerConfig, transportOptions);
  } catch (error) {
    cliConfig.emitMcpDiagnostic(
      'error',
      `Failed to create OAuth transport for server '${mcpServerName}': ${getMcpErrorMessage(error)}`,
      error,
      mcpServerName,
    );
    return null;
  }
}

/**
 * Helper function to retrieve a stored OAuth token for an MCP server.
 * Handles token validation and refresh automatically.
 *
 * @param serverName The name of the MCP server
 * @param config The server's config; it decides which credentials are its own
 * @returns The valid access token, or null if no token is stored
 */
export async function getStoredOAuthToken(
  serverName: string,
  config: MCPServerConfig,
): Promise<string | null> {
  const tokenStorage = MCPOAuthTokenStorage.forServer(serverName, config);
  const credentials = await tokenStorage.getCredentials(serverName);
  if (!credentials) return null;

  const authProvider = new MCPOAuthProvider(tokenStorage);
  return authProvider.getValidToken(serverName, {
    // Pass client ID if available
    clientId: credentials.clientId,
  });
}

/**
 * Helper function to create an SSE transport with optional OAuth authentication.
 *
 * @param config The MCP server configuration
 * @param accessToken Optional OAuth access token for authentication
 * @returns A configured SSE transport ready for connection
 */
export async function createSSETransportWithAuth(
  serverName: string,
  config: MCPServerConfig,
  accessToken?: string | null,
  cliConfig?: McpClientContext,
): Promise<SSEClientTransport> {
  const dynamicHeaders =
    (await getMcpHeadersFromHelper(serverName, config, cliConfig)) || {};
  const headers: Record<string, string> = {
    ...dynamicHeaders,
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };

  const options: SSEClientTransportOptions = {
    fetch: createMcpTransportFetch(config),
    // Same connection-level construction as every other transport, so
    // host-reserved headers are stripped here too.
    requestInit: createTransportRequestInit(
      config,
      headers,
      cliConfig?.sanitizationConfig,
    ),
  };

  return new SSEClientTransport(new URL(config.url!), options);
}
