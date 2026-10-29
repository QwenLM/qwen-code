/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  QwenSubscriptionOAuthClient,
  SubscriptionOAuthError,
  type SubscriptionDeviceAuthorization,
} from './subscription-oauth-client.js';

const fetchMock = vi.fn<typeof fetch>();
const device = {
  device_code: 'device-secret',
  user_code: 'BCDF-GHJK',
  verification_uri: 'https://oauth.example.test/device',
  verification_uri_complete:
    'https://oauth.example.test/device?user_code=BCDF-GHJK',
  expires_in: 600,
  interval: 5,
};
const tokens = {
  access_token: 'access-one',
  refresh_token: 'refresh-one',
  token_type: 'Bearer',
  expires_in: 900,
  scope: 'model:invoke profile:read',
};
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
const authorization = (): SubscriptionDeviceAuthorization => ({
  ...device,
  expiresAt: Date.now() + 600_000,
});
const bodyAt = (index: number) =>
  Object.fromEntries(
    new URLSearchParams(String(fetchMock.mock.calls[index][1]?.body)),
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('subscription OAuth protocol', () => {
  it('requests the new client and scopes without PKCE and records an absolute expiry', async () => {
    fetchMock.mockResolvedValue(json(device));
    const issuedAt = Date.now();
    const result =
      await new QwenSubscriptionOAuthClient().requestDeviceAuthorization();
    expect(result).toEqual({ ...device, expiresAt: issuedAt + 600_000 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://pre-auth.qwen.ai/api/oauth/device/code',
    );
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(bodyAt(0)).toEqual({
      client_id: 'qwen-code-cli',
      scope: 'model:invoke profile:read',
    });
  });

  it('uses the registered client ID even when an old override is present', async () => {
    vi.stubEnv('QWEN_OAUTH_CLIENT_ID', 'test-client');
    fetchMock.mockResolvedValue(json(device));
    await new QwenSubscriptionOAuthClient().requestDeviceAuthorization();
    expect(bodyAt(0)['client_id']).toBe('qwen-code-cli');
  });

  it('polls at the returned interval and exchanges after authorization', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: 'authorization_pending' }, 400),
    );
    fetchMock.mockResolvedValueOnce(json(tokens));
    const result = new QwenSubscriptionOAuthClient().pollForToken(
      authorization(),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toEqual(tokens);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://pre-auth.qwen.ai/api/oauth/token',
    );
    expect(bodyAt(1)).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: 'qwen-code-cli',
      device_code: 'device-secret',
    });
    expect(await result).not.toHaveProperty('resource_url');
  });

  it('increases slow_down by five seconds and keeps that interval after pending', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: 'slow_down' }, 400));
    fetchMock.mockResolvedValueOnce(
      json({ error: 'authorization_pending' }, 400),
    );
    fetchMock.mockResolvedValueOnce(json(tokens));
    const result = new QwenSubscriptionOAuthClient().pollForToken(
      authorization(),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual(tokens);
  });

  it.each([
    'access_denied',
    'expired_token',
    'invalid_grant',
    'invalid_client',
  ])('stops polling for %s', async (code) => {
    fetchMock.mockResolvedValue(json({ error: code }, 400));
    const result = new QwenSubscriptionOAuthClient().pollForToken(
      authorization(),
    );
    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await rejection).toMatchObject({
      code,
      status: 400,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['503', 'network'])(
    'backs off on %s and resumes without restarting authorization',
    async (failure) => {
      if (failure === '503') {
        fetchMock.mockResolvedValueOnce(
          json({ error: 'temporarily_unavailable' }, 503),
        );
      } else {
        fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
      }
      fetchMock.mockResolvedValueOnce(json(tokens));
      const result = new QwenSubscriptionOAuthClient().pollForToken(
        authorization(),
      );
      await vi.advanceTimersByTimeAsync(14_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual(tokens);
    },
  );

  it.each(['20', 'Mon, 26 Oct 2026 00:00:25 GMT'])(
    'respects Retry-After %s for rate limiting',
    async (retryAfter) => {
      fetchMock.mockResolvedValueOnce(
        json({ error: 'rate_limited' }, 429, { 'Retry-After': retryAfter }),
      );
      fetchMock.mockResolvedValueOnce(json(tokens));
      const result = new QwenSubscriptionOAuthClient().pollForToken(
        authorization(),
      );
      await vi.advanceTimersByTimeAsync(24_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual(tokens);
    },
  );

  it('cancels during the interval without making another request', async () => {
    const controller = new AbortController();
    const result = new QwenSubscriptionOAuthClient().pollForToken(
      authorization(),
      controller.signal,
    );
    const rejection = result.catch((error: unknown) => error);
    controller.abort();
    expect(await rejection).toMatchObject({
      name: 'AbortError',
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates cancellation into an in-flight token request', async () => {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => reject(options!.signal!.reason),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const result = new QwenSubscriptionOAuthClient().pollForToken(
      authorization(),
      controller.signal,
    );
    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    controller.abort();
    expect(await rejection).toMatchObject({
      name: 'AbortError',
    });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('expires at the original deadline even after slow_down', async () => {
    fetchMock.mockResolvedValue(json({ error: 'slow_down' }, 400));
    const auth = { ...authorization(), expiresAt: Date.now() + 12_000 };
    const result = new QwenSubscriptionOAuthClient().pollForToken(auth);
    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await rejection).toMatchObject({
      code: 'expired_token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not restart the lifetime when polling begins late', async () => {
    const auth = authorization();
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(
      new QwenSubscriptionOAuthClient().pollForToken(auth),
    ).rejects.toMatchObject({ code: 'expired_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts an in-flight request at device expiry', async () => {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => reject(options!.signal!.reason),
            { once: true },
          );
        }),
    );
    const result = new QwenSubscriptionOAuthClient().pollForToken({
      ...authorization(),
      expiresAt: Date.now() + 12_000,
    });
    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await rejection).toMatchObject({ code: 'expired_token' });
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('does not poll early when Retry-After exceeds the device lifetime', async () => {
    fetchMock.mockResolvedValue(
      json({ error: 'rate_limited' }, 429, { 'Retry-After': '999999999' }),
    );
    const result = new QwenSubscriptionOAuthClient().pollForToken(
      authorization(),
    );
    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await rejection).toMatchObject({ code: 'expired_token' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed device response before polling', async () => {
    fetchMock.mockResolvedValue(json({ ...device, interval: 0 }));
    await expect(
      new QwenSubscriptionOAuthClient().requestDeviceAuthorization(),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('returns rotated refresh tokens for subsequent refresh and revoke', async () => {
    const client = new QwenSubscriptionOAuthClient();
    fetchMock.mockResolvedValueOnce(
      json({ ...tokens, refresh_token: 'refresh-two' }),
    );
    fetchMock.mockResolvedValueOnce(
      json({ ...tokens, refresh_token: 'refresh-three' }),
    );
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const first = await client.refreshToken('refresh-one');
    const second = await client.refreshToken(first.refresh_token);
    await client.revokeToken(second.refresh_token);
    expect(bodyAt(0)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'qwen-code-cli',
      refresh_token: 'refresh-one',
    });
    expect(bodyAt(1)['refresh_token']).toBe('refresh-two');
    expect(bodyAt(2)).toEqual({
      client_id: 'qwen-code-cli',
      token: 'refresh-three',
      token_type_hint: 'refresh_token',
    });
    expect(fetchMock.mock.calls[2][0]).toBe(
      'https://pre-auth.qwen.ai/api/oauth/revoke',
    );
  });

  it.each(['invalid_grant', 'invalid_scope', 'invalid_client'])(
    'preserves the refresh error distinction: %s',
    async (code) => {
      fetchMock.mockResolvedValue(
        json({ error: code, error_description: 'Rejected' }, 400),
      );
      await expect(
        new QwenSubscriptionOAuthClient().refreshToken('refresh-one'),
      ).rejects.toMatchObject({ code, status: 400, description: 'Rejected' });
    },
  );

  it('loads identity and membership using the device access token', async () => {
    const identity = {
      sub: 'user-1',
      name: 'User',
      email: 'user@example.com',
      member_type: 'free',
    };
    fetchMock.mockResolvedValue(json(identity));
    const result = await new QwenSubscriptionOAuthClient().getUserInfo(
      'access-one',
    );
    expect(result).toEqual(identity);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://pre-auth.qwen.ai/api/oauth/userinfo',
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer access-one' },
    });
    expect(result).not.toHaveProperty('profile_image_url');
  });

  it('does not expose HTML error responses', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>private upstream information</html>', {
        status: 405,
      }),
    );
    await expect(
      new QwenSubscriptionOAuthClient().requestDeviceAuthorization(),
    ).rejects.toMatchObject({ message: 'invalid_response', status: 405 });
  });

  it('rejects incomplete token responses instead of retaining an old refresh token', async () => {
    fetchMock.mockResolvedValue(
      json({ access_token: 'access-two', expires_in: 900 }),
    );
    await expect(
      new QwenSubscriptionOAuthClient().refreshToken('refresh-one'),
    ).rejects.toBeInstanceOf(SubscriptionOAuthError);
  });

  it('times out requests without retrying a potentially consumed refresh token', async () => {
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener(
            'abort',
            () => reject(options!.signal!.reason),
            { once: true },
          );
        }),
    );
    const result = new QwenSubscriptionOAuthClient().refreshToken(
      'refresh-one',
    );
    const rejection = result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await rejection).toMatchObject({
      code: 'request_timeout',
      stage: 'refresh',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it('classifies the polling deadline by its own abort signal even if the clock is just before expiry', async () => {
  const expiresAt = Date.now() + 1000;
  const result = new QwenSubscriptionOAuthClient().pollForToken({
    ...authorization(),
    expiresAt,
  });
  const rejection = result.catch((error: unknown) => error);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    expect(await rejection).toMatchObject({
      code: 'expired_token',
      stage: 'exchange',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
