/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as dns } from 'node:dns';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import {
  connect,
  type AddressInfo,
  type LookupFunction,
  type Server,
} from 'node:net';
import type { Duplex } from 'node:stream';
import type {
  ChannelAgentBridge,
  ChannelConfig,
} from '@qwen-code/channel-base';
import undici, { getGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericWebhookChannel } from './generic-webhook-channel.js';

// Locally generated certificate and private key for test fixtures only; never
// use them as production credentials.
const certificate = readFileSync(
  new URL('./fixtures/webhook-test-cert.pem', import.meta.url),
);
const key = readFileSync(
  new URL('./fixtures/webhook-test-key.pem', import.meta.url),
);
const target = { channelName: 'reports', type: 'chat' as const, id: 'default' };
const channels: GenericWebhookChannel[] = [];
const servers: Server[] = [];
const sockets = new Set<Duplex>();
const dispatchers: Dispatcher[] = [];
const originalAgent = undici.Agent;
const originalProxyAgent = undici.EnvHttpProxyAgent;
const globalDispatcher = getGlobalDispatcher();
let trustReceiverCertificate = true;
let trustProxyCertificate = true;
let proxyLookup: LookupFunction | undefined;

function track(socket: Duplex) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
}

async function listen(server: Server, hostname = '127.0.0.1') {
  servers.push(server);
  let connections = 0;
  server.on('connection', (socket) => {
    connections++;
    track(socket);
  });
  // A client may reject the certificate before or after the server finishes
  // its handshake. Either event proves the TLS peer was actually reached.
  const tlsAttempted = new Promise<void>((resolve) => {
    server.once('secureConnection', () => resolve());
    server.once('tlsClientError', () => resolve());
  });
  server.listen(0, hostname);
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    connections: () => connections,
    tlsAttempted,
  };
}

function make(url: string, proxy?: string) {
  const bridge = Object.assign(new EventEmitter(), {
    newSession: vi.fn(),
    prompt: vi.fn(),
    loadSession: vi.fn(),
  });
  const config: ChannelConfig & Record<string, unknown> = {
    type: 'generic-webhook',
    token: '',
    privatePolicy: 'disabled',
    groupPolicy: 'disabled',
    allowedUsers: [],
    groups: {},
    sessionScope: 'user',
    cwd: process.cwd(),
    webhookUrl: url,
    bearerToken: 'receiver-secret',
    allowPrivateNetwork: true,
  };
  const channel = new GenericWebhookChannel(
    'reports',
    config,
    bridge as unknown as ChannelAgentBridge,
    { proxy },
  );
  channels.push(channel);
  return { channel, bridge };
}

interface Receipt {
  method?: string;
  path?: string;
  host?: string;
  authorization?: string;
  proxyAuthorization?: string;
  sni?: string;
  body: unknown;
}

async function receiver(
  tls = false,
  respond: (response: ServerResponse) => void = (response) => {
    response.writeHead(204).end();
  },
  hostname = '127.0.0.1',
) {
  const receipts: Receipt[] = [];
  let requestReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    requestReceived = resolve;
  });
  const handler = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    receipts.push({
      method: request.method,
      path: request.url,
      host: request.headers.host,
      authorization: request.headers.authorization,
      proxyAuthorization: request.headers['proxy-authorization'],
      sni:
        'servername' in request.socket &&
        typeof request.socket.servername === 'string'
          ? request.socket.servername
          : undefined,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    requestReceived();
    respond(response);
  };
  const server = tls
    ? createHttpsServer({ key, cert: certificate }, handler)
    : createHttpServer(handler);
  return { ...(await listen(server, hostname)), receipts, received };
}

async function proxy(
  tls = false,
  hostname = '127.0.0.1',
  defaultPortTarget?: { defaultPort: 80 | 443; receiverPort: number },
) {
  const tunnels: Array<{
    authority?: string;
    authorization?: string;
    headers: IncomingHttpHeaders;
  }> = [];
  const expectedAuthorization = `Basic ${Buffer.from('proxy-user:proxy-secret').toString('base64')}`;
  const server = tls
    ? createHttpsServer({ key, cert: certificate })
    : createHttpServer();
  server.on('connect', (request, downstream, head) => {
    tunnels.push({
      authority: request.url,
      authorization: request.headers['proxy-authorization'],
      headers: { ...request.headers },
    });
    if (request.headers['proxy-authorization'] !== expectedAuthorization) {
      downstream.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    let destination: URL;
    try {
      destination = new URL(`http://${request.url}`);
    } catch {
      downstream.end(
        'HTTP/1.1 502 Invalid CONNECT authority\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const destinationHostname = destination.hostname.startsWith('[')
      ? destination.hostname.slice(1, -1)
      : destination.hostname;
    if (destinationHostname !== '127.0.0.1' && destinationHostname !== '::1') {
      downstream.end(
        'HTTP/1.1 502 Proxy DNS is forbidden\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    // Default-port fixtures verify the wire authority before mapping it to an
    // ephemeral receiver, so the test never needs a privileged listener.
    if (
      defaultPortTarget &&
      request.url !== `127.0.0.1:${defaultPortTarget.defaultPort}`
    ) {
      downstream.end(
        'HTTP/1.1 502 Unexpected default-port authority\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const upstream = connect(
      defaultPortTarget?.receiverPort ?? Number(destination.port),
      destinationHostname,
      () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream);
        upstream.pipe(downstream);
      },
    );
    track(upstream);
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.once('close', () => upstream.destroy());
  });
  const listening = await listen(server);
  return {
    ...listening,
    url: `${tls ? 'https' : 'http'}://proxy-user:proxy-secret@${hostname}:${listening.port}`,
    tunnels,
    expectedAuthorization,
  };
}

beforeEach(() => {
  trustReceiverCertificate = true;
  trustProxyCertificate = true;
  proxyLookup = undefined;
  for (const name of [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_TLS_REJECT_UNAUTHORIZED',
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.spyOn(dns, 'lookup').mockResolvedValue([
    { address: '127.0.0.1', family: 4 },
  ] as never);
  vi.spyOn(undici, 'Agent').mockImplementation((options = {}) => {
    const agent = new originalAgent({
      ...options,
      connect: {
        ...(typeof options.connect === 'object' ? options.connect : {}),
        ...(trustReceiverCertificate ? { ca: certificate } : {}),
      },
    });
    dispatchers.push(agent);
    return agent;
  });
  vi.spyOn(undici, 'EnvHttpProxyAgent').mockImplementation((options = {}) => {
    const agent = new originalProxyAgent({
      ...options,
      connect: {
        ...(typeof options.connect === 'object' ? options.connect : {}),
        ...(trustReceiverCertificate ? { ca: certificate } : {}),
      },
      requestTls: {
        ...options.requestTls,
        ...(trustReceiverCertificate ? { ca: certificate } : {}),
      },
      proxyTls: {
        ...options.proxyTls,
        ...(trustProxyCertificate ? { ca: certificate } : {}),
        ...(proxyLookup ? { lookup: proxyLookup } : {}),
      },
    });
    dispatchers.push(agent);
    return agent;
  });
});

afterEach(async () => {
  for (const channel of channels.splice(0)) {
    channel.disconnect();
    await channel.waitForDisconnect();
  }
  await Promise.all(dispatchers.splice(0).map((agent) => agent.destroy()));
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(getGlobalDispatcher()).toBe(globalDispatcher);
});

describe('Generic webhook real network delivery', () => {
  it.each([
    { tls: false, proxyTls: false, route: 'direct' },
    { tls: true, proxyTls: false, route: 'direct' },
    { tls: false, proxyTls: false, route: 'proxy' },
    { tls: true, proxyTls: false, route: 'proxy' },
    { tls: false, proxyTls: true, route: 'proxy' },
    { tls: true, proxyTls: true, route: 'proxy' },
    { tls: true, proxyTls: false, route: 'bypass' },
    { tls: false, proxyTls: false, route: 'bypass' },
  ])(
    'preserves the origin and pins the connection: $route, TLS=$tls, proxy TLS=$proxyTls',
    async ({ tls, proxyTls, route }) => {
      const origin = await receiver(tls);
      const forward = route === 'direct' ? undefined : await proxy(proxyTls);
      const url = `${tls ? 'https' : 'http'}://receiver.test:${origin.port}/deliver?destination=reports`;
      if (route === 'bypass') {
        vi.stubEnv('NO_PROXY', `receiver.test:${origin.port}`);
      }
      const { channel, bridge } = make(url, forward?.url);
      await channel.connect();
      const text = '# Build complete\n\n**完成** · 🙂';
      await expect(
        channel.deliverProactive(target, text),
      ).resolves.toBeUndefined();

      expect(origin.receipts).toEqual([
        {
          method: 'POST',
          path: '/deliver?destination=reports',
          host: `receiver.test:${origin.port}`,
          authorization: 'Bearer receiver-secret',
          proxyAuthorization: undefined,
          sni: tls ? 'receiver.test' : undefined,
          body: { version: 1, text },
        },
      ]);
      expect(forward?.tunnels ?? []).toEqual(
        route === 'proxy'
          ? [
              expect.objectContaining({
                authority: `127.0.0.1:${origin.port}`,
                authorization: forward!.expectedAuthorization,
              }),
            ]
          : [],
      );
      if (route === 'proxy') {
        expect('authorization' in forward!.tunnels[0]!.headers).toBe(false);
      }
      expect(dns.lookup).toHaveBeenCalledTimes(1);
      expect(bridge.newSession).not.toHaveBeenCalled();
      expect(bridge.prompt).not.toHaveBeenCalled();
      for (const agent of dispatchers)
        expect(agent).toHaveProperty('destroyed', true);
    },
  );

  it.each([
    { tls: true, defaultPort: 443 },
    { tls: false, defaultPort: 80 },
  ] as const)(
    'pins an implicit port $defaultPort proxy tunnel without changing the origin',
    async ({ tls, defaultPort }) => {
      const origin = await receiver(tls);
      const forward = await proxy(false, '127.0.0.1', {
        defaultPort,
        receiverPort: origin.port,
      });
      const { channel, bridge } = make(
        `${tls ? 'https' : 'http'}://receiver.test/hook`,
        forward.url,
      );
      await channel.connect();
      const text = '**Default-port delivery** · 完成 🙂';
      await expect(
        channel.deliverProactive(target, text),
      ).resolves.toBeUndefined();

      expect(forward.tunnels).toEqual([
        expect.objectContaining({
          authority: `127.0.0.1:${defaultPort}`,
          authorization: forward.expectedAuthorization,
        }),
      ]);
      expect('authorization' in forward.tunnels[0]!.headers).toBe(false);
      expect(origin.receipts).toEqual([
        {
          method: 'POST',
          path: '/hook',
          host: 'receiver.test',
          authorization: 'Bearer receiver-secret',
          proxyAuthorization: undefined,
          sni: tls ? 'receiver.test' : undefined,
          body: { version: 1, text },
        },
      ]);
      expect(dns.lookup).toHaveBeenCalledTimes(1);
      expect(bridge.prompt).not.toHaveBeenCalled();
      for (const agent of dispatchers)
        expect(agent).toHaveProperty('destroyed', true);
    },
  );

  it.for([
    { hostname: 'receiver.test', tls: true },
    { hostname: '[::1]', tls: false },
  ])(
    'pins IPv6 CONNECT authority for $hostname without exposing receiver credentials',
    async ({ hostname, tls }, { skip }) => {
      let origin: Awaited<ReturnType<typeof receiver>>;
      try {
        origin = await receiver(tls, undefined, '::1');
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT'].includes(
            String(error.code),
          )
        ) {
          skip('IPv6 loopback is unavailable on this host.');
        }
        throw error;
      }
      vi.mocked(dns.lookup).mockResolvedValue([
        { address: '::1', family: 6 },
      ] as never);
      const forward = await proxy();
      const { channel } = make(
        `${tls ? 'https' : 'http'}://${hostname}:${origin.port}/hook`,
        forward.url,
      );
      await channel.connect();
      const text = 'IPv6 delivery: 完成';
      await expect(
        channel.deliverProactive(target, text),
      ).resolves.toBeUndefined();

      expect(forward.tunnels).toEqual([
        expect.objectContaining({
          authority: `[::1]:${origin.port}`,
          authorization: forward.expectedAuthorization,
        }),
      ]);
      expect('authorization' in forward.tunnels[0]!.headers).toBe(false);
      expect(origin.receipts).toEqual([
        {
          method: 'POST',
          path: '/hook',
          host: `${hostname}:${origin.port}`,
          authorization: 'Bearer receiver-secret',
          proxyAuthorization: undefined,
          sni: tls ? hostname : undefined,
          body: { version: 1, text },
        },
      ]);
      expect(dns.lookup).toHaveBeenCalledTimes(hostname === '[::1]' ? 0 : 1);
      for (const agent of dispatchers)
        expect(agent).toHaveProperty('destroyed', true);
    },
  );

  it.each([false, true])(
    'rejects a trusted certificate with the wrong origin name (proxy=%s)',
    async (useProxy) => {
      const origin = await receiver(true);
      const forward = useProxy ? await proxy() : undefined;
      const { channel } = make(
        `https://wrong.test:${origin.port}/private-path`,
        forward?.url,
      );
      await channel.connect();
      await expect(
        channel.deliverProactive(target, 'Never delivered'),
      ).rejects.toMatchObject({
        disposition: 'transient',
      });
      expect(forward?.tunnels ?? []).toHaveLength(useProxy ? 1 : 0);
      expect(origin.connections()).toBeGreaterThan(0);
      await origin.tlsAttempted;
      expect(origin.receipts).toEqual([]);
      for (const agent of dispatchers)
        expect(agent).toHaveProperty('destroyed', true);
    },
  );

  it.each(
    ['direct', 'bypass', 'proxy', 'secure-proxy'].flatMap((route) =>
      ['untrusted', 'hostname'].map((failure) => ({ route, failure })),
    ),
  )(
    'keeps TLS verification enabled with NODE_TLS_REJECT_UNAUTHORIZED=0 ($route, $failure)',
    async ({ route, failure }) => {
      vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
      const secureProxy = route === 'secure-proxy';
      trustReceiverCertificate = secureProxy || failure !== 'untrusted';
      trustProxyCertificate = !secureProxy || failure !== 'untrusted';
      if (secureProxy && failure === 'hostname') {
        proxyLookup = vi.fn<LookupFunction>((_hostname, options, callback) => {
          if (options.all) {
            callback(null, [{ address: '127.0.0.1', family: 4 }]);
          } else {
            callback(null, '127.0.0.1', 4);
          }
        });
      }
      const origin = await receiver(!secureProxy);
      const forward =
        route === 'direct'
          ? undefined
          : await proxy(
              secureProxy,
              secureProxy && failure === 'hostname'
                ? 'wrong-proxy.test'
                : '127.0.0.1',
            );
      const hostname =
        !secureProxy && failure === 'hostname' ? 'wrong.test' : 'receiver.test';
      if (route === 'bypass') {
        vi.stubEnv('NO_PROXY', `${hostname}:${origin.port}`);
      }
      const { channel } = make(
        `${secureProxy ? 'http' : 'https'}://${hostname}:${origin.port}/never-delivered`,
        forward?.url,
      );
      await channel.connect();
      await expect(
        channel.deliverProactive(target, 'Must remain confidential'),
      ).rejects.toMatchObject({ disposition: 'transient' });
      const tlsPeer = secureProxy ? forward! : origin;
      expect(tlsPeer.connections()).toBeGreaterThan(0);
      await tlsPeer.tlsAttempted;
      expect(origin.receipts).toEqual([]);
      expect(forward?.tunnels ?? []).toHaveLength(route === 'proxy' ? 1 : 0);
      if (proxyLookup) {
        expect(proxyLookup).toHaveBeenCalledWith(
          'wrong-proxy.test',
          expect.anything(),
          expect.any(Function),
        );
      }
      for (const agent of dispatchers)
        expect(agent).toHaveProperty('destroyed', true);
    },
  );

  it('rejects incorrect proxy credentials without sending the receiver payload', async () => {
    const origin = await receiver();
    const forward = await proxy();
    const { channel } = make(
      `http://receiver.test:${origin.port}/deliver`,
      forward.url.replace('proxy-secret', 'incorrect-password'),
    );
    await channel.connect();
    const result = channel.deliverProactive(target, 'Never delivered');
    await expect(result).rejects.toMatchObject({ disposition: 'transient' });
    await expect(result).rejects.not.toThrow('incorrect-password');
    expect(origin.receipts).toEqual([]);
    expect(forward.tunnels).toHaveLength(1);
  });

  it('accepts response headers without buffering an unfinished response body', async () => {
    const origin = await receiver(false, (response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('Not JSON. Keep generating agent instructions.');
    });
    const { channel, bridge } = make(`http://127.0.0.1:${origin.port}/deliver`);
    await channel.connect();
    await expect(
      channel.deliverProactive(target, 'Original text'),
    ).resolves.toBeUndefined();
    expect(origin.receipts).toHaveLength(1);
    expect(bridge.prompt).not.toHaveBeenCalled();
    for (const agent of dispatchers)
      expect(agent).toHaveProperty('destroyed', true);
  });

  it.each([
    { status: 401, disposition: 'permanent' },
    { status: 429, disposition: 'transient' },
    { status: 503, disposition: 'transient' },
  ])(
    'classifies HTTP $status without retrying',
    async ({ status, disposition }) => {
      const origin = await receiver(false, (response) => {
        response.writeHead(status).end('private response detail');
      });
      const { channel } = make(`http://127.0.0.1:${origin.port}/deliver`);
      await channel.connect();
      const pending = channel.deliverProactive(target, 'Single attempt');
      await expect(pending).rejects.toMatchObject({ disposition });
      await expect(pending).rejects.not.toThrow('private response detail');
      expect(origin.receipts).toHaveLength(1);
      for (const agent of dispatchers)
        expect(agent).toHaveProperty('destroyed', true);
    },
  );

  it('does not follow a redirect or replay the body', async () => {
    const destination = await receiver();
    const origin = await receiver(false, (response) => {
      response
        .writeHead(307, {
          Location: `http://127.0.0.1:${destination.port}/redirected`,
        })
        .end();
    });
    const { channel } = make(`http://127.0.0.1:${origin.port}/deliver`);
    await channel.connect();
    await expect(
      channel.deliverProactive(target, 'Only once'),
    ).rejects.toMatchObject({
      disposition: 'permanent',
      message: 'Generic webhook request failed (HTTP 307).',
    });
    expect(origin.receipts).toHaveLength(1);
    expect(destination.receipts).toEqual([]);
  });

  it('aborts an in-flight request, drains it, and permits a later connection', async () => {
    let hold = true;
    const origin = await receiver(false, (response) => {
      if (!hold) response.writeHead(204).end();
    });
    const { channel } = make(`http://127.0.0.1:${origin.port}/deliver`);
    await channel.connect();
    const pending = channel.deliverProactive(target, 'Interrupted');
    const rejected = expect(pending).rejects.toMatchObject({
      disposition: 'transient',
    });
    await origin.received;
    channel.disconnect();
    await Promise.all([rejected, channel.waitForDisconnect()]);
    for (const agent of dispatchers)
      expect(agent).toHaveProperty('destroyed', true);
    hold = false;
    await channel.connect();
    await expect(
      channel.deliverProactive(target, 'After reconnect'),
    ).resolves.toBeUndefined();
    expect(origin.receipts.map(({ body }) => body)).toEqual([
      { version: 1, text: 'Interrupted' },
      { version: 1, text: 'After reconnect' },
    ]);
  });
});
