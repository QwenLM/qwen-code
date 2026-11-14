/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted lstat returns the directory seen after mkdir, including a
// concurrent creator that supplied unsafe ownership or permissions.
const lstatMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: lstatMock };
});

// The transport deliberately imports its timers from node:timers (the global
// ones do not exist in the VM realm the recovery path runs in), so
// vi.useFakeTimers() cannot see them; this mock records each request timer
// with its budget instead.
const requestTimers = vi.hoisted(() => {
  interface Handle {
    callback: () => void;
    ms: number;
    unref(): Handle;
  }
  const pending = new Map<Handle, { callback: () => void; ms: number }>();
  return {
    pending,
    setTimeout: (callback: () => void, ms?: number) => {
      const handle: Handle = {
        callback,
        ms: ms ?? 0,
        unref: () => handle,
      };
      pending.set(handle, { callback, ms: ms ?? 0 });
      return handle as unknown as NodeJS.Timeout;
    },
    clearTimeout: (handle: unknown) => {
      pending.delete(handle as Handle);
    },
    fire(ms: number) {
      for (const [handle, entry] of [...pending]) {
        if (entry.ms === ms) {
          pending.delete(handle);
          entry.callback();
        }
      }
    },
    reset() {
      pending.clear();
    },
  };
});
vi.mock('node:timers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers')>();
  return {
    ...actual,
    setTimeout: requestTimers.setTimeout,
    clearTimeout: requestTimers.clearTimeout,
  };
});

import {
  CDP_REQUEST_TIMEOUT_MS,
  CHROME_BRIDGE_PROTOCOL_VERSION,
  CHROME_EXTENSION_ID,
} from './protocol.js';
import { ChromeExtensionTransport } from './transport/chrome-extension-transport.js';
import { prepareSocketDirectory } from './socket-path.js';
import { encodeFrame, FrameDecoder } from './transport/framing.js';

const roots: string[] = [];
const transports: ChromeExtensionTransport[] = [];
const servers: Server[] = [];

beforeEach(() => {
  lstatMock.mockImplementation(
    async (target: string) => await fs.promises.lstat(target),
  );
});

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  lstatMock.mockReset();
  requestTimers.reset();
});

const owner =
  typeof process.getuid === 'function' ? process.getuid() : undefined;

function directoryInfo(uid: number, mode: number) {
  return {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid,
    mode: 0o040000 | mode,
  };
}

describe('prepareSocketDirectory creation checks', () => {
  it.skipIf(process.platform === 'win32' || owner === undefined)(
    'rejects a permissive directory that appears during creation',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-race-'));
      roots.push(root);
      const leaf = path.join(root, 'leaf');
      lstatMock.mockImplementation(async (target: string) => {
        if (target === leaf) {
          return directoryInfo(owner!, 0o755);
        }
        return await fs.promises.lstat(target);
      });
      await expect(
        prepareSocketDirectory(path.join(leaf, 'bridge.sock')),
      ).rejects.toThrow('private user-owned directory');
    },
  );

  it.skipIf(process.platform === 'win32' || owner === undefined)(
    'rejects a foreign-owned directory that appears during creation',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-race-'));
      roots.push(root);
      const leaf = path.join(root, 'leaf');
      lstatMock.mockImplementation(async (target: string) => {
        if (target === leaf) {
          return directoryInfo(owner! + 1, 0o700);
        }
        return await fs.promises.lstat(target);
      });
      await expect(
        prepareSocketDirectory(path.join(leaf, 'bridge.sock')),
      ).rejects.toThrow('private user-owned directory');
    },
  );
});

describe('request deadlines', () => {
  it.skipIf(process.platform === 'win32')(
    'lets a CDP command outlive the 120s operation ceiling',
    async () => {
      expect(CDP_REQUEST_TIMEOUT_MS).toBeGreaterThan(120_000);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const transport = new ChromeExtensionTransport({
        socketPath: path.join(root, 'bridge.sock'),
      });
      transports.push(transport);
      let socket: Socket | undefined;
      const server = createServer((peer) => {
        socket = peer;
        const decoder = new FrameDecoder();
        peer.on('data', (chunk) => {
          for (const value of decoder.push(chunk))
            if ((value as { type: string }).type === 'client.hello')
              peer.write(
                encodeFrame({
                  type: 'hello',
                  protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
                  extensionId: CHROME_EXTENSION_ID,
                  extensionInstanceId: 'deadline-test',
                  hostInstanceId: 'host',
                  browserSessionId: 'session',
                }),
              );
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(transport.socketPath, resolve),
      );
      await transport.start();

      let cdpSettled = false;
      let cdpResult: unknown;
      const cdp = transport
        .request('cdp.send', { tabId: 1, method: 'Runtime.callFunctionOn' })
        .then(
          (value) => {
            cdpSettled = true;
            cdpResult = value;
          },
          (error: unknown) => {
            cdpSettled = true;
            cdpResult = error;
          },
        );
      const ping = transport
        .request('ping')
        .catch((error: unknown) => error as unknown);

      // The request bodies reach their timer registration on a microtask.
      await vi.waitFor(() => {
        const budgets = [...requestTimers.pending.values()].map(
          (entry) => entry.ms,
        );
        expect(budgets).toEqual(
          expect.arrayContaining([30_000, CDP_REQUEST_TIMEOUT_MS]),
        );
      });

      // The non-CDP default still applies to every other bridge request.
      requestTimers.fire(30_000);
      await expect(ping).resolves.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(cdpSettled).toBe(false);

      requestTimers.fire(CDP_REQUEST_TIMEOUT_MS);
      await cdp;
      expect(cdpResult).toMatchObject({
        code: 'OPERATION_TIMEOUT',
        message: expect.stringContaining('cdp.send'),
      });
      socket!.destroy();
      await vi.waitFor(() => expect(transport.isConnected()).toBe(false));
    },
  );
});
