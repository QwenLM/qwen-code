/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tip selection algorithm — picks the most relevant tip to show.
 */

import type { TipHistory } from './tipHistory.js';
import type { ContextualTip, TipContext, TipTrigger } from './tipRegistry.js';

/**
 * Select the best tip to show for a given trigger event.
 *
 * Algorithm:
 * 1. Filter by trigger type
 * 2. Filter by isRelevant(context)
 * 3. Filter by cooldown
 * 4. Sort by priority desc, then LRU (least recently shown first)
 * 5. Return first match
 */
export function selectTip(
  trigger: TipTrigger,
  context: TipContext,
  tips: ContextualTip[],
  history: TipHistory,
): ContextualTip | null {
  const candidates = tips
    .filter((tip) => tip.trigger === trigger)
    .filter((tip) => {
      try {
        return tip.isRelevant(context);
      } catch {
        return false;
      }
    })
    .filter((tip) =>
      history.isCooledDown(
        tip.id,
        tip.cooldownPrompts,
        context.sessionPromptCount,
      ),
    );

  if (candidates.length === 0) return null;

  // Sort by priority desc, then by last-shown asc (LRU)
  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return history.getLastShown(a.id) - history.getLastShown(b.id);
  });

  return candidates[0] ?? null;
}
