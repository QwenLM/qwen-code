/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { ModelScopeOpenAICompatibleProvider } from './modelscope.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

vi.mock('openai');

describe('ModelScopeOpenAICompatibleProvider', () => {
  let provider: ModelScopeOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.modelscope.cn/v1',
      model: 'qwen-max',
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    provider = new ModelScopeOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('isModelScopeProvider', () => {
    it('should return true if baseUrl includes "modelscope"', () => {
      const config = { baseUrl: 'https://api.modelscope.cn/v1' };
      expect(
        ModelScopeOpenAICompatibleProvider.isModelScopeProvider(
          config as ContentGeneratorConfig,
        ),
      ).toBe(true);
    });

    it('should return false if baseUrl does not include "modelscope"', () => {
      const config = { baseUrl: 'https://api.openai.com/v1' };
      expect(
        ModelScopeOpenAICompatibleProvider.isModelScopeProvider(
          config as ContentGeneratorConfig,
        ),
      ).toBe(false);
    });
  });

  describe('buildRequest', () => {
    it('should remove stream_options when stream is false', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        messages: [{ role: 'user', content: 'Hello!' }],
        stream: false,
        stream_options: { include_usage: true },
      };

      const result = provider.buildRequest(originalRequest, 'prompt-id');

      expect(result).not.toHaveProperty('stream_options');
    });

    it('should keep stream_options when stream is true', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        messages: [{ role: 'user', content: 'Hello!' }],
        stream: true,
        stream_options: { include_usage: true },
      };

      const result = provider.buildRequest(originalRequest, 'prompt-id');

      expect(result).toHaveProperty('stream_options');
    });

    it('should handle requests without stream_options', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        messages: [{ role: 'user', content: 'Hello!' }],
        stream: false,
      };

      const result = provider.buildRequest(originalRequest, 'prompt-id');

      expect(result).not.toHaveProperty('stream_options');
    });
  });
});
