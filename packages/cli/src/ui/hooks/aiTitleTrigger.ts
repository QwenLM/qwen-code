/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AiTitleCheckOptions {
  allowOverwriteAiTitle?: boolean;
}

export interface PendingAiTitleCadence {
  pendingPromptCount: number | null;
  aiTitleOptionsForTurn: AiTitleCheckOptions | null;
}

/**
 * Starts local title generation from the first unresolved human prompt.
 * A failed generation resets the committed count so the next meaningful
 * prompt can retry without overwriting a title that already exists.
 */
export function getAiTitleCheckOptionsForHumanPromptCount(
  promptCount: number,
): AiTitleCheckOptions | null {
  if (promptCount === 1) {
    return { allowOverwriteAiTitle: false };
  }
  return null;
}

export function planAiTitleCadenceForTurn(
  currentPromptCount: number,
  shouldCountTowardsAiTitleCadence: boolean,
): PendingAiTitleCadence {
  if (!shouldCountTowardsAiTitleCadence) {
    return {
      pendingPromptCount: null,
      aiTitleOptionsForTurn: null,
    };
  }

  const pendingPromptCount = currentPromptCount + 1;
  return {
    pendingPromptCount,
    aiTitleOptionsForTurn:
      getAiTitleCheckOptionsForHumanPromptCount(pendingPromptCount),
  };
}

export function commitAiTitleCadenceForTurn(
  pendingPromptCount: number | null,
  isSuccessfulTurn: boolean,
): number | null {
  if (!isSuccessfulTurn || pendingPromptCount === null) {
    return null;
  }

  return pendingPromptCount;
}
