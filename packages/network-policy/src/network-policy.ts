/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as dns } from 'node:dns';
import { BlockList, isIP, SocketAddress, type LookupFunction } from 'node:net';

export type NetworkPolicy = 'public' | 'allow-private';

export class NetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkPolicyError';
  }
}

export interface ResolvedNetworkTarget {
  url: URL;
  lookup: LookupFunction;
  address: string;
  family: 4 | 6;
  curlResolve: string;
}

const blockedAddresses = new BlockList();
const privateAddresses = new BlockList();
const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet('2000::', 3, 'ipv6');

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['100.64.0.0', 10],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}
// The EC2 metadata endpoint is a ULA, but not a private receiver.
blockedAddresses.addAddress('fd00:ec2::254', 'ipv6');

for (const [address, prefix] of [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  privateAddresses.addSubnet(address, prefix, 'ipv4');
}
privateAddresses.addAddress('::1', 'ipv6');
privateAddresses.addSubnet('fc00::', 7, 'ipv6');

async function waitForAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return await promise;
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function addressScope(
  address: string,
  family: number,
): 'public' | 'private' | 'blocked' {
  if (family === 6) {
    address = new SocketAddress({ address, family: 'ipv6' }).address;
    if (address.startsWith('::ffff:')) {
      return addressScope(address.slice('::ffff:'.length), 4);
    }
  }
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (blockedAddresses.check(address, type)) return 'blocked';
  if (privateAddresses.check(address, type)) return 'private';
  if (family === 6 && !publicIpv6Addresses.check(address, 'ipv6')) {
    return 'blocked';
  }
  return 'public';
}

export function parseNetworkTargetUrl(
  value: string | URL,
  policy: NetworkPolicy,
): URL {
  if (policy !== 'public' && policy !== 'allow-private') {
    throw new NetworkPolicyError('Unsupported network policy.');
  }
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    throw new NetworkPolicyError('Network requests require an absolute URL.');
  }
  if (policy === 'public' && url.protocol !== 'https:') {
    throw new NetworkPolicyError('Public network requests must use HTTPS.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkPolicyError('Network requests must use HTTP or HTTPS.');
  }
  if (url.username || url.password) {
    throw new NetworkPolicyError(
      policy === 'public'
        ? 'Public network requests must not use credentials.'
        : 'Network requests must not use credentials.',
    );
  }
  return url;
}

export async function resolveNetworkTarget(
  value: string | URL,
  policy: NetworkPolicy,
  signal?: AbortSignal,
): Promise<ResolvedNetworkTarget> {
  signal?.throwIfAborted();
  const url = parseNetworkTargetUrl(value, policy);
  const hostname = stripIpv6Brackets(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await waitForAbortable(
        dns.lookup(hostname, { all: true, verbatim: true }),
        signal,
      );
  const prefix = policy === 'public' ? 'Public network' : 'Network';
  if (addresses.length === 0) {
    throw new NetworkPolicyError(`${prefix} host did not resolve: ${hostname}`);
  }
  const scopes = addresses.map(({ address, family }) =>
    addressScope(address, family),
  );
  if (
    scopes.some(
      (scope) =>
        scope === 'blocked' || (scope === 'private' && policy === 'public'),
    )
  ) {
    throw new NetworkPolicyError(
      `${prefix} host resolved to a blocked address: ${hostname}`,
    );
  }
  if (url.protocol === 'http:' && scopes.some((scope) => scope !== 'private')) {
    throw new NetworkPolicyError(
      'HTTP network requests require private addresses.',
    );
  }

  const selected = addresses[0];
  const lookup: LookupFunction = (requestedHostname, options, callback) => {
    if (stripIpv6Brackets(requestedHostname) !== hostname) {
      const error = new Error(
        policy === 'public'
          ? 'Pinned public network lookup hostname mismatch'
          : 'Pinned network lookup hostname mismatch',
      ) as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }
    if (options.all) {
      callback(null, [selected]);
    } else {
      callback(null, selected.address, selected.family);
    }
  };
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const curlHostname = literalFamily === 6 ? `[${hostname}]` : hostname;
  const curlAddress =
    selected.family === 6 ? `[${selected.address}]` : selected.address;

  return {
    url,
    lookup,
    address: selected.address,
    family: selected.family as 4 | 6,
    curlResolve: `${curlHostname}:${port}:${curlAddress}`,
  };
}
