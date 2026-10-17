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
import {
  isLanIpv4,
  isSoftwareNetwork,
  listLanCandidates,
  selectLanAddress,
} from './lan-interfaces.js';
import { LocalControlService } from './service.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const sleep = vi.hoisted(() => ({ release: vi.fn() }));
const sleepInhibitorMock = vi.hoisted(() => ({
  acquire: vi.fn(() => sleep),
  isRunning: vi.fn(() => true),
}));

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
    expect(vi.mocked(writeStderrLine)).not.toHaveBeenCalledWith(
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
    expect(vi.mocked(writeStderrLine)).not.toHaveBeenCalledWith(
      expect.stringContaining('outside RFC 1918'),
    );

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

    expect(vi.mocked(writeStderrLine)).toHaveBeenCalledOnce();
    expect(vi.mocked(writeStderrLine)).toHaveBeenCalledWith(
      expect.stringContaining('outside RFC 1918'),
    );
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

    expect(vi.mocked(writeStderrLine)).toHaveBeenCalledOnce();
    expect(vi.mocked(writeStderrLine)).toHaveBeenCalledWith(
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

    expect(vi.mocked(writeStderrLine)).not.toHaveBeenCalled();
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
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve),
    );
    const busyPort = (blocker.address() as AddressInfo).port;
    const service = new LocalControlService({
      app: express(),
      credentials: new CredentialStore(),
      originAllowlist: new MutableOriginAllowlist({
        allowAny: false,
        origins: new Set(),
      }),
      attachWebSocket: vi.fn(),
      detachWebSocket: vi.fn(),
      getPort: () => busyPort,
    });

    await expect(
      service.enable({ address: '127.0.0.1', allowExplicitAddress: true }),
    ).rejects.toThrow();

    expect(service.grantedExplicitCandidate).toBeUndefined();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});
