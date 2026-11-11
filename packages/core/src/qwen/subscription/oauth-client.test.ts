/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  QwenSubscriptionOAuthClient,
  QwenSubscriptionOAuthError,
} from './oauth-client.js';

const devicePayload = {
  device_code: 'device-1',
  user_code: 'USER-1',
  verification_uri: 'https://chat.qwen.ai/device',
  verification_uri_complete: 'https://chat.qwen.ai/device?user_code=USER-1',
  expires_in: 60,
  interval: 0.01,
};

const tokenPayload = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  token_type: 'Bearer' as const,
  expires_in: 3600,
  scope: 'model:invoke profile:read',
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function fetchMock(): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QwenSubscriptionOAuthClient', () => {
  it('requests a device code with the CLI client id and scope', async () => {
    const fetch = fetchMock().mockResolvedValue(jsonResponse(devicePayload));
    const before = Date.now();

    const device = await new QwenSubscriptionOAuthClient().requestDeviceAuthorization();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://auth.qwen.ai/api/oauth/device/code');
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('client_id')).toBe('qwen-code-cli');
    expect(body.get('scope')).toBe('model:invoke profile:read');
    expect(device.device_code).toBe('device-1');
    expect(device.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
  });

  it('polls through authorization_pending before the token pair', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({ error: 'authorization_pending' }, 400),
      )
      .mockResolvedValueOnce(jsonResponse(tokenPayload));

    const tokens = await new QwenSubscriptionOAuthClient().pollForToken({
      ...devicePayload,
      expiresAt: Date.now() + 60_000,
    });

    expect(tokens.access_token).toBe('access-1');
    expect(fetch).toHaveBeenCalledTimes(2);
    const body = new URLSearchParams(String(fetch.mock.calls[0]![1]?.body));
    expect(body.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(body.get('device_code')).toBe('device-1');
  });

  it('keeps OAuth code, status and Retry-After on denial', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse(
        { error: 'access_denied', error_description: 'User denied access' },
        400,
        { 'Retry-After': '7' },
      ),
    );

    const error = await new QwenSubscriptionOAuthClient()
      .pollForToken({ ...devicePayload, expiresAt: Date.now() + 60_000 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(QwenSubscriptionOAuthError);
    expect(error).toMatchObject({
      code: 'access_denied',
      status: 400,
      description: 'User denied access',
      retryAfterMs: 7000,
      stage: 'exchange',
    });
  });

  it('refreshes with the rotating grant', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(jsonResponse(tokenPayload));

    const tokens = await new QwenSubscriptionOAuthClient().refreshToken(
      'refresh-1',
    );

    expect(tokens.refresh_token).toBe('refresh-1');
    const body = new URLSearchParams(String(fetch.mock.calls[0]![1]?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh-1');
  });

  it('sends the access token to userinfo', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(
      jsonResponse({
        sub: 'user-1',
        name: 'Ada',
        email: 'ada@example.com',
        member_type: 'plus',
      }),
    );

    const info = await new QwenSubscriptionOAuthClient().getUserInfo(
      'access-1',
    );

    expect(info.member_type).toBe('plus');
    const init = fetch.mock.calls[0]![1];
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer access-1',
    );
  });

  it('revokes a token without parsing a body', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(
      new Response(null, { status: 200 }),
    );

    await new QwenSubscriptionOAuthClient().revokeToken('refresh-1');

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://auth.qwen.ai/api/oauth/revoke');
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('token')).toBe('refresh-1');
    expect(body.get('token_type_hint')).toBe('refresh_token');
  });
});
