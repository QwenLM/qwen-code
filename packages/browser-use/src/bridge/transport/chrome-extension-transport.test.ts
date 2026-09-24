/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  CHROME_EXTENSION_IDS,
  defaultChromeBridgeSocketPath,
  defaultChromeBridgeSocketDirectory,
  type BridgeRequest,
} from '../protocol.js';
import { ChromeExtensionTransport } from './chrome-extension-transport.js';
import { encodeFrame, FrameDecoder } from './framing.js';

const roots: string[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const transports: ChromeExtensionTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

async function fixture(
  options: {
    profile?: string;
    hello?: Record<string, unknown>;
    holdClose?: boolean;
    root?: string;
  } = {},
) {
  const root =
    options.root ??
    fs.mkdtempSync(
      path.join(
        process.platform === 'win32' ? os.tmpdir() : '/tmp',
        'qbu-client-',
      ),
    );
  if (options.root === undefined) roots.push(root);
  const host = randomUUID();
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\qbu-${randomUUID()}`
      : path.join(root, host + '.sock');
  const requests: BridgeRequest[] = [];
  const connections: Socket[] = [];
  const session = randomUUID();
  const server = createServer((socket) => {
    sockets.push(socket);
    connections.push(socket);
    const decoder = new FrameDecoder();
    socket.on('error', () => undefined);
    socket.on('data', (data) => {
      for (const value of decoder.push(data)) {
        const message = value as BridgeRequest;
        if ((value as { type: string }).type === 'client.hello')
          socket.write(
            encodeFrame({
              type: 'hello',
              protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
              extensionId: CHROME_EXTENSION_ID,
              extensionInstanceId: options.profile ?? 'profile-a',
              hostInstanceId: host,
              browserSessionId: session,
              ...options.hello,
            }),
          );
        else if (message.method === 'session.close' && !options.holdClose)
          socket.write(
            encodeFrame({
              type: 'response',
              browserSessionId: session,
              id: message.id,
              ok: true,
              result: null,
            }),
          );
        else requests.push(message);
      }
    });
  });
  servers.push(server);
  server.listen(socketPath);
  await once(server, 'listening');
  const transport = new ChromeExtensionTransport({
    socketPath,
    connectTimeoutMs: 150,
    requestTimeoutMs: 200,
  });
  transports.push(transport);
  return {
    transport,
    requests,
    session,
    server,
    connections,
    socketPath,
    root,
    host,
    async start() {
      await transport.start();
      return connections[connections.length - 1]!;
    },
    send(socket: Socket, value: Record<string, unknown>) {
      socket.write(encodeFrame({ browserSessionId: session, ...value }));
    },
  };
}

it('rejects operations as soon as stop begins while still sending graceful close', async () => {
  const f = await fixture({ holdClose: true });
  const socket = await f.start();
  const stopping = f.transport.stop();
  await expect(
    f.transport.request('cdp.send', { tabId: 1, method: 'Page.navigate' }),
  ).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(f.requests[0]!.method).toBe('session.close');
  await expect(f.transport.request('ping')).rejects.toMatchObject({
    code: 'BROWSER_DISCONNECTED',
  });
  f.send(socket, { type: 'response', id: f.requests[0]!.id, ok: true });
  await stopping;
  expect(f.requests).toHaveLength(1);
  expect(f.transport.isConnected()).toBe(false);
});

function publish(
  f: { root: string; host: string; socketPath: string },
  record: Record<string, unknown> = {},
) {
  fs.chmodSync(f.socketPath, 0o600);
  fs.writeFileSync(
    path.join(f.root, f.host + '.json'),
    JSON.stringify({
      extensionInstanceId: 'profile-a',
      hostInstanceId: f.host,
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionProtocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      socketPath: f.socketPath,
      pid: process.pid,
      ...record,
    }),
    { mode: 0o600 },
  );
}

function discovering(root: string, connectTimeoutMs: number, override = '') {
  vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', override);
  vi.stubEnv('QWEN_BROWSER_USE_DISCOVERY_DIR', root);
  const transport = new ChromeExtensionTransport({ connectTimeoutMs });
  transports.push(transport);
  return transport;
}

it.skipIf(process.platform === 'win32')(
  'discovers profiles when the environment socket override is whitespace',
  async () => {
    const f = await fixture();
    publish(f);
    const transport = discovering(f.root, 1000, ' \t ');
    await transport.start();
    expect(transport.socketPath).toBe(f.socketPath);
    expect(transport.isConnected()).toBe(true);
  },
);

it('connects independent clients without taking ownership of the listener', async () => {
  const f = await fixture();
  await f.start();
  const b = new ChromeExtensionTransport({ socketPath: f.socketPath });
  transports.push(b);
  await b.start();
  expect(f.connections).toHaveLength(2);
  await f.transport.stop();
  expect(f.server.listening).toBe(true);
  expect(b.isConnected()).toBe(true);
  if (process.platform !== 'win32')
    expect(fs.statSync(f.socketPath).isSocket()).toBe(true);
});

it('routes requests with its session identity and ignores foreign replies and events', async () => {
  const f = await fixture();
  const socket = await f.start();
  const events: unknown[] = [];
  f.transport.onEvent((e) => events.push(e));
  const result = f.transport.request('ping');
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(f.requests[0]?.browserSessionId).toBe(f.session);
  f.send(socket, {
    type: 'event',
    browserSessionId: 'foreign',
    tabId: 1,
    method: 'foreign',
  });
  f.send(socket, {
    type: 'response',
    browserSessionId: 'foreign',
    id: f.requests[0]!.id,
    ok: true,
    result: 'foreign',
  });
  f.send(socket, {
    type: 'response',
    id: f.requests[0]!.id,
    ok: true,
    result: 'own',
  });
  expect(await result).toBe('own');
  expect(events).toEqual([]);
});

it('delivers promise continuations before following events in the same chunk', async () => {
  const f = await fixture();
  const socket = await f.start();
  const order: string[] = [];
  const result = f.transport.request('ping').then(() => {
    order.push('response');
    f.transport.onEvent(() => order.push('event'));
  });
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  socket.write(
    Buffer.concat([
      encodeFrame({
        type: 'response',
        browserSessionId: f.session,
        id: f.requests[0]!.id,
        ok: true,
      }),
      encodeFrame({
        type: 'event',
        browserSessionId: f.session,
        tabId: 1,
        method: 'Runtime.executionContextCreated',
        params: {},
      }),
    ]),
  );
  await result;
  await vi.waitFor(() => expect(order).toEqual(['response', 'event']));
});

it.each([
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
])('acknowledges only %s inputs on the dialog target', async (method) => {
  const f = await fixture();
  const socket = await f.start();
  const first = f.transport.request('cdp.send', {
    tabId: 1,
    sessionId: 'frame-a',
    method,
  });
  const other = f.transport.request('cdp.send', {
    tabId: 1,
    sessionId: 'frame-b',
    method,
  });
  await vi.waitFor(() => expect(f.requests).toHaveLength(2));
  f.send(socket, {
    type: 'event',
    tabId: 1,
    sessionId: 'frame-a',
    method: 'Page.javascriptDialogOpening',
    params: {},
  });
  expect(await first).toEqual({});
  f.send(socket, {
    type: 'response',
    id: f.requests[1]!.id,
    ok: true,
    result: 'other',
  });
  expect(await other).toBe('other');
});

it.each(['Runtime.evaluate', 'DOM.getDocument'])(
  'preserves the native response for %s when a dialog opens',
  async (method) => {
    const f = await fixture();
    const socket = await f.start();
    let settled = false;
    const result = f.transport
      .request('cdp.send', { tabId: 1, sessionId: 'frame-a', method })
      .catch((error) => error)
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.send(socket, {
      type: 'event',
      tabId: 1,
      sessionId: 'frame-a',
      method: 'Page.javascriptDialogOpening',
      params: {},
    });
    const delivered = new Promise<void>((resolve) =>
      f.transport.onEvent(() => resolve()),
    );
    await delivered;
    expect(settled).toBe(false);
    f.send(socket, {
      type: 'response',
      id: f.requests[0]!.id,
      ok: false,
      error: { code: 'PERMISSION_REQUIRED', message: 'Native refusal' },
    });
    expect(await result).toMatchObject({
      code: 'PERMISSION_REQUIRED',
      message: 'Native refusal',
    });
  },
);

it('preserves the ownership conflict error and times out unanswered requests', async () => {
  const f = await fixture();
  const socket = await f.start();
  const result = f.transport.request('tabs.attach').catch((e) => e);
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  f.send(socket, {
    type: 'response',
    id: f.requests[0]!.id,
    ok: false,
    error: {
      code: 'TAB_OWNERSHIP_CONFLICT',
      message: 'Owned by another session',
    },
  });
  expect(await result).toMatchObject({ code: 'TAB_OWNERSHIP_CONFLICT' });
  await expect(f.transport.request('ping', {}, 5)).rejects.toMatchObject({
    code: 'OPERATION_TIMEOUT',
  });
});

it.skipIf(process.platform === 'win32')(
  'a profile that never connects does not pin later selections',
  async () => {
    const f = await fixture();
    publish(f);
    const transport = discovering(f.root, 300);
    transport.selectProfile('chrome:typo');
    await expect(transport.start()).rejects.toMatchObject({
      code: 'BROWSER_DISCONNECTED',
    });
    transport.selectProfile('chrome:profile-a');
    await transport.start();
    expect(transport.isConnected()).toBe(true);
    expect(() => transport.selectProfile('chrome:typo')).toThrow(
      /already bound/,
    );
  },
);

it.skipIf(process.platform === 'win32')(
  'connecting and listing keep waiting for a compatible Host after seeing an outdated one',
  async () => {
    const outdated = await fixture({ profile: 'profile-old' });
    publish(outdated, {
      extensionInstanceId: 'profile-old',
      extensionProtocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION - 1,
    });
    const transport = discovering(outdated.root, 2_000);
    const lister = discovering(outdated.root, 2_000);
    const starting = transport.start();
    const listing = lister.profiles();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const current = await fixture({ root: outdated.root });
    publish(current);
    await starting;
    expect(transport.socketPath).toBe(current.socketPath);
    expect(
      (await listing).map((profile) => profile.extensionInstanceId),
    ).toEqual(['profile-a']);
    expect(lister.isConnected()).toBe(false);
  },
);

it.skipIf(process.platform === 'win32')(
  'reports an outdated extension once the whole wait found nothing compatible',
  async () => {
    const outdated = await fixture();
    publish(outdated, {
      extensionProtocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION - 1,
    });
    const transport = discovering(outdated.root, 300);
    const started = Date.now();
    await expect(transport.start()).rejects.toMatchObject({
      code: 'EXTENSION_VERSION_MISMATCH',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    await expect(transport.profiles()).rejects.toMatchObject({
      code: 'EXTENSION_VERSION_MISMATCH',
    });
  },
);

it.skipIf(process.platform === 'win32')(
  'profile listing reports no browsers when none appears',
  async () => {
    const root = fs.mkdtempSync('/tmp/qbu-client-');
    roots.push(root);
    const transport = discovering(root, 200);
    await expect(transport.profiles()).resolves.toEqual([]);
    await expect(transport.start()).rejects.toMatchObject({
      code: 'BROWSER_DISCONNECTED',
      message: expect.stringContaining(
        'install the extension from https://chromewebstore.google.com/detail/qwen-code/hdhmmjclhibojdddmancfgbkleahfaph or enable it at chrome://extensions',
      ),
    });
    expect(transport.isConnected()).toBe(false);
  },
);

it('explicit endpoint listing reports no browsers when nothing listens', async () => {
  const f = await fixture();
  await new Promise<void>((resolve) => f.server.close(() => resolve()));
  await expect(f.transport.profiles()).resolves.toEqual([]);
});

it.each(CHROME_EXTENSION_IDS)(
  'connects to a Host greeting for extension %s',
  async (extensionId) => {
    const f = await fixture({ hello: { extensionId } });
    f.transport.selectProfile('chrome:profile-a');
    await f.transport.start();
    expect(f.transport.isConnected()).toBe(true);
  },
);

it.each([
  ['another extension', { extensionId: 'a'.repeat(32) }],
  ['no session identity', { browserSessionId: '' }],
  ['no Host identity', { hostInstanceId: undefined }],
  ['another protocol', { protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION + 1 }],
  [
    'a profile other than the selected one',
    { extensionInstanceId: 'profile-b' },
  ],
])('rejects a Host hello with %s', async (_label, hello) => {
  const f = await fixture({ hello });
  f.transport.selectProfile('chrome:profile-a');
  await expect(f.transport.start()).rejects.toMatchObject({
    code: 'BROWSER_DISCONNECTED',
  });
  expect(f.transport.isConnected()).toBe(false);
});

it('fails pending requests, tells observers and stays pinned when its Host disappears', async () => {
  const f = await fixture();
  const changes: boolean[] = [];
  const unsubscribe = f.transport.onConnectionChange((connected) =>
    changes.push(connected),
  );
  const socket = await f.start();
  expect(changes).toEqual([true]);
  const result = f.transport.request('ping').catch((e) => e);
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  socket.destroy();
  expect(await result).toMatchObject({ code: 'BROWSER_DISCONNECTED' });
  await vi.waitFor(() => expect(changes).toEqual([true, false]));
  expect(f.transport.isConnected()).toBe(false);
  expect(() => f.transport.selectProfile('chrome:profile-b')).toThrow(
    /already bound/,
  );
  unsubscribe();
  await f.transport.start();
  expect(f.transport.isConnected()).toBe(true);
  expect(changes).toEqual([true, false]);
});

it.skipIf(process.platform === 'win32')(
  'refuses sockets in shared writable directories',
  async () => {
    const f = await fixture();
    fs.chmodSync(path.dirname(f.socketPath), 0o777);
    await expect(f.transport.start()).rejects.toMatchObject({
      code: 'TRANSPORT_UNAVAILABLE',
    });
  },
);

it('keeps deterministic default paths and supports an explicit endpoint', () => {
  expect(
    defaultChromeBridgeSocketPath({
      QWEN_BROWSER_USE_SOCKET_PATH: '/isolated/bridge.sock',
    }),
  ).toBe('/isolated/bridge.sock');
  expect(defaultChromeBridgeSocketPath({ TMPDIR: '/one' })).toBe(
    defaultChromeBridgeSocketPath({ TMPDIR: '/two' }),
  );
  expect(
    defaultChromeBridgeSocketDirectory(123, 'darwin', () => undefined),
  ).toBe('/private/tmp/qwen-browser-use-123');
  expect(
    defaultChromeBridgeSocketDirectory(123, 'linux', () => ({
      isDirectory: () => true,
      uid: 123,
      mode: 0o700,
    })),
  ).toBe('/run/user/123');
  expect(
    defaultChromeBridgeSocketDirectory(123, 'linux', () => ({
      isDirectory: () => true,
      uid: 124,
      mode: 0o700,
    })),
  ).toBe('/tmp/qwen-browser-use-123');
});
