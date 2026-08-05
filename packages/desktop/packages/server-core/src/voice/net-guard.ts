/**
 * SSRF guard for the resolved voice baseUrl. Voice audio must never be sent in
 * cleartext or to a private-network address, so the configured ASR endpoint is
 * required to be https (or loopback) and is checked against private IP ranges —
 * including a DNS resolution so a public hostname can't point at an internal IP.
 *
 * Twin of the CLI voice network guard in
 * packages/cli/src/services/voice-transcriber.ts. The bun workspace boundary
 * prevents sharing a module; keep the address classification and messages in
 * the two files in sync.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const BLOCKED_TRANSITION_IPV6_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ['64:ff9b:1::', 48],
  ['2001::', 23],
  ['2002::', 16],
] as const) {
  BLOCKED_TRANSITION_IPV6_ADDRESSES.addSubnet(address, prefix, 'ipv6');
}

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
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
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
  // The dotted-quad branch is unreachable once normalizeIpAddress has
  // canonicalized IPv6 literals to hex form; kept defensively.
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

function isBlockedTransitionIpv6Address(host: string): boolean {
  return (
    isIP(host) === 6 &&
    BLOCKED_TRANSITION_IPV6_ADDRESSES.check(host, 'ipv6')
  );
}

function unwrapIpv6TransitionStep(
  host: string,
): { address: string } | 'blocked' | undefined {
  const ipv4Mapped = readIpv4MappedIpv6(host);
  if (ipv4Mapped) {
    return { address: ipv4Mapped };
  }
  const ipv4Compatible = readIpv4CompatibleIpv6(host);
  if (ipv4Compatible) {
    return { address: ipv4Compatible };
  }
  const nat64 = readWellKnownNat64Ipv6(host);
  if (nat64) {
    return { address: nat64 };
  }
  if (host.startsWith('::ffff:')) {
    return 'blocked';
  }
  return undefined;
}

/** IP-literal private-network check; hostname resolution is handled separately. */
export function isPrivateNetworkIp(hostname: string): boolean {
  const host = normalizeIpAddress(hostname);
  if (isBlockedTransitionIpv6Address(host)) {
    return true;
  }
  if (isLoopbackHost(host)) {
    return false;
  }
  const step = unwrapIpv6TransitionStep(host);
  if (step === 'blocked') {
    return true;
  }
  if (step) {
    return isPrivateNetworkIp(step.address);
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

export function isAlwaysBlockedVoiceAddress(address: string): boolean {
  const host = normalizeIpAddress(address);
  if (isBlockedTransitionIpv6Address(host)) {
    return true;
  }
  if (isLoopbackHost(host)) return true;
  const step = unwrapIpv6TransitionStep(host);
  if (step === 'blocked') return true;
  if (step) return isAlwaysBlockedVoiceAddress(step.address);
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

export function isLoopbackVoiceAddress(address: string): boolean {
  const host = normalizeIpAddress(address);
  if (isLoopbackHost(host)) return true;
  const step = unwrapIpv6TransitionStep(host);
  if (step && step !== 'blocked') return isLoopbackVoiceAddress(step.address);
  if (isIP(host) === 4) return host.startsWith('127.');
  return false;
}

async function defaultLookupHost(
  hostname: string,
): Promise<Array<{ address: string }>> {
  return dnsLookup(hostname, { all: true });
}

export interface VoiceNetworkGuardTarget {
  baseUrl: string;
  model: string;
  allowInsecureBaseUrl?: boolean;
}

/** Reject a voice baseUrl that resolves to a private-network address. */
export async function assertVoiceBaseUrlNetworkAllowed(
  voiceConfig: VoiceNetworkGuardTarget,
  lookupHost?: VoiceHostLookup,
): Promise<void> {
  const { baseUrl, model, allowInsecureBaseUrl = false } = voiceConfig;
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
        isLoopbackVoiceAddress(host)
          ? `Voice model '${model}' uses a loopback address outside the accepted spellings. To use a local ASR endpoint, set the baseUrl to http://localhost, http://127.0.0.1, or http://[::1].`
          : `Voice model '${model}' resolved to a private-network address.`,
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
      records.some((record) => isLoopbackVoiceAddress(record.address))
        ? `Voice model '${model}' resolved to a loopback address. Loopback DNS results are always blocked; to use a local ASR endpoint, configure an explicit loopback baseUrl: http://localhost, http://127.0.0.1, or http://[::1].`
        : allowInsecureBaseUrl &&
            records.some((record) => isAlwaysBlockedVoiceAddress(record.address))
          ? `Voice model '${model}' resolved to an address that is always blocked (metadata, link-local, or transition range), even when the baseUrl is listed in security.allowedInsecureVoiceBaseUrls.`
          : `Voice model '${model}' resolved to a private-network address.`,
    );
  }
}
