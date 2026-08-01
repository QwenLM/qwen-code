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

/** IP-literal private-network check; hostname resolution is handled separately. */
export function isPrivateNetworkIp(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (isLoopbackHost(host)) {
    return false;
  }
  if (host.includes(':')) {
    const ipv4Embedded = host.match(/(?:(?:^|:))(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (ipv4Embedded) {
      return isPrivateNetworkIp(ipv4Embedded[1]!);
    }
  }
  const ipv4Mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) {
    return isPrivateNetworkIp(ipv4Mapped[1]!);
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

function isBlockedResolvedIp(address: string): boolean {
  return isLoopbackHost(address) || isPrivateNetworkIp(address);
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
): Promise<void> {
  const hostname = new URL(baseUrl).hostname;
  if (isLoopbackHost(hostname)) {
    return;
  }
  const host = normalizeHostname(hostname);
  if (isIP(host) !== 0) {
    if (isPrivateNetworkIp(host)) {
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
  if (records.some((record) => isBlockedResolvedIp(record.address))) {
    throw new Error(
      `Voice model '${model}' resolved to a private-network address.`,
    );
  }
}
