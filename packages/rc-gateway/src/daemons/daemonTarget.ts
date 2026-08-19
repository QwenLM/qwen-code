/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-daemon target resolution for the CLI (`add-multi-workspace-client`
 * task 1.4: `--daemon` flag threading). Pure: the registry entries and a
 * token-lookup callback are passed in, so the precedence rules are unit
 * tested without any filesystem or network.
 *
 * URL precedence:  explicit `--url`  >  `--daemon <name>` entry  >
 *                  default registry entry  >  local default.
 * Token precedence: explicit `--token`  >  the entry's `tokenStorageKey`
 * lookup (wired to FileTokenStore by the glue).
 */

import { resolveDefault, type DaemonEntry } from './registry.js';

/** Where a command should send its request. */
export interface DaemonTarget {
  /** Display name ('local' when nothing registry-derived matched). */
  name: string;
  /** Absolute daemon base URL, without a trailing slash. */
  url: string;
  /** Bearer token, when one is known. */
  token?: string;
  /** True when the URL came from a clients.toml entry. */
  fromRegistry: boolean;
}

export interface DaemonTargetOptions {
  /** `--daemon <name>` — a clients.toml entry name. */
  daemonName?: string;
  /** `--url <u>` — explicit base URL; bypasses the registry for the URL. */
  url?: string;
  /** `--token <t>` — explicit token; wins over the token store. */
  token?: string;
}

/** Look up a stored token for a registry entry (wired to FileTokenStore). */
export type TokenLookup = (
  tokenStorageKey: string,
) => string | undefined | Promise<string | undefined>;

/**
 * Stable codes for resolution failures (spec "Registry CLI" / `--daemon`
 * requirement): `daemon_unknown` → the CLI exits 1; `bad_url` is a usage
 * error → the CLI exits 2.
 */
export type DaemonTargetErrorCode = 'daemon_unknown' | 'bad_url';

export type DaemonTargetResult =
  | { ok: true; target: DaemonTarget }
  | { ok: false; error: string; code: DaemonTargetErrorCode };

/**
 * The local daemon default: the launcher's `qwen-rc up` port (8443, native
 * TLS). Overridable via `QWEN_RC_DAEMON_URL` — the same env var `qwen-rc
 * serve --attach-daemon` reads, so a hand-rolled daemon URL reaches every
 * per-daemon command identically.
 */
export const LOCAL_DAEMON_URL = 'https://127.0.0.1:8443';

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function isValidHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Pure: resolve the daemon target for a per-daemon CLI command.
 *
 * Errors (ok:false) cover: an unparseable `--url`, and a `--daemon <name>`
 * that matches no entry (the error lists the known names). An EMPTY registry
 * with no explicit url/name is not an error — it resolves to the local
 * default so the single-daemon setup keeps working with zero config.
 */
export async function resolveDaemonTarget(
  opts: DaemonTargetOptions,
  entries: DaemonEntry[],
  tokenFor: TokenLookup,
  env: Record<string, string | undefined> = process.env,
): Promise<DaemonTargetResult> {
  const localDefault = stripTrailingSlash(
    env['QWEN_RC_DAEMON_URL'] || LOCAL_DAEMON_URL,
  );

  if (opts.url !== undefined) {
    if (!isValidHttpUrl(opts.url)) {
      return {
        ok: false,
        error: `--url must be an absolute http(s) URL, got: ${opts.url}`,
        code: 'bad_url',
      };
    }
    return {
      ok: true,
      target: {
        name: new URL(opts.url).host,
        url: stripTrailingSlash(opts.url),
        ...(opts.token ? { token: opts.token } : {}),
        fromRegistry: false,
      },
    };
  }

  if (opts.daemonName !== undefined) {
    const entry = entries.find((e) => e.name === opts.daemonName);
    if (!entry) {
      // Spec: an unknown --daemon exits 1 with `daemon_unknown`.
      const known = entries.map((e) => e.name).join(', ') || '(none)';
      return {
        ok: false,
        error: `daemon_unknown: no such daemon "${opts.daemonName}" (known: ${known})`,
        code: 'daemon_unknown',
      };
    }
    return { ok: true, target: await targetFromEntry(entry, opts, tokenFor) };
  }

  if (entries.length > 0) {
    return {
      ok: true,
      target: await targetFromEntry(resolveDefault(entries)!, opts, tokenFor),
    };
  }

  return {
    ok: true,
    target: {
      name: 'local',
      url: localDefault,
      ...(opts.token ? { token: opts.token } : {}),
      fromRegistry: false,
    },
  };
}

async function targetFromEntry(
  entry: DaemonEntry,
  opts: DaemonTargetOptions,
  tokenFor: TokenLookup,
): Promise<DaemonTarget> {
  const token = opts.token ?? (await tokenFor(entry.tokenStorageKey));
  return {
    name: entry.name,
    url: stripTrailingSlash(entry.url),
    ...(token ? { token } : {}),
    fromRegistry: true,
  };
}

/** Split result of {@link splitTargetFlags}. */
export interface SplitTargetFlagsResult {
  /** argv with the target flags removed (the command's own args). */
  core: string[];
  target: DaemonTargetOptions;
  insecure: boolean;
}

/**
 * Pure: pull the cross-cutting `--daemon` / `--url` / `--token` /
 * `--insecure` flags out of a command's argv (both `--flag value` and
 * `--flag=value` forms), leaving the command's own args in `core`. Used by
 * `qwen-rc fork` so its core arg parser never sees the threading flags.
 * Throws when a value-taking flag is missing its value.
 */
export function splitTargetFlags(argv: string[]): SplitTargetFlagsResult {
  const core: string[] = [];
  const target: DaemonTargetOptions = {};
  let insecure = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--daemon' || a === '--url' || a === '--token') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      if (a === '--daemon') target.daemonName = v;
      else if (a === '--url') target.url = v;
      else target.token = v;
    } else if (a.startsWith('--daemon=')) {
      target.daemonName = a.slice('--daemon='.length);
    } else if (a.startsWith('--url=')) {
      target.url = a.slice('--url='.length);
    } else if (a.startsWith('--token=')) {
      target.token = a.slice('--token='.length);
    } else if (a === '--insecure') {
      insecure = true;
    } else {
      core.push(a);
    }
  }
  return { core, target, insecure };
}
