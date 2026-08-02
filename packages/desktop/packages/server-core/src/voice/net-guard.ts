/**
 * SSRF guard for the resolved voice baseUrl. Voice audio must never be sent in
 * cleartext or to a private-network address, so the configured ASR endpoint is
 * required to be https (or loopback) and is checked against private IP ranges —
 * including a DNS resolution so a public hostname can't point at an internal IP.
 *
 * Ported from the CLI voice pipeline (packages/cli/src/ui/voice/voice-transcriber.ts).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type VoiceHostLookup = (
  hostname: string,
) => Promise<{ address: string } | Array<{ address: string }>>;

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function normalizeIpAddress(address: string): string {
  const host = normalizeHostname(address);
  if (isIP(host) !== 6) return host;
  try {
    return normalizeHostname(new URL(`http://[${host}]/`).hostname);
  } catch {
    return host;
  }
}

export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  const ipv4Mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    (ipv4Mapped ? isLoopbackHost(ipv4Mapped[1]!) : false)
  );
}

function isAwsIpv6MetadataAddress(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (isIP(host) !== 6) return false;
  try {
    return (
      normalizeHostname(new URL(`http://[${host}]/`).hostname) ===
      'fd00:ec2::254'
    );
  } catch {
    return false;
  }
}

function readIpv4CompatibleIpv6(host: string): string | undefined {
  if (!host.startsWith('::') || host.startsWith('::ffff:')) {
    return undefined;
  }
  const parts = host.slice(2).split(':');
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !part)) {
    return undefined;
  }
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) {
    return undefined;
  }
  const hextets = parts.map((part) => Number.parseInt(part, 16));
  const value =
    hextets.length === 1 ? hextets[0]! : (hextets[0]! << 16) | hextets[1]!;
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function readIpv4MappedIpv6(host: string): string | undefined {
  const dotted = host.match(/^::ffff:(\d+(?:\.\d+){3})$/i);
  if (dotted && isIP(dotted[1]!) === 4) {
    return dotted[1];
  }
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) {
    return undefined;
  }
  return readIpv4HexPair(hex[1]!, hex[2]!);
}

function readIpv4HexPair(highHex: string, lowHex: string): string {
  const high = Number.parseInt(highHex, 16);
  const low = Number.parseInt(lowHex, 16);
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join('.');
}

function readWellKnownNat64Ipv6(host: string): string | undefined {
  const prefix = '64:ff9b::';
  if (!host.startsWith(prefix)) {
    return undefined;
  }
  const suffix = host.slice(prefix.length);
  if (!suffix) {
    return '0.0.0.0';
  }
  const groups = suffix.split(':');
  if (
    groups.length > 2 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))
  ) {
    return undefined;
  }
  return groups.length === 1
    ? readIpv4HexPair('0', groups[0]!)
    : readIpv4HexPair(groups[0]!, groups[1]!);
}

/** IP-literal private-network check; hostname resolution is handled separately. */
export function isPrivateNetworkIp(hostname: string): boolean {
  const host = normalizeIpAddress(hostname);
  if (isLoopbackHost(host)) {
    return false;
  }
  if (host.includes(':')) {
    const ipv4Embedded = host.match(/(?:(?:^|:))(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (ipv4Embedded) {
      return isPrivateNetworkIp(ipv4Embedded[1]!);
    }
  }
  const ipv4Mapped = readIpv4MappedIpv6(host);
  if (ipv4Mapped) {
    return isPrivateNetworkIp(ipv4Mapped);
  }
  const ipv4Compatible = readIpv4CompatibleIpv6(host);
  if (ipv4Compatible) {
    return isPrivateNetworkIp(ipv4Compatible);
  }
  const nat64 = readWellKnownNat64Ipv6(host);
  if (nat64) {
    return isPrivateNetworkIp(nat64);
  }
  if (host.startsWith('::ffff:')) {
    return true;
  }
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split('.').map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  if (isIP(host) === 6) {
    const firstHextet = Number.parseInt(host.split(':', 1)[0] || '0', 16);
    return (
      host === '::' ||
      (firstHextet & 0xffc0) === 0xfe80 ||
      (firstHextet & 0xfe00) === 0xfc00
    );
  }
  return false;
}

function isAlwaysBlockedVoiceAddress(address: string): boolean {
  const host = normalizeIpAddress(address);
  if (isLoopbackHost(host)) return true;
  if (host.includes(':')) {
    const ipv4Embedded = host.match(/(?:(?:^|:))(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (ipv4Embedded) {
      return isAlwaysBlockedVoiceAddress(ipv4Embedded[1]!);
    }
  }
  const ipv4Compatible = readIpv4CompatibleIpv6(host);
  if (ipv4Compatible) {
    return isAlwaysBlockedVoiceAddress(ipv4Compatible);
  }
  const ipv4Mapped = readIpv4MappedIpv6(host);
  if (ipv4Mapped) {
    return isAlwaysBlockedVoiceAddress(ipv4Mapped);
  }
  const nat64 = readWellKnownNat64Ipv6(host);
  if (nat64) {
    return isAlwaysBlockedVoiceAddress(nat64);
  }
  if (host.startsWith('::ffff:')) return true;
  if (isIP(host) === 4) {
    const [first = 0, second = 0] = host.split('.').map(Number);
    return (
      first === 0 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      host === '100.100.100.200'
    );
  }
  if (isIP(host) === 6) {
    const firstHextet = Number.parseInt(host.split(':', 1)[0] || '0', 16);
    return (
      host === '::' ||
      isAwsIpv6MetadataAddress(host) ||
      (firstHextet & 0xffc0) === 0xfe80
    );
  }
  return false;
}

function isBlockedResolvedIp(
  address: string,
  allowInsecureBaseUrl: boolean,
): boolean {
  return (
    isAlwaysBlockedVoiceAddress(address) ||
    (!allowInsecureBaseUrl && isPrivateNetworkIp(address))
  );
}

async function defaultLookupHost(
  hostname: string,
): Promise<Array<{ address: string }>> {
  return dnsLookup(hostname, { all: true });
}

/** Reject a voice baseUrl that resolves to a private-network address. */
export async function assertVoiceBaseUrlNetworkAllowed(
  baseUrl: string,
  model: string,
  lookupHost?: VoiceHostLookup,
  allowInsecureBaseUrl = false,
): Promise<void> {
  const hostname = new URL(baseUrl).hostname;
  if (isLoopbackHost(hostname)) {
    return;
  }
  const host = normalizeHostname(hostname);
  if (isIP(host) !== 0) {
    if (
      isAlwaysBlockedVoiceAddress(host) ||
      (!allowInsecureBaseUrl && isPrivateNetworkIp(host))
    ) {
      throw new Error(
        `Voice model '${model}': baseUrl is a private-network address.`,
      );
    }
    return;
  }
  let result: { address: string } | Array<{ address: string }>;
  try {
    result = await (lookupHost ?? defaultLookupHost)(hostname);
  } catch {
    throw new Error(
      `Voice model '${model}': DNS lookup failed for ${hostname}. Cannot verify network safety.`,
    );
  }
  const records = Array.isArray(result) ? result : [result];
  if (
    records.some((record) =>
      isBlockedResolvedIp(record.address, allowInsecureBaseUrl),
    )
  ) {
    throw new Error(
      `Voice model '${model}' resolved to a private-network address.`,
    );
  }
}
