/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Non-loopback bind safety gate (resolves `add-remote-control` design Q
 * design.md:448; enforces its threat-model row design.md:231: "Daemon SHOULD
 * refuse non-loopback bind without `--tls` or a documented opt-out").
 *
 * The gateway speaks plain HTTP and the remote-control design deliberately
 * delegates TLS to an upstream terminator (reverse proxy / Tailscale / Cloudflare
 * Tunnel). That is SAFE on loopback (traffic never leaves the host) but on a
 * non-loopback bind it would put bearer tokens on the wire in cleartext. So a
 * non-loopback bind is REFUSED unless the operator either:
 *   - supplies a cert+key for NATIVE TLS termination (`--tls`/`--tls-key`), or
 *   - asserts an upstream terminator with `--insecure-behind-proxy`.
 *
 * Pure decision logic (no fs, no network) so the gate is unit-tested; the cli
 * wiring reads the cert files and picks http vs https from the returned mode.
 */

/** A refusal to bind — the cli prints `.message` and exits non-zero. */
export class BindSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindSecurityError';
  }
}

export type BindMode =
  /** Loopback HTTP — the safe default; TLS unnecessary (traffic never leaves host). */
  | 'loopback-http'
  /** Native TLS termination in the gateway (cert+key supplied). */
  | 'tls'
  /** Native TLS with an auto-obtained Let's Encrypt cert (ACME DNS-01). */
  | 'acme'
  /** Plain HTTP on a non-loopback bind, operator asserts an upstream TLS terminator. */
  | 'insecure-proxy';

export interface BindSecurity {
  host: string;
  mode: BindMode;
  /** Cert/key paths when `mode === 'tls'`. */
  tls?: { certPath: string; keyPath: string };
  /**
   * Whether a CLIENT must use TLS to reach this gateway — `false` only for the
   * loopback-http default. Drives the mDNS `tlsRequired` TXT key: native TLS and a
   * fronting proxy both mean clients connect over TLS.
   *
   * NOTE(mdns): the cleartext-bind-vs-advertised-endpoint mismatch this once
   * flagged for insecure-proxy mode does not arise — mDNS advertising is SUPPRESSED
   * on a non-native-TLS bind (only a `tls` bind advertises; see mdns/advert.ts
   * `mdnsDecision`). If advertising were ever enabled behind a proxy, the
   * advertised endpoint must be the proxy host/port, not this cleartext bind.
   */
  tlsRequired: boolean;
}

export interface BindSecurityInput {
  /** Bind host (default `127.0.0.1`). */
  host?: string;
  tlsCert?: string;
  tlsKey?: string;
  insecureBehindProxy?: boolean;
  /** `--acme-domain` values: native TLS with an auto-obtained Let's Encrypt cert. */
  acmeDomains?: string[];
}

/**
 * Is `host` a loopback address? `127.0.0.0/8`, `::1`, and `localhost` are
 * loopback; `0.0.0.0` / `::` (wildcards, which bind LAN interfaces) and any
 * specific LAN address are NOT.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Resolve how to bind, or throw {@link BindSecurityError} when a non-loopback
 * bind lacks a TLS story. `--tls` and `--tls-key` must be supplied together.
 */
export function resolveBindSecurity(input: BindSecurityInput): BindSecurity {
  const host = (input.host ?? '127.0.0.1').trim() || '127.0.0.1';
  const hasCert = !!input.tlsCert;
  const hasKey = !!input.tlsKey;
  if (hasCert !== hasKey) {
    throw new BindSecurityError(
      '--tls <cert> and --tls-key <key> must be provided together',
    );
  }
  const hasTls = hasCert && hasKey;
  if (hasTls && input.insecureBehindProxy) {
    throw new BindSecurityError(
      'pass either --tls (native termination) or --insecure-behind-proxy, not both',
    );
  }

  // ACME (auto Let's Encrypt) is its own native-TLS story — it obtains the cert
  // rather than reading files — so it satisfies a non-loopback bind. It's mutually
  // exclusive with file-supplied TLS and with the insecure-proxy assertion.
  const hasAcme = (input.acmeDomains?.length ?? 0) > 0;
  if (hasAcme && hasTls) {
    throw new BindSecurityError(
      'pass either --acme-domain (auto TLS) or --tls (file cert), not both',
    );
  }
  if (hasAcme && input.insecureBehindProxy) {
    throw new BindSecurityError(
      'pass either --acme-domain (auto TLS) or --insecure-behind-proxy, not both',
    );
  }
  if (hasAcme) {
    return { host, mode: 'acme', tlsRequired: true };
  }

  if (isLoopbackHost(host)) {
    // Loopback: TLS is optional (operator may still terminate natively).
    return hasTls
      ? {
          host,
          mode: 'tls',
          tls: { certPath: input.tlsCert!, keyPath: input.tlsKey! },
          tlsRequired: true,
        }
      : { host, mode: 'loopback-http', tlsRequired: false };
  }

  // Non-loopback: a TLS story is mandatory.
  if (hasTls) {
    return {
      host,
      mode: 'tls',
      tls: { certPath: input.tlsCert!, keyPath: input.tlsKey! },
      tlsRequired: true,
    };
  }
  if (input.insecureBehindProxy) {
    return { host, mode: 'insecure-proxy', tlsRequired: true };
  }
  throw new BindSecurityError(
    `refusing to bind non-loopback host ${host} without TLS: bearer tokens would ` +
      'transit in cleartext. Pass --tls <cert> --tls-key <key> for native TLS, or ' +
      '--insecure-behind-proxy if a TLS-terminating reverse proxy (Caddy / Nginx / ' +
      'Tailscale / Cloudflare Tunnel) sits in front of the gateway.',
  );
}
