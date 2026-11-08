/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type Request } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MutableOriginAllowlist } from '../auth.js';
import { CredentialStore } from './credentials.js';
import { listenerIdentityOf } from './listener-identity.js';
import { LocalControlBindError, LocalControlService } from './service.js';

const sleep = vi.hoisted(() => ({ release: vi.fn() }));
const sleepInhibitorMock = vi.hoisted(() => ({
  acquire: vi.fn(() => sleep),
  isRunning: vi.fn(() => true),
}));
const writeStderrLineSafeMock = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  sleepInhibitor: sleepInhibitorMock,
}));

vi.mock('../../utils/stdioHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/stdioHelpers.js')>()),
  writeStderrLineSafe: writeStderrLineSafeMock,
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

  it('derives an ephemeral endpoint from the address the server bound', async () => {
    const credentials = new CredentialStore();
    const origins = new MutableOriginAllowlist({
      allowAny: false,
      origins: new Set(),
    });
    const attached: Server[] = [];
    const service = new LocalControlService({
      app: express(),
      credentials,
      originAllowlist: origins,
      attachWebSocket: (server) => attached.push(server),
      detachWebSocket: vi.fn(),
      getPort: () => 0,
    });

    try {
      const status = await service.enable();
      const boundPort = (attached[0].address() as AddressInfo).port;
      const authority = `127.0.0.1:${boundPort}`;

      expect(boundPort).toBeGreaterThan(0);
      expect(status.port).toBe(boundPort);
      expect(new URL(status.url!).host).toBe(authority);
      expect(origins.allows(`http://${authority}`)).toBe(true);
      expect(
        listenerIdentityOf({
          socket: { server: attached[0] },
        } as unknown as Request),
      ).toEqual({
        kind: 'local-control',
        authority,
        origin: `http://${authority}`,
      });
    } finally {
      if (service.active) await service.disable();
    }
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

  it.each(['stderr', 'daemon', 'broken-daemon'])(
    'falls back to a free port and propagates the bound endpoint with %s logging',
    async (logging) => {
      const blocker = createServer();
      await new Promise<void>((resolve) =>
        blocker.listen(0, '127.0.0.1', resolve),
      );
      const busyPort = (blocker.address() as AddressInfo).port;

      const credentials = new CredentialStore();
      const origins = new MutableOriginAllowlist({
        allowAny: false,
        origins: new Set(),
      });
      const attached: Server[] = [];
      let initialListeningHandlers: ReturnType<Server['listeners']> = [];
      const daemonLog = logging === 'stderr' ? undefined : { warn: vi.fn() };
      if (logging === 'broken-daemon') {
        daemonLog!.warn.mockImplementation(() => {
          throw new Error('Log sink closed');
        });
      }
      const service = new LocalControlService({
        app: express(),
        credentials,
        originAllowlist: origins,
        daemonLog,
        attachWebSocket: (server) => {
          initialListeningHandlers = server.listeners('listening');
          attached.push(server);
        },
        detachWebSocket: vi.fn(),
        getPort: () => busyPort,
      });

      try {
        const status = await service.enable();
        expect(status.active).toBe(true);
        expect(status.port).not.toBe(busyPort);
        expect(attached).toHaveLength(1);

        const boundPort = (attached[0].address() as AddressInfo).port;
        const authority = `127.0.0.1:${boundPort}`;
        expect(status.port).toBe(boundPort);
        expect(new URL(status.url!).host).toBe(authority);
        expect(origins.allows(`http://${authority}`)).toBe(true);
        expect(origins.allows(`http://127.0.0.1:${busyPort}`)).toBe(false);
        expect(
          listenerIdentityOf({
            socket: { server: attached[0] },
          } as unknown as Request),
        ).toEqual({
          kind: 'local-control',
          authority,
          origin: `http://${authority}`,
        });

        const pairingToken = new URL(status.url!).hash.slice('#token='.length);
        expect(
          credentials.verify(pairingToken, {
            kind: 'local-control',
            authority,
          }),
        ).toBe(true);
        // Preserve Node's connection-tracking handler, but no temporary handlers.
        expect(attached[0].listeners('listening')).toEqual(
          initialListeningHandlers,
        );
        expect(attached[0].listenerCount('error')).toBe(1);
        const diagnostic =
          'Local Control preferred port is in use (EADDRINUSE); listening on an available port instead';
        if (daemonLog) {
          expect(daemonLog.warn).toHaveBeenCalledExactlyOnceWith(diagnostic, {
            errno: 'EADDRINUSE',
          });
        }
        if (logging === 'daemon') {
          expect(writeStderrLineSafeMock).not.toHaveBeenCalled();
        } else {
          expect(writeStderrLineSafeMock).toHaveBeenCalledWith(
            `qwen serve: ${diagnostic}`,
          );
        }

        await service.disable();
        expect(origins.allows(`http://${authority}`)).toBe(false);
        expect(attached[0].listening).toBe(false);
        expect(
          credentials.verify(pairingToken, { kind: 'local-control' }),
        ).toBe(false);
      } finally {
        if (service.active) await service.disable();
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    },
  );

  it.each([
    {
      errno: 'EACCES',
      code: 'bind_denied',
      expectedPorts: [4170],
    },
    {
      errno: 'EPERM',
      code: 'bind_denied',
      expectedPorts: [4170],
    },
    {
      errno: 'EADDRINUSE',
      code: 'address_in_use',
      expectedPorts: [4170, 0],
    },
    {
      errno: 'EADDRNOTAVAIL',
      code: 'invalid_address',
      expectedPorts: [4170],
    },
    {
      errno: 'EINVAL',
      code: 'invalid_address',
      expectedPorts: [4170],
    },
  ] as const)(
    'rolls back $errno as $code and only retries address collisions',
    async ({ errno, code, expectedPorts }) => {
      const credentials = new CredentialStore();
      const addToken = vi.spyOn(credentials, 'addPairingToken');
      const origins = new MutableOriginAllowlist({
        allowAny: false,
        origins: new Set(),
      });
      const error = Object.assign(new Error(`listen ${errno}`), {
        code: errno,
      });
      const attemptedPorts: unknown[] = [];
      const attached: Server[] = [];
      const detachWebSocket = vi.fn();
      let initialListeningHandlers: ReturnType<Server['listeners']> = [];
      const service = new LocalControlService({
        app: express(),
        credentials,
        originAllowlist: origins,
        attachWebSocket: (server) => {
          attached.push(server);
          initialListeningHandlers = server.listeners('listening');
          vi.spyOn(server, 'listen').mockImplementation((...args) => {
            attemptedPorts.push(args[0]);
            if (errno === 'EINVAL') throw error;
            queueMicrotask(() => server.emit('error', error));
            return server;
          });
        },
        detachWebSocket,
        getPort: () => 4170,
      });

      const rejection = await service
        .enable()
        .catch((failure: unknown) => failure);

      expect(rejection).toBeInstanceOf(LocalControlBindError);
      expect(rejection).toMatchObject({ code, errno, cause: error });
      expect(attemptedPorts).toEqual(expectedPorts);
      expect(service.status()).toEqual({ active: false });
      expect(attached[0].listening).toBe(false);
      expect(attached[0].listeners('listening')).toEqual(
        initialListeningHandlers,
      );
      expect(attached[0].listenerCount('error')).toBe(0);
      expect(detachWebSocket).toHaveBeenCalledExactlyOnceWith(attached[0]);
      expect(origins.allows('http://127.0.0.1:4170')).toBe(false);
      expect(
        credentials.verify(addToken.mock.calls[0][1], {
          kind: 'local-control',
        }),
      ).toBe(false);
      expect(sleepInhibitorMock.acquire).not.toHaveBeenCalled();
      expect(writeStderrLineSafeMock).not.toHaveBeenCalled();
    },
  );

  it('closes the fallback listener when endpoint initialization fails', async () => {
    const credentials = new CredentialStore();
    const addToken = vi.spyOn(credentials, 'addPairingToken');
    const origins = new MutableOriginAllowlist({
      allowAny: false,
      origins: new Set(),
    });
    const addOrigin = origins.add.bind(origins);
    const error = new Error('Origin registration failed');
    const originRegistration = vi
      .spyOn(origins, 'add')
      .mockImplementation((key, origin) => {
        addOrigin(key, origin);
        throw error;
      });
    const attached: Server[] = [];
    const detachWebSocket = vi.fn();
    const service = new LocalControlService({
      app: express(),
      credentials,
      originAllowlist: origins,
      attachWebSocket: (server) => {
        attached.push(server);
        vi.spyOn(server, 'listen').mockImplementationOnce(() => {
          queueMicrotask(() =>
            server.emit(
              'error',
              Object.assign(new Error('Address in use'), {
                code: 'EADDRINUSE',
              }),
            ),
          );
          return server;
        });
      },
      detachWebSocket,
      getPort: () => 4170,
    });

    try {
      await expect(service.enable()).rejects.toBe(error);

      expect(service.status()).toEqual({ active: false });
      expect(attached[0].listening).toBe(false);
      expect(attached[0].address()).toBeNull();
      expect(detachWebSocket).toHaveBeenCalledExactlyOnceWith(attached[0]);
      for (const [, origin] of originRegistration.mock.calls) {
        expect(origins.allows(origin)).toBe(false);
      }
      expect(
        credentials.verify(addToken.mock.calls[0][1], {
          kind: 'local-control',
        }),
      ).toBe(false);
      expect(sleepInhibitorMock.acquire).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => attached[0].close(() => resolve()));
    }
  });
});
