/**
 * Generic OAuth 2.0 for API Sources
 *
 * Supports any OAuth 2.0 provider (GitHub, Linear, Notion, Spotify, etc.)
 * configured via ApiOAuthConfig in source config.json.
 *
 * Uses PKCE for all flows. Handles both JSON and application/x-www-form-urlencoded
 * token responses (GitHub returns form-encoded by default).
 */

import type { ApiOAuthConfig } from '../sources/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from './oauth-flow-types.ts';
import { generatePKCE, generateState } from './pkce.ts';

/**
 * Parse a token endpoint response that may be JSON or application/x-www-form-urlencoded.
 * GitHub (and some other providers) return form-encoded unless you send Accept: application/json.
 * We send Accept: application/json but tolerate form-encoded as a fallback.
 */
function parseTokenResponse(body: string, contentType: string | null): Record<string, unknown> {
  if (contentType?.includes('application/json')) {
    return JSON.parse(body);
  }
  // Try JSON first (many providers return JSON regardless of Content-Type)
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {
    // Not JSON — try form-urlencoded
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function readStringField(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field];
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined;
}

function readAccessToken(data: Record<string, unknown>): string | null {
  return readStringField(data, 'access_token') ?? null;
}

function parseExpiresIn(data: Record<string, unknown>): number | undefined {
  const raw = data.expires_in;
  if (raw == null || raw === '') return undefined;

  if (typeof raw === 'number') {
    if (Number.isSafeInteger(raw) && raw >= 0) return raw;
    throw new Error('Token response has invalid expires_in');
  }

  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Token response has invalid expires_in');
  }

  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Token response has invalid expires_in');
  }

  return value;
}

function expiresAtFromSeconds(expiresIn: number | undefined): number | undefined {
  return expiresIn == null ? undefined : Date.now() + expiresIn * 1000;
}

// ============================================================
// Prepare
// ============================================================

export interface PrepareGenericOAuthOptions {
  oauthConfig: ApiOAuthConfig;
  callbackPort?: number;
  callbackUrl?: string;
}

/**
 * Prepare the authorization URL for a generic OAuth flow.
 * Generates PKCE challenge and builds the auth URL with all configured parameters.
 */
export function prepareGenericOAuth(options: PrepareGenericOAuthOptions): PreparedOAuthFlow {
  const { oauthConfig, callbackPort, callbackUrl } = options;
  const pkce = generatePKCE();
  const state = generateState();
  const redirectUri = callbackUrl ?? `http://localhost:${callbackPort}/callback`;

  const authUrl = new URL(oauthConfig.authorizationUrl);
  authUrl.searchParams.set('client_id', oauthConfig.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  if (oauthConfig.scopes?.length) {
    authUrl.searchParams.set('scope', oauthConfig.scopes.join(' '));
  }
  if (oauthConfig.audience) {
    authUrl.searchParams.set('audience', oauthConfig.audience);
  }
  // Extra provider-specific params (e.g. access_type=offline)
  if (oauthConfig.extraParams) {
    for (const [key, value] of Object.entries(oauthConfig.extraParams)) {
      authUrl.searchParams.set(key, value);
    }
  }

  return {
    authUrl: authUrl.toString(),
    state,
    codeVerifier: pkce.codeVerifier,
    tokenEndpoint: oauthConfig.tokenUrl,
    clientId: oauthConfig.clientId,
    clientSecret: oauthConfig.clientSecret,
    redirectUri,
    provider: 'generic',
  };
}

// ============================================================
// Exchange
// ============================================================

/**
 * Exchange an authorization code for tokens at the generic OAuth token endpoint.
 * Handles both JSON and form-urlencoded responses.
 */
export async function exchangeGenericOAuth(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
  try {
    const body = new URLSearchParams({
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: params.redirectUri,
    });
    if (params.clientSecret) {
      body.set('client_secret', params.clientSecret);
    }

    const response = await fetch(params.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return { success: false, error: `Token exchange failed (${response.status}): ${errorText}` };
    }

    const responseBody = await response.text();
    const data = parseTokenResponse(responseBody, response.headers.get('content-type'));

    if (data.error) {
      return { success: false, error: `OAuth error: ${String(data.error)} — ${String(data.error_description ?? '')}` };
    }

    const accessToken = readAccessToken(data);
    if (!accessToken) {
      return { success: false, error: 'Token exchange response missing access_token' };
    }

    return {
      success: true,
      accessToken,
      refreshToken: readStringField(data, 'refresh_token'),
      expiresAt: expiresAtFromSeconds(parseExpiresIn(data)),
      oauthClientId: params.clientId,
      oauthClientSecret: params.clientSecret,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Generic OAuth exchange failed',
    };
  }
}

// ============================================================
// Refresh
// ============================================================

/**
 * Refresh a generic OAuth token.
 * tokenUrl and clientId come from the source config (not stored in credential).
 * clientSecret comes from stored credential, falling back to config.
 */
export async function refreshGenericOAuthToken(
  refreshToken: string,
  tokenUrl: string,
  clientId: string,
  clientSecret?: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
  }

  const responseBody = await response.text();
  const data = parseTokenResponse(responseBody, response.headers.get('content-type'));

  if (data.error) {
    throw new Error(`OAuth refresh error: ${String(data.error)} — ${String(data.error_description ?? '')}`);
  }

  const accessToken = readAccessToken(data);
  if (!accessToken) {
    throw new Error('Token refresh response missing access_token');
  }

  return {
    accessToken,
    refreshToken: readStringField(data, 'refresh_token'),
    expiresAt: expiresAtFromSeconds(parseExpiresIn(data)),
  };
}
