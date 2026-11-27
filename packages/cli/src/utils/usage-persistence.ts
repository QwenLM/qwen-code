/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  hasRunActivity,
  persistSessionUsage,
} from '@qwen-code/qwen-code-core/services/usageHistoryService.js';
import { uiTelemetryService } from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';

function persistLiveUsage(config: Config, sessionId: string): void {
  try {
    const metrics = uiTelemetryService.getLiveMetrics();
    if (!hasRunActivity(metrics)) return;
    const startTime = uiTelemetryService.getRunStartTime();
    const endTime = new Date(Math.max(startTime.getTime(), Date.now()));
    persistSessionUsage({
      sessionId,
      startTime,
      endTime,
      project: config.getProjectRoot(),
      metrics,
    });
  } catch {
    // Best-effort — usage must not block a session transition or shutdown.
  }
}

/**
 * The exit path writes only this run's counters: replayed history belongs to
 * the run that originally spent it.
 */
export function persistRunUsageOnExit(config: Config): void {
  persistLiveUsage(config, config.getSessionId());
}

/**
 * Commits the outgoing run before a successful /resume or /branch. Reset only
 * the live bucket: the incoming transcript has already been replayed into the
 * display aggregate and must remain visible.
 */
export function flushRunUsageOnSessionSwap(
  config: Config,
  outgoingSessionId: string,
): void {
  persistLiveUsage(config, outgoingSessionId);
  uiTelemetryService.resetLiveMetrics();
}

/**
 * Commits a single daemon/ACP session's own live spend when that session is
 * closed, retired, or torn down on daemon shutdown. Must run before
 * `uiTelemetryService.removeSession(sessionId)` discards the per-session live
 * bucket. Replayed/restored history is excluded by `getLiveMetricsForSession`.
 */
export function persistSessionUsageOnClose(
  config: Config,
  sessionId: string,
): void {
  try {
    const metrics = uiTelemetryService.getLiveMetricsForSession(sessionId);
    if (!metrics || !hasRunActivity(metrics)) return;
    const startTime =
      uiTelemetryService.getRunStartTimeForSession(sessionId) ?? new Date();
    const endTime = new Date(Math.max(startTime.getTime(), Date.now()));
    const project = config.getProjectRoot?.();
    if (!project) return;
    persistSessionUsage({
      sessionId,
      startTime,
      endTime,
      project,
      metrics,
    });
  } catch {
    // Best-effort — usage must not block session teardown or shutdown.
  }
}
