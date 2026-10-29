/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonClient } from '../../src/daemon/DaemonClient.js';
import type { DaemonTransport } from '../../src/daemon/DaemonTransport.js';

afterEach(() => vi.useRealTimers());

describe('DaemonClient.requestRest', () => {
  it('uses native REST with ACP and retains the base prefix, route and headers', async () => {
    const response = new Response('conflict', { status: 409 });
    const restFetch = vi.fn().mockResolvedValue(response);
    const transportFetch = vi.fn();
    const transport = {
      type: 'acp-ws',
      restFetch,
      fetch: transportFetch,
    } as unknown as DaemonTransport;
    const client = new DaemonClient({
      baseUrl: 'https://daemon.example/prefix/',
      token: 'secret',
      transport,
    });
    const signal = new AbortController().signal;
    await expect(
      client.requestRest(
        '/workspaces/%2Frepo/agent?cursor=a%2Fb',
        {
          method: 'POST',
          body: '{}',
          headers: [
            ['Content-Type', 'application/json'],
            ['X-Qwen-Client-Id', 'client'],
          ],
          signal,
          keepalive: true,
        },
        0,
      ),
    ).resolves.toBe(response);
    expect(transportFetch).not.toHaveBeenCalled();
    const [url, init] = restFetch.mock.calls[0];
    expect(url).toBe(
      'https://daemon.example/prefix/workspaces/%2Frepo/agent?cursor=a%2Fb',
    );
    expect(init).toMatchObject({
      method: 'POST',
      body: '{}',
      signal,
      keepalive: true,
    });
    expect(new Headers(init.headers).get('authorization')).toBe(
      'Bearer secret',
    );
    expect(new Headers(init.headers).get('content-type')).toBe(
      'application/json',
    );
    expect(new Headers(init.headers).get('x-qwen-client-id')).toBe('client');
  });

  it('honors explicit fetch injection before a transport native fetch', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok'));
    const restFetch = vi.fn();
    const client = new DaemonClient({
      baseUrl: '',
      fetch,
      transport: { restFetch } as unknown as DaemonTransport,
    });
    await client.requestRest(
      '/health',
      { headers: new Headers({ 'X-Test': '1' }) },
      0,
    );
    expect(fetch.mock.calls[0][0]).toBe('/health');
    expect(new Headers(fetch.mock.calls[0][1].headers).get('x-test')).toBe('1');
    expect(restFetch).not.toHaveBeenCalled();
  });

  it('does not allow an absolute or protocol-relative target to receive credentials', async () => {
    const fetch = vi.fn();
    const client = new DaemonClient({
      baseUrl: 'https://daemon',
      token: 'secret',
      fetch,
    });
    for (const path of [
      'https://other/health',
      '//daemon.invalid/secret',
      '/\\daemon.invalid/secret',
      '/\n/daemon.invalid/secret',
      '//other/health',
      '/\\other/health',
      '/\n/other/health',
      'health',
    ]) {
      await expect(client.requestRest(path)).rejects.toThrow(
        'absolute route path',
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects dot segments that escape the configured base path', async () => {
    const fetch = vi.fn();
    const client = new DaemonClient({
      baseUrl: 'https://daemon.example/prefix',
      token: 'secret',
      fetch,
    });
    for (const path of ['/../admin', '/a/../../admin']) {
      await expect(client.requestRest(path)).rejects.toThrow('base path');
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('times out a stalled connection but leaves an accepted streaming body alive', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new DaemonClient({ baseUrl: 'http://daemon', fetch });
    const failed = client
      .requestRest('/health', {}, 10)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await failed).toMatchObject({ name: 'TimeoutError' });

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    fetch.mockResolvedValueOnce(new Response(stream));
    const response = await client.requestRest('/events', {}, 10);
    const signal = fetch.mock.calls[1][1]?.signal;
    await vi.advanceTimersByTimeAsync(100);
    expect(signal?.aborted).toBe(false);
    controller.enqueue(new TextEncoder().encode('data: hello\n\n'));
    controller.close();
    expect(await response.text()).toBe('data: hello\n\n');
  });
});
