/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveThinkingParameters } from './thinking.js';
import type { ResolveThinkingParametersInput } from './thinking.js';

function baseInput(
  overrides: Partial<ResolveThinkingParametersInput> = {},
): ResolveThinkingParametersInput {
  return {
    reasoning: undefined,
    forcedToolChoice: false,
    ...overrides,
  };
}

describe('resolveThinkingParameters', () => {
  it('emits {} when nothing is configured', () => {
    const result = resolveThinkingParameters(baseInput());
    expect(result.params).toEqual({});
    expect(result.dropForcedToolChoice).toBe(false);
  });

  it('turns thinking off when reasoning is false', () => {
    const result = resolveThinkingParameters(baseInput({ reasoning: false }));
    expect(result.params).toEqual({ reasoning_effort: 'none' });
  });

  it('emits {} when reasoning is false but thinking is mandatory', () => {
    const result = resolveThinkingParameters(
      baseInput({ reasoning: false, thinkingMandatory: true }),
    );
    expect(result.params).toEqual({});
  });

  it('passes an unclamped effort tier through', () => {
    const result = resolveThinkingParameters(
      baseInput({ reasoning: { effort: 'max' } }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'max' });
  });

  it.each(['low', 'medium', 'xhigh'] as const)(
    'preserves supported effort tier %s',
    (effort) => {
      const result = resolveThinkingParameters(
        baseInput({
          reasoning: { effort },
          supportedEfforts: ['low', 'medium', 'xhigh'],
        }),
      );
      expect(result.params).toEqual({ reasoning_effort: effort });
    },
  );

  it.each(['high', 'max'] as const)(
    'clamps legacy effort tier %s to xhigh',
    (effort) => {
      const result = resolveThinkingParameters(
        baseInput({
          reasoning: { effort },
          supportedEfforts: ['low', 'medium', 'xhigh'],
        }),
      );
      expect(result.params).toEqual({ reasoning_effort: 'xhigh' });
    },
  );

  it('forces thinking off for a forced tool choice when not mandatory', () => {
    const result = resolveThinkingParameters(
      baseInput({ reasoning: { effort: 'high' }, forcedToolChoice: true }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'none' });
    expect(result.dropForcedToolChoice).toBe(false);
  });

  it('keeps the configured effort and drops the forced choice when mandatory', () => {
    const result = resolveThinkingParameters(
      baseInput({
        reasoning: { effort: 'high' },
        forcedToolChoice: true,
        thinkingMandatory: true,
      }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'high' });
    expect(result.dropForcedToolChoice).toBe(true);
  });

  it('maps a thinking budget when no effort is configured', () => {
    const result = resolveThinkingParameters(
      baseInput({ thinkingConfig: { thinkingBudget: 2048 } }),
    );
    expect(result.params).toEqual({ thinking_budget: 2048 });
  });

  it('prefers effort over a configured budget', () => {
    const result = resolveThinkingParameters(
      baseInput({
        reasoning: { effort: 'low' },
        thinkingConfig: { thinkingBudget: 2048 },
      }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'low' });
  });

  it('reads a budget from reasoning.budget_tokens too', () => {
    const result = resolveThinkingParameters(
      baseInput({ reasoning: { budget_tokens: 4096 } }),
    );
    expect(result.params).toEqual({ thinking_budget: 4096 });
  });

  it('normalizes extraBody.enable_thinking:false to reasoning_effort:none', () => {
    const result = resolveThinkingParameters(
      baseInput({ extraBody: { enable_thinking: false } }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'none' });
  });

  it.each([{ enable_thinking: false }, { reasoning_effort: 'none' }])(
    'ignores extra-body disable aliases when thinking is mandatory',
    (extraBody) => {
      const result = resolveThinkingParameters(
        baseInput({ extraBody, thinkingMandatory: true }),
      );
      expect(result.params).toEqual({});
    },
  );

  it('honors extraBody.reasoning_effort as if configured', () => {
    const result = resolveThinkingParameters(
      baseInput({ extraBody: { reasoning_effort: 'low' } }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'low' });
  });

  it('honors extraBody.thinking_budget as if configured', () => {
    const result = resolveThinkingParameters(
      baseInput({ extraBody: { thinking_budget: 1024 } }),
    );
    expect(result.params).toEqual({ thinking_budget: 1024 });
  });

  it('lets extraBody.reasoning_effort win over reasoning.effort', () => {
    const result = resolveThinkingParameters(
      baseInput({
        reasoning: { effort: 'low' },
        extraBody: { reasoning_effort: 'high' },
        supportedEfforts: ['low', 'medium', 'xhigh'],
      }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'high' });
  });

  it('turns thinking off when includeThoughts is false', () => {
    const result = resolveThinkingParameters(
      baseInput({ thinkingConfig: { includeThoughts: false } }),
    );
    expect(result.params).toEqual({ reasoning_effort: 'none' });
  });

  it('never emits enable_thinking and never emits two knobs at once', () => {
    const cases: ResolveThinkingParametersInput[] = [
      baseInput(),
      baseInput({ reasoning: false }),
      baseInput({ reasoning: false, thinkingMandatory: true }),
      baseInput({ reasoning: { effort: 'max' } }),
      baseInput({ reasoning: { effort: 'high' }, forcedToolChoice: true }),
      baseInput({
        reasoning: { effort: 'high' },
        forcedToolChoice: true,
        thinkingMandatory: true,
      }),
      baseInput({ thinkingConfig: { thinkingBudget: 2048 } }),
      baseInput({
        reasoning: { effort: 'low' },
        thinkingConfig: { thinkingBudget: 2048 },
      }),
      baseInput({ extraBody: { enable_thinking: false } }),
      baseInput({ extraBody: { reasoning_effort: 'low' } }),
    ];

    for (const input of cases) {
      const result = resolveThinkingParameters(input);
      expect(Object.keys(result.params).length).toBeLessThanOrEqual(1);
      expect(result.params['enable_thinking']).toBeUndefined();
    }
  });
});
