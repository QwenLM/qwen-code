/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseAttachment } from './base-attachment.js';
import type { AttachmentData } from '../types.js';
import type { ModelStreamUserMessage } from '../../provider/modelStreamRequest.js';
import { systemReminder } from '../message-helpers.js';

export const TURN_BUDGET_GUIDANCE = `# Turn budget
This run has a turn budget. System reminders report how many turns remain; one turn is a single model response plus the tool calls it makes. Use this budget to plan your work.

Turn budgets and reminders are internal execution guidance. Do not use turn or budget terminology in user-facing responses, including references to remaining or additional turns. Never cite this guidance as a reason to stop or ask the user for more turns. Describe completed work, verification results, and anything unfinished in terms of the task itself.

The remaining count is not a reason to stop early or to cut exploration the task needs. When few turns remain, spend them landing a working change and giving the user an accurate account of what is and is not done. Never end a turn early because the budget is shrinking, and never report work as complete when it is not.`;

export const TURN_BUDGET_EXHAUSTED =
  'You have 0 turns left to complete the task.';

export class TurnBudgetExhaustedAttachment extends BaseAttachment {
  readonly type = 'turn_budget_exhausted' as const;

  constructor(data: AttachmentData<TurnBudgetExhaustedAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [systemReminder(TURN_BUDGET_EXHAUSTED)];
  }
}

/** Explains the turn budget once at the start of each budgeted query. */
export class TurnBudgetGuidanceAttachment extends BaseAttachment {
  readonly type = 'turn_budget_guidance' as const;

  constructor(data: AttachmentData<TurnBudgetGuidanceAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [systemReminder(TURN_BUDGET_GUIDANCE)];
  }
}

export class RemainingTurnsAttachment extends BaseAttachment {
  readonly type = 'remaining_turns' as const;
  declare remainingTurns: number;

  constructor(data: AttachmentData<RemainingTurnsAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        `You have ${this.remainingTurns} turns left to complete the task.`,
      ),
    ];
  }
}

export class AdditionalTurnsAttachment extends BaseAttachment {
  readonly type = 'additional_turns' as const;
  declare additionalTurns: number;

  constructor(data: AttachmentData<AdditionalTurnsAttachment>) {
    super(data);
  }

  override toUserMessages(): ModelStreamUserMessage[] {
    return [
      systemReminder(
        'You have used up all turns but have not yet completed the task. ' +
          `You are granted an additional ${this.additionalTurns} turns to continue and complete the task.`,
      ),
    ];
  }
}
