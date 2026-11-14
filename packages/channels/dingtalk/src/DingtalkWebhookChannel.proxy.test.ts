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
import { DingtalkWebhookChannel } from './DingtalkWebhookChannel.js';

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
  vi.clearAllMocks();
});

describe('DingTalk webhook workspace proxy', () => {
  it.each([
    { errcode: 0, bypass: false },
    { errcode: 310000, bypass: false },
    { errcode: 0, bypass: true },
  ])(
    'routes and releases the request dispatcher (errcode=$errcode, bypass=$bypass)',
    async ({ errcode, bypass }) => {
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
        response.end(JSON.stringify({ errcode }));
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
        type: 'dingtalk-webhook',
        token: '',
        privatePolicy: 'disabled',
        groupPolicy: 'disabled',
        allowedUsers: [],
        groups: {},
        sessionScope: 'user',
        cwd: process.cwd(),
        webhookUrl:
          'https://oapi.dingtalk.com/robot/send?access_token=local-token',
      };
      let channel: DingtalkWebhookChannel | undefined;
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
          expect(target.origin).toBe('https://oapi.dingtalk.com');
          dispatcher = options?.dispatcher;
          // Keep the real dispatcher/transport, replacing only the remote origin.
          target.protocol = 'http:';
          target.hostname = '127.0.0.1';
          target.port = String(originPort);
          return realUndici.fetch(target, options);
        });
        channel = new DingtalkWebhookChannel(
          'robot',
          config,
          new EventEmitter() as ChannelAgentBridge,
          { proxy: `http://proxy-user:proxy-password@127.0.0.1:${proxyPort}` },
        );
        await channel.connect();
        const result = channel.sendMessage('default', '# Proxy message\nBody');
        if (errcode === 0) {
          await result;
        } else {
          await expect(result).rejects.toMatchObject({
            message: 'DingTalk webhook rejected the message (code 310000).',
            disposition: 'permanent',
          });
          await expect(result).rejects.not.toHaveProperty('cause');
        }
        expect(connects).toEqual(bypass ? [] : [`127.0.0.1:${originPort}`]);
        expect(received).toEqual([
          {
            path: '/robot/send?access_token=local-token',
            body: {
              msgtype: 'markdown',
              markdown: {
                title: 'Proxy message',
                text: '# Proxy message\nBody',
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
