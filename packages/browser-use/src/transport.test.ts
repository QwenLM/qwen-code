/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { connect } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder } from './framing.js';
import {
  BROWSER_USE_PROTOCOL_VERSION,
  browserUseSocketPath,
  QWEN_CHROME_EXTENSION_ID,
} from './protocol.js';
import { ChromeExtensionTransport } from './transport.js';

const roots: string[] = [];
const transports: ChromeExtensionTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('ChromeExtensionTransport', () => {
  it('uses an environment-independent Unix socket path', () => {
    if (process.platform === 'win32') return;
    expect(browserUseSocketPath({ TMPDIR: '/tmp/one' })).toBe(
      browserUseSocketPath({ TMPDIR: '/tmp/two' }),
    );
  });

  it('validates the fixed extension identity and correlates responses', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport(
      path.join(root, 'bridge.sock'),
    );
    transports.push(transport);
    await transport.start();
    const socket = connect(transport.socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      encodeFrame({
        type: 'hello',
        protocolVersion: BROWSER_USE_PROTOCOL_VERSION,
        extensionId: QWEN_CHROME_EXTENSION_ID,
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
    socket.destroy();
  });

  it('preserves a non-socket path instead of deleting it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const socketPath = path.join(root, 'bridge.sock');
    fs.writeFileSync(socketPath, 'keep-me');
    const transport = new ChromeExtensionTransport(socketPath);
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
    const owner = new ChromeExtensionTransport(socketPath);
    const contender = new ChromeExtensionTransport(socketPath);
    transports.push(contender, owner);
    await owner.start();
    const socket = connect(socketPath);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      encodeFrame({
        type: 'hello',
        protocolVersion: BROWSER_USE_PROTOCOL_VERSION,
        extensionId: QWEN_CHROME_EXTENSION_ID,
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
      code: 'TRANSPORT_UNAVAILABLE',
    });
    await contender.stop();
    expect(fs.existsSync(socketPath)).toBe(true);
    await expect(owner.request('after')).resolves.toBe('after');
    socket.destroy();
  });

  it('stops with a silent unauthenticated candidate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
    roots.push(root);
    const transport = new ChromeExtensionTransport(
      path.join(root, 'bridge.sock'),
    );
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
    const transport = new ChromeExtensionTransport(
      path.join(root, 'bridge.sock'),
    );
    transports.push(transport);
    await transport.start();
    const stopping = transport.stop();
    const restarting = transport.start();
    await expect(Promise.all([stopping, restarting])).resolves.toBeDefined();
    expect(fs.statSync(transport.socketPath).isSocket()).toBe(true);
  });
});
