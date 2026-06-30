/**
 * QQ Bot HTTP API client.
 *
 * Encapsulates all REST calls to the QQ Bot API:
 *  - Access token issuance
 *  - WebSocket Gateway URL resolution
 *  - Message sending (text / markdown)
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_HOST = 'https://api.sgroup.qq.com';
const SANDBOX_HOST = 'https://sandbox.api.sgroup.qq.com';

/** Standard fetch timeout to avoid hanging on network failures. */
const FETCH_TIMEOUT = 15_000;

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

/**
 * Obtain an access token via appId + clientSecret.
 * Throws on HTTP errors or missing token in the response.
 */
export async function fetchAccessToken(
  appId: string,
  appSecret: string,
): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `QQ Bot token request failed (HTTP ${resp.status}): ${body.slice(0, 80)}`,
    );
  }

  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error('QQ Bot token response missing access_token');
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 7200,
  };
}

/**
 * Validate that a URL uses wss: or ws: protocol.
 * Returns the URL unchanged on success, throws on invalid protocol.
 * Used internally by fetchGatewayUrl and available for direct URL validation.
 */
export function validateGatewayUrl(url: string): string {
  const parsed = new URL(url);
  if (!['wss:', 'ws:'].includes(parsed.protocol)) {
    throw new Error(
      `QQ Bot gateway URL has invalid protocol: ${parsed.protocol}`,
    );
  }
  return url;
}

/**
 * Resolve the WebSocket Gateway URL.
 * When called with a single URL argument, validates the URL directly without
 * making an HTTP request.  When called with (accessToken, sandbox), fetches
 * the gateway endpoint then validates the returned URL.
 * Throws on HTTP errors, missing URL in the response, or invalid protocol.
 */
export async function fetchGatewayUrl(
  accessTokenOrUrl: string,
  sandbox?: boolean,
): Promise<string> {
  // Single-arg form: validate the URL directly (no HTTP call)
  if (sandbox === undefined) {
    return validateGatewayUrl(accessTokenOrUrl);
  }

  const gw = sandbox ? `${SANDBOX_HOST}/gateway` : `${API_HOST}/gateway`;

  const resp = await fetch(gw, {
    headers: { Authorization: `QQBot ${accessTokenOrUrl}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!resp.ok) {
    throw new Error(`QQ Bot gateway request failed (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as { url?: string };
  if (!data['url']) {
    throw new Error('QQ Bot gateway response missing WebSocket URL');
  }
  // Validate protocol to avoid routing the access token to a
  // compromised or misconfigured endpoint.
  return validateGatewayUrl(data['url']);
}

/** Determine the API base URL from the sandbox flag. */
export function getApiBase(sandbox: boolean): string {
  return sandbox ? SANDBOX_HOST : API_HOST;
}

/**
 * Send a message chunk to a QQ chat.
 * Resolves on success; caller should handle errors and msg_seq tracking.
 */
export async function sendQQMessage(
  base: string,
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${accessToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
}
