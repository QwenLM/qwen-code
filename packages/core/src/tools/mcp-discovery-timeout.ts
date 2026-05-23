/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '../config/config.js';

/**
 * F2 (#4175 commit 6 review fix — wenshao W43 / W44 / gpt-5.5 W25):
 * shared discovery-timeout primitives used by BOTH
 * `McpTransportPool.spawnEntry` (initial connect/discover) AND
 * `PoolEntry.doRestart` (manual restart). Pre-fix only spawn was
 * bounded; a hung restart blocked `restartInFlight` indefinitely
 * and the HTTP route handler never returned.
 *
 * Mirrors `McpClientManager.runWithDiscoveryTimeout` /
 * `discoveryTimeoutFor` exactly (stdio default 30s, remote 5s,
 * per-server `discoveryTimeoutMs` override clamped to [100ms, 300s])
 * — same wall-clock contract regardless of whether a server's
 * discovery happens in pool mode or legacy per-session mode.
 */

/** Hard floor for the per-server `discoveryTimeoutMs` override. */
const MIN_DISCOVERY_TIMEOUT_MS = 100;
/** Hard ceiling for the per-server `discoveryTimeoutMs` override. */
const MAX_DISCOVERY_TIMEOUT_MS = 300_000;
/** stdio default — local subprocesses get more leeway for cold start. */
const STDIO_DEFAULT_TIMEOUT_MS = 30_000;
/** Remote default — networked transports carry latency risk. */
const REMOTE_DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Resolve the discovery timeout for a server config. stdio defaults
 * to 30s, remote (HTTP / SSE / WebSocket) defaults to 5s, per-server
 * `discoveryTimeoutMs` override is honored when present (clamped to
 * [100ms, 300s]).
 */
export function discoveryTimeoutFor(cfg: MCPServerConfig): number {
  const override = cfg.discoveryTimeoutMs;
  if (override !== undefined && Number.isFinite(override)) {
    return Math.max(
      MIN_DISCOVERY_TIMEOUT_MS,
      Math.min(override, MAX_DISCOVERY_TIMEOUT_MS),
    );
  }
  const isRemote = !!(cfg.httpUrl || cfg.url || cfg.tcp);
  return isRemote ? REMOTE_DEFAULT_TIMEOUT_MS : STDIO_DEFAULT_TIMEOUT_MS;
}

/**
 * Race `task` against a wall-clock timer. The background `task`
 * promise is NOT cancelled on timeout — Node's Promise model can't
 * cancel an in-flight `await`. Instead, the caller's catch block
 * runs `forceShutdown`/`sweepAndDisconnect` which closes the
 * transport, racing the disconnect ahead of any silent tool
 * registration the slow server might be midway through. Same
 * approach `McpClientManager.runWithDiscoveryTimeout` uses for the
 * same race.
 *
 * Returns the `task` value on success; rejects with a
 * `Timed out after Nms: <label>` Error if the timer fires first.
 */
export function runWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms: ${label}. The MCP server may be ` +
            `hung; pool will roll back the spawn/restart and free its budget slot.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    task.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
