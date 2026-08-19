/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure argv/ render logic for `qwen-rc daemons …` (`add-multi-workspace-client`
 * task 1.3: the registry CLI). The registry I/O (DaemonRegistry) and token I/O
 * (FileTokenStore) are already unit tested; the daemon probes are in
 * daemonClient.ts. What lives here is the part that was most likely to be
 * fiddly by hand: subcommand/flag parsing, name/URL validation, and the
 * table/line renderers.
 */

import type { HealthStatus } from './daemonClient.js';

export type DaemonsSubcommand =
  | 'list'
  | 'add'
  | 'remove'
  | 'set-default'
  | 'health'
  | 'whoami';

export interface DaemonsArgs {
  sub: DaemonsSubcommand;
  /** add/remove/set-default: the daemon name. */
  name?: string;
  /** add: the daemon base URL. */
  url?: string;
  /** add: explicit pairing code (non-interactive). */
  code?: string;
  /** add: store this token directly instead of walking pairing. */
  token?: string;
  /** add: skip pairing/token entirely (bare registry entry). */
  noPair: boolean;
  /** add: overwrite an existing entry with the same name. */
  force: boolean;
  /** add: override the entry's tokenStorageKey (default: the name). */
  tokenStorageKey?: string;
  /** health: probe every entry, not just the (default) target. */
  all: boolean;
  /** health/whoami: `--daemon <name>` (else the default daemon). */
  daemonName?: string;
  /** add: skip the trust confirmation; remove: skip the confirm prompt. */
  yes: boolean;
  insecure: boolean;
  format: 'table' | 'json';
}

export type DaemonsArgsResult =
  | { ok: true; value: DaemonsArgs }
  | { ok: false; error: string };

/** Registry daemon names: conservative, flat, path-safe. */
export const DAEMON_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const SUBS: readonly DaemonsSubcommand[] = [
  'list',
  'add',
  'remove',
  'set-default',
  'health',
  'whoami',
];

export const DAEMONS_USAGE =
  'usage: qwen-rc daemons <list|add|remove|set-default|health|whoami> [flags]\n' +
  '  list [--format table|json]                       registry + token presence + health\n' +
  '  add <name> <url> [--code <code>|--token <t>|--no-pair] [--force] [--yes] [--token-storage-key <k>]\n' +
  '  remove <name> [--yes]                             revokes the token on the daemon (best-effort)\n' +
  '  set-default <name>\n' +
  '  health [--all] [--daemon <name>]                  GET /rc/health (public)\n' +
  '  whoami [--daemon <name>]                           token identity (name, scopes, expiry)';

export function parseDaemonsArgs(argv: string[]): DaemonsArgsResult {
  const sub = argv[0];
  if (sub === undefined) {
    return { ok: false, error: `missing subcommand — ${DAEMONS_USAGE}` };
  }
  if (!(SUBS as readonly string[]).includes(sub)) {
    return {
      ok: false,
      error: `unknown subcommand "${sub}" — ${DAEMONS_USAGE}`,
    };
  }

  const value: DaemonsArgs = {
    sub: sub as DaemonsSubcommand,
    noPair: false,
    force: false,
    all: false,
    yes: false,
    insecure: false,
    format: 'table',
  };

  const rest = argv.slice(1);
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--format') {
      const v = rest[++i];
      if (v !== 'table' && v !== 'json') {
        return {
          ok: false,
          error: `--format must be table or json (got: ${v ?? ''})`,
        };
      }
      value.format = v;
    } else if (a.startsWith('--format=')) {
      const v = a.slice('--format='.length);
      if (v !== 'table' && v !== 'json') {
        return {
          ok: false,
          error: `--format must be table or json (got: ${v})`,
        };
      }
      value.format = v;
    } else if (a === '--code') {
      value.code = rest[++i];
      if (value.code === undefined) {
        return { ok: false, error: '--code requires a value' };
      }
    } else if (a === '--token') {
      value.token = rest[++i];
      if (value.token === undefined) {
        return { ok: false, error: '--token requires a value' };
      }
    } else if (a === '--no-pair') {
      value.noPair = true;
    } else if (a === '--force') {
      value.force = true;
    } else if (a === '--token-storage-key') {
      value.tokenStorageKey = rest[++i];
      if (value.tokenStorageKey === undefined) {
        return { ok: false, error: '--token-storage-key requires a value' };
      }
    } else if (a === '--all') {
      value.all = true;
    } else if (a === '--daemon') {
      value.daemonName = rest[++i];
      if (value.daemonName === undefined) {
        return { ok: false, error: '--daemon requires a value' };
      }
    } else if (a.startsWith('--daemon=')) {
      value.daemonName = a.slice('--daemon='.length);
    } else if (a === '--yes') {
      value.yes = true;
    } else if (a === '--insecure') {
      value.insecure = true;
    } else if (a.startsWith('--')) {
      return { ok: false, error: `unknown flag: ${a} — ${DAEMONS_USAGE}` };
    } else {
      positional.push(a);
    }
  }

  // Positional arity per subcommand.
  if (value.sub === 'add') {
    if (positional.length !== 2) {
      return {
        ok: false,
        error: 'add requires <name> and <url> — ' + DAEMONS_USAGE,
      };
    }
    value.name = positional[0];
    value.url = positional[1];
  } else if (value.sub === 'remove' || value.sub === 'set-default') {
    if (positional.length !== 1) {
      return {
        ok: false,
        error: `${value.sub} requires <name> — ${DAEMONS_USAGE}`,
      };
    }
    value.name = positional[0];
  } else if (positional.length > 0) {
    return {
      ok: false,
      error: `unexpected argument: ${positional[0]} — ${DAEMONS_USAGE}`,
    };
  }

  // Cross-flag validation.
  if (value.sub === 'add') {
    if (!DAEMON_NAME_RE.test(value.name!)) {
      return {
        ok: false,
        error: `invalid daemon name "${value.name}" (letters/digits/._-, 1-64, no leading punctuation)`,
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(value.url!);
    } catch {
      return {
        ok: false,
        error: `invalid daemon URL "${value.url}" (must be absolute http/https)`,
      };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        error: `daemon URL must be http(s), got: ${value.url}`,
      };
    }
    if (
      value.noPair &&
      (value.code !== undefined || value.token !== undefined)
    ) {
      return {
        ok: false,
        error: '--no-pair cannot be combined with --code/--token',
      };
    }
    if (value.code !== undefined && value.token !== undefined) {
      return { ok: false, error: 'pass at most one of --code or --token' };
    }
    if (
      value.tokenStorageKey !== undefined &&
      !DAEMON_NAME_RE.test(value.tokenStorageKey)
    ) {
      return {
        ok: false,
        error: `invalid --token-storage-key "${value.tokenStorageKey}"`,
      };
    }
  }
  if (
    (value.sub === 'remove' || value.sub === 'set-default') &&
    !DAEMON_NAME_RE.test(value.name!)
  ) {
    return {
      ok: false,
      error: `invalid daemon name "${value.name}"`,
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** One row of `daemons list`. */
export interface DaemonRow {
  name: string;
  url: string;
  isDefault: boolean;
  tokenPresent: boolean;
  health: HealthStatus;
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - s.length));
}

/** Fixed-width table: NAME / URL / DEFAULT / TOKEN / HEALTH. */
export function formatDaemonsListTable(rows: DaemonRow[]): string {
  if (rows.length === 0) {
    return '(no daemons registered — add one: qwen-rc daemons add <name> <url>)';
  }
  const headers = ['NAME', 'URL', 'DEFAULT', 'TOKEN', 'HEALTH'];
  const body = rows.map((r) => [
    r.name,
    r.url,
    r.isDefault ? '*' : '',
    r.tokenPresent ? 'yes' : 'no',
    r.health,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const line = (cols: string[]) =>
    cols.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(headers), ...body.map(line)].join('\n');
}

/** One `daemons health` line, e.g. `work-a  https://a:8443  ok (3 ms)`. */
export function formatHealthLine(
  name: string,
  url: string,
  status: HealthStatus,
  ms?: number,
  detail?: string,
): string {
  const base = `${name}  ${url}`;
  if (status === 'ok')
    return `${base}  ok${ms !== undefined ? ` (${ms} ms)` : ''}`;
  if (status === 'unreachable') {
    return `${base}  UNREACHABLE${detail ? ` — ${detail}` : ''}`;
  }
  return `${base}  ERROR${detail ? ` — ${detail}` : ''}`;
}

export interface WhoamiInfo {
  kind: 'share' | 'owner' | 'invalid' | 'unknown';
  name?: string;
  scopes: string[];
  /** ISO-8601, share tokens only; owner tokens do not expire. */
  expiresAt?: string;
}

/** Render `whoami` output (a few human lines). */
export function formatWhoami(info: WhoamiInfo): string {
  const name = info.name ?? '(unnamed)';
  const scopes = info.scopes.length > 0 ? info.scopes.join(', ') : '(none)';
  const expiry =
    info.kind === 'share' && info.expiresAt
      ? `expires ${info.expiresAt}`
      : info.kind === 'owner'
        ? 'no expiry (owner tokens are long-lived)'
        : '';
  switch (info.kind) {
    case 'share':
      return `share token  ${name}\n  scopes: ${scopes}\n  ${expiry}`;
    case 'owner':
      return `token  ${name}\n  scopes: ${scopes}\n  ${expiry}`;
    case 'invalid':
      return 'token rejected by the daemon (401) — re-pair: qwen-rc daemons remove <name> && qwen-rc daemons add <name> <url>';
    default:
      return 'token accepted, but its identity could not be determined (no recorded metadata and no owner listing access)';
  }
}
