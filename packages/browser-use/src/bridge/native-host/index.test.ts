/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  type BridgeRequest,
} from '../protocol.js';
import { encodeFrame, FrameDecoder } from '../transport/framing.js';
import { ChromeExtensionTransport } from '../transport/chrome-extension-transport.js';
import { discoverChromeProfiles } from '../discovery.js';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 10_000 });
function waitFor<T>(callback: () => T) {
  return vi.waitFor(callback, { timeout: 10_000 });
}

const root = fs.mkdtempSync(
  path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'qbu-host-'),
);
const hostPath = path.join(root, 'host.cjs');
const controlledHostPath = path.join(root, 'controlled-host.cjs');
const children: ChildProcessWithoutNullStreams[] = [];
const sockets: Socket[] = [];
beforeAll(async () => {
  const options = {
    entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
    bundle: true,
    platform: 'node' as const,
    format: 'cjs' as const,
  };
  await build({ ...options, outfile: hostPath });
  await build({
    ...options,
    outfile: controlledHostPath,
    banner: {
      js: `
      const requestTimers = new Map();
      const realSetTimeout = globalThis.setTimeout;
      const realClearTimeout = globalThis.clearTimeout;
      globalThis.setTimeout = (callback, milliseconds, ...args) => {
        if (milliseconds !== 135000) return realSetTimeout(callback, milliseconds, ...args);
        const timer = realSetTimeout(() => {}, 2147483647);
        requestTimers.set(timer, () => callback(...args));
        return timer;
      };
      globalThis.clearTimeout = (timer) => {
        requestTimers.delete(timer);
        realClearTimeout(timer);
      };
    `,
    },
    footer: {
      js: `
      process.on('message', command => {
        if (command === 'expireRequests') {
          for (const [timer, callback] of [...requestTimers]) {
            clearTimeout(timer);
            callback();
          }
        }
        process.send({
          clientStates: [...clients.values()].map(client => client.state).sort(),
          pendingMethods: [...pending.values()].map(request => request.method).sort(),
        });
      });
    `,
    },
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function startHost(
  options: {
    socketPath?: string;
    profile?: string;
    protocol?: number;
    autoOpen?: boolean;
    autoClose?: boolean;
    controlledTimers?: boolean;
    discoveryDirectory?: string;
    socketOverride?: string;
    extensionId?: string;
  } = {},
) {
  const directory = fs.mkdtempSync(path.join(root, 'profile-'));
  const socketPath = options.socketPath ?? path.join(directory, 'bridge.sock');
  const child = spawn(
    process.execPath,
    [options.controlledTimers ? controlledHostPath : hostPath],
    {
      env: {
        ...process.env,
        QWEN_BROWSER_USE_SOCKET_PATH:
          options.socketOverride ??
          (options.discoveryDirectory ? '' : socketPath),
        QWEN_BROWSER_USE_DISCOVERY_DIR: options.discoveryDirectory,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  ) as ChildProcessWithoutNullStreams;
  children.push(child);
  const messages: BridgeRequest[] = [];
  const decoder = new FrameDecoder();
  const reply = (request: BridgeRequest, result: unknown = null) =>
    child.stdin.write(
      encodeFrame({
        type: 'response',
        id: request.id,
        browserSessionId: request.browserSessionId,
        ok: true,
        result,
      }),
    );
  child.stdout.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const req = message as BridgeRequest;
      messages.push(req);
      if (
        (req.method === 'session.open' && options.autoOpen !== false) ||
        (req.method === 'session.close' && options.autoClose !== false)
      )
        reply(req);
    }
  });
  child.stdin.write(
    encodeFrame({
      type: 'hello',
      protocolVersion: options.protocol ?? CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionId: options.extensionId ?? CHROME_EXTENSION_ID,
      extensionInstanceId: options.profile ?? 'profile-a',
    }),
  );
  return {
    child,
    messages,
    socketPath,
    reply,
    async requests(method: string, count = 1) {
      await waitFor(() =>
        expect(messages.filter((m) => m.method === method)).toHaveLength(count),
      );
      return messages.filter((m) => m.method === method);
    },
  };
}

async function client(
  socketPath: string,
  identity: Record<string, unknown> = {},
) {
  await waitFor(() => expect(fs.existsSync(socketPath)).toBe(true));
  const socket = connect(socketPath);
  sockets.push(socket);
  await once(socket, 'connect');
  const received: Array<Record<string, unknown>> = [];
  const decoder = new FrameDecoder();
  socket.on('data', (chunk) =>
    received.push(...(decoder.push(chunk) as Array<Record<string, unknown>>)),
  );
  socket.on('error', () => undefined);
  socket.write(
    encodeFrame({
      type: 'client.hello',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      ...identity,
    }),
  );
  return {
    socket,
    received,
    send(
      method: string,
      id: string,
      params = {},
      browserSessionId = received.find((m) => m.type === 'hello')
        ?.browserSessionId,
    ) {
      socket.write(
        encodeFrame({ type: 'request', browserSessionId, id, method, params }),
      );
    },
    async hello() {
      await waitFor(() =>
        expect(received.some((m) => m.type === 'hello')).toBe(true),
      );
      return received.find((m) => m.type === 'hello')!;
    },
  };
}

describe.skipIf(process.platform === 'win32')('Native Host processes', () => {
  test('hosts two clients, remaps colliding IDs and routes responses/events only to their owner', async () => {
    const h = startHost();
    const a = await client(h.socketPath);
    const b = await client(h.socketPath);
    const ah = await a.hello();
    const bh = await b.hello();
    expect(ah.browserSessionId).not.toBe(bh.browserSessionId);
    for (const c of [a, b]) c.send('ping', 'same-id');
    const requests = await h.requests('ping', 2);
    expect(requests[0]!.id).not.toBe(requests[1]!.id);
    for (const req of requests) h.reply(req, req.browserSessionId);
    h.child.stdin.write(
      encodeFrame({
        type: 'event',
        browserSessionId: ah.browserSessionId,
        tabId: 1,
        sessionId: 'iframe',
        method: 'Runtime.consoleAPICalled',
        params: {},
      }),
    );
    await waitFor(() =>
      expect(a.received.filter((m) => m.type === 'event')).toHaveLength(1),
    );
    expect(a.received.find((m) => m.type === 'response')).toMatchObject({
      id: 'same-id',
      result: ah.browserSessionId,
    });
    expect(b.received.find((m) => m.type === 'response')).toMatchObject({
      id: 'same-id',
      result: bh.browserSessionId,
    });
    expect(b.received.filter((m) => m.type === 'event')).toEqual([]);
    a.socket.destroy();
    await waitFor(() =>
      expect(
        h.messages.some(
          (m) =>
            m.method === 'session.close' &&
            m.browserSessionId === ah.browserSessionId &&
            m.params.reason === 'disconnected',
        ),
      ).toBe(true),
    );
    expect(b.socket.destroyed).toBe(false);
    expect(h.child.exitCode).toBeNull();
    b.send('session.close', 'close');
    await waitFor(() =>
      expect(b.received.some((m) => m.id === 'close')).toBe(true),
    );
    expect(
      h.messages.find(
        (m) =>
          m.method === 'session.close' &&
          m.browserSessionId === bh.browserSessionId,
      )?.params.reason,
    ).toBe('graceful');
    expect(h.child.exitCode).toBeNull();
    // The socket stays private to the user.
    expect(fs.statSync(h.socketPath).mode & 0o777).toBe(0o600);
  });

  test('cleans a session whose client exits before registration ACK', async () => {
    const h = startHost({ autoOpen: false });
    const a = await client(h.socketPath);
    await waitFor(() => expect(h.messages).toHaveLength(1));
    a.socket.destroy();
    await new Promise((r) => setTimeout(r, 25));
    h.reply(h.messages[0]!);
    await waitFor(() =>
      expect(
        h.messages.some(
          (m) =>
            m.method === 'session.close' && m.params.reason === 'disconnected',
        ),
      ).toBe(true),
    );
    expect(h.child.exitCode).toBeNull();
  });

  test('rejects forged session requests without routing them', async () => {
    const h = startHost();
    const a = await client(h.socketPath);
    await a.hello();
    a.send('tabs.close', 'forged', { tabId: 1 }, 'someone-else');
    await waitFor(() => expect(a.socket.destroyed).toBe(true));
    expect(h.messages.some((m) => m.method === 'tabs.close')).toBe(false);
  });

  test('exits without listening when the hello is not from the Qwen extension', async () => {
    const h = startHost({ extensionId: 'a'.repeat(32) });
    const [code] = await once(h.child, 'exit');
    expect(code).toBe(1);
    expect(fs.existsSync(h.socketPath)).toBe(false);
  });

  test.each([
    ['profile', { extensionInstanceId: 'profile-b' }],
    ['Host', { hostInstanceId: 'another-host' }],
  ])(
    'drops a client that expects another %s without opening a session',
    async (_label, identity) => {
      const h = startHost();
      await (await client(h.socketPath)).hello();
      const stranger = await client(h.socketPath, identity);
      await waitFor(() => expect(stranger.socket.destroyed).toBe(true));
      expect(stranger.received).toEqual([]);
      expect(
        h.messages.filter((m) => m.method === 'session.open'),
      ).toHaveLength(1);
    },
  );

  test('returns actionable extension version mismatch through the client', async () => {
    const h = startHost({ protocol: 2 });
    await waitFor(() => expect(fs.existsSync(h.socketPath)).toBe(true));
    const transport = new ChromeExtensionTransport({
      socketPath: h.socketPath,
      connectTimeoutMs: 1000,
    });
    await expect(transport.start()).rejects.toMatchObject({
      code: 'EXTENSION_VERSION_MISMATCH',
      message: expect.stringContaining('native-host-setup.js install'),
    });
  });

  test('refuses a live listener and leaves its endpoint intact', async () => {
    const h = startHost();
    const a = await client(h.socketPath);
    await a.hello();
    const other = startHost({ socketPath: h.socketPath });
    await waitFor(() => expect(other.child.exitCode).toBe(1));
    expect(a.socket.destroyed).toBe(false);
    expect(fs.existsSync(h.socketPath)).toBe(true);
  });

  test('refuses shared writable socket directories', async () => {
    const directory = fs.mkdtempSync(path.join(root, 'shared-'));
    fs.chmodSync(directory, 0o777);
    const h = startHost({ socketPath: path.join(directory, 'bridge.sock') });
    await waitFor(() => expect(h.child.exitCode).toBe(1));
    expect(fs.existsSync(h.socketPath)).toBe(false);
  });

  test('does not replace a regular file or symlink at an explicit endpoint', async () => {
    const target = path.join(root, 'regular');
    fs.writeFileSync(target, 'preserve');
    const link = path.join(root, 'link.sock');
    fs.symlinkSync(target, link);
    for (const socketPath of [target, link]) {
      const h = startHost({ socketPath });
      await waitFor(() => expect(h.child.exitCode).toBe(1));
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('preserve');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  test('recovers a stale socket from a dead server', async () => {
    const socketPath = path.join(root, 'stale.sock');
    const owner = spawn(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(socketPath)})`,
    ]);
    children.push(owner);
    await waitFor(() => expect(fs.existsSync(socketPath)).toBe(true));
    const exited = once(owner, 'exit');
    owner.kill('SIGKILL');
    await exited;
    const oldInode = fs.statSync(socketPath).ino;
    const h = startHost({ socketPath });
    await waitFor(() => expect(fs.statSync(socketPath).ino).not.toBe(oldInode));
    const a = await client(h.socketPath);
    await a.hello();
    expect(h.child.exitCode).toBeNull();
  });

  test('publishes isolated profiles with a blank override and preserves the other endpoint across Host restart', async () => {
    const directory = fs.mkdtempSync(path.join(root, 'profiles-'));
    vi.stubEnv('QWEN_BROWSER_USE_DISCOVERY_DIR', directory);
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    const hostA = startHost({
      discoveryDirectory: directory,
      profile: 'profile-a',
    });
    const hostB = startHost({
      discoveryDirectory: directory,
      profile: 'profile-b',
      socketOverride: ' \t ',
    });
    const a = new ChromeExtensionTransport({ connectTimeoutMs: 5_000 });
    const b = new ChromeExtensionTransport({ connectTimeoutMs: 5_000 });
    a.selectProfile('chrome:profile-a');
    b.selectProfile('chrome:profile-b');
    try {
      await Promise.all([a.start(), b.start()]);
      const entries = await discoverChromeProfiles(directory);
      expect(entries.map((e) => [e.extensionInstanceId, e.pid]).sort()).toEqual(
        [
          ['profile-a', hostA.child.pid],
          ['profile-b', hostB.child.pid],
        ],
      );
      const eventsA: unknown[] = [];
      const eventsB: unknown[] = [];
      a.onEvent((event) => eventsA.push(event.params));
      b.onEvent((event) => eventsB.push(event.params));
      for (const [host, marker] of [
        [hostA, 'A'],
        [hostB, 'B'],
      ] as const) {
        host.child.stdin.write(
          encodeFrame({
            type: 'event',
            browserSessionId: host.messages[0]!.browserSessionId,
            tabId: 7,
            method: 'Runtime.consoleAPICalled',
            params: { marker },
          }),
        );
      }
      await waitFor(() => {
        expect(eventsA).toEqual([{ marker: 'A' }]);
        expect(eventsB).toEqual([{ marker: 'B' }]);
      });
      hostA.child.stdin.end();
      await waitFor(() => expect(a.isConnected()).toBe(false));
      await waitFor(() => expect(hostA.child.exitCode).toBe(0));
      expect(
        (await discoverChromeProfiles(directory)).map(
          (e) => e.extensionInstanceId,
        ),
      ).toEqual(['profile-b']);
      expect(
        fs.readdirSync(directory).filter((f) => f.endsWith('.json')),
      ).toHaveLength(1);
      expect(b.isConnected()).toBe(true);
      const replacement = startHost({
        discoveryDirectory: directory,
        profile: 'profile-a',
      });
      await a.start();
      expect(replacement.messages[0]!.browserSessionId).not.toBe(
        hostA.messages[0]!.browserSessionId,
      );
      expect(a.isConnected()).toBe(true);
      expect(b.isConnected()).toBe(true);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  test('greets each new protocol 2 listener once so an older CLI reports it is outdated', async () => {
    const base = fs.mkdtempSync(path.join(root, 'base-'));
    fs.chmodSync(base, 0o700);
    const directory = path.join(base, 'qwen-hosts');
    const legacyPath = path.join(base, 'bridge.sock');
    const listen = () => {
      const frames: Array<Record<string, unknown>> = [];
      const server = createServer((socket) => {
        const decoder = new FrameDecoder();
        socket.on('data', (chunk) =>
          frames.push(
            ...(decoder.push(chunk) as Array<Record<string, unknown>>),
          ),
        );
      });
      return new Promise<{ server: Server; frames: typeof frames }>((resolve) =>
        server.listen(legacyPath, () => resolve({ server, frames })),
      );
    };
    const close = (server: Server) =>
      new Promise<void>((resolve) => server.close(() => resolve()));

    const first = await listen();
    startHost({ discoveryDirectory: directory, profile: 'profile-a' });
    await waitFor(() =>
      expect(first.frames).toEqual([
        {
          type: 'hello',
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          extensionId: CHROME_EXTENSION_ID,
          extensionInstanceId: 'profile-a',
        },
      ]),
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(first.frames).toHaveLength(1);

    // An older CLI restarting binds a new socket and is greeted again.
    await close(first.server);
    const second = await listen();
    await waitFor(() => expect(second.frames).toHaveLength(1));
    await close(second.server);
  });

  test('does not greet protocol 2 listeners for an outdated extension', async () => {
    const base = fs.mkdtempSync(path.join(root, 'base-'));
    fs.chmodSync(base, 0o700);
    const connected = vi.fn();
    const server = createServer((socket) => {
      connected();
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(path.join(base, 'bridge.sock'), resolve),
    );
    const directory = path.join(base, 'qwen-hosts');
    startHost({ discoveryDirectory: directory, protocol: 2 });
    await waitFor(async () =>
      expect(
        (await discoverChromeProfiles(directory)).map((e) => e.pid),
      ).toHaveLength(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(connected).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('default selection prefers the profile Chrome last used and lists its name', async () => {
    const directory = fs.mkdtempSync(path.join(root, 'profiles-'));
    vi.stubEnv('QWEN_BROWSER_USE_DISCOVERY_DIR', directory);
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    startHost({ discoveryDirectory: directory, profile: 'profile-a' });
    await waitFor(async () =>
      expect(await discoverChromeProfiles(directory)).toHaveLength(1),
    );
    const hostB = startHost({
      discoveryDirectory: directory,
      profile: 'profile-b',
    });
    await waitFor(async () =>
      expect(await discoverChromeProfiles(directory)).toHaveLength(2),
    );
    const describeProfiles = vi.fn(
      async (ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            { name: id.toUpperCase(), lastUsed: id === 'profile-a' },
          ]),
        ),
    );
    const transport = new ChromeExtensionTransport({
      connectTimeoutMs: 5_000,
      describeProfiles,
    });
    try {
      // profile-b's Host is newer, but Chrome last used profile-a.
      await transport.start();
      expect(hostB.messages).toEqual([]);
      expect(
        (await transport.profiles()).map((p) => [
          p.extensionInstanceId,
          p.profileName,
          p.lastUsed,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['profile-a', 'PROFILE-A', true],
          ['profile-b', 'PROFILE-B', false],
        ]),
      );
    } finally {
      await transport.stop();
    }
  });

  test('default selection skips an incompatible profile while explicit selection reports it', async () => {
    const directory = fs.mkdtempSync(path.join(root, 'versions-'));
    vi.stubEnv('QWEN_BROWSER_USE_DISCOVERY_DIR', directory);
    vi.stubEnv('QWEN_BROWSER_USE_SOCKET_PATH', '');
    startHost({ discoveryDirectory: directory, profile: 'compatible' });
    startHost({
      discoveryDirectory: directory,
      profile: 'outdated',
      protocol: 2,
    });
    await waitFor(async () =>
      expect(await discoverChromeProfiles(directory)).toHaveLength(2),
    );
    const entries = await discoverChromeProfiles(directory);
    const outdated = entries.find(
      (entry) => entry.extensionInstanceId === 'outdated',
    )!;
    const future = new Date(Date.now() + 1000);
    fs.utimesSync(
      path.join(directory, outdated.hostInstanceId + '.json'),
      future,
      future,
    );
    expect(
      (await discoverChromeProfiles(directory))[0]!.extensionInstanceId,
    ).toBe('outdated');
    const normal = new ChromeExtensionTransport({ connectTimeoutMs: 1000 });
    const explicit = new ChromeExtensionTransport({ connectTimeoutMs: 1000 });
    explicit.selectProfile('chrome:outdated');
    try {
      await normal.start();
      expect(normal.isConnected()).toBe(true);
      expect(() => normal.selectProfile('chrome:compatible')).not.toThrow();
      await expect(explicit.start()).rejects.toMatchObject({
        code: 'EXTENSION_VERSION_MISMATCH',
      });
    } finally {
      await Promise.all([normal.stop(), explicit.stop()]);
    }
  });

  test('exiting an old Host preserves a replacement listener at its former endpoint', async () => {
    const oldHost = startHost();
    const oldClient = await client(oldHost.socketPath);
    await oldClient.hello();
    fs.unlinkSync(oldHost.socketPath);
    const replacement = startHost({ socketPath: oldHost.socketPath });
    const replacementClient = await client(replacement.socketPath);
    await replacementClient.hello();
    const replacementIdentity = fs.statSync(replacement.socketPath);
    oldHost.child.stdin.end();
    await waitFor(() => expect(oldHost.child.exitCode).toBe(0));
    expect(fs.statSync(replacement.socketPath).ino).toBe(
      replacementIdentity.ino,
    );
    expect(replacementClient.socket.destroyed).toBe(false);
    const newClient = await client(replacement.socketPath);
    await newClient.hello();
    expect(replacement.child.exitCode).toBeNull();
  });

  test.each([true, false])(
    'expires unanswered registration and ignores late ACKs with close ACK=%s',
    async (autoClose) => {
      const h = startHost({
        autoOpen: false,
        autoClose,
        controlledTimers: true,
      });
      const inspect = async (command = 'inspect') => {
        const response = once(h.child, 'message');
        h.child.send(command);
        return (await response)[0] as {
          clientStates: string[];
          pendingMethods: string[];
        };
      };
      const a = await client(h.socketPath);
      await waitFor(() => expect(h.messages).toHaveLength(1));
      const openingA = h.messages[0]!;
      const b = await client(h.socketPath);
      await waitFor(() => expect(h.messages).toHaveLength(2));
      h.reply(h.messages[1]!);
      await b.hello();
      expect(await inspect()).toEqual({
        clientStates: ['active', 'opening'],
        pendingMethods: ['session.open'],
      });
      await inspect('expireRequests');
      await waitFor(() => expect(a.socket.destroyed).toBe(true));
      const [close] = await h.requests('session.close');
      expect(close).toMatchObject({
        browserSessionId: openingA.browserSessionId,
        params: { reason: 'disconnected' },
      });
      if (!autoClose) {
        expect(await inspect()).toEqual({
          clientStates: ['active', 'closing'],
          pendingMethods: ['session.close'],
        });
        await inspect('expireRequests');
      }
      await waitFor(async () =>
        expect(await inspect()).toEqual({
          clientStates: ['active'],
          pendingMethods: [],
        }),
      );
      h.reply(openingA);
      h.reply(close!);
      b.send('ping', 'survived');
      const [ping] = await h.requests('ping');
      h.reply(ping!, 'pong');
      await waitFor(() =>
        expect(b.received).toContainEqual(
          expect.objectContaining({ id: 'survived', result: 'pong' }),
        ),
      );
      expect(await inspect()).toEqual({
        clientStates: ['active'],
        pendingMethods: [],
      });
      expect(
        h.messages.filter((message) => message.method === 'session.close'),
      ).toHaveLength(1);
      expect(a.received.some((message) => message.type === 'hello')).toBe(
        false,
      );
      expect(h.child.exitCode).toBeNull();
    },
  );
});
