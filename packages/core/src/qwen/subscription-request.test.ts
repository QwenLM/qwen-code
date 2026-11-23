/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, expect, it, vi } from 'vitest';
import {
  fetchSubscriptionInference,
  SUBSCRIPTION_IMAGE_URL,
} from './subscription-request.js';
import { QWEN_SUBSCRIPTION_BASE_URL } from './oauth-config.js';

const session = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  getAccessToken: vi.fn(),
}));
vi.mock('./subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    getIdentity = session.getIdentity;
    getAccessToken = session.getAccessToken;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  session.getIdentity.mockReturnValue('account-a');
  session.getAccessToken.mockResolvedValue('account-token');
});

it.each(['chat', 'image'] as const)(
  'sends %s only to the fixed gateway with the account token',
  async (kind) => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    await fetchSubscriptionInference(
      kind,
      {
        method: 'POST',
        body: '{"model":"selected"}',
        headers: { Authorization: 'Bearer wrong-provider' },
      },
      fetchFn,
    );
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(
      kind === 'image'
        ? SUBSCRIPTION_IMAGE_URL
        : `${QWEN_SUBSCRIPTION_BASE_URL}/chat/completions`,
    );
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer account-token',
    );
    expect(init?.redirect).toBe('error');
  },
);

it('refreshes a rejected token once and replays the same request', async () => {
  session.getAccessToken
    .mockResolvedValueOnce('expired')
    .mockResolvedValueOnce('fresh');
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    .mockResolvedValueOnce(new Response('{}'));
  await fetchSubscriptionInference(
    'image',
    { method: 'POST', body: 'same' },
    fetchFn,
  );
  expect(session.getAccessToken).toHaveBeenLastCalledWith(undefined, 'expired');
  expect(fetchFn).toHaveBeenCalledTimes(2);
  expect(fetchFn.mock.calls[1]?.[1]?.body).toBe('same');
});

it('does not retry quota errors and preserves retry timing', async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        error: { code: 'rate_limit_exceeded', message: 'Try later' },
      }),
      { status: 429, headers: { 'Retry-After': '60' } },
    ),
  );
  await expect(
    fetchSubscriptionInference('chat', {}, fetchFn),
  ).rejects.toMatchObject({
    code: 'rate_limit_exceeded',
    status: 429,
    retryAfterMs: 60_000,
  });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('does not retry an ambiguous image network failure', async () => {
  const fetchFn = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error('connection lost'));
  await expect(
    fetchSubscriptionInference('image', {}, fetchFn),
  ).rejects.toThrow('connection lost');
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('does not replay a request under a different account', async () => {
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async () => {
    session.getIdentity.mockReturnValue('account-b');
    return new Response('{}', { status: 401 });
  });
  await expect(
    fetchSubscriptionInference('chat', {}, fetchFn),
  ).rejects.toMatchObject({ code: 'session_changed' });
  expect(fetchFn).toHaveBeenCalledTimes(1);
});

it('does not make a request when signed out', async () => {
  session.getIdentity.mockReturnValue(undefined);
  const fetchFn = vi.fn<typeof fetch>();
  await expect(
    fetchSubscriptionInference('image', {}, fetchFn),
  ).rejects.toThrow('/auth');
  expect(fetchFn).not.toHaveBeenCalled();
});
