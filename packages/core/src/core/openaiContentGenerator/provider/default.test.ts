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
import { Config } from '../../../config/config.js';
import { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';

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

describe('DefaultOpenAICompatibleProvider', () => {
  let provider: DefaultOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

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

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        baseURL: 'https://api.openai.com/v1',
        timeout: 60000,
        maxRetries: 2,
        defaultHeaders: {
          'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
        },
      });

      expect(client).toBeDefined();
    });

    it('should use default timeout and maxRetries when not provided', () => {
      mockContentGeneratorConfig.timeout = undefined;
      mockContentGeneratorConfig.maxRetries = undefined;

      provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        baseURL: 'https://api.openai.com/v1',
        timeout: DEFAULT_TIMEOUT,
        maxRetries: DEFAULT_MAX_RETRIES,
        defaultHeaders: {
          'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
        },
      });
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

      expect(result).toEqual(minimalRequest);
    });

    it('should handle streaming requests', () => {
      const streamingRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      };

      const result = provider.buildRequest(streamingRequest, 'prompt-id');

      expect(result).toEqual(streamingRequest);
      expect(result.stream).toBe(true);
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
  });
});
