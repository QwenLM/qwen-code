/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  persistSessionUsage,
  type SessionMetrics,
  uiTelemetryService,
} from '@qwen-code/qwen-code-core';
import { registerCleanup } from './cleanup.js';

const LIVE_USAGE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

interface SessionUsageSnapshotDeps {
  getMetrics: (sessionId: string) => SessionMetrics;
  getSessionStartTime: (sessionId: string) => Date;
  persist: typeof persistSessionUsage;
  now: () => Date;
}

interface SessionUsageSnapshotOptions {
  isPartial?: boolean;
  metrics?: SessionMetrics;
  startTime?: Date;
}

const defaultSnapshotDeps: SessionUsageSnapshotDeps = {
  getMetrics: (sessionId) => uiTelemetryService.getMetricsForSession(sessionId),
  getSessionStartTime: (sessionId) =>
    uiTelemetryService.getSessionStartTimeForSession(sessionId),
  persist: persistSessionUsage,
  now: () => new Date(),
};

function resolveSnapshotDeps(
  overrides?: Partial<SessionUsageSnapshotDeps>,
): SessionUsageSnapshotDeps {
  return { ...defaultSnapshotDeps, ...overrides };
}

export function flushSessionUsageSnapshot(
  config: Pick<Config, 'getProjectRoot' | 'getSessionId'>,
  options: SessionUsageSnapshotOptions = {},
  deps?: Partial<SessionUsageSnapshotDeps>,
): boolean {
  try {
    const snapshotDeps = resolveSnapshotDeps(deps);
    const sessionId = config.getSessionId();
    const metrics = options.metrics ?? snapshotDeps.getMetrics(sessionId);
    if (!Object.values(metrics.models).some((m) => m.api.totalRequests > 0)) {
      return false;
    }

    snapshotDeps.persist({
      sessionId,
      startTime:
        options.startTime ?? snapshotDeps.getSessionStartTime(sessionId),
      endTime: snapshotDeps.now(),
      project: config.getProjectRoot(),
      metrics,
      ...(options.isPartial ? { isPartial: true } : {}),
    });
    return true;
  } catch {
    // Best-effort — usage reporting must never affect the session lifecycle.
    return false;
  }
}

export function startSessionUsageSnapshots(
  config: Pick<Config, 'getProjectRoot' | 'getSessionId'>,
  deps?: Partial<SessionUsageSnapshotDeps>,
): void {
  const snapshotDeps = resolveSnapshotDeps(deps);
  const lastSnapshotBySession = new Map<string, string>();
  const flush = (isPartial: boolean) => {
    try {
      const sessionId = config.getSessionId();
      const metrics = snapshotDeps.getMetrics(sessionId);
      const fingerprint = JSON.stringify(metrics);
      if (isPartial && lastSnapshotBySession.get(sessionId) === fingerprint) {
        return;
      }
      if (
        flushSessionUsageSnapshot(config, { isPartial, metrics }, snapshotDeps)
      ) {
        lastSnapshotBySession.set(sessionId, fingerprint);
      }
    } catch {
      // Best-effort — retry on the next interval or during cleanup.
    }
  };
  const timer = setInterval(() => flush(true), LIVE_USAGE_FLUSH_INTERVAL_MS);
  timer.unref();

  registerCleanup(() => {
    clearInterval(timer);
    flush(false);
  });
}
