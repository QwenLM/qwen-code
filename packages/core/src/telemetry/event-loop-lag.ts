/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface EventLoopLagSnapshot {
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface EventLoopLagMonitor {
  snapshot(): EventLoopLagSnapshot;
  dispose(): void;
}

export interface EventLoopLagMonitorOptions {
  resolutionMs?: number;
  stallThresholdMs?: number;
  onNewMaxStall?: (maxMs: number) => void;
}

const DEFAULT_RESOLUTION_MS = 20;
const DEFAULT_STALL_THRESHOLD_MS = 1_000;
const NS_PER_MS = 1_000_000;

export function startEventLoopLagMonitor(
  options: EventLoopLagMonitorOptions = {},
): EventLoopLagMonitor {
  const resolutionMs = positiveFiniteOrDefault(
    options.resolutionMs,
    DEFAULT_RESOLUTION_MS,
  );
  const stallThresholdMs = positiveFiniteOrDefault(
    options.stallThresholdMs,
    DEFAULT_STALL_THRESHOLD_MS,
  );
  const histogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();

  let disposed = false;
  let lastReportedMaxMs = 0;
  const readMaxMs = () => nsToMs(histogram.max);
  const checkForNewMaxStall = () => {
    if (disposed || !options.onNewMaxStall) return;
    const maxMs = readMaxMs();
    if (maxMs >= stallThresholdMs && maxMs > lastReportedMaxMs) {
      lastReportedMaxMs = maxMs;
      try {
        options.onNewMaxStall(maxMs);
      } catch {
        /* event loop monitoring must not break the process */
      }
    }
  };
  const interval =
    options.onNewMaxStall !== undefined
      ? setInterval(checkForNewMaxStall, resolutionMs)
      : undefined;
  interval?.unref();

  return {
    snapshot(): EventLoopLagSnapshot {
      return {
        meanMs: nsToMs(histogram.mean),
        p50Ms: nsToMs(histogram.percentile(50)),
        p99Ms: nsToMs(histogram.percentile(99)),
        maxMs: readMaxMs(),
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (interval) {
        clearInterval(interval);
      }
      histogram.disable();
    },
  };
}

function nsToMs(value: number): number {
  return Number.isFinite(value) ? value / NS_PER_MS : 0;
}

function positiveFiniteOrDefault(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
