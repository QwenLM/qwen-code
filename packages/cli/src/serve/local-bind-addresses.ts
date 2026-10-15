/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { networkInterfaces } from 'node:os';

/**
 * Strip the URL brackets and the RFC 6874 zone identifier from an IPv6
 * literal so it can be compared against `os.networkInterfaces()`, which
 * reports the bare address and carries the scope separately. Bracket
 * stripping is load-bearing — `new URL(...).hostname` keeps brackets — but
 * the zone handling is defensive only: production callers feed this from
 * `new URL(...).hostname`, and WHATWG URL rejects zone IDs outright, so a
 * zone never survives the parse layer to reach here.
 */
function bareAddress(hostname: string): string {
  const unbracketed =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  const decoded = unbracketed.replace(/%25/gi, '%');
  const zoneAt = decoded.indexOf('%');
  return (zoneAt === -1 ? decoded : decoded.slice(0, zoneAt)).toLowerCase();
}

/**
 * Whether `hostname` is an IP literal assigned to one of this machine's own
 * interfaces — that is, an address the local host answers on.
 *
 * Channel workers are always spawned on the daemon's own machine, but a
 * daemon bound to a concrete interface (`--hostname 192.168.1.100`) listens
 * on that socket ONLY: loopback is not bound, so rewriting the worker's URL
 * to `127.0.0.1` would trade a rejected URL for `ECONNREFUSED`. The worker
 * therefore dials the address the daemon actually bound, and this is how it
 * certifies that doing so keeps the daemon token on the local host — the
 * property the loopback rule existed to guarantee. Traffic to an own
 * interface address never reaches the wire; the kernel routes it back up the
 * stack.
 *
 * Literals only, on purpose. Resolving a DNS name here would put a lookup —
 * and whatever answers it — on the worker's startup path, so a non-literal
 * bind is refused at boot instead (see the channel bind guard in
 * `run-qwen-serve`), which fails loudly once rather than restart-looping
 * every worker.
 */
export function isOwnInterfaceAddress(hostname: string): boolean {
  const target = bareAddress(hostname);
  if (target === '') return false;
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address.toLowerCase() === target) return true;
    }
  }
  return false;
}

/**
 * Whether this host has the IPv6 loopback (`::1`) assigned on any
 * interface. A wildcard `::` listener is always dual-stack under Node
 * (libuv pins `IPV6_V6ONLY=0` unless `ipv6Only` is requested), so such a
 * daemon usually answers on BOTH loopbacks — but an IPv4-less host has only
 * `::1`, and a host that binds `::` while its loopback carries no `::1`
 * (e.g. `net.ipv6.conf.lo.disable_ipv6=1`) has only `127.0.0.1`. Channel
 * workers must dial whichever one actually exists.
 */
export function hostAssignsIpv6Loopback(
  interfaces = networkInterfaces(),
): boolean {
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv6' && entry.address === '::1') return true;
    }
  }
  return false;
}
