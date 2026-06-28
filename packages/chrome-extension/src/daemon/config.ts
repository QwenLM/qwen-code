/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Daemon connection config for the daemon-direct architecture (issue #5626).
 *
 * The extension talks directly to a local `qwen serve` daemon instead of a
 * native messaging host. Loopback binds are auth-free so `token` is optional;
 * both fields are overridable via `chrome.storage.local`.
 */

export interface DaemonConfig {
  /** Daemon base URL, e.g. `http://127.0.0.1:4170`. */
  baseUrl: string;
  /** Bearer token; omitted for loopback (auth-free) daemons. */
  token?: string;
}

/** `qwen serve`'s default bind (see `qwen serve --port`, default 4170). */
export const DEFAULT_DAEMON_BASE_URL = 'http://127.0.0.1:4170';

const STORAGE_KEY = 'qwen.daemon';

/* global console */

/** Whether a URL points at the local loopback interface. */
export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Read the daemon config, falling back to the loopback default.
 *
 * The bearer token rides every `/acp` WS handshake and `/health` probe, and
 * background-context fetch/WebSocket are NOT constrained by `host_permissions`.
 * So a tampered `chrome.storage.local.baseUrl` pointing at a remote host would
 * exfiltrate the token on every poll. Fail closed: ignore any non-loopback
 * `baseUrl` (and its token) and use the loopback default instead.
 */
export async function getDaemonConfig(): Promise<DaemonConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const cfg = (stored?.[STORAGE_KEY] ?? {}) as Partial<DaemonConfig>;
  const baseUrl = cfg.baseUrl?.trim() || DEFAULT_DAEMON_BASE_URL;
  if (!isLoopbackUrl(baseUrl)) {
    console.warn('[DaemonConfig] ignoring non-loopback baseUrl:', baseUrl);
    return { baseUrl: DEFAULT_DAEMON_BASE_URL, token: undefined };
  }
  return { baseUrl, token: cfg.token?.trim() || undefined };
}

/** Persist a partial daemon config override. */
export async function setDaemonConfig(
  config: Partial<DaemonConfig>,
): Promise<void> {
  const current = await getDaemonConfig();
  await chrome.storage.local.set({
    [STORAGE_KEY]: { ...current, ...config },
  });
}
