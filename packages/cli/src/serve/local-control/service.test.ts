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
import {
  isLanIpv4,
  isSoftwareNetwork,
  listLanCandidates,
  selectLanAddress,
} from './lan-interfaces.js';
import { listenerIdentityOf } from './listener-identity.js';
import { LocalControlBindError, LocalControlService } from './service.js';
import {
  writeStderrLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';

const sleep = vi.hoisted(() => ({ release: vi.fn() }));
const sleepInhibitorMock = vi.hoisted(() => ({
  acquire: vi.fn(() => sleep),
  isRunning: vi.fn(() => true),
}));
const writeStderrLineSafeMock = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  sleepInhibitor: sleepInhibitorMock,
}));

vi.mock('./lan-interfaces.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lan-interfaces.js')>();
  return {
    ...actual,
    isLanIpv4: vi.fn(actual.isLanIpv4),
    isSoftwareNetwork: vi.fn(actual.isSoftwareNetwork),
    listLanCandidates: vi.fn(() => []),
    selectLanAddress: vi.fn(() => ({
      interfaceName: 'en0',
      address: '127.0.0.1',
    })),
  };
});

const { isLanIpv4: realIsLanIpv4, isSoftwareNetwork: realIsSoftwareNetwork } =
  await vi.importActual<typeof import('./lan-interfaces.js')>(
    './lan-interfaces.js',
  );

// The mock above selects a loopback address, which trips the out-of-private-
// space warning on every enable; keep the warning out of the test output.
vi.mock('../../utils/stdioHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/stdioHelpers.js')>()),
  writeStderrLine: vi.fn(),
  writeStderrLineSafe: writeStderrLineSafeMock,
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
    vi.mocked(writeStderrLine).mockReset();
    vi.mocked(writeStderrLineSafe).mockReset();
    sleepInhibitorMock.isRunning.mockReturnValue(true);
    vi.mocked(isLanIpv4).mockImplementation(realIsLanIpv4);
    vi.mocked(isSoftwareNetwork).mockImplementation(realIsSoftwareNetwork);
    vi.mocked(listLanCandidates).mockReturnValue([]);
    vi.mocked(selectLanAddress).mockReturnValue({
      interfaceName: 'en0',
      address: '127.0.0.1',
    });
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
    // The exposure warning belongs to a listener that actually came up; a
    // rejected enable must not record one.
    expect(vi.mocked(writeStderrLineSafe)).not.toHaveBeenCalledWith(
      expect.stringContaining('outside RFC 1918'),
    );
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

      // The stand-in selects loopback, which trips the explicit-address
      // warning; this test is about the port-fallback log routing.
      vi.mocked(isLanIpv4).mockReturnValue(true);
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
      expect(service.active).toBe(false);
      expect(attached).toHaveLength(1);
      expect(vi.mocked(writeStderrLineSafe)).not.toHaveBeenCalledWith(
        expect.stringContaining('outside RFC 1918'),
      );

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

  it('warns once when an explicit out-of-private-space pick is enabled', async () => {
    // The default selectLanAddress stand-in picks 127.0.0.1, which is outside
    // RFC 1918/3927 — the warning is the opt-in's one loud signal and must
    // fire exactly once per transition into active.
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

    await service.enable();
    // An enable on an already-active session is a no-op and must not re-warn.
    await service.enable();

    expect(vi.mocked(writeStderrLineSafe)).toHaveBeenCalledOnce();
    expect(vi.mocked(writeStderrLineSafe)).toHaveBeenCalledWith(
      expect.stringContaining('outside RFC 1918'),
    );
    await service.disable();
  });

  it('keeps a committed enable live when the warning write hits EPIPE', async () => {
    // stderr may be a dead pipe (a supervisor rotated the log reader): the
    // warnings ride writeStderrLineSafe so failing the write cannot reject an
    // enable whose listener is already bound — a reported failure while the
    // LAN exposure stays live. The mock below re-implements the safe
    // variant's contract over the throwing writer; the variant's own
    // swallowing is pinned in stdioHelpers.test.ts.
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
    vi.mocked(writeStderrLine).mockImplementation(() => {
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    });
    vi.mocked(writeStderrLineSafe).mockImplementation((message) => {
      try {
        writeStderrLine(message);
      } catch {
        // The reader is gone; the warning is incidental to the enable.
      }
    });

    const status = await service.enable();

    expect(status.active).toBe(true);
    expect(service.active).toBe(true);
    expect(status.sleepInhibited).toBe(true);
    expect(sleepInhibitorMock.acquire).toHaveBeenCalledOnce();
    // The tolerance is only witnessed if the warning actually fired: the
    // throwing stub must have been reached, not skipped by a condition change.
    expect(vi.mocked(writeStderrLine)).toHaveBeenCalledOnce();
    await service.disable();
  });

  it('warns when the explicit pick sits on a VPN/tunnel or virtual interface', async () => {
    // A private-range address on a software-named interface passes isLanIpv4
    // but is exactly the VPN case the opt-in exists for — it must warn too.
    // 127.0.0.1 stands in for the private address so the bind succeeds on any
    // host; isLanIpv4/isSoftwareNetwork are stubbed to the tunnel scenario.
    vi.mocked(isLanIpv4).mockReturnValue(true);
    vi.mocked(isSoftwareNetwork).mockImplementation(
      (name) => name === 'docker0',
    );
    vi.mocked(selectLanAddress).mockReturnValue({
      interfaceName: 'docker0',
      address: '127.0.0.1',
    });
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

    await service.enable();

    expect(vi.mocked(writeStderrLineSafe)).toHaveBeenCalledOnce();
    expect(vi.mocked(writeStderrLineSafe)).toHaveBeenCalledWith(
      expect.stringContaining('docker0'),
    );
    await service.disable();
  });

  it('does not warn for an ordinary automatic candidate', async () => {
    vi.mocked(isLanIpv4).mockReturnValue(true);
    vi.mocked(isSoftwareNetwork).mockReturnValue(false);
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

    await service.enable();

    expect(vi.mocked(writeStderrLineSafe)).not.toHaveBeenCalled();
    await service.disable();
  });

  it('records an out-of-candidate CLI pick as the standing explicit grant', async () => {
    // listLanCandidates is mocked empty: 127.0.0.1 stands in for an address
    // the automatic filter refuses (public range or tunnel) while remaining
    // bindable on every host.
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

    expect(service.grantedExplicitCandidate).toBeUndefined();
    await service.enable({
      address: '127.0.0.1',
      allowExplicitAddress: true,
    });
    expect(service.grantedExplicitCandidate).toEqual({
      interfaceName: 'en0',
      address: '127.0.0.1',
    });
    // The grant is the daemon-start decision, not the session's: it survives
    // disable so the Web Shell card can re-enable the same address.
    await service.disable();
    expect(service.grantedExplicitCandidate).toEqual({
      interfaceName: 'en0',
      address: '127.0.0.1',
    });
  });

  it('supersedes the standing grant when a later enable picks a different address', async () => {
    // While the grant stands, any process that can reach the trusted primary
    // listener can re-post the named address — the operator's most exposed
    // one by construction. A successful enable on another address is the
    // operator's later choice and must revoke that standing admission.
    // 0.0.0.0 stands in for the move-to candidate so the second bind succeeds
    // on any host; the try/finally below contains the wildcard listener it
    // opens.
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

    try {
      await service.enable({
        address: '127.0.0.1',
        allowExplicitAddress: true,
      });
      expect(service.grantedExplicitCandidate).toEqual({
        interfaceName: 'en0',
        address: '127.0.0.1',
      });
      await service.disable();

      vi.mocked(selectLanAddress).mockReturnValue({
        interfaceName: 'en0',
        address: '0.0.0.0',
      });
      vi.mocked(listLanCandidates).mockReturnValue([
        { interfaceName: 'en0', address: '0.0.0.0' },
      ]);
      await service.enable({ address: '0.0.0.0' });

      expect(service.grantedExplicitCandidate).toBeUndefined();
    } finally {
      // 0.0.0.0 binds INADDR_ANY for real; the listener must not outlive a
      // failing assertion on a shared runner.
      await service.disable();
    }
  });

  it('keeps the standing grant when an address-less enable auto-picks another address', async () => {
    // An empty HTTP enable body names no address: the service's automatic
    // selection is a fallback, not the operator's later choice, so it must
    // not supersede the daemon-start grant (#14140).
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

    try {
      await service.enable({
        address: '127.0.0.1',
        allowExplicitAddress: true,
      });
      expect(service.grantedExplicitCandidate).toEqual({
        interfaceName: 'en0',
        address: '127.0.0.1',
      });
      await service.disable();

      vi.mocked(selectLanAddress).mockReturnValue({
        interfaceName: 'en0',
        address: '0.0.0.0',
      });
      vi.mocked(listLanCandidates).mockReturnValue([
        { interfaceName: 'en0', address: '0.0.0.0' },
      ]);
      await service.enable();

      expect(service.grantedExplicitCandidate).toEqual({
        interfaceName: 'en0',
        address: '127.0.0.1',
      });
    } finally {
      // 0.0.0.0 binds INADDR_ANY for real; the listener must not outlive a
      // failing assertion on a shared runner.
      await service.disable();
    }
  });

  it('keeps the standing grant when a re-enable posts the granted address', async () => {
    // The Web Shell card's disable→enable round trip re-posts the grant
    // through the HTTP path (no flag): superseding must fire only on a
    // DIFFERENT pick, or the card's primary #14136 flow would drop the
    // opt-in it exists to preserve.
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

    await service.enable({
      address: '127.0.0.1',
      allowExplicitAddress: true,
    });
    await service.disable();
    await service.enable({ address: '127.0.0.1' });

    expect(service.grantedExplicitCandidate).toEqual({
      interfaceName: 'en0',
      address: '127.0.0.1',
    });
    await service.disable();
  });

  it('records no grant without the CLI opt-in flag', async () => {
    // The HTTP enable path never sets the flag, so a posted address — even
    // one outside the candidate list — must not mint a grant.
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

    await service.enable({ address: '127.0.0.1' });

    expect(service.grantedExplicitCandidate).toBeUndefined();
    await service.disable();
  });

  it('records no grant for an ordinary automatic candidate', async () => {
    // Disambiguating among candidates needs no grant: the address is already
    // reachable through the normal candidate path.
    vi.mocked(listLanCandidates).mockReturnValue([
      { interfaceName: 'en0', address: '127.0.0.1' },
    ]);
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

    await service.enable({
      address: '127.0.0.1',
      allowExplicitAddress: true,
    });

    expect(service.grantedExplicitCandidate).toBeUndefined();
    await service.disable();
  });

  it('records no grant when the enable fails', async () => {
    // EACCES is not retried by the port fallback, so the enable still fails
    // rather than rebinding on another port.
    const service = new LocalControlService({
      app: express(),
      credentials: new CredentialStore(),
      originAllowlist: new MutableOriginAllowlist({
        allowAny: false,
        origins: new Set(),
      }),
      attachWebSocket: (server) => {
        vi.spyOn(server, 'listen').mockImplementationOnce(() => {
          queueMicrotask(() =>
            server.emit(
              'error',
              Object.assign(new Error('Permission denied'), {
                code: 'EACCES',
              }),
            ),
          );
          return server;
        });
      },
      detachWebSocket: vi.fn(),
      getPort: () => 4170,
    });

    await expect(
      service.enable({ address: '127.0.0.1', allowExplicitAddress: true }),
    ).rejects.toThrow();

    expect(service.grantedExplicitCandidate).toBeUndefined();
  });
});
