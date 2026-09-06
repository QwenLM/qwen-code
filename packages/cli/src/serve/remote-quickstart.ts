/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { networkInterfaces } from 'node:os';
import { formatHostForAuthority } from './loopback-binds.js';
import { hostAssignsIpv6Loopback } from './local-bind-addresses.js';
import {
  isSoftwareNetwork,
  listLanCandidates,
} from './local-control/lan-interfaces.js';
import { writeStdoutLineSafe } from '../utils/stdioHelpers.js';

/**
 * Bind literals that answer on every interface, compared after trimming and
 * lowercasing: `::ffff:0.0.0.0` is a working IPv4-mapped wildcard an operator
 * can copy from `ss`/`netstat`, and casing must not decide whether the LAN
 * addresses get enumerated.
 */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]', '::ffff:0.0.0.0', '']);

/** RFC 4291 unique-local addresses (fc00::/7) — the IPv6 private space. */
function isUlaIpv6(address: string): boolean {
  return /^(?:fc|fd)/iu.test(address);
}

export function remoteQuickstartAddresses(
  bind: string,
  port: number,
  tls: boolean,
  interfaces = networkInterfaces(),
): Array<{ label: string; url: string }> {
  const scheme = tls ? 'https' : 'http';
  const url = (host: string) =>
    `${scheme}://${formatHostForAuthority(host)}:${port}`;
  const canonical = bind.trim().toLowerCase();
  if (!WILDCARD_BINDS.has(canonical)) {
    // A zone-scoped literal (fe80::1%en0) has no browser-usable URL form and
    // the interface loop below drops the same class; the plain "listening on"
    // line still prints, so the quickstart just stays quiet about it.
    if (canonical.includes('%')) return [];
    return [{ label: 'Address', url: url(bind) }];
  }
  const ipv4Wildcard =
    canonical === '0.0.0.0' || canonical === '::ffff:0.0.0.0';
  const addresses = [
    {
      label: 'Local',
      url: url(
        !ipv4Wildcard && hostAssignsIpv6Loopback(interfaces)
          ? '::1'
          : '127.0.0.1',
      ),
    },
  ];
  // Advertise the same private-LAN population Local Control uses: software
  // interfaces (VPN, container bridges, VM adapters) and routable public
  // addresses never become a printed URL or a QR, so the scan-from-phone
  // affordance cannot point at an address the phone cannot dial — or at the
  // public internet over plain HTTP.
  for (const candidate of listLanCandidates(interfaces)) {
    addresses.push({
      label: `Network (${candidate.interfaceName})`,
      url: url(candidate.address),
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
        addresses.push({ label: `Network (${name})`, url: url(entry.address) });
      }
    }
  }
  return addresses;
}

export async function printRemoteQuickstart(input: {
  bind: string;
  port: number;
  tls: boolean;
  token: string;
  generated: boolean;
  web: boolean;
}): Promise<void> {
  // An informational block whose reader going away (`qwen serve | head`) must
  // never take the already-listening daemon down with it.
  try {
    const addresses = remoteQuickstartAddresses(
      input.bind,
      input.port,
      input.tls,
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
    const candidate = addresses.find((address) => address.label !== 'Local');
    if (!candidate) {
      writeStdoutLineSafe(
        'QR unavailable; open an address above and enter the bearer token.',
      );
      return;
    }
    // The QR encodes the resolved bearer. Print it when the credential is the
    // ephemeral one this process generated (it has no other delivery channel)
    // or the operator is at an interactive terminal; a stable operator token
    // must not be re-published into captured stdout (container/systemd logs)
    // on every restart.
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
        'QR unavailable; open an address above and enter the bearer token.',
      );
    }
  } catch {
    // Startup information never fails the daemon.
  }
}
