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

  it('keeps a raw DashScope budget exclusive when thinking is mandatory', () => {
    const result = wire({
      ...generation,
      thinkingMandatory: true,
      extra_body: { thinking_budget: 1024 },
    }) as unknown as Record<string, unknown>;
    expect(result['thinking_budget']).toBe(1024);
    expect(result).not.toHaveProperty('reasoning_effort');
  });

  it('merges raw chat template options without dropping the generated switch', () => {
    const result = wire({
      ...generation,
      reasoningConfig: { profile: 'qwen-chat-template' },
      extra_body: {
        chat_template_kwargs: { tools_in_user_message: false },
      },
    }) as unknown as Record<string, unknown>;
    expect(result['chat_template_kwargs']).toEqual({
      enable_thinking: true,
      tools_in_user_message: false,
    });
  });

  it('merges chat template options across both raw layers', () => {
    const result = wire({
      ...generation,
      reasoningConfig: { profile: 'qwen-chat-template' },
      samplingParams: {
        chat_template_kwargs: { enable_thinking: true },
      },
      extra_body: {
        chat_template_kwargs: { tools_in_user_message: false },
      },
    }) as unknown as Record<string, unknown>;
    expect(result['chat_template_kwargs']).toEqual({
      enable_thinking: true,
      tools_in_user_message: false,
    });
  });

  it('preserves non-effort reasoning fields for effort profiles', () => {
    const result = wire({
      ...generation,
      reasoning: { effort: 'max', budget_tokens: 50_000 },
      reasoningConfig: {
        profile: 'deepseek-openai',
        supportedEfforts: ['high', 'max'],
      },
    }) as unknown as Record<string, unknown>;
    expect(result['reasoning_effort']).toBe('max');
    expect(result['reasoning']).toEqual({ budget_tokens: 50_000 });
  });

  it('keeps one effort winner when a raw layer contains both shapes', () => {
    const result = wire({
      ...generation,
      extra_body: {
        reasoning: { effort: 'high', budget_tokens: 2048 },
        reasoning_effort: 'low',
      },
    }) as unknown as Record<string, unknown>;
    expect(result['reasoning_effort']).toBe('low');
    expect(result['reasoning']).toEqual({ budget_tokens: 2048 });
  });

  it('folds a raw qwen template switch into chat_template_kwargs', () => {
    const result = wire({
      ...generation,
      reasoningConfig: { profile: 'qwen-chat-template' },
      extra_body: { enable_thinking: false },
    }) as unknown as Record<string, unknown>;
    expect(result['chat_template_kwargs']).toEqual({
      enable_thinking: false,
    });
    expect(result).not.toHaveProperty('enable_thinking');
  });

  it('preserves an explicit raw null reasoning value', () => {
    const result = wire({
      ...generation,
      extra_body: { reasoning: null },
    }) as unknown as Record<string, unknown>;
    expect(result).toHaveProperty('reasoning', null);
  });

  it('overrides a raw nested enable when the request disables thinking', () => {
    const result = wire(
      {
        ...generation,
        reasoningConfig: { profile: 'openai-effort' },
        extra_body: { chat_template_kwargs: { enable_thinking: true } },
      },
      true,
    ) as unknown as Record<string, unknown>;
    expect(result['chat_template_kwargs']).toEqual({ enable_thinking: false });
  });

  it('keeps nested and top-level DashScope disable switches consistent', () => {
    const result = wire(
      {
        ...generation,
        reasoningConfig: { profile: 'dashscope-thinking' },
        extra_body: { chat_template_kwargs: { enable_thinking: true } },
      },
      true,
    ) as unknown as Record<string, unknown>;
    expect(result['enable_thinking']).toBe(false);
    expect(result['chat_template_kwargs']).toEqual({ enable_thinking: false });
  });

  it('removes lower-priority disable controls when a raw effort wins', () => {
    const result = wire({
      ...generation,
      samplingParams: {
        reasoning: { enabled: false },
        thinking: { type: 'disabled' },
      },
      extra_body: { reasoning_effort: 'low' },
    }) as unknown as Record<string, unknown>;
    expect(result['reasoning_effort']).toBe('low');
    expect(result).not.toHaveProperty('reasoning');
    expect(result).not.toHaveProperty('thinking');
  });

  it('removes a lower-priority effort when a raw disable control wins', () => {
    const nestedDisable = wire({
      ...generation,
      samplingParams: { reasoning_effort: 'high' },
      extra_body: { reasoning: { enabled: false } },
    }) as unknown as Record<string, unknown>;
    expect(nestedDisable['reasoning']).toEqual({ enabled: false });
    expect(nestedDisable).not.toHaveProperty('reasoning_effort');

    const thinkingDisable = wire({
      ...generation,
      reasoningConfig: {
        profile: 'deepseek-openai',
        supportedEfforts: ['high', 'max'],
      },
      samplingParams: { reasoning_effort: 'high' },
      extra_body: { thinking: { type: 'disabled' } },
    }) as unknown as Record<string, unknown>;
    expect(thinkingDisable['thinking']).toEqual({ type: 'disabled' });
    expect(thinkingDisable).not.toHaveProperty('reasoning_effort');
  });

  it('keeps template switches and flat efforts mutually exclusive', () => {
    const higherEffort = wire({
      ...generation,
      samplingParams: {
        chat_template_kwargs: { enable_thinking: false },
      },
      extra_body: { reasoning_effort: 'high' },
    }) as unknown as Record<string, unknown>;
    expect(higherEffort['reasoning_effort']).toBe('high');
    expect(higherEffort).not.toHaveProperty('chat_template_kwargs');

    const higherTemplateSwitch = wire({
      ...generation,
      samplingParams: { reasoning_effort: 'high' },
      extra_body: {
        chat_template_kwargs: { enable_thinking: false },
      },
    }) as unknown as Record<string, unknown>;
    expect(higherTemplateSwitch['chat_template_kwargs']).toEqual({
      enable_thinking: false,
    });
    expect(higherTemplateSwitch).not.toHaveProperty('reasoning_effort');

    const sameLayer = wire({
      ...generation,
      extra_body: {
        reasoning_effort: 'high',
        chat_template_kwargs: { enable_thinking: false },
      },
    }) as unknown as Record<string, unknown>;
    expect(sameLayer['reasoning_effort']).toBe('high');
    expect(sameLayer).not.toHaveProperty('chat_template_kwargs');
  });

  it('uses OpenRouter disable syntax only for OpenRouter or an explicit profile', () => {
    const inferred: ContentGeneratorConfig = {
      model: 'mistral-large',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://proxy.example/v1',
      reasoningConfig: { defaultEffort: 'medium' },
    };
    expect(wire(inferred, true)).not.toHaveProperty('reasoning');
    expect(
      wire({ ...inferred, baseUrl: 'https://openrouter.ai/api/v1' }, true),
    ).toMatchObject({ reasoning: { enabled: false } });
    expect(
      wire(
        {
          ...inferred,
          reasoningConfig: {
            profile: 'openai-reasoning',
            defaultEffort: 'medium',
          },
        },
        true,
      ),
    ).toMatchObject({ reasoning: { enabled: false } });
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

  it('lets a higher raw nested effort beat a lower DashScope budget', () => {
    const result = wire({
      ...generation,
      samplingParams: { thinking_budget: 1024 },
      extra_body: { reasoning: { effort: 'low' } },
    }) as unknown as Record<string, unknown>;
    expect(result['reasoning_effort']).toBe('low');
    expect(result).not.toHaveProperty('thinking_budget');
    expect(result).not.toHaveProperty('reasoning');
  });
});
