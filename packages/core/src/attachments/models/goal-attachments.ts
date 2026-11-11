/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { wrapUntrustedObjective } from '../../goal/template-renderer.js';
import { systemReminder } from '../message-helpers.js';
import { isUnlimitedGoalTurns } from '../../goal/types.js';

/**
 * Active goal state reminder.
 *
 * Goal state is injected through the message layer (as a <system-reminder>)
 * rather than the system prompt: the turn counter changes every turn, so
 * folding it into the system prompt would invalidate the prompt cache on
 * every single turn of a long goal loop.
 */
export class GoalStateAttachment extends BaseAttachment {
  readonly type = 'goal_state' as const;
  /** The goal objective. */
  declare objective: string;
  /** Interaction turns already consumed. */
  declare turnsUsed: number;
  /** Bounded hard turn ceiling or -1 for unlimited. */
  declare maxTurns?: number;
  /** Wall-clock seconds spent on the goal so far. */
  declare timeUsedSeconds: number;
  /** ISO timestamp when the reminder was generated. */
  declare currentTime: string;

  constructor(data: AttachmentData<GoalStateAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    const budget =
      this.maxTurns === undefined
        ? `${this.turnsUsed} turns used`
        : isUnlimitedGoalTurns(this.maxTurns)
          ? `${this.turnsUsed}/unlimited turns used`
          : `${this.turnsUsed}/${this.maxTurns} turns used` +
            (this.turnsUsed >= this.maxTurns
              ? ' (limit reached — the goal will be auto-paused)'
              : '');
    const limitNote =
      this.maxTurns !== undefined && !isUnlimitedGoalTurns(this.maxTurns)
        ? ` The goal is auto-paused once ${this.maxTurns} turns are used; only the user can grant more turns (/goal resume).`
        : '';

    return [
      systemReminder(
        `An active goal is registered in the goal system — do NOT create it again.\n` +
          `${wrapUntrustedObjective(this.objective)}\n` +
          `Progress: ${budget} | time used: ${this.timeUsedSeconds}s | current time: ${this.currentTime}.${limitNote}\n` +
          `Keep working towards this goal and call update_goal with status "complete" once it is fully achieved.`,
      ),
    ];
  }
}
