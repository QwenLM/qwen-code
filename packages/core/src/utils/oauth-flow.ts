/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared OAuth 2.0 Authorization Code flow primitives with PKCE support.
 *
 * These utilities are protocol-agnostic and can be reused by OAuth clients.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type * as net from 'node:net';
import { URL } from 'node:url';
import { BRAND_CLI_NAME } from '../config/brand.js';
import { runLogger } from './runLogger.js';
import { unmanagedRequest } from './fetch.js';

const OAUTH_TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Configuration for an OAuth 2.0 Authorization Code flow.
 * Contains only the fields needed by the shared flow utilities.
 */
export interface OAuthFlowConfig {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes?: string[];
  audiences?: string[];
  redirectUri?: string;
}

/**
 * Configuration subset needed for token refresh operations.
 */
export type OAuthRefreshConfig = Pick<
  OAuthFlowConfig,
  'clientId' | 'clientSecret' | 'scopes' | 'audiences'
>;

/**
 * PKCE (Proof Key for Code Exchange) parameters.
 */
export interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

/**
 * OAuth authorization response from the callback server.
 */
export interface OAuthAuthorizationResponse {
  code: string;
  state: string;
}

/**
 * OAuth token response from the authorization server.
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** The path the local callback server listens on. */
export const REDIRECT_PATH = '/oauth/callback';

const HTTP_OK = 200;

/**
 * Generate PKCE parameters for OAuth flow.
 *
 * @returns PKCE parameters including code verifier, challenge, and state
 */
export function generatePKCEParams(): PKCEParams {
  // Generate code verifier (43-128 characters)
  // using 64 bytes results in ~86 characters, safely above the minimum of 43
  const codeVerifier = crypto.randomBytes(64).toString('base64url');

  // Generate code challenge using SHA256
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // Generate state for CSRF protection
  const state = crypto.randomBytes(16).toString('base64url');

  return { codeVerifier, codeChallenge, state };
}

/**
 * Start a local HTTP server to handle OAuth callback.
 * The server will listen on the specified port (or port 0 for OS assignment).
 *
 * @param expectedState The state parameter to validate
 * @param port Optional preferred port to listen on
 * @returns Object containing the port (available immediately) and a promise for the auth response
 */
export function startCallbackServer(
  expectedState: string,
  port?: number,
  options: { unref?: boolean } = {},
): {
  port: Promise<number>;
  response: Promise<OAuthAuthorizationResponse>;
  /**
   * Close the callback server and cancel its timeout. Callers use this
   * when the authorization code has been obtained out-of-band (e.g. the
   * host pasted the callback URL) and the local server is no longer
   * needed. Idempotent.
   */
  close: () => void;
} {
  const { unref = false } = options;
  let portResolve: (port: number) => void;
  let portReject: (error: Error) => void;
  const portPromise = new Promise<number>((resolve, reject) => {
    portResolve = resolve;
    portReject = reject;
  });

  // Captured for the outer `close()` handle so callers can stop the server
  // from outside the promise executor.
  let capturedServer: http.Server | null = null;
  let capturedTimeout: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const responsePromise = new Promise<OAuthAuthorizationResponse>(
    (resolve, reject) => {
      let serverPort: number;

      const server = http.createServer(
        async (req: http.IncomingMessage, res: http.ServerResponse) => {
          try {
            const url = new URL(req.url!, `http://localhost:${serverPort}`);

            if (url.pathname !== REDIRECT_PATH) {
              res.writeHead(404);
              res.end('Not found');
              return;
            }

            const code = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(HTTP_OK, { 'Content-Type': 'text/html' });
              res.end(`
              <html>
                <body>
                  <h1>Authentication Failed</h1>
                  <p>Error: ${error.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                  <p>${(url.searchParams.get('error_description') || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                  <p>You can close this window.</p>
                </body>
              </html>
            `);
              server.close();
              reject(new Error(`OAuth error: ${error}`));
              return;
            }

            if (!code || !state) {
              res.writeHead(400);
              res.end('Missing code or state parameter');
              return;
            }

            if (state !== expectedState) {
              res.writeHead(400);
              res.end('Invalid state parameter');
              server.close();
              reject(new Error('State mismatch - possible CSRF attack'));
              return;
            }

            // Send success response to browser
            res.writeHead(HTTP_OK, { 'Content-Type': 'text/html' });
            res.end(`
            <html>
              <body>
                <h1>Authentication Successful!</h1>
                <p>You can close this window and return to ${BRAND_CLI_NAME}.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);

            server.close();
            resolve({ code, state });
          } catch (error) {
            server.close();
            reject(error);
          }
        },
      );

      server.on('error', (error) => {
        portReject(error);
        reject(error);
      });

      // Determine which port to use (env var, argument, or OS-assigned)
      let listenPort = 0; // Default to OS-assigned port

      const portStr = process.env['OAUTH_CALLBACK_PORT'];
      if (portStr) {
        const envPort = parseInt(portStr, 10);
        if (isNaN(envPort) || envPort <= 0 || envPort > 65535) {
          const error = new Error(
            `Invalid value for OAUTH_CALLBACK_PORT: "${portStr}"`,
          );
          portReject(error);
          reject(error);
          return;
        }
        listenPort = envPort;
      } else if (port !== undefined) {
        listenPort = port;
      }

      server.listen(listenPort, () => {
        const address = server.address() as net.AddressInfo;
        serverPort = address.port;
        runLogger.log(`OAuth callback server listening on port ${serverPort}`);
        // Opt-in: do not keep the Node event loop alive for this server.
        // Used by non-interactive callers (pseudo-tool in -p mode) that
        // surface the URL to the model and expect the process to exit once
        // the main logic finishes, even if the user hasn't completed the
        // browser flow. The token will simply not be saved — next session.
        if (unref) {
          server.unref();
        }
        portResolve(serverPort); // Resolve port promise immediately
      });

      // Timeout after 5 minutes
      const timeoutHandle = setTimeout(
        () => {
          server.close();
          reject(new Error('OAuth callback timeout'));
        },
        5 * 60 * 1000,
      );
      if (unref) {
        timeoutHandle.unref();
      }

      capturedServer = server;
      capturedTimeout = timeoutHandle;
    },
  );

  const close = () => {
    if (closed) return;
    closed = true;
    if (capturedTimeout) {
      clearTimeout(capturedTimeout);
      capturedTimeout = null;
    }
    if (capturedServer) {
      capturedServer.close();
      capturedServer = null;
    }
  };

  // Suppress unhandled-rejection noise when the caller intentionally
  // abandons responsePromise after calling close() — e.g. the authorization
  // code arrived out-of-band via the opener.
  responsePromise.catch(() => {});

  return { port: portPromise, response: responsePromise, close };
}

/**
 * Extract the port number from a URL string if available and valid.
 *
 * @param urlString The URL string to parse
 * @returns The port number or undefined if not found or invalid
 */
export function getPortFromUrl(urlString?: string): number | undefined {
  if (!urlString) {
    return undefined;
  }

  try {
    const url = new URL(urlString);
    if (url.port) {
      const parsedPort = parseInt(url.port, 10);
      if (!isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        return parsedPort;
      }
    }
  } catch {
    // Ignore invalid URL
  }

  return undefined;
}

/**
 * Build the authorization URL for the OAuth flow.
 *
 * @param config OAuth flow configuration
 * @param pkceParams PKCE parameters
 * @param redirectPort The port to use for the redirect URI
 * @param resource Optional resource parameter value (RFC 8707)
 * @returns The authorization URL
 */
export function buildAuthorizationUrl(
  config: OAuthFlowConfig,
  pkceParams: PKCEParams,
  redirectPort: number,
  resource?: string,
): string {
  const redirectUri =
    config.redirectUri || `http://localhost:${redirectPort}${REDIRECT_PATH}`;

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    state: pkceParams.state,
    code_challenge: pkceParams.codeChallenge,
    code_challenge_method: 'S256',
  });

  if (config.scopes && config.scopes.length > 0) {
    params.append('scope', config.scopes.join(' '));
  }

  if (config.audiences && config.audiences.length > 0) {
    params.append('audience', config.audiences.join(' '));
  }

  if (resource) {
    params.append('resource', resource);
  }

  const url = new URL(config.authorizationUrl);
  params.forEach((value, key) => {
    url.searchParams.append(key, value);
  });
  return url.toString();
}

/** An error response of an OAuth token endpoint (RFC 6749 §5.2). */
export class OAuthTokenEndpointError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The `error` code of the response, when it had one. */
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'OAuthTokenEndpointError';
  }
}

/**
 * Codes that prove the credentials invalid — the refresh token or the
 * client — rather than the attempt failing. The same the MCP SDK clears
 * credentials for.
 */
const INVALID_CREDENTIALS_CODES = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
]);

/**
 * Whether `error` shows the credentials used are invalid for good: one of
 * those codes, from the token endpoint itself. A 5xx or 429 is a failure of
 * the attempt whatever its body says (a proxy may relay one), so only a
 * 4xx answer counts; `invalid_client` may come as 401.
 */
export function isInvalidCredentialsError(error: unknown): boolean {
  return (
    error instanceof OAuthTokenEndpointError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429 &&
    error.code !== undefined &&
    INVALID_CREDENTIALS_CODES.has(error.code)
  );
}

/** The `error` and `error_description` of a JSON or form-encoded error body. */
function tokenEndpointError(body: string): {
  code: string | undefined;
  description: string | undefined;
} {
  try {
    const data = JSON.parse(body) as
      | { error?: unknown; error_description?: unknown }
      | null;
    if (data && typeof data.error === 'string') {
      return {
        code: data.error,
        description:
          typeof data.error_description === 'string'
            ? data.error_description
            : undefined,
      };
    }
    return { code: undefined, description: undefined };
  } catch {
    // Not JSON
  }
  const params = new URLSearchParams(body);
  return {
    code: params.get('error') ?? undefined,
    description: params.get('error_description') ?? undefined,
  };
}

/**
 * Parse a token endpoint response, handling both JSON and form-urlencoded formats.
 *
 * @param response The HTTP response from the token endpoint
 * @param operationName Human-readable operation name for error messages (e.g., "Token exchange", "Token refresh")
 * @param defaultErrorCode Default error code when access_token is missing (e.g., "no_access_token", "unknown_error")
 * @returns The parsed token response
 */
async function parseTokenEndpointResponse(
  response: Response,
  operationName: string,
  defaultErrorCode: string,
): Promise<OAuthTokenResponse> {
  const responseText = await response.text();
  const contentType = response.headers.get('content-type') || '';

  if (!response.ok) {
    const { code, description } = tokenEndpointError(responseText);
    const errorMessage = code
      ? `${operationName} failed: ${code} - ${description || 'No description'}`
      : `${operationName} failed: ${response.status} - ${responseText}`;
    throw new OAuthTokenEndpointError(errorMessage, response.status, code);
  }

  // Log unexpected content types for debugging
  if (
    !contentType.includes('application/json') &&
    !contentType.includes('application/x-www-form-urlencoded')
  ) {
    runLogger.warn(
      `${operationName} endpoint returned unexpected content-type: ${contentType}. ` +
        `Expected application/json or application/x-www-form-urlencoded. ` +
        `Will attempt to parse response.`,
    );
  }

  // Try to parse as JSON first, fall back to form-urlencoded
  try {
    const data: unknown = JSON.parse(responseText);
    if (
      data &&
      typeof data === 'object' &&
      'access_token' in data &&
      // eslint-disable-next-line eslint-js/no-restricted-syntax
      typeof (data as Record<string, unknown>)['access_token'] === 'string'
    ) {
      const obj = data as Record<string, unknown>;
      const result: OAuthTokenResponse = {
        access_token: String(obj['access_token']),
        token_type:
          // eslint-disable-next-line eslint-js/no-restricted-syntax
          typeof obj['token_type'] === 'string' ? obj['token_type'] : 'Bearer',
        expires_in:
          // eslint-disable-next-line eslint-js/no-restricted-syntax
          typeof obj['expires_in'] === 'number' ? obj['expires_in'] : undefined,
        refresh_token:
          // eslint-disable-next-line eslint-js/no-restricted-syntax
          typeof obj['refresh_token'] === 'string'
            ? obj['refresh_token']
            : undefined,
        // eslint-disable-next-line eslint-js/no-restricted-syntax
        scope: typeof obj['scope'] === 'string' ? obj['scope'] : undefined,
      };
      return result;
    }
    // JSON parsed but doesn't look like a token response — fall through
  } catch {
    // Not JSON — fall through to form-urlencoded parsing
  }

  // Parse form-urlencoded response
  const tokenParams = new URLSearchParams(responseText);
  const accessToken = tokenParams.get('access_token');
  const tokenType = tokenParams.get('token_type') || 'Bearer';
  const expiresIn = tokenParams.get('expires_in');
  const refreshToken = tokenParams.get('refresh_token');
  const scope = tokenParams.get('scope');

  if (!accessToken) {
    // Check for error in response
    const error = tokenParams.get('error');
    const errorDescription = tokenParams.get('error_description');
    throw new Error(
      `${operationName} failed: ${error || defaultErrorCode} - ${errorDescription || responseText}`,
    );
  }

  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: expiresIn ? parseInt(expiresIn, 10) : undefined,
    refresh_token: refreshToken || undefined,
    scope: scope || undefined,
  } as OAuthTokenResponse;
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param config OAuth flow configuration
 * @param code Authorization code
 * @param codeVerifier PKCE code verifier
 * @param redirectPort The port to use for the redirect URI
 * @param resource Optional resource parameter value (RFC 8707)
 * @returns The token response
 */
export async function exchangeCodeForToken(
  config: OAuthFlowConfig,
  code: string,
  codeVerifier: string,
  redirectPort: number,
  resource?: string,
): Promise<OAuthTokenResponse> {
  const redirectUri =
    config.redirectUri || `http://localhost:${redirectPort}${REDIRECT_PATH}`;

  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: config.clientId,
  });

  if (config.clientSecret) {
    params.append('client_secret', config.clientSecret);
  }

  if (config.audiences && config.audiences.length > 0) {
    params.append('audience', config.audiences.join(' '));
  }

  if (resource) {
    params.append('resource', resource);
  }

  const response = await unmanagedRequest(
    config.tokenUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
    { timeoutMs: OAUTH_TOKEN_REQUEST_TIMEOUT_MS },
  );

  return parseTokenEndpointResponse(
    response,
    'Token exchange',
    'no_access_token',
  );
}

/**
 * Refresh an access token using a refresh token.
 *
 * @param config OAuth configuration subset needed for refresh
 * @param refreshToken The refresh token
 * @param tokenUrl The token endpoint URL
 * @param resource Optional resource parameter value (RFC 8707)
 * @returns The new token response
 */
export async function refreshAccessToken(
  config: OAuthRefreshConfig,
  refreshToken: string,
  tokenUrl: string,
  resource?: string,
): Promise<OAuthTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  });

  if (config.clientSecret) {
    params.append('client_secret', config.clientSecret);
  }

  if (config.scopes && config.scopes.length > 0) {
    params.append('scope', config.scopes.join(' '));
  }

  if (config.audiences && config.audiences.length > 0) {
    params.append('audience', config.audiences.join(' '));
  }

  if (resource) {
    params.append('resource', resource);
  }

  const response = await unmanagedRequest(
    tokenUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
    { timeoutMs: OAUTH_TOKEN_REQUEST_TIMEOUT_MS },
  );

  return parseTokenEndpointResponse(response, 'Token refresh', 'unknown_error');
}
