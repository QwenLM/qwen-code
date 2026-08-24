/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import {
  AuthType,
  type ContentGeneratorConfig,
} from '../../contentGenerator.js';
import { determineProvider } from '../index.js';
import { MoonshotOpenAICompatibleProvider } from './moonshot.js';

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config) => ({ config })),
}));

const cliConfig = {
  getCliVersion: vi.fn().mockReturnValue('1.0.0'),
  getProxy: vi.fn().mockReturnValue(undefined),
} as unknown as Config;

function makeProvider(
  overrides: Partial<ContentGeneratorConfig> = {},
): MoonshotOpenAICompatibleProvider {
  return new MoonshotOpenAICompatibleProvider(
    {
      apiKey: 'test-key',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
      ...overrides,
    },
    cliConfig,
  );
}

describe('MoonshotOpenAICompatibleProvider', () => {
  it('routes only exact Moonshot hostnames', () => {
    expect(
      determineProvider(
        {
          apiKey: 'key',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.moonshot.cn/v1',
          model: 'kimi-k3',
        },
        cliConfig,
      ),
    ).toBeInstanceOf(MoonshotOpenAICompatibleProvider);
    expect(
      MoonshotOpenAICompatibleProvider.isMoonshotHostname({
        model: 'kimi-k3',
        baseUrl: 'https://api.moonshot.cn.evil.example/v1',
      }),
    ).toBe(false);
  });

  it('routes the international Moonshot hostname', () => {
    expect(
      determineProvider(
        {
          apiKey: 'key',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k3',
        },
        cliConfig,
      ),
    ).toBeInstanceOf(MoonshotOpenAICompatibleProvider);
    expect(
      MoonshotOpenAICompatibleProvider.isMoonshotHostname({
        model: 'kimi-k3',
        baseUrl: 'https://api.moonshot.ai.evil.example/v1',
      }),
    ).toBe(false);
  });

  it('flattens Kimi K3 reasoning effort on the international host', () => {
    const result = makeProvider({
      baseUrl: 'https://api.moonshot.ai/v1',
    }).buildRequest(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'high' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-id',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('high');
    expect(result['reasoning']).toBeUndefined();
  });

  it('flattens Kimi K3 reasoning effort', () => {
    const result = makeProvider().buildRequest(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'high' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-id',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('high');
    expect(result['reasoning']).toBeUndefined();
  });

  it('flattens mixed-case Kimi K3 reasoning effort', () => {
    const result = makeProvider({ model: 'Kimi-K3' }).buildRequest(
      {
        model: 'Kimi-K3',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'high' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-id',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('high');
    expect(result['reasoning']).toBeUndefined();
  });

  it('drops stale reasoning effort for toggle-only Kimi K2.6', () => {
    const result = makeProvider({ model: 'kimi-k2.6' }).buildRequest(
      {
        model: 'kimi-k2.6',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'high' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-id',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBeUndefined();
    expect(result['reasoning']).toBeUndefined();
  });

  it('clamps a stale Kimi K3 tier and keeps sibling reasoning fields', () => {
    const result = makeProvider().buildRequest(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: { effort: 'medium', budget_tokens: 4096 },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-id',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning_effort']).toBe('high');
    expect(result['reasoning']).toEqual({ budget_tokens: 4096 });
  });

  it('preserves primitive nested reasoning without throwing', () => {
    const result = makeProvider().buildRequest(
      {
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hello' }],
        reasoning: 'high',
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-id',
    ) as unknown as Record<string, unknown>;

    expect(result['reasoning']).toBe('high');
  });
});
