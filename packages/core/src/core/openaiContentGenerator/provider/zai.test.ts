/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { ZaiOpenAICompatibleProvider } from './zai.js';
import { determineProvider } from '../index.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { Config } from '../../../config/config.js';

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config) => ({ config })),
}));

const userPromptId = 'prompt-123';

function makeProvider(
  overrides: Partial<ContentGeneratorConfig> = {},
): ZaiOpenAICompatibleProvider {
  const contentGeneratorConfig = {
    apiKey: 'test-api-key',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-5.2',
    ...overrides,
  } as ContentGeneratorConfig;
  const cliConfig = {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
  } as unknown as Config;
  return new ZaiOpenAICompatibleProvider(contentGeneratorConfig, cliConfig);
}

describe('ZaiOpenAICompatibleProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isZaiProvider / isZaiHostname', () => {
    it('detects z.ai and bigmodel.cn hostnames', () => {
      expect(
        ZaiOpenAICompatibleProvider.isZaiHostname({
          baseUrl: 'https://api.z.ai/api/paas/v4',
        } as ContentGeneratorConfig),
      ).toBe(true);
      expect(
        ZaiOpenAICompatibleProvider.isZaiHostname({
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        } as ContentGeneratorConfig),
      ).toBe(true);
    });

    it('matches glm-* models by name for routing, but not the hostname gate', () => {
      const config = {
        baseUrl: 'https://my-vllm.example.com/v1',
        model: 'glm-4.6',
      } as ContentGeneratorConfig;
      expect(ZaiOpenAICompatibleProvider.isZaiProvider(config)).toBe(true);
      expect(ZaiOpenAICompatibleProvider.isZaiHostname(config)).toBe(false);
    });

    it('returns false for unrelated providers', () => {
      const config = {
        baseUrl: 'https://api.example.com/v1',
        model: 'gpt-4o',
      } as ContentGeneratorConfig;
      expect(ZaiOpenAICompatibleProvider.isZaiProvider(config)).toBe(false);
    });
  });

  // Guards the dispatch chain in determineProvider(): a future reordering of the
  // provider checks (or an anchored hostname test) could silently misroute GLM
  // requests through the DefaultOpenAICompatibleProvider, dropping the z.ai
  // reasoning_effort reshape with no test failure.
  describe('determineProvider routing', () => {
    const cliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getProxy: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    it('routes api.z.ai base URLs to the Zai provider', () => {
      const provider = determineProvider(
        {
          apiKey: 'k',
          baseUrl: 'https://api.z.ai/api/paas/v4',
          model: 'glm-5.2',
        } as ContentGeneratorConfig,
        cliConfig,
      );
      expect(provider).toBeInstanceOf(ZaiOpenAICompatibleProvider);
    });

    it('routes open.bigmodel.cn base URLs to the Zai provider', () => {
      const provider = determineProvider(
        {
          apiKey: 'k',
          baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
          model: 'glm-4.6',
        } as ContentGeneratorConfig,
        cliConfig,
      );
      expect(provider).toBeInstanceOf(ZaiOpenAICompatibleProvider);
    });

    it('routes glm-* models on a non-Zai hostname to the Zai provider', () => {
      const provider = determineProvider(
        {
          apiKey: 'k',
          baseUrl: 'https://my-vllm.example.com/v1',
          model: 'glm-4.6',
        } as ContentGeneratorConfig,
        cliConfig,
      );
      expect(provider).toBeInstanceOf(ZaiOpenAICompatibleProvider);
    });
  });

  describe('buildRequest', () => {
    it('flattens nested reasoning.effort to a verbatim reasoning_effort (no remap)', () => {
      const provider = makeProvider();
      const request = {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'xhigh' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(
        request,
        userPromptId,
      ) as unknown as Record<string, unknown>;
      // Unlike DeepSeek (which remaps xhigh -> max), GLM keeps the raw tier.
      expect(result['reasoning_effort']).toBe('xhigh');
      expect(result['reasoning']).toBeUndefined();
    });

    it('keeps medium verbatim rather than collapsing to high', () => {
      const provider = makeProvider();
      const request = {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'medium' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(
        request,
        userPromptId,
      ) as unknown as Record<string, unknown>;
      expect(result['reasoning_effort']).toBe('medium');
    });

    it('does not clobber a user-set top-level reasoning_effort', () => {
      const provider = makeProvider();
      const request = {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'low' },
        reasoning_effort: 'max',
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(
        request,
        userPromptId,
      ) as unknown as Record<string, unknown>;
      expect(result['reasoning_effort']).toBe('max');
    });

    it('does not reshape when the hostname is not a GLM endpoint', () => {
      const provider = makeProvider({
        baseUrl: 'https://my-vllm.example.com/v1',
        model: 'glm-4.6',
      });
      const request = {
        model: 'glm-4.6',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning: { effort: 'high' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(
        request,
        userPromptId,
      ) as unknown as Record<string, unknown>;
      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['reasoning']).toEqual({ effort: 'high' });
    });

    it('leaves requests without reasoning untouched', () => {
      const provider = makeProvider();
      const request = {
        model: 'glm-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(
        request,
        userPromptId,
      ) as unknown as Record<string, unknown>;
      expect(result['reasoning_effort']).toBeUndefined();
    });
  });
});
