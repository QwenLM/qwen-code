/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// OAuth recovery for URL-based MCP servers. `HttpMcpConnector` exposes this as
// its authenticate phase: the runtime reports the failed handshake, the
// connector performs discovery/authentication and hands back transports to
// retry through the supplied connect callback.

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MCPServerConfig } from '../mcpServerConfig.js';
import { MCPOAuthTokenStorage } from '../oauth-token-storage.js';
import { OAuthUtils } from './oauth/utils.js';
import { MCPOAuthProvider } from './oauth/provider.js';
import { runLogger } from '../../utils/runLogger.js';
import { getMcpErrorMessage } from '../errors.js';
import { UnauthorizedError } from '../../utils/errors.js';
import { mcpServerRequiresOAuth } from '../oauthState.js';
import type { McpClientContext } from '../mcpClientContext.js';
import {
  createSSETransportWithAuth,
  createTransportWithOAuth,
  getStoredOAuthToken,
} from './oauth/transport.js';

/** A transport accepted by the connection orchestration for a retry. */
export type McpTransportConnector = (transport: Transport) => Promise<void>;

export interface McpAuthenticationFailure {
  readonly error: unknown;
  /** The failing transport already returned 404, so retry SSE directly. */
  readonly httpReturned404: boolean;
}

/**
 * @visiblefortesting
 * Checks if the MCP server configuration has a network transport URL (SSE or HTTP).
 */
export function hasNetworkTransport(config: MCPServerConfig): boolean {
  return !!(
    config.url ||
    config.httpUrl ||
    config.type === 'http' ||
    config.type === 'sse' ||
    config.type === 'ws'
  );
}

/**
 * Authenticates a URL-based server after its handshake was rejected. Throws the
 * original failure when authentication is impossible or declined.
 */
export async function authenticateHttpConnection(
  serverName: string,
  config: MCPServerConfig,
  cliConfig: McpClientContext,
  failure: McpAuthenticationFailure,
  connectTransport: McpTransportConnector,
): Promise<void> {
  mcpServerRequiresOAuth.set(serverName, true);

  // Clear a stale token so the UI does not report "Authenticated" for a
  // revoked credential.
  await MCPOAuthTokenStorage.forServer(serverName, config).deleteCredentials(
    serverName,
  );

  // Only trigger automatic OAuth when explicitly enabled in config.
  if (!config.oauth?.enabled) {
    await showAuthRequiredMessage(serverName, config, cliConfig);
  }

  const wwwAuthenticate = await resolveWwwAuthenticate(
    serverName,
    config,
    failure,
  );
  if (wwwAuthenticate) {
    await authenticateFromHeader(
      serverName,
      config,
      wwwAuthenticate,
      failure.httpReturned404,
      cliConfig,
      connectTransport,
    );
    return;
  }
  await discoverAndAuthenticate(
    serverName,
    config,
    cliConfig,
    connectTransport,
  );
}

/**
 * Extract WWW-Authenticate header from error message string.
 * This is a more robust approach than regex matching.
 */
function extractWWWAuthenticateHeader(errorString: string): string | null {
  const patterns = [
    /www-authenticate:\s*([^\n\r]+)/i,
    /WWW-Authenticate:\s*([^\n\r]+)/i,
    /"www-authenticate":\s*"([^"]+)"/i,
    /'www-authenticate':\s*'([^']+)'/i,
  ];
  for (const pattern of patterns) {
    const match = errorString.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

async function resolveWwwAuthenticate(
  serverName: string,
  config: MCPServerConfig,
  failure: McpAuthenticationFailure,
): Promise<string | null> {
  let wwwAuthenticate = extractWWWAuthenticateHeader(
    String(failure.error),
  );
  if (wwwAuthenticate || !hasNetworkTransport(config)) {
    return wwwAuthenticate;
  }

  runLogger.log(
    `No www-authenticate header in error, trying to fetch it from server...`,
  );
  try {
    const urlToFetch = config.httpUrl || config.url!;
    const response = await fetch(urlToFetch, {
      method: 'HEAD',
      headers: { Accept: authenticateProbeAcceptHeader(config, failure) },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) {
      wwwAuthenticate = response.headers.get('www-authenticate');
      if (wwwAuthenticate) {
        runLogger.log(
          `Found www-authenticate header from server: ${wwwAuthenticate}`,
        );
      }
    }
  } catch (fetchError) {
    runLogger.debug(
      `Failed to fetch www-authenticate header: ${getMcpErrorMessage(
        fetchError,
      )}`,
    );
  }
  return wwwAuthenticate;
}

/** The transport that last failed decides which auth scheme to probe for. */
function authenticateProbeAcceptHeader(
  config: MCPServerConfig,
  failure: McpAuthenticationFailure,
): string {
  if (config.httpUrl) return 'application/json';
  if (config.type === 'http') return 'application/json';
  if (config.type === 'sse') return 'text/event-stream';
  return failure.httpReturned404 ? 'text/event-stream' : 'application/json';
}

/**
 * Handle automatic OAuth discovery and authentication for a server.
 *
 * @returns True if OAuth was successfully configured and authenticated.
 */
async function handleAutomaticOAuth(
  serverName: string,
  config: MCPServerConfig,
  wwwAuthenticate: string,
  cliConfig: McpClientContext,
): Promise<boolean> {
  try {
    runLogger.log(`🔐 '${serverName}' requires OAuth authentication`);

    const serverUrl = config.httpUrl || config.url;

    let oauthConfig = await OAuthUtils.discoverOAuthFromWWWAuthenticate(
      wwwAuthenticate,
      serverUrl,
    );
    if (!oauthConfig && hasNetworkTransport(config)) {
      oauthConfig = await OAuthUtils.discoverOAuthConfig(serverUrl!);
    }
    if (!oauthConfig) {
      cliConfig.emitMcpDiagnostic(
        'error',
        `Could not configure OAuth for '${serverName}'. Check the server's OAuth settings.`,
        undefined,
        serverName,
      );
      return false;
    }

    const oauthAuthConfig = {
      ...config.oauth,
      enabled: true,
      authorizationUrl: oauthConfig.authorizationUrl,
      issuer: oauthConfig.issuer,
      tokenUrl: oauthConfig.tokenUrl,
      scopes: oauthConfig.scopes || [],
      resource: oauthConfig.resource ?? config.oauth?.resource,
      // An explicitly configured client wins over the one advertised by the
      // resource in WWW-Authenticate / protected resource metadata.
      clientId: config.oauth?.clientId || oauthConfig.clientId,
    };

    runLogger.log(`Starting OAuth authentication for server '${serverName}'...`);
    const authProvider = new MCPOAuthProvider(
      MCPOAuthTokenStorage.forServer(serverName, config),
    );
    await authProvider.authenticate(serverName, oauthAuthConfig, serverUrl);
    runLogger.log(`OAuth authentication successful for server '${serverName}'`);
    return true;
  } catch (error) {
    cliConfig.emitMcpDiagnostic(
      'error',
      `Failed to handle automatic OAuth for server '${serverName}': ${getMcpErrorMessage(error)}`,
      error,
      serverName,
    );
    return false;
  }
}

async function showAuthRequiredMessage(
  serverName: string,
  config: MCPServerConfig,
  cliConfig: McpClientContext,
): Promise<never> {
  const hasRejectedToken = !!(await getStoredOAuthToken(serverName, config));
  const message = hasRejectedToken
    ? `MCP server '${serverName}' rejected the stored OAuth token.`
    : `MCP server '${serverName}' requires authentication.`;
  cliConfig.emitMcpDiagnostic('info', message, undefined, serverName);
  throw new UnauthorizedError(message);
}

async function authenticateFromHeader(
  serverName: string,
  config: MCPServerConfig,
  wwwAuthenticate: string,
  httpReturned404: boolean,
  cliConfig: McpClientContext,
  connectTransport: McpTransportConnector,
): Promise<void> {
  runLogger.log(
    `Received 401 with www-authenticate header: ${wwwAuthenticate}`,
  );

  const oauthSuccess = await handleAutomaticOAuth(
    serverName,
    config,
    wwwAuthenticate,
    cliConfig,
  );
  if (!oauthSuccess) {
    throw new Error(
      `Failed to handle automatic OAuth for server '${serverName}'`,
    );
  }

  const accessToken = await getStoredOAuthToken(serverName, config);
  if (!accessToken) {
    throw new Error(`Failed to get OAuth token for server '${serverName}'`);
  }
  await retryWithOAuth(
    serverName,
    config,
    accessToken,
    httpReturned404,
    cliConfig,
    connectTransport,
  );
}

async function discoverAndAuthenticate(
  serverName: string,
  config: MCPServerConfig,
  cliConfig: McpClientContext,
  connectTransport: McpTransportConnector,
): Promise<void> {
  // No header found, but we got a 401: only discover when OAuth is enabled.
  if (!config.oauth?.enabled) {
    await showAuthRequiredMessage(serverName, config, cliConfig);
  }
  if (!hasNetworkTransport(config)) {
    throw new Error(
      `MCP server '${serverName}' requires authentication. Please configure OAuth or check server settings.`,
    );
  }

  runLogger.log(`🔍 Attempting OAuth discovery for '${serverName}'...`);
  const fullServerUrl = config.httpUrl || config.url!;
  const oauthConfig = await OAuthUtils.discoverOAuthConfig(fullServerUrl);
  if (!oauthConfig) {
    throw new Error(
      `OAuth configuration failed for '${serverName}'. Check the server's OAuth settings.`,
    );
  }
  runLogger.log(`Discovered OAuth configuration for server '${serverName}'`);

  const oauthAuthConfig = {
    ...config.oauth,
    enabled: true,
    authorizationUrl: oauthConfig.authorizationUrl,
    issuer: oauthConfig.issuer,
    tokenUrl: oauthConfig.tokenUrl,
    scopes: oauthConfig.scopes || [],
    resource: oauthConfig.resource ?? config.oauth?.resource,
  };

  runLogger.log(`Starting OAuth authentication for server '${serverName}'...`);
  const authProvider = new MCPOAuthProvider(
    MCPOAuthTokenStorage.forServer(serverName, config),
  );
  await authProvider.authenticate(
    serverName,
    oauthAuthConfig,
    config.httpUrl || config.url,
  );

  const accessToken = await getStoredOAuthToken(serverName, config);
  if (!accessToken) {
    throw new Error(`Failed to get OAuth token for server '${serverName}'`);
  }
  const oauthTransport = await createTransportWithOAuth(
    serverName,
    config,
    accessToken,
    cliConfig,
  );
  if (!oauthTransport) {
    throw new Error(
      `Failed to create OAuth transport for server '${serverName}'`,
    );
  }
  await connectTransport(oauthTransport);
}

async function retryWithOAuth(
  serverName: string,
  config: MCPServerConfig,
  accessToken: string,
  httpReturned404: boolean,
  cliConfig: McpClientContext,
  connectTransport: McpTransportConnector,
): Promise<void> {
  if (httpReturned404) {
    runLogger.log(
      `Retrying SSE connection to '${serverName}' with OAuth token...`,
    );
    await connectSseWithOAuth(
      serverName,
      config,
      accessToken,
      cliConfig,
      connectTransport,
    );
    runLogger.log(
      `Successfully connected to '${serverName}' using SSE with OAuth.`,
    );
    return;
  }

  runLogger.log(`Retrying connection to '${serverName}' with OAuth token...`);
  const httpTransport = await createTransportWithOAuth(
    serverName,
    config,
    accessToken,
    cliConfig,
  );
  if (!httpTransport) {
    throw new Error(
      `Failed to create OAuth transport for server '${serverName}'`,
    );
  }

  try {
    await connectTransport(httpTransport);
    runLogger.log(
      `Successfully connected to '${serverName}' using HTTP with OAuth.`,
    );
  } catch (httpError) {
    // If HTTP+OAuth returns 404 and auto-detection is enabled, try SSE+OAuth.
    if (
      String(httpError).includes('404') &&
      config.url &&
      !config.type &&
      !config.httpUrl
    ) {
      runLogger.log(`HTTP with OAuth returned 404, trying SSE with OAuth...`);
      await connectSseWithOAuth(
        serverName,
        config,
        accessToken,
        cliConfig,
        connectTransport,
      );
      runLogger.log(
        `Successfully connected to '${serverName}' using SSE with OAuth.`,
      );
      return;
    }
    throw httpError;
  }
}

async function connectSseWithOAuth(
  serverName: string,
  config: MCPServerConfig,
  accessToken: string,
  cliConfig: McpClientContext,
  connectTransport: McpTransportConnector,
): Promise<void> {
  const transport = await createSSETransportWithAuth(
    serverName,
    config,
    accessToken,
    cliConfig,
  );
  await connectTransport(transport);
}
