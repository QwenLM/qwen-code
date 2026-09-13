/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { connect, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A scripted lstat simulates the lstat→mkdir race: the directory appears
// between the existence check and the create, owned by someone else or with
// permissive bits.
const lstatMock = vi.hoisted(() => vi.fn());
// A scripted chmod fails the post-listen step of start() while the socket is
// already bound and accepting.
const chmodMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: lstatMock, chmod: chmodMock };
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
  type BridgeRequest,
} from '../protocol.js';
import {
  ChromeExtensionTransport,
  ensureSocketDirectory,
} from './chrome-extension-transport.js';
import { encodeFrame, FrameDecoder } from './framing.js';

const roots: string[] = [];
const transports: ChromeExtensionTransport[] = [];

beforeEach(() => {
  lstatMock.mockImplementation(
    async (target: string) => await fs.promises.lstat(target),
  );
  chmodMock.mockImplementation(
    async (target: string, mode: number) =>
      await fs.promises.chmod(target, mode),
  );
});

afterEach(async () => {
  for (const transport of transports.splice(0)) await transport.stop();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  lstatMock.mockReset();
  chmodMock.mockReset();
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

describe('ensureSocketDirectory create race', () => {
  it.skipIf(process.platform === 'win32' || owner === undefined)(
    'rejects a permissive directory that appears during creation',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-race-'));
      roots.push(root);
      const leaf = path.join(root, 'leaf');
      lstatMock.mockImplementation(async (target: string) => {
        if (target === leaf) {
          // First look: missing. After mkdir: a permissive entry the
          // mkdir(0o700) could not have produced itself.
          const seen = lstatMock.mock.calls.filter(
            ([candidate]) => candidate === leaf,
          ).length;
          if (seen === 1)
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return directoryInfo(owner!, 0o755);
        }
        return await fs.promises.lstat(target);
      });
      await expect(ensureSocketDirectory(leaf)).rejects.toThrow('not usable');
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
          const seen = lstatMock.mock.calls.filter(
            ([candidate]) => candidate === leaf,
          ).length;
          if (seen === 1)
            throw Object.assign(new Error('missing'), { code: 'ENOENT' });
          return directoryInfo(owner! + 1, 0o700);
        }
        return await fs.promises.lstat(target);
      });
      await expect(ensureSocketDirectory(leaf)).rejects.toThrow('not usable');
    },
  );
});

describe('start failure after listen', () => {
  it.skipIf(process.platform === 'win32')(
    'tears down a validated peer when start fails after listen',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qbu-transport-'));
      roots.push(root);
      const socketPath = path.join(root, 'bridge.sock');
      const transport = new ChromeExtensionTransport({ socketPath });
      transports.push(transport);
      let peer: Socket | undefined;
      chmodMock.mockImplementationOnce(async () => {
        peer = connect(socketPath);
        peer.on('error', () => undefined);
        await new Promise<void>((resolve) => peer!.once('connect', resolve));
        peer.write(
          encodeFrame({
            type: 'hello',
            protocolVersion: CHROME_BRIDGE_PROTOCOL_VERSION,
            extensionId: CHROME_EXTENSION_ID,
          }),
        );
        await vi.waitFor(() => expect(transport.isConnected()).toBe(true));
        throw Object.assign(new Error('read-only socket'), { code: 'EPERM' });
      });

      await expect(transport.start()).rejects.toMatchObject({
        code: 'TRANSPORT_UNAVAILABLE',
      });
      expect(fs.existsSync(socketPath)).toBe(false);
      expect(transport.isConnected()).toBe(false);
      await vi.waitFor(() => expect(peer?.destroyed).toBe(true));
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
      socket.destroy();
    },
  );
});
