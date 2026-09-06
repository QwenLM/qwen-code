/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { networkInterfaces } from 'node:os';

export interface LanCandidate {
  /** OS interface name, e.g. `en0` / `wlan0`. */
  readonly interfaceName: string;
  /** IPv4 literal to bind and advertise. */
  readonly address: string;
}

/**
 * Only RFC 1918 private space and RFC 3927 link-local are advertised.
 *
 * The pre-consolidation `localControlUrls` accepted every non-internal IPv4,
 * which meant a QR could point at a VPN address or — on a host with a routable
 * address — the public internet. Local Control is scoped to "same physical
 * network"; a public address is out of scope by definition, not merely
 * inadvisable, so it is refused rather than warned about.
 */
function isLanIpv4(address: string): boolean {
  const octets = address.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o))) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isSoftwareNetwork(interfaceName: string): boolean {
  // `vpn` matches as a substring, deliberately looser than the bounded
  // tokens below: consumer VPN adapter names almost always END in "VPN"
  // (OpenVPN Wintun, NordVPN, ExpressVPN…) or embed it mid-word (vpnkit),
  // and no physical adapter is realistically named with that run. A
  // boundary requirement let `OpenVPN Wintun` escape — the `vpn` sits
  // inside "openvpn" with no leading boundary.
  if (/vpn/i.test(interfaceName)) return true;
  // Bridge tokens stay narrow on purpose: Docker user bridges are `br-<hex>`
  // (the ID may start with a letter, so the hex run is part of the token —
  // the shared boundary alone would let `br-fa5c…` escape) and macOS
  // Thunderbolt bridges are `bridge<N>` (both virtual), while a plain `br0`
  // is the canonical libvirt bridged-LAN host interface and Windows names a
  // manual physical bridge "Network Bridge" — those carry the machine's real
  // LAN address and must stay eligible. `veth` keeps the same shape: Docker
  // peer IDs are `veth<hex>` and may be letter-led (`vethd4a1b2c`), which
  // the bare token's digit boundary let escape. Corporate SSL-VPN adapters
  // (AnyConnect, GlobalProtect, Pulse Secure, FortiClient, Cloudflare WARP)
  // carry no `vpn` substring, so their vendor names are listed explicitly —
  // including post-rename successor products (Ivanti Connect Secure is the
  // 2021 rename of Pulse Secure; Cisco Secure Client succeeds AnyConnect),
  // which escape under their new names otherwise. Each added token only
  // defers the next corner of this unbounded entrance space; the class fix
  // (structural classification instead of name matching) is tracked in
  // #9158.
  return /(^|[\s_.-])(utun|tun|tap|ppp|ipsec|wg|wireguard|tailscale|zerotier|zt[a-z0-9]*|hamachi|nordlynx|proton|wintun|docker|veth[0-9a-f]+|vmnet|vboxnet|vethernet|virtualbox|host[- ]only|podman|cni|lxcbr|lxdbr|flannel|virbr|br-[0-9a-f]+|bridge\d|anyconnect|globalprotect|pulse[\s-]secure|forticlient|fortinet|ivanti|cisco[\s_-]secure|citrix|sonicwall|cloudflare)(\d|[\s_.-]|$)/i.test(
    interfaceName,
  );
}

/** Every private/link-local IPv4 the host currently has, sorted for stable output. */
export function listLanCandidates(
  interfaces = networkInterfaces(),
): LanCandidate[] {
  const candidates: LanCandidate[] = [];
  for (const [interfaceName, addresses] of Object.entries(interfaces).sort()) {
    if (isSoftwareNetwork(interfaceName)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      if (!isLanIpv4(address.address)) continue;
      candidates.push({ interfaceName, address: address.address });
    }
  }
  return candidates;
}

export class NoLanInterfaceError extends Error {
  readonly code = 'no_lan_interface';
  constructor() {
    super(
      'No private IPv4 address is available. Local Control needs the host to ' +
        'be on a local network (Wi-Fi or Ethernet).',
    );
    this.name = 'NoLanInterfaceError';
  }
}

export class AmbiguousLanInterfaceError extends Error {
  readonly code = 'ambiguous_lan_interface';
  readonly candidates: readonly LanCandidate[];
  constructor(candidates: readonly LanCandidate[]) {
    super(
      'Multiple local networks are available; choose which one to expose: ' +
        candidates.map((c) => `${c.interfaceName} (${c.address})`).join(', '),
    );
    this.name = 'AmbiguousLanInterfaceError';
    this.candidates = candidates;
  }
}

export class UnknownLanInterfaceError extends Error {
  readonly code = 'unknown_lan_interface';
  constructor(requested: string) {
    super(
      `${requested} is not a private IPv4 address on this host right now. ` +
        'The network may have changed since the list was fetched.',
    );
    this.name = 'UnknownLanInterfaceError';
  }
}

/**
 * Pick the address to bind.
 *
 * Ambiguity is surfaced, not resolved. The Rust implementation failed outright
 * when a host had more than one LAN address and
 * the CLI printed a QR for every one, leaving the user to guess. Neither is
 * right: the caller gets {@link AmbiguousLanInterfaceError} carrying the
 * candidates so the Web Shell can ask, and can then pass `preferredAddress` to
 * commit to an answer.
 */
export function selectLanAddress(
  preferredAddress?: string,
  interfaces = networkInterfaces(),
): LanCandidate {
  const candidates = listLanCandidates(interfaces);
  if (candidates.length === 0) throw new NoLanInterfaceError();
  if (preferredAddress !== undefined) {
    const match = candidates.find((c) => c.address === preferredAddress);
    if (!match) throw new UnknownLanInterfaceError(preferredAddress);
    return match;
  }
  if (candidates.length > 1) throw new AmbiguousLanInterfaceError(candidates);
  return candidates[0];
}
