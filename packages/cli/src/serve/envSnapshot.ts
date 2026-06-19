/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import {
  detectRuntime,
  redactProxyCredentials,
} from '@qwen-code/qwen-code-core';
import {
  STATUS_SCHEMA_VERSION,
  type ServeEnvCell,
  type ServeWorkspaceEnvStatus,
} from './status.js';
import { formatMemoryUsage } from '../ui/utils/formatters.js';

/**
 * Whitelisted environment variables whose **presence** the daemon will
 * surface on `/workspace/env`. These are credential-bearing, so cells emit
 * `present: boolean` only — never the value, not even masked.
 */
const SECRET_ENV_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DASHSCOPE_API_KEY',
  'OPENROUTER_API_KEY',
  'BLAZE_RUNTIME_TOKEN',
  'QWEN_SERVER_TOKEN',
] as const;

/**
 * Whitelisted environment variables whose **presence** is reported. Values
 * are still omitted to keep the env_var cell shape uniform — clients always
 * see `{ name, present }` and never have to decide whether `value` is safe
 * to display. Non-credential context (proxy host, runtime, sandbox name) is
 * surfaced through other `kind`s with structured value fields.
 */
const NONSECRET_ENV_VARS = [
  'OPENAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_BASE',
  'NODE_EXTRA_CA_CERTS',
  'TZ',
  'LANG',
  'LC_ALL',
  'TERM',
  'BLAZE_RUNTIME_ENTRY',
  'QWEN_CLI_ENTRY',
] as const;

const PROXY_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
] as const;

/**
 * Resolve a proxy env var, preferring the uppercase canonical form and
 * falling back to the lowercase variant only when the uppercase is
 * **absent** (`undefined`). Exported solely so tests can verify the
 * `??`-vs-`||` semantics with an injected env object — `process.env`
 * itself is case-insensitive on Windows, so the production caller passes
 * a snapshot of `process.env` while the unit test passes a plain JS
 * object with both keys distinct.
 */
export function readProxyVar(
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  // `??` (not `||`) so an explicitly empty `HTTPS_PROXY=""` (a Docker/K8s
  // entrypoint convention for "explicitly disabled") doesn't silently fall
  // through to the lowercase variant. The downstream `if (raw)` branch
  // then treats empty-string as disabled and emits the `proxy` cell with
  // `present: false`.
  return env[name] ?? env[name.toLowerCase()];
}

/**
 * Reduce a proxy env value to `host:port` so the wire never carries
 * credentials. NO_PROXY is a comma-separated host list (not a URL) so it
 * just goes through credential redaction verbatim.
 *
 * For URL-shaped values, `new URL(raw).host` discards userinfo and gives
 * us host:port directly. The catch ladder handles two malformed shapes:
 * authority-only (`user:pass@host:port` without a scheme — `URL` throws,
 * but prepending a dummy scheme parses cleanly), and anything else (last
 * resort: aggressive string scrub of `[^@/]*@` prefix and post-`/?#` tail).
 *
 * The catch path NEVER returns the redacted-but-otherwise-raw input —
 * `redactProxyCredentials` deliberately preserves SSH-like authority
 * (`git@github.com:22`) so its output can still leak credentials when the
 * shape is non-URL-like. Defense-in-depth.
 */
function safeProxyValue(name: string, raw: string): string {
  if (name === 'NO_PROXY') return redactProxyCredentials(raw);
  try {
    const host = new URL(raw).host;
    if (host) return host;
  } catch {
    /* fall through to authority-only attempt */
  }
  try {
    const host = new URL(`http://${raw}`).host;
    if (host) return host;
  } catch {
    /* fall through to scrub */
  }
  // Strip leading `<userinfo>@` and trailing `[/?#]…`. Whatever's left
  // is at most a host:port literal; never an unredacted credential.
  const stripped = raw.replace(/^[^@/?#]*@/, '').split(/[/?#]/)[0] ?? '';
  return stripped || '<unparseable>';
}

/**
 * Build the daemon's environment snapshot from `process.*` state. Pure
 * function — no I/O, no ACP roundtrip, no globals beyond `process.env`.
 *
 * The daemon owns runtime locality: all checks reflect the daemon
 * process, not a client-side environment.
 */
export function buildEnvStatusFromProcess(
  workspaceCwd: string,
  acpChannelLive: boolean,
): ServeWorkspaceEnvStatus {
  // `process.env` is shared mutable state — any concurrent code path
  // (auth flow, settings reload, child boot) can mutate it mid-snapshot.
  // Snapshot once at function entry so all 14+ cells observe the same
  // env, and a client polling `/workspace/env` can never see a torn
  // half-pre-init / half-post-init snapshot. Copy is cheap (a few hundred
  // string refs) and atomic from JS' single-threaded execution model.
  const env = { ...process.env };
  const cells: ServeEnvCell[] = [];

  // Under Bun, `process.versions.node` is the pinned node-compat shim
  // version (typically several minors behind the real Node release). The
  // operator wants to see Bun's actual version, not the shim. `detectRuntime`
  // returns `'node' | 'bun' | 'unknown'`; only `'bun'` benefits from the
  // override. Future runtimes can extend the same pattern.
  const runtime = detectRuntime();
  const runtimeVersion =
    runtime === 'bun'
      ? (process.versions['bun'] ?? process.versions.node)
      : process.versions.node;
  cells.push({
    kind: 'runtime',
    name: runtime,
    status: 'ok',
    value: runtimeVersion,
  });

  cells.push({
    kind: 'platform',
    name: process.platform,
    status: 'ok',
    value: `${process.arch} (${os.release()})`,
  });

  cells.push({
    kind: 'memory',
    name: 'rss',
    status: 'ok',
    value: formatMemoryUsage(process.memoryUsage().rss),
  });

  const sandboxName = env['SANDBOX'];
  cells.push({
    kind: 'sandbox',
    name: 'SANDBOX',
    status: sandboxName ? 'ok' : 'disabled',
    present: Boolean(sandboxName),
    ...(sandboxName ? { value: sandboxName } : {}),
  });

  const seatbelt = env['SEATBELT_PROFILE'];
  if (seatbelt) {
    cells.push({
      kind: 'sandbox',
      name: 'SEATBELT_PROFILE',
      status: 'ok',
      present: true,
      value: seatbelt,
    });
  }

  for (const name of PROXY_VARS) {
    const raw = readProxyVar(env, name);
    if (raw) {
      cells.push({
        kind: 'proxy',
        name,
        status: 'ok',
        present: true,
        value: safeProxyValue(name, raw),
      });
    } else {
      cells.push({
        kind: 'proxy',
        name,
        status: 'disabled',
        present: false,
      });
    }
  }

  for (const name of [...SECRET_ENV_VARS, ...NONSECRET_ENV_VARS]) {
    const present = Boolean(env[name]);
    cells.push({
      kind: 'env_var',
      name,
      status: present ? 'ok' : 'disabled',
      present,
    });
  }

  return {
    v: STATUS_SCHEMA_VERSION,
    workspaceCwd,
    initialized: true,
    acpChannelLive,
    cells,
  };
}

/** Exposed for tests and protocol docs. */
export const ENV_SECRET_VARS: readonly string[] = SECRET_ENV_VARS;
export const ENV_NONSECRET_VARS: readonly string[] = NONSECRET_ENV_VARS;
export const ENV_PROXY_VARS: readonly string[] = PROXY_VARS;
