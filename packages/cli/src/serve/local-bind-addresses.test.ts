/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import {
  hostAssignsIpv6Loopback,
  isOwnInterfaceAddress,
} from './local-bind-addresses.js';

/**
 * `isOwnInterfaceAddress` is reached only through
 * `assertChannelWorkerDaemonUrlIsLocal` and `validateDaemonWorkerUrl`, and in
 * both of those every bracketed literal the suites feed short-circuits on
 * `isLoopbackBind` first (`[::1]` is in `LOOPBACK_BINDS`, and the wildcard
 * binds are rewritten to `127.0.0.1` before the assertion sees them). So the
 * normalisation this function does on the way to `os.networkInterfaces()` —
 * which reports BARE, lowercase addresses and carries the scope separately in
 * `scopeid` — was exercised by nothing, and deleting it shipped green.
 *
 * What a lost normalisation step costs: `qwen serve --hostname <own address>
 * --tls-cert … --channel telegram` binds fine and then refuses its own bind
 * with "does not name an address on this host … Bind to … a literal address of
 * one of this machine's interfaces" — at boot, and again in
 * `validateDaemonWorkerUrl` for every hand-launched worker.
 *
 * Driven off the host's real interfaces rather than a mock: `node:os` is
 * external to the module graph vitest transforms here, so a `vi.mock('node:os')`
 * is visible to this file but NOT to the module under test — a mocked version
 * of this suite passes against a deleted bracket strip. Every address below is
 * one this machine actually answers on, so the assertions hold on an
 * IPv4-only host too.
 */
describe('isOwnInterfaceAddress', () => {
  const currentAddresses = () =>
    Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .map((entry) => entry.address);

  const own = currentAddresses();

  /**
   * A shared CI host adds and drops veth interfaces while a suite runs, and
   * `isOwnInterfaceAddress` re-reads `networkInterfaces()` on every call — so
   * an address captured at collection can be gone by the time a later case
   * asserts on it, and the case then fails on a host that changed rather than
   * on a lost normalisation. That is how a release lane went red on the two
   * cases that run last here while the earlier ones passed. Intersect the
   * collection snapshot with a fresh read per case, from `node:os` rather than
   * from the function under test so no case can confirm itself, and keep the
   * vacuity guard: the loopback never churns, so this never runs empty.
   */
  const stillOwn = () => {
    const current = new Set(currentAddresses());
    const stable = own.filter((address) => current.has(address));
    expect(stable.length).toBeGreaterThan(0);
    return stable;
  };

  it('reports at least one own address to test against', () => {
    // Guards the loops below from passing vacuously on a host that somehow
    // reports no interfaces at all.
    expect(own.length).toBeGreaterThan(0);
  });

  it('accepts every own interface address in its bare form', () => {
    for (const address of stillOwn()) {
      expect(isOwnInterfaceAddress(address)).toBe(true);
    }
  });

  it('accepts an own address in the URL-bracketed form', () => {
    // The bracketed spelling is what `workerDialHost` hands back out of a
    // `https://[2001:db8::5]:8080` daemon URL, and what an operator passes to
    // `--hostname`. `os.networkInterfaces()` never reports the brackets.
    for (const address of stillOwn()) {
      expect(isOwnInterfaceAddress(`[${address}]`)).toBe(true);
    }
  });

  it('strips an RFC 6874 zone identifier before matching', () => {
    // A link-local bind is unusable without a zone, so a zone-carrying literal
    // is the only form an operator can pass for one — and `networkInterfaces()`
    // keeps the scope in `scopeid`, not in `address`. Both the percent-encoded
    // URL spelling and the bare one have to survive.
    for (const address of stillOwn()) {
      expect(isOwnInterfaceAddress(`${address}%eth0`)).toBe(true);
      expect(isOwnInterfaceAddress(`[${address}%25eth0]`)).toBe(true);
    }
  });

  it('matches an own address case-insensitively', () => {
    // IPv6 literals are hex and an operator may type them uppercase, while
    // `networkInterfaces()` reports them lowercase.
    for (const address of stillOwn()) {
      expect(isOwnInterfaceAddress(address.toUpperCase())).toBe(true);
    }
  });

  it('rejects a literal no interface holds', () => {
    // RFC 5737 TEST-NET-3 and RFC 3849's documentation prefix: reserved for
    // documentation, so no host is assigned one.
    expect(own).not.toContain('203.0.113.255');
    expect(isOwnInterfaceAddress('203.0.113.255')).toBe(false);
    expect(isOwnInterfaceAddress('[2001:db8::ffff]')).toBe(false);
  });

  it('rejects an empty or bracket-only hostname', () => {
    // `[]` strips to the empty string, which must fail closed rather than
    // match an interface that reports an empty address.
    expect(isOwnInterfaceAddress('')).toBe(false);
    expect(isOwnInterfaceAddress('[]')).toBe(false);
  });

  it('does not resolve DNS names, even ones that name this host', () => {
    // Literals only, on purpose: resolving here would put a lookup — and
    // whatever answers it — on every channel worker's startup path.
    expect(isOwnInterfaceAddress('localhost')).toBe(false);
  });
});

describe('hostAssignsIpv6Loopback', () => {
  const v4Loopback: NetworkInterfaceInfo = {
    address: '127.0.0.1',
    netmask: '255.0.0.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: true,
    cidr: '127.0.0.1/8',
  };
  const v6Loopback: NetworkInterfaceInfo = {
    address: '::1',
    netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: true,
    cidr: '::1/128',
    scopeid: 0,
  };
  // A global IPv6 address is not the loopback — a host that binds `::` with
  // IPv6 only on non-loopback interfaces still has no `::1` to dial.
  const v6Global: NetworkInterfaceInfo = {
    address: '2001:db8::5',
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: '2001:db8::5/64',
    scopeid: 2,
  };

  it('reports true when the table assigns ::1', () => {
    expect(hostAssignsIpv6Loopback({ lo: [v4Loopback, v6Loopback] })).toBe(
      true,
    );
  });

  it('reports false when no entry is ::1', () => {
    expect(hostAssignsIpv6Loopback({ lo: [v4Loopback] })).toBe(false);
    expect(hostAssignsIpv6Loopback({ eth0: [v6Global] })).toBe(false);
    expect(hostAssignsIpv6Loopback({})).toBe(false);
  });

  it('reads the live interface table when called with no argument', () => {
    const live = Object.values(networkInterfaces()).some((entries) =>
      entries?.some((info) => info.family === 'IPv6' && info.address === '::1'),
    );
    expect(hostAssignsIpv6Loopback()).toBe(live);
  });
});
