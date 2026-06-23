/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Daemon discovery: probe `GET /health` to decide whether a local `qwen serve`
 * daemon is reachable before the side panel tries to open a session. When it's
 * not, the UI shows a "start `qwen serve`" hint instead of a broken chat.
 */

import type { DaemonConfig } from './config.js';

export type DaemonHealth =
  | { reachable: true; status: string }
  | { reachable: false; error: string };

/** Probe the daemon's `/health` endpoint with a short timeout. */
export async function checkDaemonHealth(
  config: DaemonConfig,
  timeoutMs = 2_000,
): Promise<DaemonHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/health`, {
      headers: config.token
        ? { Authorization: `Bearer ${config.token}` }
        : {},
      signal: controller.signal,
    });
    if (!res.ok) {
      return { reachable: false, error: `health returned ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return { reachable: true, status: body?.status ?? 'ok' };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
