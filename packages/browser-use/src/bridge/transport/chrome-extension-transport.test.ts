/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { connect } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
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

const roots: string[] = [];
const transports: ChromeExtensionTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ChromeExtensionTransport', () => {
  it('recognizes address-in-use errors created in another VM realm', () => {
    const error = runInNewContext(
      `Object.assign(new Error('address in use'), { code: 'EADDRINUSE' })`,
    ) as unknown;

    expect(error instanceof Error).toBe(false);
    expect(isAddressInUse(error)).toBe(true);
  });

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
