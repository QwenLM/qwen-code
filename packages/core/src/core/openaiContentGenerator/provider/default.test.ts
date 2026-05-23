/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockedFunction,
} from 'vitest';
import OpenAI from 'openai';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import type { OpenAIRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config) => ({
    config,
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  })),
}));

vi.mock('../../../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: vi.fn(),
}));

describe('DefaultOpenAICompatibleProvider', () => {
  let provider: DefaultOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    const mockedBuildRuntimeFetchOptions =
      buildRuntimeFetchOptions as unknown as MockedFunction<
        (sdkType: 'openai', proxyUrl?: string) => OpenAIRuntimeFetchOptions
      >;
    mockedBuildRuntimeFetchOptions.mockReturnValue(undefined);

    // Mock ContentGeneratorConfig
    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.openai.com/v1',
      timeout: 60000,
      maxRetries: 2,
      model: 'gpt-4',
    } as ContentGeneratorConfig;

    // Mock Config
    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getProxy: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    provider = new DefaultOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('constructor', () => {
    it('should initialize with provided configs', () => {
      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
    });
  });

  describe('buildHeaders', () => {
    it('should build headers with User-Agent', () => {
      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
      });
    });

    it('should merge customHeaders with defaults (and allow overrides)', () => {
      const providerWithCustomHeaders = new DefaultOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          customHeaders: {
            'X-Custom': '1',
            'User-Agent': 'custom-agent',
          },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );

      const headers = providerWithCustomHeaders.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': 'custom-agent',
        'X-Custom': '1',
      });
    });

    it('should handle unknown CLI version', () => {
      (
        mockCliConfig.getCliVersion as MockedFunction<
          typeof mockCliConfig.getCliVersion
        >
      ).mockReturnValue(undefined);

      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': `QwenCode/unknown (${process.platform}; ${process.arch})`,
      });
    });
  });

  describe('buildClient', () => {
    it('should create OpenAI client with correct configuration', () => {
      const client = provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-api-key',
          baseURL: 'https://api.openai.com/v1',
          timeout: 60000,
          maxRetries: 2,
          defaultHeaders: {
            'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
          },
        }),
      );

      expect(client).toBeDefined();
    });

    it('should use default timeout and maxRetries when not provided', () => {
      mockContentGeneratorConfig.timeout = undefined;
      mockContentGeneratorConfig.maxRetries = undefined;

      provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-api-key',
          baseURL: 'https://api.openai.com/v1',
          timeout: DEFAULT_TIMEOUT,
          maxRetries: DEFAULT_MAX_RETRIES,
          defaultHeaders: {
            'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
          },
        }),
      );
    });

    it('should include custom headers from buildHeaders', () => {
      provider.buildClient();

      const expectedHeaders = provider.buildHeaders();
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: expectedHeaders,
        }),
      );
    });
  });

  describe('buildRequest', () => {
    it('should pass through all request parameters unchanged', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hello!' },
        ],
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        stream: false,
      };

      const userPromptId = 'test-prompt-id';
      const result = provider.buildRequest(originalRequest, userPromptId);

      expect(result).toEqual(originalRequest);
      expect(result).not.toBe(originalRequest); // Should be a new object
    });

    it('should set conservative max_tokens default when not configured', () => {
      const requestWithoutMaxTokens: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = provider.buildRequest(
        requestWithoutMaxTokens,
        'prompt-id',
      );

      // Should set capped default (min of model limit and CAPPED_DEFAULT_MAX_TOKENS)
      // GPT-4 has 16K output limit, so min(16K, 8K) = 8K
      expect(result.max_tokens).toBe(8000);
    });

    it('should respect user max_tokens for unknown models (deployment aliases, self-hosted)', () => {
      // Unknown models: user config is respected entirely (backend may support larger limits)
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000,
      };

      const result = provider.buildRequest(request, 'prompt-id');

      // User's 100K setting is preserved for unknown models
      expect(result.max_tokens).toBe(100000);
    });

    it('should use capped default for unknown models when max_tokens not configured', () => {
      // Unknown models without user config: use CAPPED_DEFAULT_MAX_TOKENS
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'custom-deployment-alias',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = provider.buildRequest(request, 'prompt-id');

      // Uses capped default (8K)
      expect(result.max_tokens).toBe(8000);
    });

    it('should cap max_tokens for known models to avoid API errors', () => {
      // Known models (GPT-4): user config is capped at model limit
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000, // Exceeds GPT-4's 16K limit
      };

      const result = provider.buildRequest(request, 'prompt-id');

      // Capped to GPT-4's output limit (16K)
      expect(result.max_tokens).toBe(16384);
    });

    it('should treat null max_tokens as not configured', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: null as unknown as undefined,
      };

      const result = provider.buildRequest(request, 'prompt-id');

      // GPT-4 has 16K output limit, capped default is 8K: min(16K, 8K) = 8K
      expect(result.max_tokens).toBe(8000);
    });

    it('should preserve all sampling parameters', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Test message' }],
        temperature: 0.5,
        max_tokens: 500,
        top_p: 0.8,
        frequency_penalty: 0.3,
        presence_penalty: 0.4,
        stop: ['END'],
        logit_bias: { '123': 10 },
        user: 'test-user',
        seed: 42,
      };

      const result = provider.buildRequest(originalRequest, 'prompt-id');

      expect(result).toEqual(originalRequest);
      expect(result.temperature).toBe(0.5);
      expect(result.max_tokens).toBe(500);
      expect(result.top_p).toBe(0.8);
      expect(result.frequency_penalty).toBe(0.3);
      expect(result.presence_penalty).toBe(0.4);
      expect(result.stop).toEqual(['END']);
      expect(result.logit_bias).toEqual({ '123': 10 });
      expect(result.user).toBe('test-user');
      expect(result.seed).toBe(42);
    });

    it('should handle minimal request parameters', () => {
      const minimalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = provider.buildRequest(minimalRequest, 'prompt-id');

      // Should set conservative max_tokens default
      expect(result.model).toBe('gpt-4');
      expect(result.messages).toEqual(minimalRequest.messages);
      expect(result.max_tokens).toBe(8000); // GPT-4 has 16K limit, min(16K, 8K) = 8K
    });

    it('should not inject max_tokens when samplingParams is set without it (e.g. GPT-5 / o-series)', () => {
      // GPT-5 / o-series on Azure reject max_tokens entirely.
      // When the user sets samplingParams without max_tokens, honor the opt-out.
      const cfg = {
        ...mockContentGeneratorConfig,
        samplingParams: { max_completion_tokens: 4096 },
      } as ContentGeneratorConfig;
      const p = new DefaultOpenAICompatibleProvider(cfg, mockCliConfig);

      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = p.buildRequest(request, 'prompt-id');

      expect(result.max_tokens).toBeUndefined();
    });

    it('should pass samplingParams.max_tokens through verbatim, bypassing the model cap', () => {
      // When samplingParams is the source of truth, even max_tokens values that
      // exceed the known model output limit pass through unchanged —
      // no automatic capping.
      const cfg = {
        ...mockContentGeneratorConfig,
        samplingParams: { max_tokens: 100000 },
      } as ContentGeneratorConfig;
      const p = new DefaultOpenAICompatibleProvider(cfg, mockCliConfig);

      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4', // known model, 16K output limit — would normally cap.
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000,
      };

      const result = p.buildRequest(request, 'prompt-id');

      expect(result.max_tokens).toBe(100000);
    });

    it('should handle streaming requests', () => {
      const streamingRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      };

      const result = provider.buildRequest(streamingRequest, 'prompt-id');

      // Should set conservative max_tokens default while preserving stream
      expect(result.model).toBe('gpt-4');
      expect(result.messages).toEqual(streamingRequest.messages);
      expect(result.stream).toBe(true);
      expect(result.max_tokens).toBe(8000); // GPT-4 has 16K limit, min(16K, 8K) = 8K
    });

    it('should not modify the original request object', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const originalRequestCopy = { ...originalRequest };
      const result = provider.buildRequest(originalRequest, 'prompt-id');

      // Original request should be unchanged
      expect(originalRequest).toEqual(originalRequestCopy);
      // Result should be a different object
      expect(result).not.toBe(originalRequest);
    });

    it('should merge extra_body into the request', () => {
      const providerWithExtraBody = new DefaultOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          extra_body: {
            custom_param: 'custom_value',
            nested: { key: 'value' },
          },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );

      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const result = providerWithExtraBody.buildRequest(
        originalRequest,
        'prompt-id',
      );

      expect(result).toEqual({
        ...originalRequest,
        max_tokens: 8000, // GPT-4 has 16K limit, min(16K, 8K) = 8K
        custom_param: 'custom_value',
        nested: { key: 'value' },
      });
    });

    it('should not include extra_body when not configured', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
      };

      const result = provider.buildRequest(originalRequest, 'prompt-id');

      // Should preserve original params and set conservative max_tokens default
      expect(result.model).toBe('gpt-4');
      expect(result.messages).toEqual(originalRequest.messages);
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(8000); // GPT-4 has 16K limit, min(16K, 8K) = 8K
      expect(result).not.toHaveProperty('custom_param');
    });
  });
});
