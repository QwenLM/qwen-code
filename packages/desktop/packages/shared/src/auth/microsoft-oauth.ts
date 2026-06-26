/**
 * Microsoft OAuth flow using Azure AD OAuth 2.0 with PKCE
 *
 * This module handles the complete Microsoft OAuth flow for Microsoft 365 APIs:
 * 1. Opens browser for Microsoft consent screen
 * 2. Receives authorization code via local callback server
 * 3. Exchanges code for access and refresh tokens
 * 4. Returns tokens and user email
 *
 * Supports multiple Microsoft services (Outlook, OneDrive, Calendar, Teams)
 * with predefined scope sets, or custom scopes for other Microsoft Graph APIs.
 *
 * Uses "common" tenant endpoint to support both personal Microsoft accounts
 * and work/school (Azure AD) accounts.
 */

import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { createCallbackServer, type AppType } from './callback-server.ts';
import { type MicrosoftService } from '../sources/types.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';

// Re-export MicrosoftService type for convenient access
export type { MicrosoftService };

// Microsoft OAuth configuration - must be set via environment variables
// These are baked into the build at compile time
// Used for all Microsoft services (Outlook, OneDrive, Calendar, Teams, etc.)
// Uses pure PKCE flow - no client_secret needed for public clients (desktop/mobile apps)
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_OAUTH_CLIENT_ID || '';

// Microsoft OAuth endpoints (using "common" tenant for multi-tenant support)
// "common" supports both personal Microsoft accounts and work/school accounts
const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MICROSOFT_GRAPH_ME_URL = 'https://graph.microsoft.com/v1.0/me';

/**
 * Predefined scope sets for common Microsoft services
 *
 * Microsoft Graph uses delegated permissions with format:
 * https://graph.microsoft.com/{permission}
 *
 * Common permissions:
 * - User.Read: Sign in and read user profile
 * - Mail.Read/ReadWrite/Send: Email access
 * - Calendars.Read/ReadWrite: Calendar access
 * - Files.Read/ReadWrite: OneDrive access
 * - Chat.Read/ReadWrite: Teams chat access
 * - offline_access: Required for refresh tokens
 */
export const MICROSOFT_SERVICE_SCOPES: Record<MicrosoftService, string[]> = {
  outlook: [
    'https://graph.microsoft.com/Mail.ReadWrite',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  'microsoft-calendar': [
    'https://graph.microsoft.com/Calendars.ReadWrite',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  onedrive: [
    'https://graph.microsoft.com/Files.ReadWrite',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  teams: [
    'https://graph.microsoft.com/Chat.ReadWrite',
    'https://graph.microsoft.com/ChannelMessage.Send',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
  sharepoint: [
    'https://graph.microsoft.com/Sites.ReadWrite.All',
    'https://graph.microsoft.com/User.Read',
    'offline_access',
  ],
};

/**
 * Options for starting Microsoft OAuth flow
 */
export interface MicrosoftOAuthOptions {
  /** Microsoft service to authenticate (uses predefined scopes) */
  service?: MicrosoftService;
  /** Custom scopes (overrides service scopes if provided) */
  scopes?: string[];
  /** App type for callback server styling */
  appType?: AppType;
  /** Session context for building deeplink back to chat after OAuth */
  sessionContext?: OAuthSessionContext;
}

/**
 * Result of Microsoft OAuth flow
 */
export interface MicrosoftOAuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  error?: string;
}

/**
 * Generate PKCE code verifier and challenge
 */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Generate random state for CSRF protection
 */
function generateState(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Get user email from access token using Microsoft Graph API
 */
async function getUserEmail(accessToken: string): Promise<string> {
  const response = await fetch(MICROSOFT_GRAPH_ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info from Microsoft Graph');
  }

  const data = (await response.json()) as {
    mail?: string;
    userPrincipalName?: string;
  };

  // Microsoft Graph returns 'mail' for work accounts, 'userPrincipalName' as fallback
  // For personal accounts, userPrincipalName is typically the email
  return data.mail || data.userPrincipalName || 'unknown';
}

/**
 * Refresh Microsoft access token using refresh token
 */
export async function refreshMicrosoftToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}> {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(MICROSOFT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error('Failed to refresh Microsoft token');
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    // Microsoft may return a new refresh token (rotation)
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * Check if Microsoft OAuth is configured (client ID is set)
 * Note: Client secret is optional for public clients using PKCE
 */
export function isMicrosoftOAuthConfigured(): boolean {
  return Boolean(MICROSOFT_CLIENT_ID);
}

/**
 * Get scopes for a Microsoft service or use custom scopes
 */
export function getMicrosoftScopes(options: MicrosoftOAuthOptions): string[] {
  // Custom scopes take precedence
  if (options.scopes && options.scopes.length > 0) {
    // Ensure required scopes are included
    const requiredScopes = ['https://graph.microsoft.com/User.Read', 'offline_access'];
    const allScopes = [...options.scopes];
    for (const scope of requiredScopes) {
      if (!allScopes.includes(scope)) {
        allScopes.push(scope);
      }
    }
    return allScopes;
  }

  // Use predefined service scopes
  if (options.service && options.service in MICROSOFT_SERVICE_SCOPES) {
    return MICROSOFT_SERVICE_SCOPES[options.service];
  }

  // Default to Outlook scopes for backwards compatibility
  return MICROSOFT_SERVICE_SCOPES.outlook;
}

/**
 * Options for preparing a Microsoft OAuth flow (server-side, no browser interaction)
 */
export interface PrepareMicrosoftOAuthOptions {
  service?: MicrosoftService;
  scopes?: string[];
  /** Port for the local callback server (Electron). One of callbackPort or callbackUrl required. */
  callbackPort?: number;
  /** Full callback URL (WebUI). Takes precedence over callbackPort. */
  callbackUrl?: string;
}

/**
 * Prepare a Microsoft OAuth flow without starting a callback server or opening a browser.
 * Returns everything needed to construct the auth URL and later exchange the code.
 */
export function prepareMicrosoftOAuth(options: PrepareMicrosoftOAuthOptions): PreparedOAuthFlow {
  if (!isMicrosoftOAuthConfigured()) {
    throw new Error(
      'Microsoft OAuth not configured. Set MICROSOFT_OAUTH_CLIENT_ID environment variable.'
    );
  }

  const scopes = getMicrosoftScopes(options);
  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}/callback`;

  const authUrl = new URL(MICROSOFT_AUTH_URL);
  authUrl.searchParams.set('client_id', MICROSOFT_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('response_mode', 'query');
  authUrl.searchParams.set('prompt', 'consent');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: MICROSOFT_TOKEN_URL,
    clientId: MICROSOFT_CLIENT_ID,
    redirectUri,
    provider: 'microsoft',
  };
}

/**
 * Exchange a Microsoft authorization code for tokens (server-side).
 * Also fetches the user's email/UPN via Microsoft Graph.
 */
export async function exchangeMicrosoftOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeCodeForTokens(params.code, params.codeVerifier, params.redirectUri);

    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Microsoft OAuth exchange failed',
    };
  }
}

/**
 * Start Microsoft OAuth flow
 *
 * Opens browser for Microsoft consent, handles callback, and returns tokens + email.
 * Supports multiple Microsoft services via the service option, or custom scopes.
 *
 * @example
 * // Authenticate for Outlook
 * const result = await startMicrosoftOAuth({ service: 'outlook' });
 *
 * @example
 * // Authenticate for OneDrive
 * const result = await startMicrosoftOAuth({ service: 'onedrive' });
 *
 * @example
 * // Authenticate with custom scopes
 * const result = await startMicrosoftOAuth({
 *   scopes: ['https://graph.microsoft.com/Tasks.ReadWrite']
 * });
 */
export async function startMicrosoftOAuth(
  options: MicrosoftOAuthOptions = {}
): Promise<MicrosoftOAuthResult> {
  try {
    // Verify OAuth credentials are configured
    if (!isMicrosoftOAuthConfigured()) {
      return {
        success: false,
        error:
          'Microsoft OAuth not configured. Set MICROSOFT_OAUTH_CLIENT_ID environment variable.',
      };
    }

    // Get scopes for this request
    const scopes = getMicrosoftScopes(options);

    // Generate PKCE and state
    const pkce = generatePKCE();
    const state = generateState();

    // Start callback server with deeplink for returning to chat session
    const appType = options.appType || 'electron';
    const deeplinkUrl = buildOAuthDeeplinkUrl(options.sessionContext);
    const callbackServer = await createCallbackServer({ appType, deeplinkUrl });
    const redirectUri = `${callbackServer.url}/callback`;

    // Build authorization URL
    const authUrl = new URL(MICROSOFT_AUTH_URL);
    authUrl.searchParams.set('client_id', MICROSOFT_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    // Response mode 'query' returns code in URL query params (default for authorization_code)
    authUrl.searchParams.set('response_mode', 'query');
    // Prompt 'consent' forces consent screen to ensure we get refresh token
    authUrl.searchParams.set('prompt', 'consent');

    // Open browser for authorization
    await openUrl(authUrl.toString());

    // Wait for callback
    const callback = await callbackServer.promise;

    // Verify state
    if (callback.query.state !== state) {
      return {
        success: false,
        error: 'OAuth state mismatch - possible CSRF attack',
      };
    }

    // Check for error
    if (callback.query.error) {
      return {
        success: false,
        error: callback.query.error_description || callback.query.error,
      };
    }

    // Get authorization code
    const code = callback.query.code;
    if (!code) {
      return {
        success: false,
        error: 'No authorization code received',
      };
    }

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri);

    // Get user email
    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during Microsoft OAuth',
    };
  }
}
