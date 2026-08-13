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

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  sleepInhibitor: { acquire: vi.fn(() => sleep) },
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
    expect(attached).toHaveLength(1);
    expect(attached[0].maxConnections).toBe(64);
    expect(attached[0].headersTimeout).toBe(10_000);
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
});
