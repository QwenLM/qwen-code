/**
 * Google OAuth flow using Google's OAuth 2.0 with PKCE
 *
 * This module handles the complete Google OAuth flow for any Google API:
 * 1. Opens browser for Google consent screen
 * 2. Receives authorization code via local callback server
 * 3. Exchanges code for access and refresh tokens
 * 4. Returns tokens and user email
 *
 * Supports multiple Google services (Gmail, Calendar, Drive) with predefined
 * scope sets, or custom scopes for other Google APIs.
 */

import { URL } from 'url';
import { randomBytes, createHash } from 'crypto';
import { openUrl } from '../utils/open-url.ts';
import { createCallbackServer, type AppType } from './callback-server.ts';
import { type GoogleService } from '../sources/types.ts';
import { type OAuthSessionContext, buildOAuthDeeplinkUrl } from './types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';

// Re-export GoogleService type for convenient access
export type { GoogleService };

// Google OAuth configuration - environment variables used as fallback
// Users can provide their own credentials via source config (preferred for OSS)
// These env vars are only used if credentials are not provided explicitly
// Note: Google requires client_secret for Desktop apps despite PKCE support
const GOOGLE_CLIENT_ID_ENV = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET_ENV = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

/**
 * Predefined scope sets for common Google services
 */
export const GOOGLE_SERVICE_SCOPES: Record<GoogleService, string[]> = {
  gmail: [
    'https://www.googleapis.com/auth/gmail.modify', // Read, trash, labels, mark read/unread
    'https://www.googleapis.com/auth/gmail.compose', // Create and send drafts
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  calendar: [
    'https://www.googleapis.com/auth/calendar', // Full calendar access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  drive: [
    'https://www.googleapis.com/auth/drive', // Full Drive access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  docs: [
    'https://www.googleapis.com/auth/documents', // Full Docs access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  sheets: [
    'https://www.googleapis.com/auth/spreadsheets', // Full Sheets access
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  youtube: [
    'https://www.googleapis.com/auth/youtube.readonly', // Read channel, video, playlist data
    'https://www.googleapis.com/auth/youtube.force-ssl', // Manage content (comments, playlists, etc.)
    'https://www.googleapis.com/auth/userinfo.email',
  ],
  searchconsole: [
    'https://www.googleapis.com/auth/webmasters.readonly', // Read Search Console data
    'https://www.googleapis.com/auth/userinfo.email',
  ],
};

/**
 * Options for starting Google OAuth flow
 */
export interface GoogleOAuthOptions {
  /** Google service to authenticate (uses predefined scopes) */
  service?: GoogleService;
  /** Custom scopes (overrides service scopes if provided) */
  scopes?: string[];
  /** App type for callback server styling */
  appType?: AppType;
  /** OAuth client ID (user-provided, falls back to env var) */
  clientId?: string;
  /** OAuth client secret (user-provided, falls back to env var) */
  clientSecret?: string;
  /** Session context for building deeplink back to chat after OAuth */
  sessionContext?: OAuthSessionContext;
}

/**
 * Result of Google OAuth flow
 */
export interface GoogleOAuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
  error?: string;
  /** OAuth client ID used (for storage alongside tokens) */
  clientId?: string;
  /** OAuth client secret used (for storage alongside tokens - needed for refresh) */
  clientSecret?: string;
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
  redirectUri: string,
  clientId: string,
  clientSecret: string
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
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
 * Get user email from access token
 */
async function getUserEmail(accessToken: string): Promise<string> {
  const response = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  const data = (await response.json()) as { email: string };
  return data.email;
}

/**
 * Refresh Google access token using refresh token
 *
 * @param refreshToken - The refresh token from initial OAuth
 * @param clientId - OAuth client ID (falls back to env var if not provided)
 * @param clientSecret - OAuth client secret (falls back to env var if not provided)
 */
export async function refreshGoogleToken(
  refreshToken: string,
  clientId?: string,
  clientSecret?: string
): Promise<{
  accessToken: string;
  expiresAt?: number;
}> {
  const id = clientId || GOOGLE_CLIENT_ID_ENV;
  const secret = clientSecret || GOOGLE_CLIENT_SECRET_ENV;

  if (!id || !secret) {
    throw new Error(
      'Google OAuth credentials not available for token refresh. ' +
        'Credentials must be stored with the token or set via environment variables.'
    );
  }

  const params = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    throw new Error('Failed to refresh Google token');
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/**
 * Check if Google OAuth is configured (client ID and secret are available)
 *
 * @param clientId - Optional user-provided client ID
 * @param clientSecret - Optional user-provided client secret
 * @returns true if credentials are available (either provided or from env vars)
 */
export function isGoogleOAuthConfigured(clientId?: string, clientSecret?: string): boolean {
  const id = clientId || GOOGLE_CLIENT_ID_ENV;
  const secret = clientSecret || GOOGLE_CLIENT_SECRET_ENV;
  return Boolean(id && secret);
}

/**
 * Get scopes for a Google service or use custom scopes
 */
export function getGoogleScopes(options: GoogleOAuthOptions): string[] {
  // Custom scopes take precedence
  if (options.scopes && options.scopes.length > 0) {
    // Ensure userinfo.email is included for email retrieval
    const emailScope = 'https://www.googleapis.com/auth/userinfo.email';
    if (!options.scopes.includes(emailScope)) {
      return [...options.scopes, emailScope];
    }
    return options.scopes;
  }

  // Use predefined service scopes
  if (options.service && options.service in GOOGLE_SERVICE_SCOPES) {
    return GOOGLE_SERVICE_SCOPES[options.service];
  }

  // Default to Gmail scopes for backwards compatibility
  return GOOGLE_SERVICE_SCOPES.gmail;
}

/**
 * Options for preparing a Google OAuth flow (server-side, no browser interaction)
 */
export interface PrepareGoogleOAuthOptions {
  service?: GoogleService;
  scopes?: string[];
  /** Port for the local callback server (Electron). One of callbackPort or callbackUrl required. */
  callbackPort?: number;
  /** Full callback URL (WebUI). Takes precedence over callbackPort. */
  callbackUrl?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Prepare a Google OAuth flow without starting a callback server or opening a browser.
 * Returns everything needed to construct the auth URL and later exchange the code.
 */
export function prepareGoogleOAuth(options: PrepareGoogleOAuthOptions): PreparedOAuthFlow {
  const clientId = options.clientId || GOOGLE_CLIENT_ID_ENV;
  const clientSecret = options.clientSecret || GOOGLE_CLIENT_SECRET_ENV;

  if (!isGoogleOAuthConfigured(clientId, clientSecret)) {
    throw new Error(
      'Google OAuth not configured. Provide clientId and clientSecret in source config, ' +
      'or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables.'
    );
  }

  const scopes = getGoogleScopes(options);
  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = options.callbackUrl
    ?? `http://localhost:${options.callbackPort}/callback`;

  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.verifier,
    tokenEndpoint: GOOGLE_TOKEN_URL,
    clientId,
    clientSecret,
    redirectUri,
    provider: 'google',
  };
}

/**
 * Exchange a Google authorization code for tokens (server-side).
 * Also fetches the user's email address.
 */
export async function exchangeGoogleOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const tokens = await exchangeCodeForTokens(
      params.code,
      params.codeVerifier,
      params.redirectUri,
      params.clientId,
      params.clientSecret || ''
    );

    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
      oauthClientId: params.clientId,
      oauthClientSecret: params.clientSecret,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Google OAuth exchange failed',
    };
  }
}

/**
 * Start Google OAuth flow
 *
 * Opens browser for Google consent, handles callback, and returns tokens + email.
 * Supports multiple Google services via the service option, or custom scopes.
 *
 * @example
 * // Authenticate for Gmail
 * const result = await startGoogleOAuth({ service: 'gmail' });
 *
 * @example
 * // Authenticate for Google Calendar
 * const result = await startGoogleOAuth({ service: 'calendar' });
 *
 * @example
 * // Authenticate with custom scopes
 * const result = await startGoogleOAuth({
 *   scopes: ['https://www.googleapis.com/auth/spreadsheets']
 * });
 */
export async function startGoogleOAuth(
  options: GoogleOAuthOptions = {}
): Promise<GoogleOAuthResult> {
  try {
    // Resolve credentials: use provided values or fall back to env vars
    const clientId = options.clientId || GOOGLE_CLIENT_ID_ENV;
    const clientSecret = options.clientSecret || GOOGLE_CLIENT_SECRET_ENV;

    // Verify OAuth credentials are configured
    if (!isGoogleOAuthConfigured(clientId, clientSecret)) {
      return {
        success: false,
        error:
          'Google OAuth not configured. Provide clientId and clientSecret in source config, ' +
          'or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET environment variables.',
      };
    }

    // Get scopes for this request
    const scopes = getGoogleScopes(options);

    // Generate PKCE and state
    const pkce = generatePKCE();
    const state = generateState();

    // Start callback server with deeplink for returning to chat session
    const appType = options.appType || 'electron';
    const deeplinkUrl = buildOAuthDeeplinkUrl(options.sessionContext);
    const callbackServer = await createCallbackServer({ appType, deeplinkUrl });
    const redirectUri = `${callbackServer.url}/callback`;

    // Build authorization URL
    const authUrl = new URL(GOOGLE_AUTH_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline'); // Request refresh token
    authUrl.searchParams.set('prompt', 'consent'); // Always show consent to get refresh token

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
      const isAccessBlocked =
        callback.query.error === 'access_denied' &&
        String(callback.query.error_description ?? '').toLowerCase().includes('verif');
      const error = isAccessBlocked
        ? 'Google has blocked this app (not yet verified).\n\n' +
          'To fix this, add your own Google OAuth credentials to the source config:\n' +
          '  "googleOAuthClientId": "...",\n' +
          '  "googleOAuthClientSecret": "..."\n\n' +
          'See: https://console.cloud.google.com/apis/credentials'
        : callback.query.error_description || callback.query.error;
      return { success: false, error };
    }

    // Get authorization code
    const code = callback.query.code;
    if (!code) {
      return {
        success: false,
        error: 'No authorization code received',
      };
    }

    // Exchange code for tokens (pass credentials for token exchange)
    const tokens = await exchangeCodeForTokens(code, pkce.verifier, redirectUri, clientId, clientSecret);

    // Get user email
    const email = await getUserEmail(tokens.accessToken);

    return {
      success: true,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : undefined,
      email,
      // Return credentials so they can be stored for token refresh
      clientId,
      clientSecret,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during Google OAuth',
    };
  }
}
