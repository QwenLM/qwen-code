/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { DeepSeekOpenAICompatibleProvider } from './deepseek.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { Config } from '../../../config/config.js';

// Mock OpenAI client to avoid real network calls
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config) => ({
    config,
  })),
}));

describe('DeepSeekOpenAICompatibleProvider', () => {
  let provider: DeepSeekOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    provider = new DeepSeekOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('isDeepSeekProvider', () => {
    it('returns true when baseUrl includes deepseek', () => {
      const result = DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(
        mockContentGeneratorConfig,
      );
      expect(result).toBe(true);
    });

    it('returns false for non deepseek baseUrl', () => {
      const config = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://api.example.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DeepSeekOpenAICompatibleProvider.isDeepSeekProvider(config);
      expect(result).toBe(false);
    });
  });

  describe('buildRequest', () => {
    const userPromptId = 'prompt-123';

    it('converts array content into a string', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'text', text: ' world' },
            ],
          },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      expect(result.messages).toHaveLength(1);
      expect(result.messages?.[0]).toEqual({
        role: 'user',
        content: 'Hello world',
      });
      expect(originalRequest.messages?.[0].content).toEqual([
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' },
      ]);
    });

    it('leaves string content unchanged', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: 'Hello world',
          },
        ],
      };

      const result = provider.buildRequest(originalRequest, userPromptId);

      expect(result.messages?.[0].content).toBe('Hello world');
    });

    it('throws when encountering non-text multimodal parts', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.png' },
              },
            ],
          },
        ],
      };

      expect(() =>
        provider.buildRequest(originalRequest, userPromptId),
      ).toThrow(/only supports text content/i);
    });
  });
});
