/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Provider-specific output fields that take the place of `max_tokens`. */
export const PROVIDER_OUTPUT_BUDGET_KEYS = [
  'max_completion_tokens',
  'max_new_tokens',
] as const;

/** The positive output budget carried by a Chat request or its overrides. */
export function getWireOutputBudget(request: object): number | undefined {
  const wire = request as Record<string, unknown>;
  const maxTokens = wire['max_tokens'];
  if (typeof maxTokens === 'number' && maxTokens > 0) return maxTokens;
  for (const key of PROVIDER_OUTPUT_BUDGET_KEYS) {
    const value = wire[key];
    if (typeof value === 'number' && value > 0) return value;
  }
  return undefined;
}
