/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MutableOriginAllowlist } from '../auth.js';
import { CredentialStore } from './credentials.js';
import { LocalControlService } from './service.js';

const sleep = vi.hoisted(() => ({ release: vi.fn() }));
const sleepInhibitorMock = vi.hoisted(() => ({
  acquire: vi.fn(() => sleep),
  isRunning: vi.fn(() => true),
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  sleepInhibitor: sleepInhibitorMock,
}));

vi.mock('./lan-interfaces.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lan-interfaces.js')>()),
  selectLanAddress: vi.fn(() => ({
    interfaceName: 'en0',
    address: '127.0.0.1',
  })),
}));

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('LocalControlService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sleepInhibitorMock.isRunning.mockReturnValue(true);
  });

  it('serializes lifecycle changes and fully revokes state on disable', async () => {
    const port = await unusedPort();
    const credentials = new CredentialStore();
    const origins = new MutableOriginAllowlist({
      allowAny: false,
      origins: new Set(),
    });
    const attached: Server[] = [];
    const detached: Server[] = [];
    const service = new LocalControlService({
      app: express(),
      credentials,
      originAllowlist: origins,
      attachWebSocket: (server) => attached.push(server),
      detachWebSocket: (server) => detached.push(server),
      getPort: () => port,
    });

    const [first, second] = await Promise.all([
      service.enable(),
      service.enable(),
    ]);
    expect(second.url).toBe(first.url);
    expect(first.sleepInhibited).toBe(true);
    expect(attached).toHaveLength(1);
    expect(attached[0].maxConnections).toBe(64);
    expect(attached[0].headersTimeout).toBe(10_000);
    // A bounded whole-request budget: connection slots are consumed pre-auth,
    // so an unlimited budget let an unauthenticated LAN client trickle bodies
    // and hold every slot open indefinitely (round-7 review). 30 minutes
    // still covers a phone trickling a large upload over slow Wi-Fi.
    expect(attached[0].requestTimeout).toBe(30 * 60_000);
    expect(attached[0].keepAliveTimeout).toBe(5_000);
    // Exactly one: the persistent logging handler. The temporary `once('error')`
    // used while waiting for `listening` must be removed once listening
    // resolves, or it lingers on the running server for its whole lifetime.
    expect(attached[0].listenerCount('error')).toBe(1);
    expect(origins.allows(`http://127.0.0.1:${port}`)).toBe(true);

    const oldToken = new URL(first.url!).hash.slice('#token='.length);
    expect(
      credentials.verify(oldToken, {
        kind: 'local-control',
        authority: `127.0.0.1:${port}`,
      }),
    ).toBe(true);

    await Promise.all([service.disable(), service.disable()]);
    expect(service.active).toBe(false);
    expect(detached).toEqual(attached);
    expect(origins.allows(`http://127.0.0.1:${port}`)).toBe(false);
    expect(
      credentials.verify(oldToken, {
        kind: 'local-control',
        authority: `127.0.0.1:${port}`,
      }),
    ).toBe(false);
    expect(sleep.release).toHaveBeenCalledOnce();

    const next = await service.enable();
    expect(next.url).not.toBe(first.url);
    await service.disable();
  });

  it('orders disable after an in-flight enable', async () => {
    const port = await unusedPort();
    const service = new LocalControlService({
      app: express(),
      credentials: new CredentialStore(),
      originAllowlist: new MutableOriginAllowlist({
        allowAny: false,
        origins: new Set(),
      }),
      attachWebSocket: vi.fn(),
      detachWebSocket: vi.fn(),
      getPort: () => port,
    });

    const enabling = service.enable();
    const disabling = service.disable();
    expect((await enabling).active).toBe(true);
    expect((await disabling).active).toBe(false);
    expect(service.active).toBe(false);
  });

  it('validates target before committing listener state', async () => {
    const port = await unusedPort();
    const origins = new MutableOriginAllowlist({
      allowAny: false,
      origins: new Set(),
    });
    const attachWebSocket = vi.fn();
    const service = new LocalControlService({
      app: express(),
      credentials: new CredentialStore(),
      originAllowlist: origins,
      attachWebSocket,
      detachWebSocket: vi.fn(),
      getPort: () => port,
    });

    await expect(service.enable({ target: 'http://%' })).rejects.toThrow();

    expect(service.active).toBe(false);
    expect(attachWebSocket).not.toHaveBeenCalled();
    expect(origins.allows(`http://127.0.0.1:${port}`)).toBe(false);
  });

  it('reports sleep inhibition only when the inhibitor is running', async () => {
    sleepInhibitorMock.isRunning.mockReturnValue(false);
    const port = await unusedPort();
    const service = new LocalControlService({
      app: express(),
      credentials: new CredentialStore(),
      originAllowlist: new MutableOriginAllowlist({
        allowAny: false,
        origins: new Set(),
      }),
      attachWebSocket: vi.fn(),
      detachWebSocket: vi.fn(),
      getPort: () => port,
    });

    expect((await service.enable()).sleepInhibited).toBe(false);
    await service.disable();
  });

  it('detaches the temporary listening handler when listen fails', async () => {
    // Occupy the port so `listen()` rejects with EADDRINUSE. The pending
    // `once('listening')` handler must be removed on the error path; if it
    // lingered, a retry on the same server could resolve via the stale handler.
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve),
    );
    const busyPort = (blocker.address() as AddressInfo).port;

    const attached: Server[] = [];
    const service = new LocalControlService({
      app: express(),
      credentials: new CredentialStore(),
      originAllowlist: new MutableOriginAllowlist({
        allowAny: false,
        origins: new Set(),
      }),
      attachWebSocket: (server) => attached.push(server),
      detachWebSocket: vi.fn(),
      getPort: () => busyPort,
    });

    await expect(service.enable()).rejects.toThrow();
    expect(service.active).toBe(false);
    expect(attached).toHaveLength(1);

    // Node attaches its own internal 'listening' listener during listen(), so
    // compare against a control server that failed the same way without any of
    // the service's handlers: a leftover temporary handler would show up as +1.
    const control = createServer();
    await new Promise<void>((resolve) => {
      control.once('error', () => resolve());
      control.listen(busyPort, '127.0.0.1');
    });
    expect(attached[0].listenerCount('listening')).toBe(
      control.listenerCount('listening'),
    );

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});
