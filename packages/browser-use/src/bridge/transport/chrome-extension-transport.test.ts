/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { connect } from 'node:net';
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
  defaultChromeBridgeSocketDirectory,
  defaultChromeBridgeSocketPath,
  type BridgeRequest,
} from '../protocol.js';
import {
  ChromeExtensionTransport,
  ensureSocketDirectory,
  isAddressInUse,
  type ChromeExtensionTransportOptions,
} from './chrome-extension-transport.js';
import { encodeFrame, FrameDecoder } from './framing.js';

const roots: string[] = [];
const transports: ChromeExtensionTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ensureSocketDirectory', () => {
  it('creates a missing directory with owner-only permissions', async () => {
    if (process.platform === 'win32') return;
    // The ancestor sweep rejects symlinks, and macOS reaches its temp root
    // through one (/var -> /private/var), so resolve the real path first.
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'qbu-dir-'),
    );
    roots.push(root);
    const dir = path.join(root, 'qwen-browser-use', '1000');
    await ensureSocketDirectory(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('tightens a permissive owned directory and rejects a non-directory', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'qbu-dir-'),
    );
    roots.push(root);
    const dir = path.join(root, 'loose');
    fs.mkdirSync(dir, { mode: 0o755 });
    await ensureSocketDirectory(dir);
    expect(fs.statSync(dir).mode & 0o077).toBe(0);
    const squat = path.join(root, 'squat');
    fs.writeFileSync(squat, '');
    await expect(ensureSocketDirectory(squat)).rejects.toThrow('not usable');
  });

  it('rejects a socket directory behind a symlinked parent', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'qbu-dir-'),
    );
    roots.push(root);
    const target = path.join(root, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, 'link'));
    await expect(
      ensureSocketDirectory(path.join(root, 'link', 'leaf')),
    ).rejects.toThrow('not usable');
  });

  it('rejects a socket directory under a group/other-writable ancestor', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), 'qbu-dir-'),
    );
    roots.push(root);
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose);
    fs.chmodSync(loose, 0o777);
    await expect(
      ensureSocketDirectory(path.join(loose, 'leaf')),
    ).rejects.toThrow('not usable');
  });
});

describe('ChromeExtensionTransport', () => {
  it.skipIf(process.platform === 'win32').each([
    ['Input.dispatchMouseEvent', undefined],
    ['Input.dispatchKeyEvent', undefined],
    ['Input.insertText', undefined],
    ['Input.dispatchMouseEvent', 'frame-1'],
    ['Input.dispatchKeyEvent', 'frame-1'],
    ['Input.insertText', 'frame-1'],
  ] as const)(
    'acknowledges pending %s on a dialog in its session %s',
    async (method, sessionId) => {
      const { transport, socket, requests } = await connectedTransport();
      const order: string[] = [];
      transport.onEvent(() => order.push('dialog'));
      const result = transport
        .request('cdp.send', { tabId: 7, sessionId, method }, 300)
        .then(
          (value) => {
            order.push('result');
            return value;
          },
          (error: unknown) => error,
        );
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      socket.write(
        encodeFrame({
          type: 'event',
          tabId: 7,
          sessionId,
          method: 'Page.javascriptDialogOpening',
          params: { type: 'alert', message: 'Clicked' },
        }),
      );
      expect(await result).toStrictEqual({});
      expect(order).toEqual(['dialog', 'result']);

      socket.write(
        encodeFrame({
          type: 'response',
          id: requests[0].id,
          ok: false,
          error: { message: 'late input response' },
        }),
      );
      const next = transport.request('ping');
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      socket.write(
        encodeFrame({
          type: 'response',
          id: requests[1].id,
          ok: true,
          result: 'pong',
        }),
      );
      await expect(next).resolves.toBe('pong');
      expect(order).toEqual(['dialog', 'result']);
      socket.destroy();
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['Input.dispatchMouseEvent', 8, 'frame-1'],
    ['Input.dispatchKeyEvent', 7, 'frame-2'],
    ['Input.insertText', 7, undefined],
    ['Runtime.evaluate', 7, 'frame-1'],
    ['DOM.getDocument', 7, 'frame-1'],
  ] as const)(
    'preserves the native response for %s on tab %s session %s',
    async (method, tabId, sessionId) => {
      const { transport, socket, requests } = await connectedTransport();
      const eventSeen = vi.fn();
      transport.onEvent(eventSeen);
      const settled = vi.fn();
      const operation = transport
        .request('cdp.send', { tabId, sessionId, method })
        .then(settled, settled);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      socket.write(
        encodeFrame({
          type: 'event',
          tabId: 7,
          sessionId: 'frame-1',
          method: 'Page.javascriptDialogOpening',
          params: { type: 'alert', message: 'Unrelated' },
        }),
      );
      await vi.waitFor(() => expect(eventSeen).toHaveBeenCalledOnce());
      expect(settled).not.toHaveBeenCalled();
      socket.write(
        encodeFrame({
          type: 'response',
          id: requests[0].id,
          ok: false,
          error: { message: 'native command failed' },
        }),
      );
      await operation;
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'native command failed' }),
      );
      socket.destroy();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not reopen a stopped socket for a late request',
    async () => {
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
    },
  );

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
    expect(
      defaultChromeBridgeSocketPath({
        AGENT_BROWSER_SOCKET_PATH: '/tmp/legacy.sock',
      }),
    ).not.toBe('/tmp/legacy.sock');
    expect(CHROME_BRIDGE_PROTOCOL_VERSION).toBe(1);
  });

  it('honours an explicit QWEN_BROWSER_USE_SOCKET_PATH and ignores a blank one', () => {
    expect(
      defaultChromeBridgeSocketPath({
        QWEN_BROWSER_USE_SOCKET_PATH: '/run/qbu/x.sock',
      }),
    ).toBe('/run/qbu/x.sock');
    expect(
      defaultChromeBridgeSocketPath({ QWEN_BROWSER_USE_SOCKET_PATH: ' ' }),
    ).toBe(defaultChromeBridgeSocketPath({}));
  });

  it('prefers an owned per-user runtime directory over world-writable /tmp', () => {
    const owned = () => ({
      isDirectory: () => true,
      uid: 42,
      mode: 0o040700,
    });
    expect(defaultChromeBridgeSocketDirectory(42, 'linux', owned)).toBe(
      '/run/user/42',
    );
    // A foreign-owned or group/other-accessible runtime dir is not safer
    // than the per-user temp subdirectory the server creates 0700.
    expect(
      defaultChromeBridgeSocketDirectory(42, 'linux', () => ({
        isDirectory: () => true,
        uid: 43,
        mode: 0o040700,
      })),
    ).toBe('/tmp/qwen-browser-use-42');
    expect(
      defaultChromeBridgeSocketDirectory(42, 'linux', () => ({
        isDirectory: () => true,
        uid: 42,
        mode: 0o040770,
      })),
    ).toBe('/tmp/qwen-browser-use-42');
    expect(
      defaultChromeBridgeSocketDirectory(42, 'linux', () => undefined),
    ).toBe('/tmp/qwen-browser-use-42');
    expect(
      defaultChromeBridgeSocketDirectory(42, 'linux', () => ({
        isDirectory: () => false,
        uid: 42,
        mode: 0o040700,
      })),
    ).toBe('/tmp/qwen-browser-use-42');
    expect(defaultChromeBridgeSocketDirectory('default', 'linux')).toBe(
      '/tmp/qwen-browser-use-default',
    );
    expect(defaultChromeBridgeSocketDirectory(42, 'darwin')).toBe(
      '/private/tmp/qwen-browser-use-42',
    );
    // The per-user directory sits directly under the sticky temp root: a
    // shared intermediate would belong to whichever user created it first.
    expect(path.dirname(defaultChromeBridgeSocketDirectory(42, 'darwin'))).toBe(
      '/private/tmp',
    );
    expect(
      path.dirname(
        defaultChromeBridgeSocketDirectory(42, 'linux', () => undefined),
      ),
    ).toBe('/tmp');
  });

  it('derives the macOS socket directory without reading ambient TMPDIR', () => {
    const original = process.env.TMPDIR;
    try {
      process.env.TMPDIR = '/var/folders/one';
      const first = defaultChromeBridgeSocketDirectory(42, 'darwin');
      process.env.TMPDIR = '/var/folders/two';
      expect(defaultChromeBridgeSocketDirectory(42, 'darwin')).toBe(first);
      expect(first).toBe('/private/tmp/qwen-browser-use-42');
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  });

  it('derives the default socket path from a private directory when one is available', () => {
    if (process.platform === 'win32') return;
    const parent = path.dirname(defaultChromeBridgeSocketPath({}));
    // The per-user fallback directory is created 0700 by the server at
    // bind time and may not exist yet.
    if (path.basename(parent).startsWith('qwen-browser-use-')) return;
    expect(parent).toBe(
      `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 0}`,
    );
    expect(fs.statSync(parent).mode & 0o002).toBe(0);
  });

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

  it.skipIf(process.platform === 'win32')(
    'validates the fixed extension identity and correlates responses',
    async () => {
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
              result: { method: request.method },
            }),
          );
        }
      });
      await expect(transport.request('ping')).resolves.toEqual({
        method: 'ping',
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
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects an oversized request before registering its timeout',
    async () => {
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
    },
  );

  it.skipIf(process.platform === 'win32')(
    'preserves a non-socket path instead of deleting it',
    async () => {
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
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not replace or unlink a live owner socket',
    async () => {
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
    },
  );

  it.skipIf(process.platform === 'win32')(
    'stops with a silent unauthenticated candidate',
    async () => {
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
    },
  );

  it.skipIf(process.platform === 'win32')(
    'waits for an overlapping stop before restarting',
    async () => {
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
    },
  );

  it.skipIf(process.platform === 'win32').each([
    [
      'protocolVersion',
      {
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION + 1,
        extensionId: CHROME_EXTENSION_ID,
      },
    ],
    [
      'extensionId',
      {
        protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
        extensionId: 'wrong-extension-id',
      },
    ],
  ] as const)(
    'rejects a hello with a mismatched %s',
    async (_field, identity) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const transport = new ChromeExtensionTransport({
        socketPath: path.join(root, 'bridge.sock'),
      });
      transports.push(transport);
      await transport.start();
      const impostor = connect(transport.socketPath);
      impostor.on('error', () => undefined);
      await new Promise<void>((resolve) => impostor.once('connect', resolve));
      impostor.write(encodeFrame({ type: 'hello', ...identity }));
      await new Promise<void>((resolve) => impostor.once('close', resolve));
      expect(transport.isConnected()).toBe(false);

      // The same server still promotes a matching hello afterwards.
      const extension = connect(transport.socketPath);
      await new Promise<void>((resolve) => extension.once('connect', resolve));
      extension.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          extensionId: CHROME_EXTENSION_ID,
        }),
      );
      await vi.waitFor(() => expect(transport.isConnected()).toBe(true));
      extension.destroy();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'notifies validated connection changes and honours unsubscribe',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const transport = new ChromeExtensionTransport({
        socketPath: path.join(root, 'bridge.sock'),
      });
      transports.push(transport);
      await transport.start();
      const states: boolean[] = [];
      const unsubscribe = transport.onConnectionChange((connected) => {
        states.push(connected);
      });
      const first = connect(transport.socketPath);
      await new Promise<void>((resolve) => first.once('connect', resolve));
      first.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          extensionId: CHROME_EXTENSION_ID,
        }),
      );
      await vi.waitFor(() => expect(states).toEqual([true]));
      first.destroy();
      await vi.waitFor(() => expect(states).toEqual([true, false]));

      unsubscribe();
      const second = connect(transport.socketPath);
      await new Promise<void>((resolve) => second.once('connect', resolve));
      second.write(
        encodeFrame({
          type: 'hello',
          protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
          extensionId: CHROME_EXTENSION_ID,
        }),
      );
      await vi.waitFor(() => expect(transport.isConnected()).toBe(true));
      expect(states).toEqual([true, false]);
      second.destroy();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'fails an in-flight request closed when the extension disconnects',
    async () => {
      const { transport, socket, requests } = await connectedTransport();
      const slow = transport.request('slow');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      socket.destroy();
      await expect(slow).rejects.toMatchObject({
        code: 'BROWSER_DISCONNECTED',
      });
      expect(transport.isConnected()).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'times out an unanswered request with the configured budget',
    async () => {
      const { transport, socket, requests } = await connectedTransport({
        requestTimeoutMs: 10,
      });
      const stalled = transport
        .request('stalled')
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      await expect(stalled).resolves.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        message: expect.stringContaining('stalled'),
      });
      expect(transport.isConnected()).toBe(true);
      socket.destroy();
    },
  );

  it.skipIf(process.platform === 'win32').each([
    ['NOT_GRANTED', 'TAB_NOT_GRANTED'],
    ['STALE_TAB', 'STALE_TAB'],
    ['UNSUPPORTED_TAB', 'UNSUPPORTED_TAB'],
    ['PERMISSION_REQUIRED', 'PERMISSION_REQUIRED'],
    ['SOMETHING_NEW', 'OPERATION_FAILED'],
    [undefined, 'OPERATION_FAILED'],
  ] as const)('maps extension error code %s to %s', async (code, expected) => {
    const { transport, socket, requests } = await connectedTransport();
    const failing = transport.request('tabs.attach');
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    socket.write(
      encodeFrame({
        type: 'response',
        id: requests[0].id,
        ok: false,
        error: { code, message: 'tab not granted' },
      }),
    );
    await expect(failing).rejects.toMatchObject({
      code: expected,
      message: 'tab not granted',
    });
    socket.destroy();
  });

  it.skipIf(process.platform === 'win32')(
    'falls back to a generic message for an extension error without one',
    async () => {
      const { transport, socket, requests } = await connectedTransport();
      const failing = transport.request('tabs.attach');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      socket.write(
        encodeFrame({
          type: 'response',
          id: requests[0].id,
          ok: false,
          error: {},
        }),
      );
      await expect(failing).rejects.toMatchObject({
        code: 'OPERATION_FAILED',
        message: 'Chrome extension operation failed',
      });
      socket.destroy();
    },
  );
});

async function connectedTransport(
  options: Omit<ChromeExtensionTransportOptions, 'socketPath'> = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
  roots.push(root);
  const transport = new ChromeExtensionTransport({
    socketPath: path.join(root, 'bridge.sock'),
    ...options,
  });
  transports.push(transport);
  await transport.start();
  const socket = connect(transport.socketPath);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  const requests: BridgeRequest[] = [];
  const decoder = new FrameDecoder();
  socket.on('data', (chunk: Buffer) => {
    requests.push(...(decoder.push(chunk) as BridgeRequest[]));
  });
  socket.write(
    encodeFrame({
      type: 'hello',
      protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
      extensionId: CHROME_EXTENSION_ID,
    }),
  );
  await vi.waitFor(() => expect(transport.isConnected()).toBe(true));
  return { transport, socket, requests };
}
