/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildTimeline } from './buildTimeline';
import type { Trajectory } from './types';

export interface TrajectorySummary {
  turnCount: number;
  requestCount: number;
  toolCount: number;
  requestFailures: number;
  toolFailures: number;
  mainRequestMs?: number;
  elapsedMs?: number;
  activeMs?: number;
  plottedCount: number;
  missingStartCount: number;
  missingTimingCount: number;
}

export function summarizeTrajectory(trajectory: Trajectory): TrajectorySummary {
  const summary: TrajectorySummary = {
    turnCount: trajectory.turns.length,
    requestCount: 0,
    toolCount: 0,
    requestFailures: 0,
    toolFailures: 0,
    plottedCount: 0,
    missingStartCount: 0,
    missingTimingCount: 0,
  };
  for (const row of trajectory.rows) {
    if (row.kind === 'request') {
      summary.requestCount++;
      if (row.status === 'error') summary.requestFailures++;
      if (row.depth === 0)
        summary.mainRequestMs =
          (summary.mainRequestMs ?? 0) + row.timing.durationMs;
    } else if (row.kind === 'tool') {
      summary.toolCount++;
      const status = row.toolStatus ?? row.block.status;
      if (status === 'error' || status === 'failed') summary.toolFailures++;
      if (row.timing === undefined) {
        summary.missingTimingCount++;
        continue;
      }
    } else {
      continue;
    }
    if (row.timing?.startedAt === undefined) summary.missingStartCount++;
    else summary.plottedCount++;
  }
  const timeline = buildTimeline(trajectory, { mode: 'clock' });
  if (timeline) {
    summary.elapsedMs = timeline.total;
    summary.activeMs = timeline.activeMs;
  }
  return summary;
}
