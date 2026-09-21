/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The canonical `--hostname` values that are treated as loopback. Both the
 * runner (boot-time auth-required check) and the request middleware (Host
 * header allowlist) consult this; keeping the set in one place prevents the
 * two from drifting apart.
 *
 * IPv6 loopback is included so users who prefer `::1`/`[::1]` don't have to
 * configure a token. The complete IPv4 loopback range is handled separately
 * below.
 */
export const LOOPBACK_BINDS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
]);

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4) return false;
  const [first, ...rest] = octets;
  return (
    first === '127' &&
    rest.every((octet) => {
      if (!/^\d+$/.test(octet)) return false;
      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}

export function isLoopbackBind(hostname: string): boolean {
  // Lowercase the operator-supplied hostname so `--hostname Localhost`
  // / `--hostname LOCALHOST` are treated identically to `localhost`.
  // The Host-header allowlist (auth.ts) already lowercases the
  // request-side string before comparing; this aligns boot-time
  // detection with the runtime check so a valid loopback bind isn't
  // forced to require a token just because the operator typed a
  // capital. All entries in `LOOPBACK_BINDS` are already lowercase.
  const normalized = hostname.toLowerCase();
  return LOOPBACK_BINDS.has(normalized) || isIpv4Loopback(normalized);
}

export function isLoopbackAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === '::1' || normalized === '[::1]' || isIpv4Loopback(normalized)
  );
}

/**
 * Is this `--hostname` spelling a wildcard bind (`0.0.0.0` / `::`)? The
 * spelling is canonicalized through the WHATWG URL parser before comparing —
 * the same normalization Node applies at bind time — so inet_aton short
 * forms (`0`, `0.0`), IPv6 zero variants (`::0`, `[::0]`, `0::`), and the
 * IPv4-mapped wildcard (`::ffff:0.0.0.0`) all classify as wildcard, matching
 * what the socket actually binds. A DNS name or an empty string never does.
 */
export function isWildcardBind(hostname: string): boolean {
  const trimmed = hostname.trim().toLowerCase();
  const inner =
    trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
  try {
    const parsed = new URL(
      `http://${inner.includes(':') ? `[${inner}]` : inner}`,
    ).hostname;
    const canonical =
      parsed.startsWith('[') && parsed.endsWith(']')
        ? parsed.slice(1, -1)
        : parsed;
    // `::ffff:0:0` is the WHATWG serialization of the IPv4-mapped wildcard
    // `::ffff:0.0.0.0`, which Node binds as a working wildcard.
    return (
      canonical === '0.0.0.0' ||
      canonical === '::' ||
      canonical === '::ffff:0:0'
    );
  } catch {
    return false;
  }
}

export function formatHostForAuthority(hostname: string): string {
  const normalized = hostname.toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    return normalized;
  }
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}
