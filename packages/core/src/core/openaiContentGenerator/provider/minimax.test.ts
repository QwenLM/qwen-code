/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { MiniMaxOpenAICompatibleProvider } from './minimax.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { Config } from '../../../config/config.js';

// Mock OpenAI client to avoid real network calls
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config) => ({
    config,
  })),
}));

describe('MiniMaxOpenAICompatibleProvider', () => {
  let provider: MiniMaxOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContentGeneratorConfig = {
      apiKey: 'test-minimax-api-key',
      baseUrl: 'https://api.minimax.io/v1',
      model: 'MiniMax-M2.7',
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getProxy: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    provider = new MiniMaxOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('isMiniMaxProvider', () => {
    it('returns true when baseUrl hostname is api.minimax.io', () => {
      const result = MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(
        mockContentGeneratorConfig,
      );
      expect(result).toBe(true);
    });

    it('returns true when baseUrl hostname is api.minimaxi.com', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://api.minimaxi.com/v1',
      } as ContentGeneratorConfig;
      expect(MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(config)).toBe(
        true,
      );
    });

    it('returns false for non-MiniMax baseUrl', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://api.openai.com/v1',
      } as ContentGeneratorConfig;
      expect(MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(config)).toBe(
        false,
      );
    });

    it('returns false when baseUrl is undefined', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: undefined,
      } as ContentGeneratorConfig;
      expect(MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(config)).toBe(
        false,
      );
    });

    it('returns false for a URL that contains api.minimax.io as a path component', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://proxy.example.com/api.minimax.io/v1',
      } as ContentGeneratorConfig;
      expect(MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(config)).toBe(
        false,
      );
    });

    it('returns false for a URL with api.minimax.io embedded in another hostname', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://evil.api.minimax.io.malicious.com/v1',
      } as ContentGeneratorConfig;
      expect(MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(config)).toBe(
        false,
      );
    });
  });

  describe('getDefaultGenerationConfig', () => {
    it('returns temperature 1.0 as default', () => {
      expect(provider.getDefaultGenerationConfig()).toEqual({
        temperature: 1.0,
      });
    });
  });

  describe('buildRequest', () => {
    const userPromptId = 'prompt-123';

    it('removes response_format from request', () => {
      const request = {
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        response_format: { type: 'json_object' as const },
      } as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(request, userPromptId);
      expect(result).not.toHaveProperty('response_format');
    });

    it('sets temperature to 1.0 when temperature is 0', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0,
      };

      const result = provider.buildRequest(request, userPromptId);
      expect(result.temperature).toBe(1.0);
    });

    it('sets temperature to 1.0 when temperature is undefined', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = provider.buildRequest(request, userPromptId);
      expect(result.temperature).toBe(1.0);
    });

    it('sets temperature to 1.0 when temperature is null', () => {
      const request = {
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        temperature: null,
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

      const result = provider.buildRequest(request, userPromptId);
      expect(result.temperature).toBe(1.0);
    });

    it('preserves valid temperature values', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'MiniMax-M2.7',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const result = provider.buildRequest(request, userPromptId);
      expect(result.temperature).toBe(0.7);
    });

    it('preserves messages unchanged', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'MiniMax-M2.7',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there' },
        ],
      };

      const result = provider.buildRequest(request, userPromptId);
      expect(result.messages).toHaveLength(2);
      expect(result.messages?.[0].content).toBe('Hello');
    });
  });

  describe('buildClient', () => {
    it('uses DEFAULT_MINIMAX_BASE_URL when no baseUrl configured', () => {
      const configWithoutUrl = {
        apiKey: 'test-key',
        model: 'MiniMax-M2.7',
      } as ContentGeneratorConfig;

      const providerWithoutUrl = new MiniMaxOpenAICompatibleProvider(
        configWithoutUrl,
        mockCliConfig,
      );

      const client = providerWithoutUrl.buildClient();
      expect(client).toBeDefined();
    });

    it('uses configured baseUrl when provided', () => {
      const client = provider.buildClient();
      expect(client).toBeDefined();
    });
  });
});
