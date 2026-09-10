/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import { resolveModelReasoningConfig } from '../model-reasoning-config.js';
import {
  applyOpenAIReasoningProfile,
  getOpenAIReasoningState,
} from './reasoning-profile.js';

const generation: ContentGeneratorConfig = {
  model: 'alias',
  authType: AuthType.USE_OPENAI,
  reasoningConfig: {
    profile: 'dashscope-effort',
    supportedEfforts: ['low', 'medium', 'xhigh'],
    defaultEffort: 'medium',
  },
};

function wire(config: ContentGeneratorConfig, requestDisabled = false) {
  return applyOpenAIReasoningProfile(
    {
      model: config.model,
      messages: [],
      temperature: 0.2,
      reasoning_effort: 'high',
    },
    config,
    resolveModelReasoningConfig(config)!,
    requestDisabled,
  );
}

describe('explicit OpenAI thinking profiles', () => {
  it('replaces legacy adapter inference without changing sampling', () => {
    expect(wire(generation)).toEqual({
      model: 'alias',
      messages: [],
      temperature: 0.2,
      reasoning_effort: 'medium',
    });
  });

  it('keeps raw overrides above defaults and reports their effective value', () => {
    const config = {
      ...generation,
      samplingParams: { reasoning_effort: 'low' },
      extra_body: { reasoning_effort: 'xhigh' },
    };
    expect(wire(config)).toMatchObject({ reasoning_effort: 'xhigh' });
    expect(
      getOpenAIReasoningState(config, resolveModelReasoningConfig(config)!),
    ).toEqual({ effort: 'xhigh' });
  });

  it('honors request opt-out above raw overrides', () => {
    expect(
      wire(
        {
          ...generation,
          extra_body: { reasoning_effort: 'xhigh', thinking_budget: 4096 },
        },
        true,
      ),
    ).toEqual({
      model: 'alias',
      messages: [],
      temperature: 0.2,
      reasoning_effort: 'none',
    });
  });

  it('restores the actual default for mandatory thinking despite every off source', () => {
    expect(
      wire(
        {
          ...generation,
          thinkingMandatory: true,
          reasoning: false,
          extra_body: { reasoning_effort: 'none' },
        },
        true,
      ),
    ).toMatchObject({ reasoning_effort: 'medium' });
  });

  it('does not clamp an explicitly supported new DeepSeek tier', () => {
    expect(
      wire({
        ...generation,
        reasoningConfig: {
          profile: 'deepseek-openai',
          supportedEfforts: ['medium', 'max'],
          defaultEffort: 'medium',
        },
      }),
    ).toMatchObject({ reasoning_effort: 'medium' });
  });

  it('keeps explicit budget and effort mutually exclusive for DashScope', () => {
    const result = wire({
      ...generation,
      extra_body: { thinking_budget: 1024 },
    }) as unknown as Record<string, unknown>;
    expect(result['thinking_budget']).toBe(1024);
    expect(result).not.toHaveProperty('reasoning_effort');
  });

  it('does not treat a model default-off as an explicit opt-out above a raw effort', () => {
    const config: ContentGeneratorConfig = {
      model: 'gpt-5.2',
      authType: AuthType.USE_OPENAI,
      reasoningConfig: { supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
      extra_body: { reasoning_effort: 'high' },
    };
    expect(wire(config)).toMatchObject({ reasoning_effort: 'high' });
  });

  it('reports an inferred model default-off while still honoring a raw enable', () => {
    const config: ContentGeneratorConfig = {
      model: 'gpt-5.2',
      authType: AuthType.USE_OPENAI,
      reasoningConfig: { supportedEfforts: ['low', 'medium', 'high', 'xhigh'] },
    };
    const resolved = resolveModelReasoningConfig(config)!;
    expect(getOpenAIReasoningState(config, resolved)).toBe(false);
    expect(
      getOpenAIReasoningState(
        { ...config, extra_body: { reasoning_effort: 'high' } },
        resolved,
      ),
    ).toEqual({ effort: 'high' });
  });

  it('retains the lower DashScope knob when the higher layer contains a nullish placeholder', () => {
    const result = wire({
      ...generation,
      samplingParams: { thinking_budget: 1024 },
      extra_body: { thinking_budget: null },
    }) as unknown as Record<string, unknown>;
    expect(result['thinking_budget']).toBe(1024);
    expect(result).not.toHaveProperty('reasoning_effort');
  });
});
