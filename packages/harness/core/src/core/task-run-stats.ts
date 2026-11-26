/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelRequestRunnerEvent } from '../model-request/types.js';
import type {
  TurnHookModule,
  TurnStepResult,
  TurnStepStream,
} from './turn-hooks.js';

/** Credit totals a finished turn hands to its consumers. */
export interface TaskStatisticsSnapshot {
  readonly totalCredits: number;
  readonly totalOriginalCredits: number;
}

/**
 * Per-query run bookkeeping: the credits a
 * turn accrued (cron splits them across the fires it served) and the doom-loop
 * counters the repeated-call guard reports into.
 */
export class TaskRunStatsAccumulator {
  readonly turnHookModule: TurnHookModule = {
    id: 'task-run-stats',
    register: (on) => {
      on('turn.step', (_context, input, next) =>
        this.observeModelStep(next(input)),
      );
    },
  };

  loopDetected = false;
  approvalCount = 0;
  approvalRejectedCount = 0;

  private totalCredits = 0;
  private totalOriginalCredits = 0;

  private async *observeModelStep(stream: TurnStepStream): TurnStepStream {
    let result: TurnStepResult | undefined;
    try {
      while (true) {
        const item: IteratorResult<ModelRequestRunnerEvent, TurnStepResult> =
          await stream.next();
        if (item.done) {
          result = item.value;
          break;
        }
        yield item.value;
      }
    } finally {
      if (result === undefined) await stream.return(undefined as never);
    }
    this.recordUsage(result.usage);
    return result;
  }

  private recordUsage(usage: TurnStepResult['usage']): void {
    if (!usage) return;
    if (typeof usage.credits === 'number' && Number.isFinite(usage.credits)) {
      this.totalCredits += usage.credits;
    }
    if (
      typeof usage.original_credits === 'number' &&
      Number.isFinite(usage.original_credits)
    ) {
      this.totalOriginalCredits += usage.original_credits;
    }
  }

  statisticsSnapshot(): TaskStatisticsSnapshot {
    return {
      totalCredits: this.totalCredits,
      totalOriginalCredits: this.totalOriginalCredits,
    };
  }
}
