/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../provider/model/model.js';
import type { ModelPurpose } from '../provider/model/modelSelectContext.js';
import type { Attachment } from '../attachments/types.js';
import {
  AdditionalTurnsAttachment,
  RemainingTurnsAttachment,
  TurnBudgetExhaustedAttachment,
  TurnBudgetGuidanceAttachment,
} from '../attachments/models/turn-attachments.js';
import { resolveDynamicTurnLimits } from '../config-service/features/dynamicTurnBudget.js';
import { createDynamicTurnBudget } from './turn-budget.js';

/** Resolves one query's policy; subsequent reminders depend only on turns used. */
export async function resolveTurnBudgetReminders(options: {
  model: Model;
  purpose: ModelPurpose;
  isSubagent?: boolean;
  maxTurns?: number;
  signal?: AbortSignal;
}): Promise<((turnsUsed: number) => readonly Attachment[]) | undefined> {
  if (options.isSubagent || options.purpose !== 'main') return undefined;
  const limits = await resolveDynamicTurnLimits(options.model, options.signal);
  const budget = limits && createDynamicTurnBudget(limits, options.maxTurns);
  if (!budget) return undefined;

  return (turnsUsed) => {
    if (turnsUsed === 0) {
      return [
        new TurnBudgetGuidanceAttachment({ type: 'turn_budget_guidance' }),
      ];
    }
    const snapshot = budget.getSnapshot(turnsUsed);
    if (snapshot.exhausted) {
      return [
        new TurnBudgetExhaustedAttachment({ type: 'turn_budget_exhausted' }),
      ];
    }
    return [
      ...(snapshot.additionalTurns === undefined
        ? []
        : [
            new AdditionalTurnsAttachment({
              type: 'additional_turns',
              additionalTurns: snapshot.additionalTurns,
            }),
          ]),
      new RemainingTurnsAttachment({
        type: 'remaining_turns',
        remainingTurns: snapshot.remainingTurns,
      }),
    ];
  };
}
