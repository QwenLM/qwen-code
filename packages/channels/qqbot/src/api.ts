/**
 * QQ Bot HTTP API client.
 *
 * Encapsulates all REST calls to the QQ Bot API:
 *  - Access token issuance
 *  - WebSocket Gateway URL resolution
 *  - Message sending (text / markdown / ark / media)
 *  - Rich media file upload
 */

import type { MediaUploadResponse } from './types.js';

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
      `QQ Bot token request failed (HTTP ${resp.status}): ${body}`,
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
  return data['url'];
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

/**
 * Upload a rich media file to QQ's backend for later use in msg_type=7 messages.
 *
 * C2C and group uploads are separate — file_info from a C2C upload cannot be
 * sent to a group and vice versa. The returned file_info has a TTL; once it
 * expires the file must be re-uploaded.
 *
 * @param fileType — 1=image, 2=video, 3=voice, 4=file (4 is C2C-only)
 * @param url — publicly-accessible URL of the media file
 * @param srvSendMsg — if true, QQ sends the message directly and returns an id
 */
export async function uploadQQMedia(
  base: string,
  path: string,
  accessToken: string,
  fileType: number,
  url: string,
  srvSendMsg = false,
): Promise<MediaUploadResponse> {
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${accessToken}`,
    },
    body: JSON.stringify({
      file_type: fileType,
      url,
      srv_send_msg: srvSendMsg,
    }),
    signal: AbortSignal.timeout(60_000), // uploads may take longer
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(
      `QQ Bot media upload failed (HTTP ${resp.status}): ${body.slice(0, 200)}`,
    );
  }

  const data = (await resp.json()) as MediaUploadResponse;
  if (!data.file_info || !data.file_uuid) {
    throw new Error(
      'QQ Bot media upload response missing file_info or file_uuid',
    );
  }
  return data;
}
