/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  type MockedFunction,
} from 'vitest';
import type { ContentGeneratorConfig } from '../../../contentGenerator.js';
import { AuthType } from '../../../contentGenerator.js';
import { BedrockOpenAICompatibleProvider } from './provider.js';
import type { Config } from '../../../../config/config.js';

describe('BedrockOpenAICompatibleProvider', () => {
  let mockConfig: Config;
  let contentGeneratorConfig: ContentGeneratorConfig;

  beforeEach(() => {
    // Mock the Config interface
    mockConfig = {
      getCliVersion: vi.fn().mockReturnValue('0.0.14'),
    } as unknown as Config;

    contentGeneratorConfig = {
      model: 'qwen.qwen3-coder-30b-a3b-v1:0',
      authType: AuthType.USE_BEDROCK,
      timeout: 60000,
      maxRetries: 3,
    };
  });

  describe('constructor', () => {
    it('should initialize with provided configs', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      expect(provider).toBeInstanceOf(BedrockOpenAICompatibleProvider);
    });

    it('should use default timeout when not provided', () => {
      const configWithoutTimeout = {
        ...contentGeneratorConfig,
        timeout: undefined,
      };
      const provider = new BedrockOpenAICompatibleProvider(
        configWithoutTimeout,
        mockConfig,
      );
      expect(provider).toBeInstanceOf(BedrockOpenAICompatibleProvider);
    });

    it('should use default maxRetries when not provided', () => {
      const configWithoutRetries = {
        ...contentGeneratorConfig,
        maxRetries: undefined,
      };
      const provider = new BedrockOpenAICompatibleProvider(
        configWithoutRetries,
        mockConfig,
      );
      expect(provider).toBeInstanceOf(BedrockOpenAICompatibleProvider);
    });
  });

  describe('isBedrockProvider', () => {
    it('should return true for Bedrock auth type', () => {
      expect(
        BedrockOpenAICompatibleProvider.isBedrockProvider(
          contentGeneratorConfig,
        ),
      ).toBe(true);
    });

    it('should return false for non-Bedrock auth type', () => {
      const config = {
        ...contentGeneratorConfig,
        authType: AuthType.USE_OPENAI,
      };
      expect(BedrockOpenAICompatibleProvider.isBedrockProvider(config)).toBe(
        false,
      );
    });

    it('should return false for QWEN_OAUTH auth type', () => {
      const config = {
        ...contentGeneratorConfig,
        authType: AuthType.QWEN_OAUTH,
      };
      expect(BedrockOpenAICompatibleProvider.isBedrockProvider(config)).toBe(
        false,
      );
    });

    it('should return false for undefined auth type', () => {
      const config = {
        ...contentGeneratorConfig,
        authType: undefined,
      };
      expect(
        BedrockOpenAICompatibleProvider.isBedrockProvider(
          config as ContentGeneratorConfig,
        ),
      ).toBe(false);
    });
  });

  describe('buildHeaders', () => {
    it('should build headers with user agent', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const headers = provider.buildHeaders();

      expect(headers).toHaveProperty('User-Agent');
      expect(headers['User-Agent']).toBe(
        `QwenCode/0.0.14 (${process.platform}; ${process.arch})`,
      );
    });

    it('should handle unknown CLI version', () => {
      (
        mockConfig.getCliVersion as MockedFunction<
          typeof mockConfig.getCliVersion
        >
      ).mockReturnValue(undefined);

      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const headers = provider.buildHeaders();

      expect(headers['User-Agent']).toBe(
        `QwenCode/unknown (${process.platform}; ${process.arch})`,
      );
    });

    it('should handle null CLI version', () => {
      (
        mockConfig.getCliVersion as MockedFunction<
          typeof mockConfig.getCliVersion
        >
      ).mockReturnValue(null as never);

      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const headers = provider.buildHeaders();

      expect(headers['User-Agent']).toBe(
        `QwenCode/unknown (${process.platform}; ${process.arch})`,
      );
    });
  });

  describe('buildClient', () => {
    it('should build a client with chat completions interface', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const client = provider.buildClient();

      expect(client).toHaveProperty('chat');
      expect(client.chat).toHaveProperty('completions');
      expect(client.chat.completions).toHaveProperty('create');
      expect(typeof client.chat.completions.create).toBe('function');
    });

    it('should use configured timeout value', () => {
      const configWithCustomTimeout = {
        ...contentGeneratorConfig,
        timeout: 120000,
      };
      const provider = new BedrockOpenAICompatibleProvider(
        configWithCustomTimeout,
        mockConfig,
      );
      const client = provider.buildClient();

      expect(client).toBeDefined();
    });

    it('should use default timeout when not provided', () => {
      const configWithoutTimeout = {
        ...contentGeneratorConfig,
        timeout: undefined,
      };
      const provider = new BedrockOpenAICompatibleProvider(
        configWithoutTimeout,
        mockConfig,
      );
      const client = provider.buildClient();

      expect(client).toBeDefined();
    });

    it('should use configured maxRetries value', () => {
      const configWithCustomRetries = {
        ...contentGeneratorConfig,
        maxRetries: 5,
      };
      const provider = new BedrockOpenAICompatibleProvider(
        configWithCustomRetries,
        mockConfig,
      );
      const client = provider.buildClient();

      expect(client).toBeDefined();
    });

    it('should use default maxRetries when not provided', () => {
      const configWithoutRetries = {
        ...contentGeneratorConfig,
        maxRetries: undefined,
      };
      const provider = new BedrockOpenAICompatibleProvider(
        configWithoutRetries,
        mockConfig,
      );
      const client = provider.buildClient();

      expect(client).toBeDefined();
    });
  });

  describe('buildRequest', () => {
    it('should pass through request without modification', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const request = {
        model: 'qwen.qwen3-coder-30b-a3b-v1:0',
        messages: [{ role: 'user' as const, content: 'Hello' }],
      };

      const result = provider.buildRequest(request, 'test-prompt-id');
      expect(result).toEqual(request);
    });

    it('should preserve all request parameters', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const complexRequest = {
        model: 'qwen.qwen3-coder-30b-a3b-v1:0',
        messages: [
          { role: 'system' as const, content: 'You are helpful' },
          { role: 'user' as const, content: 'Hello' },
        ],
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 0.9,
        stream: false,
      };

      const result = provider.buildRequest(complexRequest, 'test-prompt-id');
      expect(result).toEqual(complexRequest);
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(1000);
      expect(result.top_p).toBe(0.9);
      expect(result.stream).toBe(false);
    });

    it('should handle minimal request', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const minimalRequest = {
        model: 'qwen.qwen3-coder-30b-a3b-v1:0',
        messages: [{ role: 'user' as const, content: 'Hi' }],
      };

      const result = provider.buildRequest(minimalRequest, 'prompt-id');
      expect(result).toEqual(minimalRequest);
    });

    it('should handle streaming requests', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const streamRequest = {
        model: 'qwen.qwen3-coder-30b-a3b-v1:0',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        stream: true,
      };

      const result = provider.buildRequest(streamRequest, 'prompt-id');
      expect(result).toEqual(streamRequest);
      expect(result.stream).toBe(true);
    });

    it('should not modify the original request object', () => {
      const provider = new BedrockOpenAICompatibleProvider(
        contentGeneratorConfig,
        mockConfig,
      );
      const originalRequest = {
        model: 'qwen.qwen3-coder-30b-a3b-v1:0',
        messages: [{ role: 'user' as const, content: 'Hello' }],
        temperature: 0.5,
      };
      const originalCopy = { ...originalRequest };

      const result = provider.buildRequest(originalRequest, 'prompt-id');

      // Original should be unchanged
      expect(originalRequest).toEqual(originalCopy);
      // Result should equal original
      expect(result).toEqual(originalRequest);
    });
  });
});
