/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { persistSessionUsage } from '@qwen-code/qwen-code-core/services/usageHistoryService.js';
import { uiTelemetryService } from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';

function persistLiveUsage(config: Config, sessionId: string): void {
  try {
    const metrics = uiTelemetryService.getLiveMetrics();
    const hasActivity = Object.values(metrics.models).some(
      (m) => m.api.totalRequests > 0,
    );
    if (!hasActivity) return;
    persistSessionUsage({
      sessionId,
      startTime: uiTelemetryService.getSessionStartTime(),
      endTime: new Date(),
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
