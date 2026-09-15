/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { networkInterfaces } from 'node:os';
import { formatHostForAuthority, isLoopbackAddress } from './loopback-binds.js';
import { hostAssignsIpv6Loopback } from './local-bind-addresses.js';
import {
  isSoftwareNetwork,
  listLanCandidates,
} from './local-control/lan-interfaces.js';
import { writeStdoutLineSafe } from '../utils/stdioHelpers.js';

/** RFC 4291 unique-local addresses (fc00::/7) — the IPv6 private space. */
function isUlaIpv6(address: string): boolean {
  return /^(?:fc|fd)/iu.test(address);
}

/** RFC 3927 link-local IPv4 — admitted by isLanIpv4 but rarely dialable. */
function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith('169.254.');
}

/**
 * How much of the startup block a listener may print. Wildcard-ness and
 * loopback-ness are read from the address the socket actually bound, not from
 * the operator-typed spelling, so inet_aton and IPv6-zero variants (`0`,
 * `0::`, `[::0]`, …) behave like the canonical wildcards and a DNS name that
 * resolves to loopback never advertises undialable addresses. A generated
 * bearer is printed even on a loopback bind — it is the operator's only way
 * in — while an operator-supplied token on loopback prints nothing, matching
 * the pre-quickstart behavior.
 */
export function quickstartPrintMode(
  boundAddress: string,
  generated: boolean,
): 'full' | 'token-only' | 'silent' {
  if (!isLoopbackAddress(boundAddress)) return 'full';
  return generated ? 'token-only' : 'silent';
}

interface QuickstartAddress {
  label: string;
  url: string;
  address: string;
}

/**
 * Enumerate the addresses worth printing for a listener.
 */
export function remoteQuickstartAddresses(
  bind: string,
  boundAddress: string,
  port: number,
  tls: boolean,
  interfaces = networkInterfaces(),
): Array<{ label: string; url: string }> {
  return remoteQuickstartEntries(bind, boundAddress, port, tls, interfaces).map(
    ({ label, url }) => ({ label, url }),
  );
}

function remoteQuickstartEntries(
  bind: string,
  boundAddress: string,
  port: number,
  tls: boolean,
  interfaces: ReturnType<typeof networkInterfaces>,
): QuickstartAddress[] {
  const scheme = tls ? 'https' : 'http';
  const url = (host: string) =>
    `${scheme}://${formatHostForAuthority(host)}:${port}`;
  // Node canonicalises most wildcard spellings into the bound address (`0`
  // → `0.0.0.0`, `::0` → `::`); the IPv4-mapped form and stray whitespace
  // (the defensive fallback to the operator spelling) are normalised here so
  // every wildcard listener enumerates alike.
  const bound = boundAddress.trim().toLowerCase();
  const ipv4Wildcard = bound === '0.0.0.0' || bound === '::ffff:0.0.0.0';
  if (!ipv4Wildcard && bound !== '::') {
    // An explicit bind: print exactly what the operator chose, except a
    // zone-scoped literal (fe80::1%en0), which has no browser-usable URL
    // form; the plain "listening on" line still prints.
    if (bind.trim().includes('%')) return [];
    return [{ label: 'Address', url: url(bind), address: bind }];
  }
  const localAddress =
    !ipv4Wildcard && hostAssignsIpv6Loopback(interfaces) ? '::1' : '127.0.0.1';
  const addresses: QuickstartAddress[] = [
    { label: 'Local', url: url(localAddress), address: localAddress },
  ];
  // Advertise Local Control's private IPv4 population (RFC 1918 plus RFC 3927
  // link-local) and, on dual-stack wildcard binds, fc00::/7 ULAs of physical
  // interfaces. Software interfaces (VPN, container bridges, VM adapters) and
  // routable public addresses never become a printed URL or a QR, so the
  // scan-from-phone affordance cannot point at an address the phone cannot
  // dial — or at the public internet over plain HTTP. The name-based software
  // filter is a heuristic (see #9158), not a guarantee.
  for (const candidate of listLanCandidates(interfaces)) {
    addresses.push({
      label: `Network (${candidate.interfaceName})`,
      url: url(candidate.address),
      address: candidate.address,
    });
  }
  if (!ipv4Wildcard) {
    // A `::` listener is dual-stack under Node, so IPv6 ULAs are dialable too.
    for (const [name, entries] of Object.entries(interfaces).sort()) {
      if (isSoftwareNetwork(name)) continue;
      for (const entry of entries ?? []) {
        if (entry.internal || entry.family !== 'IPv6') continue;
        // Scoped link-local IPv6 URLs are not supported by browsers, and
        // globally routable IPv6 is out of scope for a LAN quickstart.
        if (entry.address.includes('%') || !isUlaIpv6(entry.address)) continue;
        addresses.push({
          label: `Network (${name})`,
          url: url(entry.address),
          address: entry.address,
        });
      }
    }
  }
  return addresses;
}

export async function printRemoteQuickstart(input: {
  bind: string;
  boundAddress: string;
  port: number;
  tls: boolean;
  token: string;
  generated: boolean;
  web: boolean;
  interfaces?: ReturnType<typeof networkInterfaces>;
}): Promise<void> {
  // An informational block whose reader going away (`qwen serve | head`) must
  // never take the already-listening daemon down with it: the serve entry
  // point installs a broken-pipe guard, and every write here goes through
  // the non-throwing helper.
  try {
    const mode = quickstartPrintMode(input.boundAddress, input.generated);
    if (mode === 'silent') return;
    if (mode === 'token-only') {
      writeStdoutLineSafe(
        `Generated bearer token (secret; changes on restart): ${input.token}`,
      );
      writeStdoutLineSafe(
        'The listener bound loopback, so no network address or QR is ' +
          'printed; local clients must present this bearer.',
      );
      return;
    }
    const addresses = remoteQuickstartEntries(
      input.bind,
      input.boundAddress,
      input.port,
      input.tls,
      input.interfaces ?? networkInterfaces(),
    );
    for (const address of addresses)
      writeStdoutLineSafe(`${address.label}: ${address.url}`);
    if (input.generated) {
      writeStdoutLineSafe(
        `Generated bearer token (secret; changes on restart): ${input.token}`,
      );
    }
    if (!input.tls)
      writeStdoutLineSafe(
        'HTTP is unencrypted. Use the existing TLS options for encrypted remote access.',
      );
    if (!input.web) return;
    // Prefer a routable private address for the QR: link-local entries are
    // admitted by the LAN filter but rarely dialable from a phone.
    const candidate =
      addresses.find(
        (address) =>
          address.label !== 'Local' && !isLinkLocalIpv4(address.address),
      ) ?? addresses.find((address) => address.label !== 'Local');
    if (!candidate) {
      writeStdoutLineSafe(
        'QR unavailable; enter the bearer token at the daemon address.',
      );
      return;
    }
    // The QR encodes the resolved bearer. Print it when the credential is the
    // ephemeral one this process generated (it has no other delivery channel)
    // or the operator is at an interactive terminal; a stable operator token
    // must not be re-published into captured stdout (container/systemd logs)
    // on every restart. A pty-allocated container counts as interactive, so
    // its logs remain secret-bearing by design.
    if (!input.generated && !process.stdout.isTTY) return;
    try {
      const { default: qrcode } = (await import('qrcode-terminal')) as {
        default: typeof import('qrcode-terminal');
      };
      qrcode.setErrorLevel('Q');
      qrcode.generate(
        `${candidate.url}/#token=${encodeURIComponent(input.token)}`,
        { small: true },
        (code) => {
          writeStdoutLineSafe(
            `Scan to open Web Shell: ${candidate.url} (${candidate.label})`,
          );
          writeStdoutLineSafe('SECRET QR: grants daemon access. Do not share.');
          writeStdoutLineSafe(code.trimEnd());
        },
      );
    } catch {
      writeStdoutLineSafe(
        'QR unavailable; enter the bearer token at the daemon address.',
      );
    }
  } catch {
    // Startup information never fails the daemon.
  }
}
