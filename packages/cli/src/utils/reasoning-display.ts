/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from '@qwen-code/qwen-code-core/core/reasoning-effort.js';
import type { SubscriptionThinkingStrength } from '@qwen-code/qwen-code-core/qwen/subscription-models.js';

export function formatReasoningEffortBudget(
  effort: ReasoningEffort,
  thinkingStrength?: SubscriptionThinkingStrength,
): string | undefined {
  const budget = thinkingStrength?.find(
    (entry) => entry.level === effort,
  )?.budget_tokens;
  return budget === undefined
    ? undefined
    : `${budget.toLocaleString('en-US')} tokens`;
}
