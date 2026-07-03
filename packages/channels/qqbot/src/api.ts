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
 * Validate the WebSocket Gateway URL to enforce TLS.
 * - Enforces wss:// protocol (hard boundary — throws on non-wss).
 * - Logs a stderr warning for unexpected hostnames (advisory only).
 *
 * The real security value is blocking a ws:// cleartext downgrade that would
 * leak the bot token in the IDENTIFY frame. Since data.url comes from QQ's
 * authenticated TLS /gateway endpoint, exploitability is low — this is
 * defense-in-depth, not true SSRF prevention.
 */
export function validateGatewayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:') {
      throw new Error(
        `QQ Bot gateway URL must use wss:// protocol, got: ${parsed.protocol}`,
      );
    }
    // Advisory: warn on unexpected gateway hostnames
    const hostname = parsed.hostname.toLowerCase();
    if (
      !hostname.endsWith('.qq.com') &&
      !hostname.endsWith('.tencent.com') &&
      !hostname.endsWith('.tencentcs.com')
    ) {
      process.stderr.write(
        `[QQ] Warning: unexpected gateway hostname: ${hostname}\n`,
      );
    }
    return url;
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error(`QQ Bot gateway URL is not a valid URL: ${url}`);
    }
    throw e;
  }
}

/**
 * Resolve the WebSocket Gateway URL.
 * Throws on HTTP errors or missing URL in the response.
 */
export async function fetchGatewayUrl(
  accessToken: string,
  sandbox: boolean,
): Promise<string> {
  const gw = sandbox ? `${SANDBOX_HOST}/gateway` : `${API_HOST}/gateway`;

  const resp = await fetch(gw, {
    headers: { Authorization: `QQBot ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!resp.ok) {
    throw new Error(`QQ Bot gateway request failed (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as { url?: string };
  if (!data['url']) {
    throw new Error('QQ Bot gateway response missing WebSocket URL');
  }
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
