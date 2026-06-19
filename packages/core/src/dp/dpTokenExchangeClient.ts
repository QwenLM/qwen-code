import { randomUUID } from 'node:crypto';

import { getNestorServerUrl } from './dpConfig.js';

const TOKEN_EXCHANGE_PATH = '/api/v2/token';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TokenResponse {
  token?: {
    created_at?: string;
    id?: string;
    expires_at?: string;
  };
  jwt: string;
}

export async function exchangeDpToken(
  dpToken: string,
  options: { serverUrl?: string; requestId?: string; timeoutMs?: number } = {},
): Promise<TokenResponse> {
  const origin = (options.serverUrl || getNestorServerUrl()).replace(
    /\/+$/,
    '',
  );
  const url = `${origin}${TOKEN_EXCHANGE_PATH}`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Request-Id': options.requestId || randomUUID(),
        Authorization: `Bearer ${dpToken}`,
      },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        // Ignore body read failures and report the HTTP status below.
      }
      throw new Error(
        `Nestor token exchange failed: HTTP ${response.status} ${response.statusText}${body ? `: ${body}` : ''}`,
      );
    }

    const data = (await response.json()) as TokenResponse;
    if (!data.jwt) {
      throw new Error('Nestor token exchange response is missing jwt');
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}
