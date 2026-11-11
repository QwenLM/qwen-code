/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared setup for every URL-based transport, so the HTTP and WebSocket
// connectors do not have to import each other.

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import { McpOAuthTokenProvider } from './oauth/token-provider.js';
import { MCPOAuthTokenStorage } from '../oauth-token-storage.js';
import { runLogger } from '../../utils/runLogger.js';
import { expandMcpEnvVars } from '../mcpEnvExpansion.js';
import { getMcpHeadersFromHelper } from './transport/headers-helper.js';
import {
  createMcpTransportFetch,
  createTransportRequestInit,
  getPluginEnvironment,
} from './transport/support.js';
import type {
  McpConnectRequest,
  McpConnectorContext,
  McpPreparedHttpConnection,
} from './types.js';

export async function prepareHttpConnection(
  request: McpConnectRequest,
  ctx: McpConnectorContext,
): Promise<McpPreparedHttpConnection> {
  const { serverName, config } = request;
  const pluginEnv = getPluginEnvironment(config.plugin);
  const urlExpansionEnv = { ...process.env, ...pluginEnv };
  const expandedUrl = config.url
    ? expandMcpEnvVars(config.url, urlExpansionEnv)
    : undefined;
  const expandedHttpUrl = config.httpUrl
    ? expandMcpEnvVars(config.httpUrl, urlExpansionEnv)
    : undefined;
  const expandedConfig: MCPServerConfig = Object.assign(
    {},
    config,
    expandedUrl !== undefined ? { url: expandedUrl } : {},
    expandedHttpUrl !== undefined ? { httpUrl: expandedHttpUrl } : {},
  );

  // Connecting is where credentials stored the old way move to this
  // server's key; reads elsewhere only look.
  const tokenStorage = MCPOAuthTokenStorage.forServer(serverName, config);
  await tokenStorage.adoptLegacy();

  let authProvider: OAuthClientProvider | undefined;
  if (expandedConfig.oauth?.enabled) {
    // A dynamic provider lets the SDK transport refresh tokens per request, so
    // a token expiring mid-session does not fail the call.
    const tokenProvider = new McpOAuthTokenProvider(
      serverName,
      expandedConfig.oauth,
      tokenStorage,
    );
    const initialToken = await tokenProvider.tokens();
    if (initialToken) {
      authProvider = tokenProvider;
    } else {
      ctx.cliConfig.emitMcpDiagnostic(
        'info',
        `MCP server '${serverName}' requires authentication.`,
        undefined,
        serverName,
      );
    }
  } else {
    // Still use a dynamic provider so the SDK transport can handle
    // 401 → token refresh for servers with stored OAuth credentials.
    const tokenProvider = new McpOAuthTokenProvider(
      serverName,
      {},
      tokenStorage,
    );
    const initialToken = await tokenProvider.tokens();
    if (initialToken) {
      runLogger.log(`Found stored OAuth token for server '${serverName}'`);
      authProvider = tokenProvider;
    }
  }

  const dynamicHeaders =
    (await getMcpHeadersFromHelper(serverName, expandedConfig, ctx.cliConfig)) ||
    {};

  return {
    config: expandedConfig,
    transportOptions: {
      requestInit: createTransportRequestInit(
        config,
        dynamicHeaders,
        ctx.cliConfig.sanitizationConfig,
      ),
      authProvider,
      fetch: createMcpTransportFetch(config),
    },
  };
}
