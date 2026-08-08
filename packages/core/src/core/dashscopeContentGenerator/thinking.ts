/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../contentGenerator.js';
import {
  clampReasoningEffort,
  type ReasoningEffort,
} from '../reasoning-effort.js';
import { createDebugLogger } from '../../utils/debugLogger.js';

const debugLogger = createDebugLogger('DASHSCOPE');

/**
 * `'none'` is the canonical wire off-switch (live-verified, see
 * api-contract.md §5) and is deliberately not part of the shared
 * {@link ReasoningEffort} ladder, which only enumerates the
 * user-selectable tiers.
 */
type DashScopeReasoningEffort = ReasoningEffort | 'none';

export interface ResolvedThinking {
  /** `{}` or exactly one of `{reasoning_effort}` / `{thinking_budget}`. */
  params: Record<string, unknown>;
  /**
   * When `true`, the converter must downgrade a forced `tool_choice` to
   * `'auto'` — the API 400s on a forced choice while thinking is on, and
   * `thinkingMandatory` forbids turning thinking off to route around it.
   */
  dropForcedToolChoice: boolean;
}

export interface ResolveThinkingParametersInput {
  reasoning: ContentGeneratorConfig['reasoning'];
  thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean };
  /**
   * When `true`, the active model rejects `enable_thinking: false` (or, by
   * extension, any request that would leave thinking off) with an HTTP 400.
   */
  thinkingMandatory?: boolean;
  /**
   * Raw provider passthrough. `enable_thinking` / `reasoning_effort` /
   * `thinking_budget` are intercepted here and never reach the assembled
   * `parameters` object verbatim.
   */
  extraBody?: Record<string, unknown>;
  supportedEfforts?: readonly ReasoningEffort[];
  /** `true` for tool_choice `'required'` or a named-function object form. */
  forcedToolChoice: boolean;
}

let warnedEffortAndBudgetConflict = false;

/**
 * Single source of truth for the native DashScope thinking knobs. Emits at
 * most one of `reasoning_effort` / `thinking_budget` and never emits
 * `enable_thinking` (see api-contract.md §5 for the live-verified 400s this
 * avoids).
 */
export function resolveThinkingParameters(
  input: ResolveThinkingParametersInput,
): ResolvedThinking {
  const underlying = resolveUnderlyingThinkingParams(input);

  if (input.forcedToolChoice) {
    if (input.thinkingMandatory) {
      return { params: underlying, dropForcedToolChoice: true };
    }
    return {
      params: { reasoning_effort: 'none' satisfies DashScopeReasoningEffort },
      dropForcedToolChoice: false,
    };
  }

  return { params: underlying, dropForcedToolChoice: false };
}

function resolveUnderlyingThinkingParams(
  input: ResolveThinkingParametersInput,
): Record<string, unknown> {
  const { reasoning, thinkingConfig, thinkingMandatory, extraBody } = input;

  if (reasoning === false || thinkingConfig?.includeThoughts === false) {
    return thinkingMandatory
      ? {}
      : { reasoning_effort: 'none' satisfies DashScopeReasoningEffort };
  }

  if (extraBody?.['enable_thinking'] === false && !thinkingMandatory) {
    return { reasoning_effort: 'none' satisfies DashScopeReasoningEffort };
  }

  const extraEffort = extraBody?.['reasoning_effort'];
  const effort =
    typeof extraEffort === 'string'
      ? (extraEffort as DashScopeReasoningEffort)
      : reasoning?.effort === undefined
        ? undefined
        : clampReasoningEffort(reasoning.effort, input.supportedEfforts);

  const extraBudget = extraBody?.['thinking_budget'];
  const budget =
    typeof extraBudget === 'number'
      ? extraBudget
      : typeof reasoning?.budget_tokens === 'number'
        ? reasoning.budget_tokens
        : thinkingConfig?.thinkingBudget;

  if (effort !== undefined && !(thinkingMandatory && effort === 'none')) {
    if (budget !== undefined && !warnedEffortAndBudgetConflict) {
      warnedEffortAndBudgetConflict = true;
      debugLogger.warn(
        'resolveThinkingParameters: both a reasoning effort and a thinking ' +
          'budget were configured; reasoning_effort wins and thinking_budget ' +
          'is dropped.',
      );
    }
    return { reasoning_effort: effort };
  }

  if (typeof budget === 'number' && budget > 0) {
    return { thinking_budget: budget };
  }

  return {};
}
