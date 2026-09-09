/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared Chrome bridge for non-daemon Qwen Code processes (issue #8737).
 *
 * Chrome demands consent for EVERY new connection to its remote-debugging
 * endpoint, and each CLI process spawns its own `chrome-devtools-mcp` child —
 * so a user-configured `--autoConnect` server pops the "Allow remote
 * debugging?" dialog once per session. When a local `qwen serve` daemon has a
 * Chrome extension bridge connected, its `/cdp` tunnel offers the same tab
 * over `chrome.debugger` with no per-connection consent; this module detects
 * that and reroutes the server's spawn to it (`--wsEndpoint`), so consent
 * happens once per daemon/extension lifetime instead of once per session.
 *
 * The reroute is strictly fail-open: any probe failure, absent bridge,
 * legacy (single-client) extension, token-gated daemon, or opt-out keeps the
 * user's literal config. When a candidate server exists but no usable bridge
 * is found, a one-line hint explains that direct connections keep popping
 * Chrome's per-connection consent dialog and how to enable the shared bridge.
 */

import {
  isGatedMcpScope,
  type Config,
  type MCPServerConfig,
} from '@qwen-code/qwen-code-core';
import { QWEN_CODE_SERVE_ENV } from './acp-channel-fallback.js';
import { QWEN_DAEMON_URL_ENV } from '../serve/channel-worker-env.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

/** Opt out of the shared Chrome bridge reroute. */
export const SHARED_CHROME_BRIDGE_OPT_OUT_ENV = 'QWEN_NO_SHARED_CHROME_BRIDGE';

/** Default daemon base URL (mirrors the `qwen channel` commands). */
const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4170';

/** Bound the startup probe so a dead/unresponsive daemon never delays boot. */
const PROBE_TIMEOUT_MS = 750;

/** The daemon-side server name the extension tunnel registers under. */
const CHROME_DEVTOOLS_SERVER_NAME = 'chrome-devtools';

/** Shape of `GET /cdp/status` on the daemon (see routes/cdp-status.ts). */
export interface CdpStatusResponse {
  enabled?: boolean;
  bridgeConnected?: boolean;
  multiClient?: boolean;
  linkCount?: number;
  usable?: boolean;
}

interface StdioLikeServerConfig {
  command?: unknown;
  args?: unknown;
}

function isStdioLike(cfg: MCPServerConfig): cfg is MCPServerConfig & {
  command: string;
  args?: unknown[];
} {
  return (
    typeof (cfg as StdioLikeServerConfig).command === 'string' &&
    ((cfg as StdioLikeServerConfig).args === undefined ||
      Array.isArray((cfg as StdioLikeServerConfig).args))
  );
}

/**
 * Whether a configured MCP server is a chrome-devtools adapter that would
 * re-dial Chrome's consent-gated remote-debugging endpoint per process:
 * a stdio server named `chrome-devtools` or running a `chrome-devtools-mcp`
 * binary, launched with `--autoConnect`. Explicit connection targets already
 * point at a stable browser/bridge and are left alone.
 */
export function isAutoConnectChromeDevToolsServer(
  name: string,
  cfg: MCPServerConfig,
): boolean {
  if (!isStdioLike(cfg)) return false;
  const command = cfg.command;
  const args = cfg.args ?? [];
  const matchesAdapter =
    name === CHROME_DEVTOOLS_SERVER_NAME ||
    /(^|[\\/])chrome-devtools-mcp(\.(cmd|exe|js))?$/.test(command) ||
    args.some(
      (arg) =>
        typeof arg === 'string' &&
        (arg === 'chrome-devtools-mcp' ||
          arg.startsWith('chrome-devtools-mcp@')),
    );
  if (!matchesAdapter) return false;
  const hasExplicitEndpoint = args.some(
    (a) =>
      typeof a === 'string' &&
      (a === '--wsEndpoint' ||
        a.startsWith('--wsEndpoint=') ||
        a === '--ws-endpoint' ||
        a.startsWith('--ws-endpoint=') ||
        a === '-w' ||
        a === '--browserUrl' ||
        a.startsWith('--browserUrl=') ||
        a === '--browser-url' ||
        a.startsWith('--browser-url=') ||
        a === '-u'),
  );
  return args.includes('--autoConnect') && !hasExplicitEndpoint;
}

/**
 * Rewrite adapter args to dial the daemon's `/cdp` tunnel instead of Chrome
 * directly: drop `--autoConnect`, replace any existing `--wsEndpoint` value,
 * keep everything else (browser hints, isolation flags, …) as configured.
 */
export function rewriteToWsEndpoint(
  args: readonly unknown[],
  wsEndpoint: string,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]!);
    if (arg === '--autoConnect') continue;
    if (arg === '--wsEndpoint' || arg.startsWith('--wsEndpoint=')) {
      if (arg === '--wsEndpoint') i++; // also skip its value
      continue;
    }
    out.push(arg);
  }
  out.push('--wsEndpoint', wsEndpoint);
  return out;
}

function resolveDaemonUrl(env: Readonly<NodeJS.ProcessEnv>): string {
  const raw = env[QWEN_DAEMON_URL_ENV] || DEFAULT_DAEMON_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Probe the daemon's `/cdp/status`. Returns the parsed status, or `undefined`
 * on any failure (daemon down, timeout, non-JSON, …) — callers must treat
 * `undefined` as "keep the user's config".
 */
export async function probeDaemonCdpStatus(
  env: Readonly<NodeJS.ProcessEnv>,
  fetchImpl: typeof fetch = fetch,
): Promise<CdpStatusResponse | undefined> {
  const url = `${resolveDaemonUrl(env)}/cdp/status`;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as CdpStatusResponse;
    if (typeof body !== 'object' || body === null) return undefined;
    return body;
  } catch {
    return undefined;
  }
}

/** The `/cdp` WS endpoint a rerouted adapter should dial. */
export function cdpWsEndpointFor(env: Readonly<NodeJS.ProcessEnv>): string {
  const base = resolveDaemonUrl(env);
  const wsBase = base.replace(/^https?:/i, (scheme) =>
    scheme.toLowerCase() === 'https:' ? 'wss:' : 'ws:',
  );
  return `${wsBase}/cdp`;
}

/**
 * If a usable shared Chrome bridge is live on the local daemon, reroute every
 * `--autoConnect` chrome-devtools server in the session's MCP map to dial the
 * daemon's `/cdp` tunnel instead of Chrome. Mutates the Config's MCP map via
 * `setMcpServers`; safe to call before `config.initialize()`.
 *
 * Never throws: any failure leaves the user's literal config in place.
 */
export async function maybeRouteChromeDevToolsViaDaemonBridge(
  config: Config,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  log: (line: string) => void = writeStderrLineSafe,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    if (env[QWEN_CODE_SERVE_ENV] === '1') return;
    if (env[SHARED_CHROME_BRIDGE_OPT_OUT_ENV]) return;
    if (config.isSafeMode() || config.getBareMode()) return;

    const servers = config.getSettingsMcpServers();
    if (!servers) return;
    const candidates = Object.entries(servers).filter(
      ([name, cfg]) =>
        !isGatedMcpScope(cfg.scope) &&
        isAutoConnectChromeDevToolsServer(name, cfg),
    );
    if (candidates.length === 0) return;

    const status = await probeDaemonCdpStatus(env, fetchImpl);
    if (status?.usable !== true) {
      // The fallback still attaches to the user's own Chrome (login state
      // preserved) but re-triggers Chrome's per-connection consent dialog;
      // point users at the one-time-consent path instead of leaving them to
      // wonder why the dialog keeps re-appearing.
      log(
        `qwen: no usable shared Chrome bridge on the local daemon; ` +
          `'${candidates[0]![0]}' will connect to Chrome directly and ` +
          `re-trigger Chrome's "Allow remote debugging?" dialog on every ` +
          `new connection. For one-time consent, run 'qwen serve' with the ` +
          `Qwen Code Chrome extension connected (set ` +
          `${SHARED_CHROME_BRIDGE_OPT_OUT_ENV}=1 to silence this hint)`,
      );
      return;
    }

    const wsEndpoint = cdpWsEndpointFor(env);
    const next = { ...servers };
    for (const [name, cfg] of candidates) {
      const rewritten: MCPServerConfig = {
        ...cfg,
        args: rewriteToWsEndpoint(
          (cfg as { args?: unknown[] }).args ?? [],
          wsEndpoint,
        ),
      };
      next[name] = rewritten;
      log(
        `qwen: routed MCP server '${name}' through the daemon's shared Chrome ` +
          `bridge (${wsEndpoint}) to avoid Chrome's per-session remote-debugging ` +
          `consent dialog; set ${SHARED_CHROME_BRIDGE_OPT_OUT_ENV}=1 to disable`,
      );
    }
    config.setMcpServers(next);
  } catch (err) {
    // Fail-open: the reroute is an optimization, never a boot dependency.
    log(
      `qwen: shared Chrome bridge reroute skipped: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
