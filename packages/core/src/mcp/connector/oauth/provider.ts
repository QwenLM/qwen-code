/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { URL } from 'node:url';
import { openBrowserSecurely } from '../../../utils/secure-browser-launcher.js';
import { unmanagedRequest } from '../../../utils/fetch.js';
import type { OAuthToken } from '../../token-storage/types.js';

const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Optional metadata passed to a custom MCP OAuth browser opener. Lets the
 * host correlate a browser-open request with the triggering MCP server.
 */
export interface McpOAuthBrowserOpenMeta {
  serverName?: string;
  state?: string;
  scopes?: string[];
  redirectUri?: string;
}

/**
 * Possible return values from a custom {@link McpOAuthBrowserOpener}.
 *
 * - `void` / `undefined` — default: the opener only displayed the URL; the
 *   cli waits on its own local callback server to receive the redirect.
 * - `{ token }` — the host completed the entire OAuth flow out-of-band
 *   and hands the cli a ready token. The cli skips the callback server and
 *   code exchange, saves the token, and returns.
 * - `{ code, state? }` — the host already obtained the authorization code
 *   (e.g. the user pasted it back). The cli skips the callback server and
 *   proceeds directly to token exchange using this code.
 * - `{ callbackUrl }` — the host got the full redirect URL back (typical
 *   "paste the callback URL" flow). The cli parses `code` / `state` out of
 *   its query string and proceeds as above.
 *
 * When a code/state is supplied, the cli validates `state` against the
 * PKCE state it generated and throws on mismatch.
 */
export type McpOAuthBrowserOpenResult =
  | { token: OAuthToken }
  | { code: string; state?: string }
  | { callbackUrl: string };

/**
 * Signature for a process-scoped MCP OAuth browser opener. When set via
 * {@link setMcpOAuthBrowserOpener}, the provider calls this instead of
 * `openBrowserSecurely` — typically installed by the StructuredIO session
 * so an Electron / SDK host can drive the user-agent step itself.
 *
 * Contract:
 *   - Resolve with `void` once the host has started showing the URL. The
 *     cli keeps its local callback server running and exchanges the code
 *     when the redirect arrives.
 *   - Resolve with a {@link McpOAuthBrowserOpenResult} to short-circuit the
 *     local callback server — useful when the redirect URI cannot hit the
 *     cli's `localhost:PORT` (remote / headless hosts, paste-the-URL UX).
 *   - Throw to fall back to the default browser launcher.
 */
export type McpOAuthBrowserOpener = (
  authUrl: string,
  meta: McpOAuthBrowserOpenMeta,
) => Promise<void | McpOAuthBrowserOpenResult>;

let customBrowserOpener: McpOAuthBrowserOpener | null = null;

/**
 * Install (or clear) a process-scoped MCP OAuth browser opener. Pass
 * `null` to restore the default `openBrowserSecurely` behaviour.
 */
export function setMcpOAuthBrowserOpener(
  opener: McpOAuthBrowserOpener | null,
): void {
  customBrowserOpener = opener;
}

/** Internal: returns the currently installed opener, for testing. */
export function getMcpOAuthBrowserOpener(): McpOAuthBrowserOpener | null {
  return customBrowserOpener;
}
import { MCPOAuthTokenStorage } from '../../oauth-token-storage.js';
import { lockMcpOAuthCredential } from '../../oauthFileLock.js';
import type { FileLock } from '../../../utils/fileLock.js';
import { getErrorMessage, FatalCancellationError } from '../../../utils/errors.js';
import {
  OAuthUtils,
  ResourceMismatchError,
  buildMcpClientMetadata,
} from './utils.js';
import { coreEvents } from '../../../utils/events.js';
import { runLogger } from '../../../utils/runLogger.js';
import { getConsentForOauth } from '../../../utils/authConsent.js';
import {
  generatePKCEParams,
  startCallbackServer,
  getPortFromUrl,
  buildAuthorizationUrl,
  exchangeCodeForToken,
  isInvalidCredentialsError,
  refreshAccessToken as refreshAccessTokenShared,
  REDIRECT_PATH,
  type OAuthFlowConfig,
  type OAuthTokenResponse,
} from '../../../utils/oauth-flow.js';

// Re-export types that were moved to oauth-flow.ts for backward compatibility.
export type {
  OAuthAuthorizationResponse,
  OAuthTokenResponse,
} from '../../../utils/oauth-flow.js';

/**
 * OAuth configuration for an MCP server.
 */
export interface MCPOAuthConfig {
  enabled?: boolean; // Whether OAuth is enabled for this server
  clientId?: string;
  clientSecret?: string;
  authorizationUrl?: string;
  issuer?: string;
  tokenUrl?: string;
  scopes?: string[];
  audiences?: string[];
  redirectUri?: string;
  tokenParamName?: string; // For SSE connections, specifies the query parameter name for the token
  registrationUrl?: string;
  // Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs).
  callbackPort?: number;
  resource?: string;
}

/**
 * Opt-in behaviour switches for {@link MCPOAuthProvider.authenticate}.
 *
 * Default (no options) preserves the historical interactive flow: prompt
 * for consent, open a browser, wait for the callback. Callers running in
 * contexts without a TTY/browser (the `mcp_<server>_authenticate`
 * pseudo-tool, `-p` / print mode) can pass these to surface the URL to the
 * model instead of opening a browser.
 */
export interface MCPAuthenticateOptions {
  /**
   * Skip `openBrowserSecurely` and the accompanying "Opening your browser…"
   * banner. The caller is responsible for relaying {@link onAuthUrl} to the
   * user (typically via a tool_result the model then narrates).
   */
  skipBrowserOpen?: boolean;
  /**
   * Skip the interactive consent dialog. The caller is asserting that
   * consent was already granted out-of-band (e.g. the model was instructed
   * by the user to call this tool).
   */
  skipConsent?: boolean;
  /**
   * Fires exactly once, synchronously, as soon as the authorization URL has
   * been built — before awaiting the OAuth callback. Enables a URL-first
   * pattern where the caller can race this callback against the full flow
   * and return the URL to the model immediately while the callback server
   * continues running in the background.
   */
  onAuthUrl?: (authUrl: string) => void;
  /**
   * Receives human-readable progress messages (e.g. "Opening your browser…").
   * When provided, messages are delivered here instead of broadcast via
   * `coreEvents.emitFeedback` — so an in-dialog caller (MCP browser) can
   * render them inline without also polluting the chat transcript.
   */
  onMessage?: (message: string) => void;
}

/**
 * Dynamic client registration request (RFC 7591).
 */
export interface OAuthClientRegistrationRequest {
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

/**
 * Dynamic client registration response (RFC 7591).
 */
export interface OAuthClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

/**
 * Provider for handling OAuth authentication for MCP servers.
 */
export class MCPOAuthProvider {
  private readonly tokenStorage: MCPOAuthTokenStorage;

  constructor(tokenStorage: MCPOAuthTokenStorage = new MCPOAuthTokenStorage()) {
    this.tokenStorage = tokenStorage;
  }

  /**
   * Register a client dynamically with the OAuth server.
   *
   * @param serverName The name of the MCP server, used for client_name
   * @param registrationUrl The client registration endpoint URL
   * @param config OAuth configuration
   * @param redirectPort The port to use for the redirect URI
   * @returns The registered client information
   */
  private async registerClient(
    serverName: string,
    registrationUrl: string,
    config: MCPOAuthConfig,
    redirectPort: number,
  ): Promise<OAuthClientRegistrationResponse> {
    const redirectUri =
      config.redirectUri || `http://localhost:${redirectPort}${REDIRECT_PATH}`;

    const registrationRequest: OAuthClientRegistrationRequest =
      buildMcpClientMetadata(serverName, {
        redirect_uris: [redirectUri],
        scope: config.scopes?.join(' ') || '',
      }) as OAuthClientRegistrationRequest;

    const response = await unmanagedRequest(
      registrationUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(registrationRequest),
      },
      { timeoutMs: OAUTH_REQUEST_TIMEOUT_MS },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Client registration failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    return (await response.json()) as OAuthClientRegistrationResponse;
  }

  /**
   * Discover OAuth configuration from an MCP server URL.
   *
   * @param mcpServerUrl The MCP server URL
   * @returns OAuth configuration if discovered, null otherwise
   */
  private async discoverOAuthFromMCPServer(
    mcpServerUrl: string,
  ): Promise<MCPOAuthConfig | null> {
    // Use the full URL with path preserved for OAuth discovery
    return OAuthUtils.discoverOAuthConfig(mcpServerUrl);
  }

  private async discoverAuthServerMetadataForRegistration(
    issuer: string,
  ): Promise<{
    issuerUrl: string;
    metadata: NonNullable<
      Awaited<ReturnType<typeof OAuthUtils.discoverAuthorizationServerMetadata>>
    >;
  }> {
    const authUrl = new URL(issuer);

    // Preserve path components for issuers with path-based discovery (e.g., Keycloak)
    // Extract issuer by removing the OIDC protocol-specific path suffix
    // For example: http://localhost:8888/realms/my-realm/protocol/openid-connect/auth
    //           -> http://localhost:8888/realms/my-realm
    const oidcPatterns = [
      '/protocol/openid-connect/auth',
      '/protocol/openid-connect/authorize',
      '/oauth2/authorize',
      '/oauth/authorize',
      '/authorize',
    ];

    let pathname = authUrl.pathname.replace(/\/$/, ''); // Trim trailing slash
    for (const pattern of oidcPatterns) {
      if (pathname.endsWith(pattern)) {
        pathname = pathname.slice(0, -pattern.length);
        break;
      }
    }

    const issuerCandidates = new Set<string>();
    issuerCandidates.add(authUrl.origin);

    if (pathname) {
      issuerCandidates.add(`${authUrl.origin}${pathname}`);

      const versionSegmentPattern = /^v\d+(\.\d+)?$/i;
      const segments = pathname.split('/').filter(Boolean);
      const lastSegment = segments.at(-1);
      if (lastSegment && versionSegmentPattern.test(lastSegment)) {
        const withoutVersionPath = segments.slice(0, -1);
        if (withoutVersionPath.length) {
          issuerCandidates.add(
            `${authUrl.origin}/${withoutVersionPath.join('/')}`,
          );
        }
      }
    }

    // URI-template issuers (e.g. Entra ID's `{tenantid}`) are not fetchable
    // discovery URLs; keep the concrete origin/path candidates only.
    const attemptedIssuers = Array.from(issuerCandidates).filter(
      (candidate) => !/[{}]/.test(candidate),
    );
    let selectedIssuer = attemptedIssuers[0];
    let discoveredMetadata: NonNullable<
      Awaited<ReturnType<typeof OAuthUtils.discoverAuthorizationServerMetadata>>
    > | null = null;

    for (const issuer of attemptedIssuers) {
      runLogger.debug(`   Trying issuer URL: ${issuer}`);
      const metadata =
        await OAuthUtils.discoverAuthorizationServerMetadata(issuer);
      if (metadata) {
        selectedIssuer = issuer;
        discoveredMetadata = metadata;
        break;
      }
    }

    if (!discoveredMetadata) {
      throw new Error(
        `Failed to fetch authorization server metadata for client registration (attempted issuers: ${attemptedIssuers.join(', ')})`,
      );
    }

    runLogger.debug(`   Selected issuer URL: ${selectedIssuer}`);
    return {
      issuerUrl: selectedIssuer,
      metadata: discoveredMetadata,
    };
  }

  /**
   * Build the OAuth resource parameter.
   * Prefers PRM selected resource (config.resource) when available.
   * Falls back to constructing from serverUrl (compat extension for servers without PRM).
   */
  private buildResourceParam(
    mcpServerUrl?: string,
    config?: MCPOAuthConfig,
  ): string | undefined {
    if (config?.resource) return config.resource;
    if (!mcpServerUrl) return undefined;
    try {
      return OAuthUtils.buildResourceParameter(mcpServerUrl);
    } catch (error) {
      runLogger.warn(
        `Could not add resource parameter: ${getErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Refresh an access token using a refresh token.
   *
   * @param config OAuth configuration
   * @param refreshToken The refresh token
   * @param tokenUrl The token endpoint URL
   * @param mcpServerUrl The MCP server URL to use as the resource parameter
   * @returns The new token response
   */
  async refreshAccessToken(
    config: MCPOAuthConfig,
    refreshToken: string,
    tokenUrl: string,
    mcpServerUrl?: string,
    resource?: string,
  ): Promise<OAuthTokenResponse> {
    if (!config.clientId) {
      throw new Error('Missing required clientId for token refresh');
    }

    const effectiveResource = resource ?? this.buildResourceParam(mcpServerUrl, config);

    return refreshAccessTokenShared(
      {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: config.scopes,
        audiences: config.audiences,
      },
      refreshToken,
      tokenUrl,
      effectiveResource,
    );
  }

  /**
   * Perform the full OAuth authorization code flow with PKCE.
   *
   * @param serverName The name of the MCP server
   * @param config OAuth configuration
   * @param mcpServerUrl Optional MCP server URL for OAuth discovery
   * @param options Optional behaviour switches for callers (e.g. the
   *   `mcp_<server>_authenticate` pseudo-tool) that want to surface the auth
   *   URL to the model instead of opening a browser themselves.
   * @returns The obtained OAuth token
   */
  async authenticate(
    serverName: string,
    config: MCPOAuthConfig,
    mcpServerUrl?: string,
    options: MCPAuthenticateOptions = {},
  ): Promise<OAuthToken> {
    const {
      skipBrowserOpen = false,
      skipConsent = false,
      onAuthUrl,
      onMessage,
    } = options;
    // Route progress messages to the caller-supplied handler when present,
    // otherwise broadcast via the shared feedback bus (default behaviour for
    // tool/structuredIO callers that do want transcript entries).
    const displayMessage = (message: string) => {
      if (onMessage) {
        onMessage(message);
        return;
      }
      coreEvents.emitFeedback('info', message);
    };

    // If no authorization URL is provided, try to discover OAuth configuration
    if (!config.authorizationUrl && mcpServerUrl) {
      runLogger.debug(`Starting OAuth for MCP server "${serverName}"…
✓ No authorization URL; using OAuth discovery`);

      // First check if the server requires authentication via WWW-Authenticate header
      try {
        const headers: HeadersInit = OAuthUtils.isSSEEndpoint(mcpServerUrl)
          ? { Accept: 'text/event-stream' }
          : { Accept: 'application/json' };

        const response = await unmanagedRequest(
          mcpServerUrl,
          { method: 'HEAD', headers },
          { timeoutMs: OAUTH_REQUEST_TIMEOUT_MS },
        );

        if (response.status === 401 || response.status === 307) {
          const wwwAuthenticate = response.headers.get('www-authenticate');

          if (wwwAuthenticate) {
            const discoveredConfig =
              await OAuthUtils.discoverOAuthFromWWWAuthenticate(
                wwwAuthenticate,
                mcpServerUrl,
              );
            if (discoveredConfig) {
              // Merge discovered config with existing config, preserving clientId and clientSecret
              config = {
                ...config,
                authorizationUrl: discoveredConfig.authorizationUrl,
                issuer: discoveredConfig.issuer,
                tokenUrl: discoveredConfig.tokenUrl,
                scopes: config.scopes || discoveredConfig.scopes || [],
                resource: discoveredConfig.resource ?? config.resource,
                // Preserve existing client credentials; fall back to the
                // client_id advertised by the resource, if any.
                clientId: config.clientId || discoveredConfig.clientId,
                clientSecret: config.clientSecret,
              };
            }
          }
        }
      } catch (error) {
        // Re-throw security validation errors
        if (error instanceof ResourceMismatchError) {
          throw error;
        }

        runLogger.debug(
          `Failed to check endpoint for authentication requirements: ${getErrorMessage(error)}`,
        );
      }

      // If we still don't have OAuth config, try the standard discovery
      if (!config.authorizationUrl) {
        const discoveredConfig =
          await this.discoverOAuthFromMCPServer(mcpServerUrl);
        if (discoveredConfig) {
          // Merge discovered config with existing config, preserving clientId and clientSecret
          config = {
            ...config,
            authorizationUrl: discoveredConfig.authorizationUrl,
            tokenUrl: discoveredConfig.tokenUrl,
            issuer: discoveredConfig.issuer,
            scopes: config.scopes || discoveredConfig.scopes || [],
            registrationUrl: discoveredConfig.registrationUrl,
            resource: discoveredConfig.resource ?? config.resource,
            // Preserve existing client credentials
            clientId: config.clientId,
            clientSecret: config.clientSecret,
          };
        } else {
          throw new Error(
            'Failed to discover OAuth configuration from MCP server',
          );
        }
      }
    }

    // Generate PKCE parameters
    const pkceParams = generatePKCEParams();

    // Determine preferred port: explicit callbackPort takes precedence,
    // then fall back to extracting from redirectUri.
    const preferredPort =
      config.callbackPort ?? getPortFromUrl(config.redirectUri);

    // Start callback server first to allocate port
    // This ensures we only create one server and eliminates race conditions.
    //
    // When skipBrowserOpen is set, the caller (typically the pseudo-tool in
    // -p mode) is surfacing the URL to the model rather than driving the
    // browser themselves. In that case the user may never complete the flow
    // from the same process, so we unref the server / timeout to let the
    // event loop exit naturally once the main logic finishes.
    const callbackServer = startCallbackServer(
      pkceParams.state,
      preferredPort,
      { unref: skipBrowserOpen },
    );

    // Wait for server to start and get the allocated port
    // We need this port for client registration and auth URL building
    const redirectPort = await callbackServer.port;
    runLogger.debug(`Callback server listening on port ${redirectPort}`);

    // If no client ID is provided, try dynamic client registration
    if (!config.clientId) {
      let registrationUrl = config.registrationUrl;

      // If no registration URL was previously discovered, try to discover it
      if (!registrationUrl) {
        // Use the issuer to discover registration endpoint
        if (!config.issuer) {
          throw new Error('Cannot perform dynamic registration without issuer');
        }

        runLogger.debug('→ Attempting dynamic client registration...');
        const { metadata: authServerMetadata } =
          await this.discoverAuthServerMetadataForRegistration(config.issuer);
        registrationUrl = authServerMetadata.registration_endpoint;
      }

      // Register client if registration endpoint is available
      if (registrationUrl) {
        const clientRegistration = await this.registerClient(
          serverName,
          registrationUrl,
          config,
          redirectPort,
        );

        config.clientId = clientRegistration.client_id;
        if (clientRegistration.client_secret) {
          config.clientSecret = clientRegistration.client_secret;
        }

        runLogger.debug('✓ Dynamic client registration successful');
      } else {
        throw new Error(
          'No client ID provided and dynamic registration not supported',
        );
      }
    }

    // Validate configuration
    if (!config.clientId || !config.authorizationUrl || !config.tokenUrl) {
      throw new Error(
        'Missing required OAuth configuration after discovery and registration',
      );
    }

    // Build flow config for shared utilities
    const flowConfig: OAuthFlowConfig = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      authorizationUrl: config.authorizationUrl,
      tokenUrl: config.tokenUrl,
      scopes: config.scopes,
      audiences: config.audiences,
      redirectUri: config.redirectUri,
    };

    // Build authorization URL
    const resource = this.buildResourceParam(mcpServerUrl, config);
    const authUrl = buildAuthorizationUrl(
      flowConfig,
      pkceParams,
      redirectPort,
      resource,
    );

    // Consent: when skipConsent is true the caller (typically the
    // mcp_<server>_authenticate pseudo-tool) is asserting that the model's
    // explicit invocation of that tool IS the consent signal — no interactive
    // dialog is needed or possible (e.g. in -p / non-interactive mode).
    if (!skipConsent) {
      const userConsent = await getConsentForOauth(
        `Authentication required for MCP Server: '${serverName}.'`,
      );
      if (!userConsent) {
        throw new FatalCancellationError('Authentication cancelled by user.');
      }
    }

    // Surface the URL to the caller as soon as it's built. When
    // skipBrowserOpen is set, the caller (e.g. pseudo-tool) is responsible
    // for relaying the URL to the user — so don't ALSO print a
    // "opening browser…" banner, which would be misleading.
    onAuthUrl?.(authUrl);

    // Captured outside the browser-open branch so the code/token/callbackUrl
    // returned by a custom opener can short-circuit the callback server.
    let openerResult: McpOAuthBrowserOpenResult | null = null;

    if (!skipBrowserOpen) {
      displayMessage(`→ Opening your browser for OAuth sign-in...

If the browser does not open, copy and paste this URL into your browser:
${authUrl}

💡 TIP: Triple-click to select the entire URL, then copy and paste it into your browser.
⚠️  Make sure to copy the COMPLETE URL - it may wrap across multiple lines.`);

      // Prefer a host-installed opener (StructuredIO / SDK scenarios) so the
      // authorization step can happen in an Electron BrowserWindow, deep
      // link, or paste-the-URL flow instead of a local system browser. If
      // the opener throws, fall back to the default launcher so
      // single-process usage still works.
      let delegated = false;
      if (customBrowserOpener) {
        try {
          const result = await customBrowserOpener(authUrl, {
            serverName,
            state: pkceParams.state,
            scopes: config.scopes,
            redirectUri: config.redirectUri,
          });
          delegated = true;
          if (result) openerResult = result;
        } catch (error) {
          runLogger.warn(
            'Custom MCP OAuth browser opener failed, falling back:',
            getErrorMessage(error),
          );
        }
      }
      if (!delegated) {
        try {
          await openBrowserSecurely(authUrl);
        } catch (error) {
          runLogger.warn(
            'Failed to open browser automatically:',
            getErrorMessage(error),
          );
        }
      }
    }

    // If the opener supplied a ready token, save and return immediately.
    // The local callback server is no longer needed.
    if (openerResult && 'token' in openerResult) {
      callbackServer.close();
      try {
        await this.tokenStorage.saveToken(
          serverName,
          openerResult.token,
          config.clientId,
          config.tokenUrl,
          mcpServerUrl,
          resource,
        );
        runLogger.debug('✓ Token provided by opener saved for MCP server.');
      } catch (saveError) {
        runLogger.error(
          'Failed to save opener-provided auth token.',
          saveError,
        );
        throw saveError;
      }
      return openerResult.token;
    }

    // Extract an authorization code from the opener result when provided —
    // either directly (`{code, state?}`) or by parsing a full callback URL
    // the host pasted back (`{callbackUrl}`).
    let code: string;
    if (openerResult) {
      const extracted = extractCodeFromOpenerResult(
        openerResult,
        pkceParams.state,
      );
      callbackServer.close();
      code = extracted;
    } else {
      // Default: wait for the local callback server to receive the redirect.
      const response = await callbackServer.response;
      code = response.code;
    }

    runLogger.debug('✓ Authorization code received, exchanging for tokens...');

    // Exchange code for tokens
    const tokenResponse = await exchangeCodeForToken(
      flowConfig,
      code,
      pkceParams.codeVerifier,
      redirectPort,
      resource,
    );

    // Convert to our token format
    if (!tokenResponse.access_token) {
      throw new Error('No access token received from token endpoint');
    }

    const token: OAuthToken = {
      accessToken: tokenResponse.access_token,
      tokenType: tokenResponse.token_type || 'Bearer',
      refreshToken: tokenResponse.refresh_token,
      scope: tokenResponse.scope,
    };

    if (tokenResponse.expires_in) {
      token.expiresAt = Date.now() + tokenResponse.expires_in * 1000;
    }

    // Save token
    try {
      await this.tokenStorage.saveToken(
        serverName,
        token,
        config.clientId,
        config.tokenUrl,
        mcpServerUrl,
        resource,
      );
      runLogger.debug('✓ Authentication successful! Token saved.');

      // Verify token was saved
      const savedToken = await this.tokenStorage.getCredentials(serverName);
      if (savedToken && savedToken.token && savedToken.token.accessToken) {
        // Avoid leaking token material; log a short SHA-256 fingerprint instead.
        const tokenFingerprint = crypto
          .createHash('sha256')
          .update(savedToken.token.accessToken)
          .digest('hex')
          .slice(0, 8);
        runLogger.debug(
          `✓ Token verification successful (fingerprint: ${tokenFingerprint})`,
        );
      } else {
        runLogger.warn(
          'Token verification failed: token not found or invalid after save',
        );
      }
    } catch (saveError) {
      runLogger.error('Failed to save auth token.', saveError);
      throw saveError;
    }

    return token;
  }

  /**
   * Get a valid access token for an MCP server, refreshing if necessary.
   *
   * @param serverName The name of the MCP server
   * @param config OAuth configuration
   * @returns A valid access token or null if not authenticated
   */
  async getValidToken(
    serverName: string,
    config: MCPOAuthConfig,
  ): Promise<string | null> {
    return (await this.getValidOAuthToken(serverName, config))?.accessToken ?? null;
  }

  /**
   * Like {@link getValidToken}, with the whole token (access, refresh,
   * expiry). After a refresh it is the refreshed token itself, so a caller
   * gets it even when it could not be saved.
   */
  async getValidOAuthToken(
    serverName: string,
    config: MCPOAuthConfig,
  ): Promise<OAuthToken | null> {
    runLogger.debug(`Getting valid token for server: ${serverName}`);
    const credentials = await this.tokenStorage.getCredentials(serverName);

    if (!credentials) {
      runLogger.debug(`No credentials found for server: ${serverName}`);
      return null;
    }

    const { token } = credentials;
    runLogger.debug(
      `Found token for server: ${serverName}, expired: ${this.tokenStorage.isTokenExpired(token)}`,
    );

    // Check if token is expired
    if (!this.tokenStorage.isTokenExpired(token)) {
      runLogger.debug(`Returning valid token for server: ${serverName}`);
      return token;
    }

    // Try to refresh if we have a refresh token.
    // Use a cross-process file lock to serialize refresh across multiple CLI
    // instances — prevents race conditions where concurrent refreshes
    // invalidate a one-time-use refresh_token.
    if (token.refreshToken && config.clientId && credentials.tokenUrl) {
      const resource = credentials.resource ?? config.resource;
      return this.refreshTokenWithLock(
        serverName,
        config,
        credentials.tokenUrl,
        credentials.mcpServerUrl,
        resource,
      );
    }

    return null;
  }

  /**
   * Refresh an expired token with cross-process locking.
   *
   * Uses proper-lockfile to serialize token refresh across multiple CLI
   * instances. Implements double-check locking: after acquiring the lock,
   * re-reads the token to see if another process already refreshed it.
   */
  private async refreshTokenWithLock(
    serverName: string,
    config: MCPOAuthConfig,
    tokenUrl: string,
    mcpServerUrl?: string,
    resource?: string,
  ): Promise<OAuthToken | null> {
    let refreshLock: FileLock;
    try {
      // One lock per stored credential, shared with every other process.
      refreshLock = await lockMcpOAuthCredential(
        'refresh',
        this.tokenStorage.credentialKey(serverName),
      );
    } catch (error) {
      // Another process held the refresh lock longer than we wait. If it
      // stored a token meanwhile, that token is the answer: refreshing again
      // with the same refresh token is the race the lock exists to prevent.
      const refreshed = await this.tokenStorage
        .getCredentials(serverName)
        .catch(() => null);
      if (refreshed && !this.tokenStorage.isTokenExpired(refreshed.token)) {
        runLogger.debug(
          `Token for MCP server ${serverName} was refreshed elsewhere while waiting for the lock`,
        );
        return refreshed.token;
      }
      runLogger.warn(
        `Token refresh for MCP server ${serverName} is busy elsewhere: ${getErrorMessage(error)}`,
      );
      return null;
    }
    let storedToken: OAuthToken | undefined;
    try {
      // Double-check: another process may have refreshed while we waited
      const freshCredentials =
        await this.tokenStorage.getCredentials(serverName);
      if (!freshCredentials) {
        // Cleared while this waited: there is nothing to refresh.
        return null;
      }
      storedToken = freshCredentials.token;
      if (!this.tokenStorage.isTokenExpired(storedToken)) {
        runLogger.debug(
          `Token for ${serverName} was already refreshed by another process`,
        );
        return storedToken;
      }

      // The latest refresh token: another process may have stored a new one.
      const currentRefreshToken = storedToken.refreshToken;
      if (!currentRefreshToken) {
        return null;
      }

      const effectiveResource = freshCredentials.resource ?? resource;

      // A lost refresh lock may mean a peer is already spending this token.
      try {
        refreshLock.assertHeld();
      } catch {
        const refreshed = await this.tokenStorage
          .getCredentials(serverName)
          .catch(() => null);
        if (refreshed && !this.tokenStorage.isTokenExpired(refreshed.token)) {
          return refreshed.token;
        }
        return null;
      }

      runLogger.log(`Refreshing expired token for MCP server: ${serverName}`);

      const newTokenResponse = await this.refreshAccessToken(
        config,
        currentRefreshToken,
        tokenUrl,
        mcpServerUrl,
        effectiveResource,
      );

      // Update stored token
      const newToken: OAuthToken = {
        accessToken: newTokenResponse.access_token,
        tokenType: newTokenResponse.token_type,
        refreshToken: newTokenResponse.refresh_token || currentRefreshToken,
        scope: newTokenResponse.scope || storedToken.scope,
      };

      if (newTokenResponse.expires_in) {
        newToken.expiresAt = Date.now() + newTokenResponse.expires_in * 1000;
      }

      try {
        const saved = await this.tokenStorage.saveRefreshedToken(
          serverName,
          storedToken,
          newToken,
          config.clientId,
          tokenUrl,
          mcpServerUrl,
          effectiveResource,
        );
        if (!saved) {
          // Cleared or signed in again while refreshing: that is the newer
          // state, so it is what counts.
          runLogger.debug(
            `Refreshed token for MCP server ${serverName} dropped: its sign-in changed meanwhile`,
          );
          return (await this.tokenStorage.getCredentials(serverName))?.token ?? null;
        }
      } catch (saveError) {
        // The refresh worked; only keeping it did not. The stored credentials
        // are not invalid, so they stay, and the fresh token still serves now.
        runLogger.warn(
          `Refreshed token for MCP server ${serverName} could not be saved: ${getErrorMessage(saveError)}`,
        );
      }

      return newToken;
    } catch (error) {
      coreEvents.emitFeedback('error', 'Failed to refresh auth token.', error);
      // Only an answer that the credentials are invalid removes them, and
      // only while they are still the ones refreshed. Any other failure — the
      // network, the server — says nothing about them: they stay for the
      // next attempt.
      if (storedToken && isInvalidCredentialsError(error)) {
        await this.tokenStorage
          .deleteInvalidToken(serverName, storedToken)
          .catch((deleteError) => {
            runLogger.warn(
              `Invalid token for MCP server ${serverName} could not be removed: ${getErrorMessage(deleteError)}`,
            );
          });
      }
      return null;
    } finally {
      await refreshLock.release().catch((error) => {
        runLogger.warn(
          `[mcp-oauth] refresh lock for ${serverName} could not be released`,
          error,
        );
      });
    }
  }

}

/**
 * Extract `code` from a non-token opener result, validating `state` against
 * the PKCE state the cli generated. Accepts either a raw {code, state?} or
 * a full callback URL ({callbackUrl}).
 */
function extractCodeFromOpenerResult(
  result: Exclude<McpOAuthBrowserOpenResult, { token: OAuthToken }>,
  expectedState: string,
): string {
  let code: string;
  let state: string | undefined;

  if ('callbackUrl' in result) {
    let parsed: URL;
    try {
      parsed = new URL(result.callbackUrl);
    } catch {
      throw new Error(
        `OAuth opener returned an invalid callbackUrl: ${result.callbackUrl}`,
      );
    }
    const error = parsed.searchParams.get('error');
    if (error) {
      const description = parsed.searchParams.get('error_description');
      throw new Error(
        description
          ? `OAuth error: ${error} — ${description}`
          : `OAuth error: ${error}`,
      );
    }
    const pastedCode = parsed.searchParams.get('code');
    if (!pastedCode) {
      throw new Error(
        'OAuth opener returned a callbackUrl without a `code` parameter',
      );
    }
    code = pastedCode;
    state = parsed.searchParams.get('state') ?? undefined;
  } else {
    code = result.code;
    state = result.state;
  }

  // State is optional on the wire (host may not echo it), but if present it
  // MUST match — mismatch indicates CSRF or mixed-up concurrent flows.
  if (state !== undefined && state !== expectedState) {
    throw new Error('OAuth state mismatch — possible CSRF or mixed flow');
  }

  return code;
}
