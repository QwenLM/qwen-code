/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';
import { AvianOpenAICompatibleProvider } from './avian.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';

describe('AvianOpenAICompatibleProvider', () => {
  let provider: AvianOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.avian.io/v1',
      timeout: 60000,
      maxRetries: 2,
      model: 'deepseek/deepseek-v3.2',
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    provider = new AvianOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('constructor', () => {
    it('should extend DefaultOpenAICompatibleProvider', () => {
      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      expect(provider).toBeInstanceOf(AvianOpenAICompatibleProvider);
    });
  });

  describe('isAvianProvider', () => {
    it('should return true for api.avian.io URLs', () => {
      const configs = [
        { baseUrl: 'https://api.avian.io/v1' },
        { baseUrl: 'https://api.avian.io' },
        { baseUrl: 'http://api.avian.io/v1' },
      ];

      configs.forEach((config) => {
        const result = AvianOpenAICompatibleProvider.isAvianProvider(
          config as ContentGeneratorConfig,
        );
        expect(result).toBe(true);
      });
    });

    it('should return false for non-avian URLs', () => {
      const configs = [
        { baseUrl: 'https://api.openai.com/v1' },
        { baseUrl: 'https://api.anthropic.com/v1' },
        { baseUrl: 'https://openrouter.ai/api/v1' },
        { baseUrl: 'https://example.com/api/v1' },
        { baseUrl: '' },
        { baseUrl: undefined },
      ];

      configs.forEach((config) => {
        const result = AvianOpenAICompatibleProvider.isAvianProvider(
          config as ContentGeneratorConfig,
        );
        expect(result).toBe(false);
      });
    });

    it('should handle missing baseUrl gracefully', () => {
      const config = {} as ContentGeneratorConfig;
      const result = AvianOpenAICompatibleProvider.isAvianProvider(config);
      expect(result).toBe(false);
    });
  });

  describe('buildHeaders', () => {
    it('should include base headers from parent class', () => {
      const headers = provider.buildHeaders();

      expect(headers['User-Agent']).toBe(
        `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
      );
    });

    it('should add Avian-specific headers', () => {
      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
        'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
        'X-Avian-Title': 'Qwen Code',
      });
    });

    it('should override parent headers if there are conflicts', () => {
      const parentBuildHeaders = vi.spyOn(
        DefaultOpenAICompatibleProvider.prototype,
        'buildHeaders',
      );
      parentBuildHeaders.mockReturnValue({
        'User-Agent': 'ParentAgent/1.0.0',
        'HTTP-Referer': 'https://parent.com',
      });

      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': 'ParentAgent/1.0.0',
        'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
        'X-Avian-Title': 'Qwen Code',
      });

      parentBuildHeaders.mockRestore();
    });

    it('should handle unknown CLI version from parent', () => {
      vi.mocked(mockCliConfig.getCliVersion).mockReturnValue(undefined);

      const headers = provider.buildHeaders();

      expect(headers['User-Agent']).toBe(
        `QwenCode/unknown (${process.platform}; ${process.arch})`,
      );
      expect(headers['HTTP-Referer']).toBe(
        'https://github.com/QwenLM/qwen-code.git',
      );
      expect(headers['X-Avian-Title']).toBe('Qwen Code');
    });
  });

  describe('buildClient', () => {
    it('should inherit buildClient behavior from parent', () => {
      const mockClient = { test: 'client' };
      const parentBuildClient = vi.spyOn(
        DefaultOpenAICompatibleProvider.prototype,
        'buildClient',
      );
      parentBuildClient.mockReturnValue(mockClient as unknown as OpenAI);

      const result = provider.buildClient();

      expect(parentBuildClient).toHaveBeenCalled();
      expect(result).toBe(mockClient);

      parentBuildClient.mockRestore();
    });
  });

  describe('buildRequest', () => {
    it('should inherit buildRequest behavior from parent', () => {
      const mockRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'deepseek/deepseek-v3.2',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const mockUserPromptId = 'test-prompt-id';
      const mockResult = { ...mockRequest, modified: true };

      const parentBuildRequest = vi.spyOn(
        DefaultOpenAICompatibleProvider.prototype,
        'buildRequest',
      );
      parentBuildRequest.mockReturnValue(mockResult);

      const result = provider.buildRequest(mockRequest, mockUserPromptId);

      expect(parentBuildRequest).toHaveBeenCalledWith(
        mockRequest,
        mockUserPromptId,
      );
      expect(result).toBe(mockResult);

      parentBuildRequest.mockRestore();
    });
  });

  describe('integration with parent class', () => {
    it('should properly call parent constructor', () => {
      const newProvider = new AvianOpenAICompatibleProvider(
        mockContentGeneratorConfig,
        mockCliConfig,
      );

      expect(newProvider).toHaveProperty('buildHeaders');
      expect(newProvider).toHaveProperty('buildClient');
      expect(newProvider).toHaveProperty('buildRequest');
    });

    it('should maintain parent functionality while adding Avian specifics', () => {
      const headers = provider.buildHeaders();

      expect(headers['User-Agent']).toBeDefined();
      expect(headers['HTTP-Referer']).toBe(
        'https://github.com/QwenLM/qwen-code.git',
      );
      expect(headers['X-Avian-Title']).toBe('Qwen Code');
    });
  });
});
