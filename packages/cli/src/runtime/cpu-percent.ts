/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Windowed CPU utilization percent from two `process.cpuUsage()` samples over
 * `elapsedMs`, normalized by core count and clamped to [0,100]. Returns 0 when
 * either sample is null or the window is non-positive, so a failed read adds
 * no delta and callers that only advance successful baselines cannot create a
 * phantom spike.
 */
export function computeCpuPercent(
  prev: NodeJS.CpuUsage | null,
  cur: NodeJS.CpuUsage | null,
  elapsedMs: number,
  coreCount: number,
): number {
  if (!prev || !cur || elapsedMs <= 0 || coreCount <= 0) return 0;
  const cpuUs = cur.user - prev.user + (cur.system - prev.system);
  return Math.min(
    100,
    Math.max(0, ((cpuUs / (elapsedMs * 1000)) * 100) / coreCount),
  );
}
