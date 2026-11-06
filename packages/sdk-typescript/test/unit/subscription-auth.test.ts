/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';

const baseUrl = 'http://127.0.0.1:3131';
function clientWith(status = 200, body: unknown = {}) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(
      async () =>
        new Response(status === 204 ? null : JSON.stringify(body), { status }),
    );
  return {
    client: new DaemonClient({ baseUrl, token: 'daemon-token', fetch }),
    fetch,
  };
}
describe('Subscription transport', () => {
  it('uses process-global routes and daemon credentials', async () => {
    const { client, fetch } = clientWith();
    await client.getSubscriptionConfig();
    await client.startSubscriptionLogin();
    await client.getSubscriptionLogin('flow/id');
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.cancelSubscriptionLogin('flow/id');
    await client.getSubscriptionUserInfo();
    await client.signOutSubscription();
    expect(
      fetch.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET']),
    ).toEqual([
      [`${baseUrl}/auth/subscription`, 'GET'],
      [`${baseUrl}/auth/subscription/flows`, 'POST'],
      [`${baseUrl}/auth/subscription/flows/flow%2Fid`, 'GET'],
      [`${baseUrl}/auth/subscription/flows/flow%2Fid`, 'DELETE'],
      [`${baseUrl}/auth/subscription/userinfo`, 'POST'],
      [`${baseUrl}/auth/subscription/revoke`, 'POST'],
    ]);
    for (const [, init] of fetch.mock.calls)
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer daemon-token',
      );
  });
  it('preserves safe backend error codes in the standard error body', async () => {
    const { client } = clientWith(502, { code: 'invalid_grant' });
    await expect(client.getSubscriptionUserInfo()).rejects.toMatchObject({
      status: 502,
      body: { code: 'invalid_grant' },
    });
  });
  it('treats cancellation of an already removed flow as successful', async () => {
    const { client } = clientWith(404);
    await expect(
      client.cancelSubscriptionLogin('gone'),
    ).resolves.toBeUndefined();
  });
  it('propagates cancellation to read requests', async () => {
    const { client, fetch } = clientWith();
    const controller = new AbortController();
    await client.getSubscriptionConfig({ signal: controller.signal });
    await client.getSubscriptionLogin('f', { signal: controller.signal });
    await client.getSubscriptionUserInfo({ signal: controller.signal });
    const signals = fetch.mock.calls.map(([, init]) => init?.signal);
    controller.abort();
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
  });
  it('activates the explicit workspace with daemon credentials and cancellation', async () => {
    const { client, fetch } = clientWith(200, {
      authType: 'qwen-subscription',
      modelId: 'qwen3.8-max',
      runtimeSync: { status: 'deferred' },
    });
    const controller = new AbortController();
    const result = await client
      .workspaceById('secondary')
      .activateSubscription({ signal: controller.signal });
    expect(result.runtimeSync.status).toBe('deferred');
    expect(fetch.mock.calls[0][0]).toBe(
      `${baseUrl}/workspaces/secondary/auth/subscription`,
    );
    const init = fetch.mock.calls[0][1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({});
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer daemon-token',
    );
    controller.abort();
    expect(init?.signal?.aborted).toBe(true);
  });
});
