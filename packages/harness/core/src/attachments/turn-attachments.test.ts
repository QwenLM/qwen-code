/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { restoreAttachment } from './transcript-conversion.js';
import {
  TurnBudgetGuidanceAttachment,
  TurnBudgetExhaustedAttachment,
  TURN_BUDGET_EXHAUSTED,
  RemainingTurnsAttachment,
  AdditionalTurnsAttachment,
  TURN_BUDGET_GUIDANCE,
} from './models/turn-attachments.js';

describe('turn budget transcript reminders', () => {
  it('preserves completion safeguards without a low-budget wrap-up cue', () => {
    expect(TURN_BUDGET_GUIDANCE).toContain(
      'The remaining count is not a reason to stop early or to cut exploration the task needs. Never end a turn early because the budget is shrinking, and never report work as complete when it is not.',
    );
    expect(TURN_BUDGET_GUIDANCE).not.toContain('When few turns remain');
  });

  it.each([
    [new TurnBudgetExhaustedAttachment({ type: 'turn_budget_exhausted' }), TURN_BUDGET_EXHAUSTED],
    [
      new TurnBudgetGuidanceAttachment({ type: 'turn_budget_guidance' }),
      TURN_BUDGET_GUIDANCE,
    ],
    [
      new RemainingTurnsAttachment({
        type: 'remaining_turns',
        remainingTurns: 13,
      }),
      'You have 13 turns left to complete the task.',
    ],
    [
      new AdditionalTurnsAttachment({
        type: 'additional_turns',
        additionalTurns: 10,
      }),
      'You have used up all turns but have not yet completed the task. You are granted an additional 10 turns to continue and complete the task.',
    ],
  ] as const)(
    'restores %j as a user-role system reminder',
    (attachment, text) => {
      const restored = restoreAttachment(
        JSON.parse(JSON.stringify(attachment.toTranscript())),
      );
      expect(restored?.toUserMessages()).toEqual([
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `<system-reminder>\n${text}\n</system-reminder>`,
            },
          ],
        },
      ]);
    },
  );
});
