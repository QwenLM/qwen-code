/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import type {
  ChannelAgentBridge,
  ChannelConfig,
} from '@qwen-code/channel-base';
import undici, { getGlobalDispatcher } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuWebhookChannel } from './FeishuWebhookChannel.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    default: { ...actual.default, fetch: vi.fn<typeof actual.fetch>() },
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Feishu webhook workspace proxy', () => {
  it.each([false, true])(
    'routes the HTTPS origin with workspace credentials (NO_PROXY bypass=%s)',
    async (bypass) => {
      vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1');
      vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:1');
      vi.stubEnv('http_proxy', undefined);
      vi.stubEnv('https_proxy', undefined);
      vi.stubEnv('NO_PROXY', bypass ? 'open.feishu.cn' : '');
      vi.stubEnv('no_proxy', undefined);
      const unproxiedFetch = vi
        .fn()
        .mockRejectedValue(new Error('Unexpected unproxied request'));
      vi.stubGlobal('fetch', unproxiedFetch);
      const realUndici =
        await vi.importActual<typeof import('undici')>('undici');
      const directConnections: Array<{ hostname: string; protocol: string }> =
        [];
      vi.spyOn(undici, 'EnvHttpProxyAgent').mockImplementation(
        (options) =>
          new realUndici.EnvHttpProxyAgent({
            ...options,
            // Preserve routing decisions, but stop direct sockets before external I/O.
            connect: (target, callback) => {
              directConnections.push({
                hostname: target.hostname,
                protocol: target.protocol,
              });
              callback(new Error('Direct socket blocked by fixture'), null);
            },
          }),
      );
      vi.mocked(undici.fetch).mockImplementation(realUndici.fetch);
      const connects: Array<{ authority: string; authorization?: string }> = [];
      const sockets = new Set<Socket>();
      const proxy = createServer((_request, response) =>
        response.writeHead(405).end(),
      );
      proxy.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      proxy.on('connect', (request, client) => {
        connects.push({
          authority: request.url!,
          authorization: request.headers['proxy-authorization'],
        });
        client.end(
          'HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      });
      let channel: FeishuWebhookChannel | undefined;
      try {
        proxy.listen(0, '127.0.0.1');
        await once(proxy, 'listening');
        channel = new FeishuWebhookChannel(
          'robot',
          {
            type: 'feishu-webhook',
            token: '',
            privatePolicy: 'disabled',
            groupPolicy: 'disabled',
            allowedUsers: [],
            groups: {},
            sessionScope: 'user',
            cwd: process.cwd(),
            webhookUrl:
              'https://open.feishu.cn/open-apis/bot/v2/hook/private-token',
          },
          new EventEmitter() as unknown as ChannelAgentBridge,
          {
            proxy: `http://proxy-user:proxy-password@127.0.0.1:${(proxy.address() as AddressInfo).port}`,
          },
        );
        await channel.connect();
        await expect(
          channel.sendMessage('default', 'Routing probe'),
        ).rejects.toMatchObject({
          disposition: 'transient',
          message:
            'Feishu webhook request failed or returned an invalid response; delivery may have been accepted.',
        });
        expect(undici.fetch).toHaveBeenCalledOnce();
        expect(unproxiedFetch).not.toHaveBeenCalled();
        expect(connects).toEqual(
          bypass
            ? []
            : [
                {
                  authority: 'open.feishu.cn:443',
                  authorization: `Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`,
                },
              ],
        );
        expect(directConnections).toEqual(
          bypass ? [{ hostname: 'open.feishu.cn', protocol: 'https:' }] : [],
        );
      } finally {
        channel?.disconnect();
        await channel?.waitForDisconnect();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    },
  );

  it.each([
    { code: 0, bypass: false },
    { code: 19024, bypass: false },
    { code: 0, bypass: true },
  ])(
    'routes and releases the request dispatcher (code=$code, bypass=$bypass)',
    async ({ code, bypass }) => {
      vi.stubEnv('NO_PROXY', bypass ? '127.0.0.1' : '');
      vi.stubEnv('no_proxy', undefined);
      const unproxiedFetch = vi
        .fn()
        .mockRejectedValue(new Error('Unexpected unproxied request'));
      vi.stubGlobal('fetch', unproxiedFetch);
      const realUndici =
        await vi.importActual<typeof import('undici')>('undici');
      const globalDispatcher = getGlobalDispatcher();
      const sockets = new Set<Socket>();
      const connects: string[] = [];
      const received: Array<{ path: string; body: unknown }> = [];
      const origin = createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        received.push({ path: request.url!, body: JSON.parse(body) });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code }));
      });
      const proxy = createServer((_request, response) => {
        response.writeHead(405).end();
      });
      const track = (socket: Socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      };
      origin.on('connection', track);
      proxy.on('connection', track);
      proxy.on('connect', (request, client, head) => {
        connects.push(request.url!);
        const upstream = connect(
          (origin.address() as AddressInfo).port,
          '127.0.0.1',
          () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(client);
            client.pipe(upstream);
          },
        );
        track(upstream);
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      const config: ChannelConfig & Record<string, unknown> = {
        type: 'feishu-webhook',
        token: '',
        privatePolicy: 'disabled',
        groupPolicy: 'disabled',
        allowedUsers: [],
        groups: {},
        sessionScope: 'user',
        cwd: process.cwd(),
        webhookUrl:
          'https://open.feishu.cn/open-apis/bot/v2/hook/private-token',
      };
      let channel: FeishuWebhookChannel | undefined;
      let dispatcher: import('undici').Dispatcher | undefined;
      try {
        origin.listen(0, '127.0.0.1');
        proxy.listen(0, '127.0.0.1');
        await Promise.all([
          once(origin, 'listening'),
          once(proxy, 'listening'),
        ]);
        const originPort = (origin.address() as AddressInfo).port;
        const proxyPort = (proxy.address() as AddressInfo).port;
        vi.mocked(undici.fetch).mockImplementation((input, options) => {
          const target = new URL(String(input));
          expect(target.origin).toBe('https://open.feishu.cn');
          dispatcher = options?.dispatcher;
          // Keep the real dispatcher/transport, replacing only the remote origin.
          target.protocol = 'http:';
          target.hostname = '127.0.0.1';
          target.port = String(originPort);
          return realUndici.fetch(target, options);
        });
        channel = new FeishuWebhookChannel(
          'robot',
          config,
          new EventEmitter() as unknown as ChannelAgentBridge,
          { proxy: `http://proxy-user:proxy-password@127.0.0.1:${proxyPort}` },
        );
        await channel.connect();
        const result = channel.sendMessage('default', '# Proxy message\nBody');
        if (code === 0) {
          await result;
        } else {
          await expect(result).rejects.toMatchObject({
            message: 'Feishu webhook rejected the message (code 19024).',
            disposition: 'permanent',
          });
          await expect(result).rejects.not.toHaveProperty('cause');
        }
        expect(connects).toEqual(bypass ? [] : [`127.0.0.1:${originPort}`]);
        expect(received).toEqual([
          {
            path: '/open-apis/bot/v2/hook/private-token',
            body: {
              msg_type: 'interactive',
              card: {
                schema: '2.0',
                body: {
                  elements: [
                    { tag: 'markdown', content: '# Proxy message\nBody' },
                  ],
                },
              },
            },
          },
        ]);
        expect(undici.fetch).toHaveBeenCalledOnce();
        expect(unproxiedFetch).not.toHaveBeenCalled();
        expect(dispatcher).toBeInstanceOf(undici.EnvHttpProxyAgent);
        expect(dispatcher).toHaveProperty('destroyed', true);
        expect(getGlobalDispatcher()).toBe(globalDispatcher);
      } finally {
        channel?.disconnect();
        await channel?.waitForDisconnect();
        await dispatcher?.destroy();
        for (const socket of sockets) socket.destroy();
        await Promise.all([
          new Promise<void>((resolve) => origin.close(() => resolve())),
          new Promise<void>((resolve) => proxy.close(() => resolve())),
        ]);
      }
    },
  );
});
