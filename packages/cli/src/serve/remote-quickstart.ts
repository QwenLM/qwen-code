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

/**
 * Why a requested token QR cannot print, or `undefined` when it can. Covers
 * the two causes that are known before the printer runs: an unmounted Web
 * Shell (`--no-web`, unresolved assets) and a loopback bind, which prints no
 * QR — `quickstartPrintMode` answers `token-only` or `silent` there, and both
 * collapse to this one cause, so `generated` cannot change the result (a
 * generated bearer still gets its own plain-text line from the printer). The
 * flag exists to remove silent no-ops, so both causes are named on stderr.
 * The third inert case — no dialable LAN candidate to encode — is discovered
 * inside the printer and reported by its own `QR unavailable` line on stdout.
 */
export function tokenQrNoEffectReason(input: {
  requested: boolean;
  webShellMounted: boolean;
  boundAddress: string;
  generated: boolean;
}): string | undefined {
  if (!input.requested) return undefined;
  if (!input.webShellMounted)
    return 'qwen serve: --token-qr / serve.tokenQr has no effect because the Web Shell is not mounted.';
  if (quickstartPrintMode(input.boundAddress, input.generated) !== 'full')
    return 'qwen serve: --token-qr / serve.tokenQr has no effect on this bind: a loopback listener prints no quickstart QR.';
  return undefined;
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
  /**
   * The token-QR posture, resolved once by the caller from the flag and the
   * setting: `'force'` prints the credential-bearing QR even when the
   * default policy would withhold it, `'veto'` suppresses it on every path
   * (a generated bearer still prints as plain text), and `'policy'` — or an
   * omitted field — applies the default suppression. One resolved field,
   * not a requested/vetoed boolean pair whose two falses would mean
   * opposite things one hop apart.
   */
  tokenQrMode?: 'policy' | 'force' | 'veto';
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
    // The QR may encode the resolved bearer. That happens when the
    // credential is the ephemeral one this process generated (it has no
    // other delivery channel), when the operator is at an interactive
    // terminal, or when the operator explicitly opted in via --token-qr /
    // serve.tokenQr; otherwise a stable operator token must not be
    // re-published into captured stdout (container/systemd logs) on every
    // restart. A pty-allocated container counts as interactive, so its logs
    // remain secret-bearing by design. An explicit --no-token-qr vetoes the
    // QR on every path, including the two above — a generated bearer is
    // still printed as plain text on its own line, so the veto costs
    // access to nothing. The suppressed case still delivers the address by
    // QR — the same URL is printed as plain text above, so the marginal
    // disclosure is zero, and the Web Shell's auth gate asks for the token
    // on arrival.
    const suppressTokenQr =
      input.tokenQrMode === 'veto' ||
      (!input.generated &&
        !process.stdout.isTTY &&
        input.tokenQrMode !== 'force');
    try {
      const { default: qrcode } = (await import('qrcode-terminal')) as {
        default: typeof import('qrcode-terminal');
      };
      qrcode.setErrorLevel('Q');
      qrcode.generate(
        suppressTokenQr
          ? candidate.url
          : `${candidate.url}/#token=${encodeURIComponent(input.token)}`,
        { small: true },
        (code) => {
          // The hint is emitted only once a QR is actually rendered: when
          // the renderer itself fails, the catch below already reports the
          // QR as unavailable, and advising --token-qr there would point the
          // operator at a flag that cannot produce one.
          if (suppressTokenQr)
            writeStdoutLineSafe(
              input.tokenQrMode === 'veto'
                ? 'Token-bearing QR suppressed: the token QR was ' +
                    'explicitly disabled for this run.'
                : 'Token-bearing QR suppressed: stable operator token with ' +
                    'non-interactive stdout. Pass --token-qr to print it anyway.',
            );
          writeStdoutLineSafe(
            `Scan to open Web Shell: ${candidate.url} (${candidate.label})`,
          );
          writeStdoutLineSafe(
            suppressTokenQr
              ? 'Address-only QR: the Web Shell will ask for the bearer token.'
              : 'SECRET QR: grants daemon access. Do not share.',
          );
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
