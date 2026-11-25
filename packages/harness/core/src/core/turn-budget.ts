/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TurnBudgetSnapshot {
  remainingTurns: number;
  additionalTurns?: number;
  exhausted?: true;
}

/** Limits are validated, strictly increasing cumulative ceilings from QCS. */
export function createDynamicTurnBudget(
  limits: readonly number[],
  hardLimit?: number,
) {
  // A caller's hard limit still controls whether any model request may start.
  if (hardLimit !== undefined && hardLimit <= 0) return undefined;
  const finalLimit = Math.min(limits[limits.length - 1], hardLimit ?? Infinity);
  const stages = [...limits.filter((limit) => limit < finalLimit), finalLimit];
  return {
    finalLimit,
    getSnapshot(turnsUsed: number): TurnBudgetSnapshot {
      const stage = stages.findIndex((limit) => limit > turnsUsed);
      if (stage < 0) return { remainingTurns: 0, exhausted: true };
      const previousLimit = stages[stage - 1];
      return {
        remainingTurns: stages[stage] - turnsUsed,
        ...(stage > 0 && turnsUsed === previousLimit
          ? { additionalTurns: stages[stage] - previousLimit }
          : {}),
      };
    },
  };
}
