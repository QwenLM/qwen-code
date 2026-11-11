/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  TurnRunStartInput,
  TurnHookModule,
  TurnRunEndInput,
} from '../core/turn-hooks.js';
import type { TaskTrigger } from '../core/task-trigger.js';
import type { PendingCronFire } from './cron-fire-registry.js';
import type { CronManager } from './cronManager.js';

type CronTurnManager = Pick<
  CronManager,
  | 'claimPendingFires'
  | 'markUserActivity'
  | 'addTaskCredits'
  | 'addWakeupCredits'
>;

/** 每次 query 独立持有领取记录，通过同步生命周期 hook 接入 Cron 业务。 */
export class CronTurn {
  private claimedFires: readonly PendingCronFire[] = [];

  readonly turnHookModule: TurnHookModule = {
    id: 'cron',
    register: (on) => {
      on('turn.run.start', (_context, input, next) => {
        const trigger = this.prepare(input);
        return { ...next(), trigger };
      });
      on('turn.step.result', (_context, _input, next) => next());
      on('turn.run.end', (_context, input, next) => {
        this.finish(input);
        return next();
      });
    },
  };

  constructor(
    private readonly getCronManager: () => CronTurnManager | undefined,
  ) {}

  /** Called after execution setup, before task_started, for main and child turns. */
  private prepare(input: TurnRunStartInput): TaskTrigger {
    this.claimedFires =
      this.getCronManager()?.claimPendingFires(input.promptText) ?? [];
    const scheduled = this.claimedFires.length > 0;
    const trigger = input.isSubagent
      ? 'subagent'
      : input.isWorkflow
        ? 'workflow'
        : scheduled
          ? 'scheduled'
          : (input.trigger ?? 'unknown');
    // Source labels do not prove human presence; workflow turns can be human too.
    if (!scheduled && !input.isSubagent && !input.isRemoteWorker) {
      this.getCronManager()?.markUserActivity();
    }
    return trigger;
  }

  /** Called once after task_ended, at the same boundary as credit accounting. */
  private finish(params: TurnRunEndInput): void {
    const claimedCronFires = this.claimedFires;
    if (claimedCronFires.length === 0) return;
    const cronManager = this.getCronManager();
    if (!cronManager) return;
    // The turn's cost, split across the fires that shared it. A task's own
    // history has no second chance to divide, so it stores the share.
    const creditsPerFire =
      params.statistics.totalCredits > 0
        ? params.statistics.totalCredits / claimedCronFires.length
        : undefined;
    if (creditsPerFire === undefined) return;
    // Charge the run against whichever allowance governs it. A dynamic wakeup
    // is not a CronTask - it lives in the session's cron manager - so it has
    // its own track, but both are charged from this one place so the two
    // cannot drift apart. Both tracks are per session: charging through
    // anything shared would let one session's turn spend another's budget.
    for (const claimed of claimedCronFires) {
      if (claimed.isWakeup) {
        cronManager.addWakeupCredits(creditsPerFire);
      } else if (claimed.taskId !== undefined) {
        void cronManager.addTaskCredits(claimed.taskId, creditsPerFire).catch(() => {
          // Suppress - accounting the user reads must not fail a turn.
        });
      }
    }
  }
}
