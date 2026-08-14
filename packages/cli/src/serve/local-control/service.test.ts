/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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
    expect(attached[0].requestTimeout).toBe(30_000);
    expect(attached[0].keepAliveTimeout).toBe(5_000);
    expect(attached[0].listenerCount('error')).toBeGreaterThan(0);
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
});
