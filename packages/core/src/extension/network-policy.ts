/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as dns } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import type { ExtensionNetworkPolicy } from '../config/config.js';

const blockedAddresses = new BlockList();
const publicIpv6Addresses = new BlockList();
publicIpv6Addresses.addSubnet('2000::', 3, 'ipv6');

for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
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
] as const) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6');
}

export interface ResolvedNetworkTarget {
  url: URL;
  lookup?: LookupFunction;
  curlResolve?: string;
}

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

function parseMappedIpv4(address: string): string | undefined {
  const suffix = address.toLowerCase().slice('::ffff:'.length);
  if (isIP(suffix) === 4) return suffix;

  const parts = suffix.split(':');
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[\da-f]{1,4}$/.test(part))
  ) {
    return undefined;
  }
  const upper = Number.parseInt(parts[0], 16);
  const lower = Number.parseInt(parts[1], 16);
  return `${upper >> 8}.${upper & 0xff}.${lower >> 8}.${lower & 0xff}`;
}

function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6 && address.toLowerCase().startsWith('::ffff:')) {
    const mapped = parseMappedIpv4(address);
    return mapped === undefined || isBlockedAddress(mapped, 4);
  }
  if (family === 6 && !publicIpv6Addresses.check(address, 'ipv6')) return true;
  return blockedAddresses.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export async function resolveNetworkTarget(
  value: string | URL,
  policy?: ExtensionNetworkPolicy,
  signal?: AbortSignal,
): Promise<ResolvedNetworkTarget> {
  signal?.throwIfAborted();
  const url = value instanceof URL ? value : new URL(value);
  if (policy !== 'public') return { url };
  if (url.protocol !== 'https:') {
    throw new Error('Public extension network requests must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error(
      'Public extension network requests must not use credentials.',
    );
  }

  const hostname = stripIpv6Brackets(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await waitForAbortable(
        dns.lookup(hostname, { all: true, verbatim: true }),
        signal,
      );
  if (addresses.length === 0) {
    throw new Error(`Extension network host did not resolve: ${hostname}`);
  }
  if (
    addresses.some(({ address, family }) => isBlockedAddress(address, family))
  ) {
    throw new Error(
      `Extension network host resolved to a blocked address: ${hostname}`,
    );
  }

  const selected = addresses[0];
  const lookup: LookupFunction = (requestedHostname, options, callback) => {
    if (stripIpv6Brackets(requestedHostname) !== hostname) {
      const error = new Error(
        'Pinned extension lookup hostname mismatch',
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
  const port = url.port || '443';
  const curlHostname = literalFamily === 6 ? `[${hostname}]` : hostname;
  const curlAddress =
    selected.family === 6 ? `[${selected.address}]` : selected.address;

  return {
    url,
    lookup,
    curlResolve: `${curlHostname}:${port}:${curlAddress}`,
  };
}
