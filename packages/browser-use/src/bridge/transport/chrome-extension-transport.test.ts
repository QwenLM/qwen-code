/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
  MAX_BRIDGE_FRAME_BYTES,
  defaultChromeBridgeSocketPath,
} from '../protocol.js';
import {
  ChromeExtensionTransport,
  isAddressInUse,
} from './chrome-extension-transport.js';
import { encodeFrame, FrameDecoder } from './framing.js';
import { PlaywrightRuntime } from '../../playwright/playwright-runtime.js';

const roots: string[] = [];
const transports: ChromeExtensionTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ChromeExtensionTransport', () => {
  it('parks other profiles without interrupting requests or accepting their events', async () => {
    const transport = await startProfileTransport();
    const changes: boolean[] = [];
    const events: unknown[] = [];
    transport.onConnectionChange((connected) => changes.push(connected));
    transport.onEvent((event) => events.push(event));
    let requestId: string | undefined;
    const a = await connectProfile(transport, 'profile-a', (request) => {
      requestId = request.id;
    });
    const pending = transport.request('cdp.send', { tabId: 7 });
    await vi.waitFor(() => expect(requestId).toBeDefined());
    const b = await connectProfile(transport, 'profile-b');
    b.write(
      encodeFrame({
        type: 'response',
        id: requestId,
        ok: true,
        result: 'wrong profile',
      }),
    );
    b.write(encodeFrame({ type: 'event', tabId: 7, method: 'Page.fromB' }));
    a.write(encodeFrame({ type: 'event', tabId: 7, method: 'Page.fromA' }));
    await vi.waitFor(() => expect(events).toHaveLength(1));
    a.write(
      encodeFrame({
        type: 'response',
        id: requestId,
        ok: true,
        result: 'profile-a:7',
      }),
    );
    await expect(pending).resolves.toBe('profile-a:7');
    expect(events).toEqual([
      { type: 'event', tabId: 7, method: 'Page.fromA', params: undefined },
    ]);
    expect(changes).toEqual([true]);
    expect(a.destroyed).toBe(false);
    expect(b.destroyed).toBe(false);
    b.destroy();
    await vi.waitFor(() => expect(b.closed).toBe(true));
    expect(changes).toEqual([true]);
  });

  it('waits for the original profile after disconnect instead of failing over', async () => {
    const transport = await startProfileTransport();
    const a = await connectProfile(transport, 'profile-a');
    await expect(transport.request('ping')).resolves.toBe('profile-a');
    await connectProfile(transport, 'profile-b');
    a.destroy();
    await vi.waitFor(() => expect(transport.isConnected()).toBe(false));
    await connectProfile(transport, 'profile-b');
    await expect(transport.request('ping', {}, 20)).rejects.toMatchObject({
      code: 'BROWSER_DISCONNECTED',
    });
    const waiting = transport.request('ping');
    await connectProfile(transport, 'profile-a');
    await expect(waiting).resolves.toBe('profile-a');
  });

  it('can select another profile after the transport is stopped and restarted', async () => {
    const transport = await startProfileTransport();
    const a = await connectProfile(transport, 'profile-a');
    await expect(transport.request('ping')).resolves.toBe('profile-a');
    const b = await connectProfile(transport, 'profile-b');
    await transport.stop();
    await vi.waitFor(() => expect(a.destroyed && b.destroyed).toBe(true));
    await transport.start();
    await connectProfile(transport, 'profile-b');
    await expect(transport.request('ping')).resolves.toBe('profile-b');
  });

  it.each([undefined, '', ' ', 42, 'x'.repeat(129)])(
    'rejects an invalid instance identity (%s) before selecting a profile',
    async (extensionInstanceId) => {
      const transport = await startProfileTransport();
      const candidate = connect(transport.socketPath);
      candidate.on('error', () => undefined);
      await once(candidate, 'connect');
      candidate.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          extensionId: CHROME_EXTENSION_ID,
          extensionInstanceId,
        }),
      );
      await once(candidate, 'close');
      expect(transport.isConnected()).toBe(false);
      await connectProfile(transport, 'profile-b');
      await expect(transport.request('ping')).resolves.toBe('profile-b');
    },
  );

  it('does not reopen a stopped socket for a late request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport({
      socketPath: path.join(root, 'bridge.sock'),
      connectTimeoutMs: 20,
    });
    transports.push(transport);
    await transport.start();
    await transport.stop();
    await expect(transport.request('ping')).rejects.toMatchObject({
      code: 'BROWSER_DISCONNECTED',
    });
    expect(fs.existsSync(transport.socketPath)).toBe(false);
  });

  it('recognizes address-in-use errors created in another VM realm', () => {
    const error = runInNewContext(
      `Object.assign(new Error('address in use'), { code: 'EADDRINUSE' })`,
    ) as unknown;

    expect(error instanceof Error).toBe(false);
    expect(isAddressInUse(error)).toBe(true);
  });

  it.skipIf(process.platform === 'win32').each(['dead', 'live'] as const)(
    'handles a %s recovery-lock owner when running in a VM realm',
    async (ownerState) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const socketPath = path.join(root, 'bridge.sock');
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
          socketPath,
        ],
        { timeout: 15_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(() => process.kill(child.pid, 0)).toThrowError(
        expect.objectContaining({ code: 'ESRCH' }),
      );
      const originalSocket = fs.statSync(socketPath);
      expect(originalSocket.isSocket()).toBe(true);
      const lockPath = `${socketPath}.recovery-lock`;
      const lockContents = JSON.stringify({
        pid: ownerState === 'dead' ? child.pid : process.pid,
        token: 'fixture-owner',
      });
      fs.writeFileSync(lockPath, lockContents);

      const bundled = await build({
        entryPoints: [
          fileURLToPath(
            new URL('./chrome-extension-transport.ts', import.meta.url),
          ),
        ],
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
      });
      const sandbox = {
        module: { exports: {} },
        require: createRequire(import.meta.url),
        process,
        Buffer,
      };
      runInNewContext(bundled.outputFiles[0].text, sandbox);
      const { ChromeExtensionTransport: ForeignTransport } = sandbox.module
        .exports as {
        ChromeExtensionTransport: typeof ChromeExtensionTransport;
      };
      const transport = new ForeignTransport({ socketPath });
      transports.push(transport);
      expect(transport instanceof ChromeExtensionTransport).toBe(false);

      if (ownerState === 'dead') {
        await expect(transport.start()).resolves.toBeUndefined();
        expect(fs.existsSync(lockPath)).toBe(false);
        const socket = connect(socketPath);
        await new Promise<void>((resolve) => socket.once('connect', resolve));
        socket.destroy();
      } else {
        await expect(transport.start()).rejects.toMatchObject({
          code: 'TRANSPORT_UNAVAILABLE',
        });
        expect(fs.readFileSync(lockPath, 'utf8')).toBe(lockContents);
        expect(fs.statSync(socketPath)).toMatchObject({
          dev: originalSocket.dev,
          ino: originalSocket.ino,
        });
      }
    },
    30_000,
  );

  it('uses an environment-independent Unix socket path', () => {
    if (process.platform === 'win32') return;
    expect(defaultChromeBridgeSocketPath({ TMPDIR: '/tmp/one' })).toBe(
      defaultChromeBridgeSocketPath({ TMPDIR: '/tmp/two' }),
    );
    expect(path.dirname(defaultChromeBridgeSocketPath({}))).not.toBe('/tmp');
    expect(
      defaultChromeBridgeSocketPath({
        AGENT_BROWSER_SOCKET_PATH: '/tmp/legacy.sock',
      }),
    ).not.toBe('/tmp/legacy.sock');
    expect(CHROME_BRIDGE_PROTOCOL_VERSION).toBe(2);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a shared socket directory without changing its permissions',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      fs.chmodSync(root, 0o777);
      const transport = new ChromeExtensionTransport({
        socketPath: path.join(root, 'bridge.sock'),
      });
      transports.push(transport);
      await expect(transport.start()).rejects.toMatchObject({
        code: 'TRANSPORT_UNAVAILABLE',
      });
      expect(fs.statSync(root).mode & 0o777).toBe(0o777);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'creates a private socket directory and rejects directory symlinks',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const directory = path.join(root, 'private');
      const transport = new ChromeExtensionTransport({
        socketPath: path.join(directory, 'bridge.sock'),
      });
      transports.push(transport);
      await transport.start();
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(transport.socketPath).mode & 0o777).toBe(0o600);
      const link = path.join(root, 'link');
      fs.symlinkSync(directory, link);
      const linked = new ChromeExtensionTransport({
        socketPath: path.join(link, 'bridge.sock'),
      });
      transports.push(linked);
      await expect(linked.start()).rejects.toMatchObject({
        code: 'TRANSPORT_UNAVAILABLE',
      });
      expect(transport.isConnected()).toBe(false);
      expect(fs.existsSync(transport.socketPath)).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a private directory belonging to another UID',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const transport = new ChromeExtensionTransport({
        socketPath: path.join(root, 'bridge.sock'),
      });
      transports.push(transport);
      const uid = vi
        .spyOn(process as { getuid: () => number }, 'getuid')
        .mockReturnValue(fs.statSync(root).uid + 1);
      try {
        await expect(transport.start()).rejects.toMatchObject({
          code: 'TRANSPORT_UNAVAILABLE',
        });
        expect(fs.existsSync(transport.socketPath)).toBe(false);
      } finally {
        uid.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'recovers a stale socket guarded by an abandoned unidentifiable lock',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const socketPath = path.join(root, 'bridge.sock');
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
          socketPath,
        ],
        { timeout: 15_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const lockPath = `${socketPath}.recovery-lock`;
      fs.writeFileSync(lockPath, '');
      const abandoned = new Date(Date.now() - 120_000);
      fs.utimesSync(lockPath, abandoned, abandoned);

      const transport = new ChromeExtensionTransport({ socketPath });
      transports.push(transport);
      await transport.start();
      expect(fs.existsSync(lockPath)).toBe(false);
      const socket = connect(socketPath);
      await new Promise<void>((resolve) => socket.once('connect', resolve));
      socket.destroy();
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'refuses recovery while a fresh unidentifiable lock may be a live peer',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const socketPath = path.join(root, 'bridge.sock');
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))",
          socketPath,
        ],
        { timeout: 15_000 },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      const lockPath = `${socketPath}.recovery-lock`;
      fs.writeFileSync(lockPath, '');

      const transport = new ChromeExtensionTransport({ socketPath });
      transports.push(transport);
      await expect(transport.start()).rejects.toMatchObject({
        code: 'TRANSPORT_UNAVAILABLE',
      });
      expect(fs.existsSync(lockPath)).toBe(true);
    },
    30_000,
  );

  it('validates the fixed extension identity and correlates responses', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport({
      socketPath: path.join(root, 'bridge.sock'),
    });
    transports.push(transport);
    await transport.start();
    const socket = connect(transport.socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      encodeFrame({
        type: 'hello',
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        extensionId: CHROME_EXTENSION_ID,
        extensionInstanceId: 'profile-a',
      }),
    );
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        const request = message as { id: string; method: string };
        socket.write(
          encodeFrame(
            request.method === 'conflict'
              ? {
                  type: 'response',
                  id: request.id,
                  ok: false,
                  error: {
                    code: 'TAB_DEBUGGER_CONFLICT',
                    message: 'Another debugger is already attached',
                  },
                }
              : {
                  type: 'response',
                  id: request.id,
                  ok: true,
                  result: { method: request.method },
                },
          ),
        );
      }
    });
    await expect(transport.request('ping')).resolves.toEqual({
      method: 'ping',
    });
    await expect(transport.request('conflict')).rejects.toMatchObject({
      code: 'TAB_DEBUGGER_CONFLICT',
    });
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));
    socket.write(
      encodeFrame({
        type: 'event',
        tabId: 7,
        method: 'Page.invalidChildEvent',
        params: {},
        sessionId: '',
      }),
    );
    socket.write(
      encodeFrame({
        type: 'event',
        tabId: 7,
        method: 'Page.rootEvent',
        params: {},
      }),
    );
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'event',
        tabId: 7,
        method: 'Page.rootEvent',
        params: {},
      }),
    );
    expect(events).toHaveLength(1);
    socket.destroy();
  });

  it('allows browser listing to wait for discovery while keeping explicit probes short', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport({
      socketPath: path.join(root, 'bridge.sock'),
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 500,
    });
    transports.push(transport);
    await transport.start();
    await expect(transport.request('ping', {}, 5)).rejects.toMatchObject({
      code: 'BROWSER_DISCONNECTED',
    });
    const runtime = new PlaywrightRuntime({ bridge: transport });
    const request = runtime.dispatch('browsers.list', {});
    // Discovery also needs to outlast the old 1.5-second browser-list probe.
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    const socket = connect(transport.socketPath);
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        socket.write(
          encodeFrame({
            type: 'response',
            id: (message as { id: string }).id,
            ok: true,
            result: 'ready',
          }),
        );
      }
    });
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      encodeFrame({
        type: 'hello',
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        extensionId: CHROME_EXTENSION_ID,
        extensionInstanceId: 'profile-a',
      }),
    );
    await expect(request).resolves.toEqual([
      expect.objectContaining({ id: 'chrome' }),
    ]);
    socket.destroy();
  });

  it('rejects an oversized request before registering its timeout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport({
      socketPath: path.join(root, 'bridge.sock'),
    });
    transports.push(transport);
    await transport.start();
    const socket = connect(transport.socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      encodeFrame({
        type: 'hello',
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        extensionId: CHROME_EXTENSION_ID,
        extensionInstanceId: 'profile-a',
      }),
    );
    await vi.waitFor(() => expect(transport.isConnected()).toBe(true));

    await expect(
      transport.request(
        'oversized',
        { value: 'x'.repeat(MAX_BRIDGE_FRAME_BYTES) },
        5,
      ),
    ).rejects.toThrow(`Bridge frame exceeds ${MAX_BRIDGE_FRAME_BYTES} bytes`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.destroy();
  });

  it('preserves a non-socket path instead of deleting it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const socketPath = path.join(root, 'bridge.sock');
    fs.writeFileSync(socketPath, 'keep-me');
    const transport = new ChromeExtensionTransport({ socketPath });
    transports.push(transport);
    await expect(transport.start()).rejects.toMatchObject({
      code: 'TRANSPORT_UNAVAILABLE',
    });
    expect(fs.readFileSync(socketPath, 'utf8')).toBe('keep-me');
  });

  it('does not replace or unlink a live owner socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const socketPath = path.join(root, 'bridge.sock');
    const owner = new ChromeExtensionTransport({ socketPath });
    const contender = new ChromeExtensionTransport({ socketPath });
    transports.push(contender, owner);
    await owner.start();
    const socket = connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      encodeFrame({
        type: 'hello',
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        extensionId: CHROME_EXTENSION_ID,
        extensionInstanceId: 'profile-a',
      }),
    );
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        const request = message as { id: string; method: string };
        socket.write(
          encodeFrame({
            type: 'response',
            id: request.id,
            ok: true,
            result: request.method,
          }),
        );
      }
    });
    await expect(owner.request('before')).resolves.toBe('before');
    await expect(contender.start()).rejects.toMatchObject({
      code: 'BROWSER_USE_BUSY',
    });
    await contender.stop();
    expect(fs.existsSync(socketPath)).toBe(true);
    await expect(owner.request('after')).resolves.toBe('after');
    socket.destroy();
  });

  it('stops with a silent unauthenticated candidate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport({
      socketPath: path.join(root, 'bridge.sock'),
    });
    transports.push(transport);
    await transport.start();
    const candidate = connect(transport.socketPath);
    await new Promise<void>((resolve) => candidate.once('connect', resolve));
    await expect(transport.stop()).resolves.toBeUndefined();
    candidate.destroy();
  });

  it('waits for an overlapping stop before restarting', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport({
      socketPath: path.join(root, 'bridge.sock'),
    });
    transports.push(transport);
    await transport.start();
    const stopping = transport.stop();
    const restarting = transport.start();
    await expect(Promise.all([stopping, restarting])).resolves.toBeDefined();
    expect(fs.statSync(transport.socketPath).isSocket()).toBe(true);
  });
});

async function startProfileTransport(): Promise<ChromeExtensionTransport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-profiles-'));
  roots.push(root);
  const transport = new ChromeExtensionTransport({
    socketPath: path.join(root, 'bridge.sock'),
  });
  transports.push(transport);
  await transport.start();
  return transport;
}

async function connectProfile(
  transport: ChromeExtensionTransport,
  extensionInstanceId: string,
  onRequest?: (request: { id: string }) => void,
): Promise<Socket> {
  const socket = connect(transport.socketPath);
  socket.on('error', () => undefined);
  const decoder = new FrameDecoder();
  socket.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const request = message as { id: string };
      if (onRequest) onRequest(request);
      else
        socket.write(
          encodeFrame({
            type: 'response',
            id: request.id,
            ok: true,
            result: extensionInstanceId,
          }),
        );
    }
  });
  await once(socket, 'connect');
  socket.write(
    encodeFrame({
      type: 'hello',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionId: CHROME_EXTENSION_ID,
      extensionInstanceId,
    }),
  );
  return socket;
}
