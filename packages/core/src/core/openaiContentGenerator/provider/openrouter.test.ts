/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { OpenRouterOpenAICompatibleProvider } from './openrouter.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import { Config } from '../../../config/config.js';
import { ContentGeneratorConfig } from '../../contentGenerator.js';

describe('OpenRouterOpenAICompatibleProvider', () => {
  let provider: OpenRouterOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    // Mock ContentGeneratorConfig
    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      timeout: 60000,
      maxRetries: 2,
      model: 'openai/gpt-4',
    } as ContentGeneratorConfig;

    // Mock Config
    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    provider = new OpenRouterOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('constructor', () => {
    it('should extend DefaultOpenAICompatibleProvider', () => {
      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
      expect(provider).toBeInstanceOf(OpenRouterOpenAICompatibleProvider);
    });
  });

  describe('isOpenRouterProvider', () => {
    it('should return true for openrouter.ai URLs', () => {
      const configs = [
        { baseUrl: 'https://openrouter.ai/api/v1' },
        { baseUrl: 'https://api.openrouter.ai/v1' },
        { baseUrl: 'https://openrouter.ai' },
        { baseUrl: 'http://openrouter.ai/api/v1' },
      ];

      configs.forEach((config) => {
        const result = OpenRouterOpenAICompatibleProvider.isOpenRouterProvider(
          config as ContentGeneratorConfig,
        );
        expect(result).toBe(true);
      });
    });

    it('should return false for non-openrouter URLs', () => {
      const configs = [
        { baseUrl: 'https://api.openai.com/v1' },
        { baseUrl: 'https://api.anthropic.com/v1' },
        { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
        { baseUrl: 'https://example.com/api/v1' }, // different domain
        { baseUrl: '' },
        { baseUrl: undefined },
      ];

      configs.forEach((config) => {
        const result = OpenRouterOpenAICompatibleProvider.isOpenRouterProvider(
          config as ContentGeneratorConfig,
        );
        expect(result).toBe(false);
      });
    });

    it('should handle missing baseUrl gracefully', () => {
      const config = {} as ContentGeneratorConfig;
      const result =
        OpenRouterOpenAICompatibleProvider.isOpenRouterProvider(config);
      expect(result).toBe(false);
    });
  });

  describe('buildHeaders', () => {
    it('should include base headers from parent class', () => {
      const headers = provider.buildHeaders();

      // Should include User-Agent from parent
      expect(headers['User-Agent']).toBe(
        `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
      );
    });

    it('should add OpenRouter-specific headers', () => {
      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
        'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
        'X-Title': 'Qwen Code',
      });
    });

    it('should override parent headers if there are conflicts', () => {
      // Mock parent to return conflicting headers
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
        'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git', // OpenRouter-specific value should override
        'X-Title': 'Qwen Code',
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
      expect(headers['X-Title']).toBe('Qwen Code');
    });
  });

  describe('buildClient', () => {
    it('should inherit buildClient behavior from parent', () => {
      // Mock the parent's buildClient method
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
        model: 'openai/gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };
      const mockUserPromptId = 'test-prompt-id';
      const mockResult = { ...mockRequest, modified: true };

      // Mock the parent's buildRequest method
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
      const newProvider = new OpenRouterOpenAICompatibleProvider(
        mockContentGeneratorConfig,
        mockCliConfig,
      );

      // Verify that parent properties are accessible
      expect(newProvider).toHaveProperty('buildHeaders');
      expect(newProvider).toHaveProperty('buildClient');
      expect(newProvider).toHaveProperty('buildRequest');
    });

    it('should maintain parent functionality while adding OpenRouter specifics', () => {
      // Test that the provider can perform all parent operations
      const headers = provider.buildHeaders();

      // Should have both parent and OpenRouter-specific headers
      expect(headers['User-Agent']).toBeDefined(); // From parent
      expect(headers['HTTP-Referer']).toBe(
        'https://github.com/QwenLM/qwen-code.git',
      ); // OpenRouter-specific
      expect(headers['X-Title']).toBe('Qwen Code'); // OpenRouter-specific
    });
  });
});
