/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DaemonClient } from '@qwen-code/sdk/daemon';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonRestRequest } from './rest-request.js';
import {
  DaemonAvailability,
  createDaemonClient,
  registerDaemonAvailability,
} from './availability.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function setup(
  baseUrl: string,
  native: typeof fetch,
  mode: 'sdk' | 'legacy',
  fetchTimeoutMs?: number,
) {
  const availability = new DaemonAvailability(baseUrl, undefined, native);
  const unregister = registerDaemonAvailability(
    baseUrl,
    undefined,
    availability,
  );
  const client =
    mode === 'sdk'
      ? createDaemonClient(
          { baseUrl, fetch: native, fetchTimeoutMs },
          availability,
        )
      : ({ transport: { restFetch: native } } as unknown as DaemonClient);
  cleanups.push(() => {
    unregister();
    availability.dispose();
    if (mode === 'sdk') client.dispose();
  });
  return { availability, client };
}

it.each(['unavailable', 'auth-required'] as const)(
  'uses the supplied client owner when another same-target controller is %s',
  async (state) => {
    const baseUrl = 'https://shared.example';
    const nativeA = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    const nativeB = vi.fn(async () => {
      if (state === 'unavailable') throw new TypeError('offline');
      return new Response(null, { status: 401 });
    });
    const { client } = setup(baseUrl, nativeA, 'sdk');
    const { availability: b } = setup(baseUrl, nativeB, 'sdk');
    await b.check();
    expect(b.getSnapshot()).toBe(state);
    await expect(
      createDaemonRestRequest(baseUrl, undefined, client)('/goals'),
    ).resolves.toMatchObject({ status: 200 });
    expect(nativeA).toHaveBeenCalledOnce();
    const raw = new DaemonClient({ baseUrl, fetch: nativeA });
    cleanups.push(() => raw.dispose());
    await expect(
      createDaemonRestRequest(baseUrl, undefined, raw)('/goals'),
    ).rejects.toMatchObject({ name: 'DaemonUnavailableError' });
  },
);

it.each(['sdk', 'legacy'] as const)(
  'aborts a stalled %s native connection and diagnoses without closing a healthy gate',
  async (mode) => {
    vi.useFakeTimers();
    const baseUrl = 'https://deadline.example';
    let signal: AbortSignal | undefined;
    const native = vi.fn<typeof fetch>((input, init) => {
      if (String(input).endsWith('/health'))
        return Promise.resolve(Response.json({ status: 'ok' }));
      if (String(input).endsWith('/capabilities'))
        return Promise.resolve(Response.json({ features: [] }));
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal?.reason), {
          once: true,
        });
      });
    });
    const { availability, client } = setup(baseUrl, native, mode);
    const result = createDaemonRestRequest(
      baseUrl,
      undefined,
      client,
    )('/goals').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ name: 'TimeoutError' });
    expect(signal?.aborted).toBe(true);
    expect(native.mock.calls.map(([input]) => String(input))).toEqual([
      `${baseUrl}/goals`,
      `${baseUrl}/health`,
      `${baseUrl}/capabilities`,
    ]);
    expect(availability.getSnapshot()).toBe('available');
  },
);

it('uses the shared SDK entry and leaves caller deadlines intact', async () => {
  const response = new Response('ok');
  const requestRest = vi.fn().mockResolvedValue(response);
  const request = createDaemonRestRequest('http://daemon', 'secret', {
    requestRest,
  } as unknown as DaemonClient);
  const init = { signal: new AbortController().signal, keepalive: true };
  await expect(request('/session/s/detach', init)).resolves.toBe(response);
  expect(requestRest).toHaveBeenCalledWith('/session/s/detach', init, 0);
});

it.each(['sdk', 'legacy'] as const)(
  'keeps a caller-owned %s stream alive and cancels it without diagnosing an outage',
  async (mode) => {
    vi.useFakeTimers();
    const baseUrl = 'https://cancel.example';
    const native = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const { availability, client } = setup(baseUrl, native, mode, 5);
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    let completed = false;
    const request = createDaemonRestRequest(
      baseUrl,
      undefined,
      client,
    )('/events', {
      signal: controller.signal,
    }).catch((error: unknown) => {
      completed = true;
      return error;
    });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(completed).toBe(false);
    controller.abort();
    expect(await request).toBe(controller.signal.reason);
    expect(native).toHaveBeenCalledOnce();
    expect(availability.getSnapshot()).toBe('available');
  },
);

it('retains older peer SDK native REST support without using ACP fetch', async () => {
  const response = new Response('ok');
  const restFetch = vi.fn().mockResolvedValue(response);
  const fetch = vi.fn();
  const request = createDaemonRestRequest('http://daemon/prefix/', 'secret', {
    transport: { restFetch, fetch },
  } as unknown as DaemonClient);
  const signal = new AbortController().signal;
  await expect(
    request('/goals?cursor=a%2Fb', { headers: [['X-Test', '1']], signal }),
  ).resolves.toBe(response);
  expect(restFetch.mock.calls[0][0]).toBe(
    'http://daemon/prefix/goals?cursor=a%2Fb',
  );
  expect(restFetch.mock.calls[0][1].signal).toBe(signal);
  expect(
    new Headers(restFetch.mock.calls[0][1].headers).get('authorization'),
  ).toBe('Bearer secret');
  expect(new Headers(restFetch.mock.calls[0][1].headers).get('x-test')).toBe(
    '1',
  );
  expect(fetch).not.toHaveBeenCalled();
  for (const path of [
    '//daemon.invalid/secret',
    '/\\daemon.invalid/secret',
    '/\n/daemon.invalid/secret',
    '//other/secret',
    '/\\other/secret',
    '/\n/other/secret',
  ]) {
    await expect(request(path)).rejects.toThrow('absolute route path');
  }
  for (const path of ['/../admin', '/a/../../admin']) {
    await expect(request(path)).rejects.toThrow('base path');
  }
  expect(restFetch).toHaveBeenCalledTimes(1);
});
