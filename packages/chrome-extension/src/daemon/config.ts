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

/** Read the daemon config, falling back to the loopback default. */
export async function getDaemonConfig(): Promise<DaemonConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const cfg = (stored?.[STORAGE_KEY] ?? {}) as Partial<DaemonConfig>;
  return {
    baseUrl: cfg.baseUrl?.trim() || DEFAULT_DAEMON_BASE_URL,
    token: cfg.token?.trim() || undefined,
  };
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
