/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure mDNS advertisement + discovery logic (add-mdns-discovery spec):
 * TXT-record schema, name/workspace validation (path-traversal refusal), the
 * advertise/suppress decision, and browse-result normalize/dedupe/format. No
 * network or fs here — the bonjour wrapper (advertiser.ts / browser.ts) reads
 * the cwd and drives the multicast socket; this module is unit-tested in full.
 *
 * Interaction with the step-1 bind gate (bindSecurity.ts): a non-loopback bind
 * is only reachable in `tls` or `insecure-proxy` mode. We advertise ONLY in
 * `tls` mode — in `insecure-proxy` mode the gateway's own bind is cleartext
 * while the real TLS endpoint is the upstream proxy (whose host:port the gateway
 * does not know), so advertising our own host:port with `tlsRequired=true` would
 * mislead clients. Per design D2 ("the proxy is the better mDNS source") the
 * proxy should advertise itself. This means the spec's headline scenario
 * (`serve --host 0.0.0.0` with no other flags) now reaches advertising only with
 * `--tls`, because the bare form is refused by the bind gate first.
 */

import { basename } from 'node:path';

/** mDNS/DNS-SD protocol version this gateway speaks; mirrors the value the
 * capability surface advertises so the TXT `version` and `/rc/capabilities`
 * never drift. */
export const RC_PROTOCOL_VERSION = 1;

/** A bad operator-supplied mDNS option — the cli prints `.message` and exits. */
export class MdnsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MdnsConfigError';
  }
}

/**
 * Validate a TXT label (instance name / workspace name): 1–63 printable ASCII
 * characters, no path separators, no `.`/`..` traversal. Returns the trimmed
 * value or throws {@link MdnsConfigError}.
 */
export function validateMdnsLabel(value: string, field: string): string {
  const v = value.trim();
  if (v.length === 0) {
    throw new MdnsConfigError(`--mdns ${field} must not be empty`);
  }
  if (v.length > 63) {
    throw new MdnsConfigError(
      `--mdns ${field} must be 1-63 characters (got ${v.length})`,
    );
  }
  if (v === '.' || v === '..' || v.includes('/') || v.includes('\\')) {
    throw new MdnsConfigError(
      `--mdns ${field} must not contain a path separator or be a traversal token (got "${v}")`,
    );
  }
  // Printable ASCII only (0x20–0x7e), and not a leading dot (hidden-ish).
  if (!/^[\x20-\x7e]+$/.test(v)) {
    throw new MdnsConfigError(
      `--mdns ${field} must be printable ASCII (got "${value}")`,
    );
  }
  return v;
}

/**
 * The advertised `workspace` TXT value: the cwd basename by default (NEVER an
 * absolute path), or a validated operator override.
 */
export function deriveWorkspaceName(cwd: string, override?: string): string {
  if (override !== undefined) {
    return validateMdnsLabel(override, 'workspace-name');
  }
  return validateMdnsLabel(basename(cwd) || 'workspace', 'workspace-name');
}

/**
 * The service instance name: `<hostname>-<workspace>` by default (truncated to
 * 63 chars so a long host+workspace never throws), or a validated override.
 */
export function deriveInstanceName(
  hostname: string,
  workspace: string,
  override?: string,
): string {
  if (override !== undefined) {
    return validateMdnsLabel(override, 'instance-name');
  }
  const host = (hostname || 'host').split('.')[0];
  return `${host}-${workspace}`.slice(0, 63);
}

export type BindModeLike = 'loopback-http' | 'tls' | 'acme' | 'insecure-proxy';

export type MdnsSuppressReason =
  | 'flag'
  | 'env'
  | 'loopback'
  | 'insecure-proxy'
  | null;

/**
 * Decide whether to advertise. Advertise ONLY on a native-TLS bind with no
 * disable flag/env. Precedence of suppression reasons: explicit flag → env →
 * loopback bind → insecure-proxy bind.
 */
export function mdnsDecision(input: {
  bindMode: BindModeLike;
  noMdnsFlag?: boolean;
  envDisabled?: boolean;
}): { advertise: boolean; reason: MdnsSuppressReason } {
  if (input.noMdnsFlag) return { advertise: false, reason: 'flag' };
  if (input.envDisabled) return { advertise: false, reason: 'env' };
  if (input.bindMode === 'loopback-http') {
    return { advertise: false, reason: 'loopback' };
  }
  if (input.bindMode === 'insecure-proxy') {
    return { advertise: false, reason: 'insecure-proxy' };
  }
  return { advertise: true, reason: null };
}

export interface TxtRecord {
  version: string;
  name: string;
  workspace: string;
  tlsRequired: string;
}

/** Build the strict four-key TXT record (all values strings). */
export function buildTxtRecord(input: {
  name: string;
  workspace: string;
  tlsRequired: boolean;
}): TxtRecord {
  return {
    version: String(RC_PROTOCOL_VERSION),
    name: input.name,
    workspace: input.workspace,
    tlsRequired: input.tlsRequired ? 'true' : 'false',
  };
}

/** A raw service object as surfaced by the bonjour browser `up` event. */
export interface RawBrowseService {
  name: string;
  host?: string;
  addresses?: string[];
  port: number;
  txt?: Record<string, string | undefined>;
}

/** A discovered daemon, normalized to the six documented fields. */
export interface DaemonRecord {
  name: string;
  host: string;
  port: number;
  version: string;
  tlsRequired: boolean;
  workspace: string;
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Normalize a raw browse hit to a {@link DaemonRecord}, or `null` when no
 * usable host can be determined. Prefers an explicit `.host`, else the first
 * IPv4 address, else the first address of any kind.
 */
export function normalizeBrowseService(
  raw: RawBrowseService,
): DaemonRecord | null {
  const addrs = raw.addresses ?? [];
  const host = raw.host ?? addrs.find((a) => IPV4.test(a)) ?? addrs[0];
  if (!host) return null;
  const txt = raw.txt ?? {};
  return {
    name: txt.name ?? raw.name,
    host,
    port: raw.port,
    version: txt.version ?? '',
    tlsRequired: txt.tlsRequired === 'true',
    workspace: txt.workspace ?? '',
  };
}

/** Dedupe by service name (latest wins), then sort by host, then port. */
export function dedupeAndSortDaemons(records: DaemonRecord[]): DaemonRecord[] {
  const byName = new Map<string, DaemonRecord>();
  for (const r of records) byName.set(r.name, r);
  return [...byName.values()].sort(
    (a, b) => a.host.localeCompare(b.host) || a.port - b.port,
  );
}

function elapsedSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Render the `qwen rc daemons discover` table (header + rows + summary). */
export function formatDaemonsTable(
  records: DaemonRecord[],
  elapsedMs: number,
): string {
  const header = ['NAME', 'HOST', 'PORT', 'VERSION', 'TLS', 'WORKSPACE'];
  const rows = records.map((r) => [
    r.name,
    r.host,
    String(r.port),
    r.version,
    r.tlsRequired ? 'yes' : 'no',
    r.workspace,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length), 0),
  );
  const fmt = (cols: string[]) =>
    cols
      .map((c, i) => c.padEnd(i === cols.length - 1 ? 0 : widths[i]))
      .join('  ')
      .trimEnd();
  // No header for an empty result — just the summary line (friendlier for the
  // "nothing advertises" case; the table-format scenario assumes >=1 daemon).
  const lines = records.length ? [fmt(header), ...rows.map(fmt)] : [];
  const noun = records.length === 1 ? 'daemon' : 'daemons';
  lines.push(`${records.length} ${noun} found in ${elapsedSeconds(elapsedMs)}`);
  return lines.join('\n');
}

/** Render the `--format json` array — no surrounding text, six fields each. */
export function formatDaemonsJson(records: DaemonRecord[]): string {
  return JSON.stringify(
    records.map((r) => ({
      name: r.name,
      host: r.host,
      port: r.port,
      version: r.version,
      tlsRequired: r.tlsRequired,
      workspace: r.workspace,
    })),
  );
}

/** Parse a duration string (`5s`, `500ms`, or bare seconds `3`) to ms. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(s.trim());
  if (!m) throw new MdnsConfigError(`invalid duration "${s}"`);
  const n = Number(m[1]);
  const ms = m[2] === 'ms' ? n : n * 1000;
  if (!(ms > 0)) throw new MdnsConfigError(`duration must be positive: "${s}"`);
  return ms;
}

export interface DiscoverArgs {
  timeoutMs: number;
  format: 'table' | 'json';
}

/** Parse `daemons discover [--timeout <d>] [--format json|table]`. */
export function parseDiscoverArgs(argv: string[]): DiscoverArgs {
  let timeoutMs = 5000;
  let format: 'table' | 'json' = 'table';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--timeout') {
      timeoutMs = parseDuration(argv[++i] ?? '');
    } else if (a === '--format') {
      const f = argv[++i];
      if (f !== 'json' && f !== 'table') {
        throw new MdnsConfigError(
          `--format must be json or table (got "${f}")`,
        );
      }
      format = f;
    } else {
      throw new MdnsConfigError(`unknown argument "${a}"`);
    }
  }
  return { timeoutMs, format };
}
