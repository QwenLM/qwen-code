/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import {
  getOrCreateSharedDispatcher,
  preloadRuntimeFetchModule,
  resetDispatcherCache,
} from './runtimeFetchOptions.js';

describe('shared proxy dispatcher NO_PROXY behavior', () => {
  const savedEnv = {
    NO_PROXY: process.env['NO_PROXY'],
    no_proxy: process.env['no_proxy'],
  };

  beforeAll(async () => {
    await preloadRuntimeFetchModule();
  });

  beforeEach(() => {
    delete process.env['NO_PROXY'];
    delete process.env['no_proxy'];
    resetDispatcherCache();
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedEnv.NO_PROXY === undefined) {
      delete process.env['NO_PROXY'];
    } else {
      process.env['NO_PROXY'] = savedEnv.NO_PROXY;
    }
    if (savedEnv.no_proxy === undefined) {
      delete process.env['no_proxy'];
    } else {
      process.env['no_proxy'] = savedEnv.no_proxy;
    }
    resetDispatcherCache();
    vi.restoreAllMocks();
  });

  it.each(['NO_PROXY', 'no_proxy'] as const)(
    'bypasses the explicit proxy when %s matches the target',
    async (noProxyKey) => {
      let originRequests = 0;
      let proxyRequests = 0;
      const origin = createServer((_request, response) => {
        originRequests += 1;
        response.end('direct');
      });
      const proxy = createServer((_request, response) => {
        proxyRequests += 1;
        response.writeHead(502).end();
      });
      proxy.on('connect', (_request, socket) => {
        proxyRequests += 1;
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });

      origin.listen(0, '127.0.0.1');
      proxy.listen(0, '127.0.0.1');
      await Promise.all([once(origin, 'listening'), once(proxy, 'listening')]);

      const originPort = (origin.address() as AddressInfo).port;
      const proxyPort = (proxy.address() as AddressInfo).port;
      process.env[noProxyKey] = '127.0.0.1';
      let dispatcher: Dispatcher | undefined;

      try {
        dispatcher = getOrCreateSharedDispatcher(
          `http://127.0.0.1:${proxyPort}`,
        );
        const response = await undiciFetch(
          `http://127.0.0.1:${originPort}/v1/chat/completions`,
          {
            dispatcher,
            signal: AbortSignal.timeout(2_000),
          },
        );

        expect(await response.text()).toBe('direct');
        expect(originRequests).toBe(1);
        expect(proxyRequests).toBe(0);
      } finally {
        await dispatcher?.close();
        const closed = Promise.all([
          once(origin, 'close'),
          once(proxy, 'close'),
        ]);
        origin.close();
        proxy.close();
        await closed;
      }
    },
  );

  it('still routes through the proxy when NO_PROXY does not match the target', async () => {
    let originRequests = 0;
    const proxyConnects: string[] = [];
    const origin = createServer((_request, response) => {
      originRequests += 1;
      response.end('via-proxy');
    });
    const proxy = createServer((_request, response) => {
      response.writeHead(405).end();
    });
    proxy.on('connect', (request, clientSocket, head) => {
      proxyConnects.push(request.url ?? '');
      const [host, port] = (request.url ?? '').split(':');
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
      upstream.on('close', () => clientSocket.destroy());
    });

    origin.listen(0, '127.0.0.1');
    proxy.listen(0, '127.0.0.1');
    await Promise.all([once(origin, 'listening'), once(proxy, 'listening')]);

    const originPort = (origin.address() as AddressInfo).port;
    const proxyPort = (proxy.address() as AddressInfo).port;
    process.env['NO_PROXY'] = 'example.com';
    let dispatcher: Dispatcher | undefined;

    try {
      dispatcher = getOrCreateSharedDispatcher(`http://127.0.0.1:${proxyPort}`);
      const response = await undiciFetch(
        `http://127.0.0.1:${originPort}/v1/chat/completions`,
        {
          dispatcher,
          signal: AbortSignal.timeout(2_000),
        },
      );

      expect(await response.text()).toBe('via-proxy');
      expect(originRequests).toBe(1);
      expect(proxyConnects).toEqual([`127.0.0.1:${originPort}`]);
    } finally {
      await dispatcher?.close();
      const closed = Promise.all([once(origin, 'close'), once(proxy, 'close')]);
      origin.close();
      proxy.close();
      await closed;
    }
  });
});
