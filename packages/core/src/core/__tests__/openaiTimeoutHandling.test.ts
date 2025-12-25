/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIContentGenerator } from '../openaiContentGenerator/openaiContentGenerator.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from '../openaiContentGenerator/provider/index.js';
import OpenAI from 'openai';

// Mock OpenAI
vi.mock('openai');

// Mock logger modules
vi.mock('../../telemetry/loggers.js', () => ({
  logApiResponse: vi.fn(),
  logApiError: vi.fn(),
}));

vi.mock('../../utils/openaiLogger.js', () => ({
  OpenAILogger: vi.fn().mockImplementation(() => ({
    logInteraction: vi.fn(),
  })),
  openaiLogger: {
    logInteraction: vi.fn(),
  },
}));

describe('OpenAIContentGenerator Timeout Handling', () => {
  let generator: OpenAIContentGenerator;
  let mockConfig: Config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOpenAIClient: any;
  let mockProvider: OpenAICompatibleProvider;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock environment variables
    vi.stubEnv('OPENAI_BASE_URL', '');

    // Mock config
    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'openai',
        enableOpenAILogging: false,
      }),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    // Mock OpenAI client
    mockOpenAIClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
      embeddings: {
        create: vi.fn(),
      },
    };

    vi.mocked(OpenAI).mockImplementation(() => mockOpenAIClient);

    // Create mock provider
    mockProvider = {
      buildHeaders: vi.fn().mockReturnValue({
        'User-Agent': 'QwenCode/1.0.0 (test; test)',
      }),
      buildClient: vi.fn().mockReturnValue(mockOpenAIClient),
      buildRequest: vi.fn().mockImplementation((req) => req),
      getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
    };

    // Create generator instance
    const contentGeneratorConfig = {
      model: 'gpt-4',
      apiKey: 'test-key',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    };
    generator = new OpenAIContentGenerator(
      contentGeneratorConfig,
      mockConfig,
      mockProvider,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('timeout error identification through actual requests', () => {
    it('should handle various timeout error formats correctly', async () => {
      const timeoutErrors = [
        new Error('Request timeout'),
        new Error('Connection timed out'),
        new Error('ETIMEDOUT'),
        Object.assign(new Error('Network error'), { code: 'ETIMEDOUT' }),
        Object.assign(new Error('Socket error'), { code: 'ESOCKETTIMEDOUT' }),
        Object.assign(new Error('API error'), { type: 'timeout' }),
        new Error('request timed out'),
        new Error('deadline exceeded'),
      ];

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      for (const error of timeoutErrors) {
        mockOpenAIClient.chat.completions.create.mockRejectedValueOnce(error);

        try {
          await generator.generateContent(request, 'test-prompt-id');
        } catch (thrownError: unknown) {
          // Should contain timeout-specific messaging and troubleshooting tips
          const errorMessage =
            thrownError instanceof Error
              ? thrownError.message
              : String(thrownError);
          expect(errorMessage).toMatch(
            /timeout after \d+s|Troubleshooting tips:/,
          );
        }
      }
    });

    it('should handle non-timeout errors without timeout messaging', async () => {
      const nonTimeoutErrors = [
        new Error('Invalid API key'),
        new Error('Rate limit exceeded'),
        new Error('Model not found'),
        Object.assign(new Error('Auth error'), { code: 'INVALID_REQUEST' }),
        Object.assign(new Error('API error'), { type: 'authentication_error' }),
      ];

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      for (const error of nonTimeoutErrors) {
        mockOpenAIClient.chat.completions.create.mockRejectedValueOnce(error);

        try {
          await generator.generateContent(request, 'test-prompt-id');
        } catch (thrownError: unknown) {
          // Should NOT contain timeout-specific messaging
          const errorMessage =
            thrownError instanceof Error
              ? thrownError.message
              : String(thrownError);
          expect(errorMessage).not.toMatch(/timeout after \d+s/);
          expect(errorMessage).not.toMatch(/Troubleshooting tips:/);
          // Should preserve the original error message
          expect(errorMessage).toMatch(new RegExp(error.message));
        }
      }
    });
  });

  describe('generateContent timeout handling', () => {
    it('should handle timeout errors with helpful message', async () => {
      // Mock timeout error
      const timeoutError = new Error('Request timeout');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow(
        /Request timeout after \d+s\. Try reducing input length or increasing timeout in config\./,
      );
    });

    it('should handle non-timeout errors normally', async () => {
      // Mock non-timeout error
      const apiError = new Error('Invalid API key');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Invalid API key');
    });

    it('should include troubleshooting tips for timeout errors', async () => {
      const timeoutError = new Error('Connection timed out');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      try {
        await generator.generateContent(request, 'test-prompt-id');
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        expect(errorMessage).toContain('Troubleshooting tips:');
        expect(errorMessage).toContain('Reduce input length or complexity');
        expect(errorMessage).toContain('Increase timeout in config');
        expect(errorMessage).toContain('Check network connectivity');
        expect(errorMessage).toContain('Consider using streaming mode');
      }
    });
  });

  describe('generateContentStream timeout handling', () => {
    it('should handle streaming timeout errors', async () => {
      const timeoutError = new Error('Streaming timeout');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContentStream(request, 'test-prompt-id'),
      ).rejects.toThrow(
        /Streaming request timeout after \d+s\. Try reducing input length or increasing timeout in config\./,
      );
    });

    it('should include streaming-specific troubleshooting tips', async () => {
      const timeoutError = new Error('request timed out');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      try {
        await generator.generateContentStream(request, 'test-prompt-id');
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        expect(errorMessage).toContain('Streaming timeout troubleshooting:');
        expect(errorMessage).toContain('Check network connectivity');
        expect(errorMessage).toContain('Consider using non-streaming mode');
      }
    });
  });

  describe('timeout configuration', () => {
    it('should use default timeout configuration', () => {
      const contentGeneratorConfig = {
        model: 'gpt-4',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:8080',
      };
      new OpenAIContentGenerator(
        contentGeneratorConfig,
        mockConfig,
        mockProvider,
      );

      // Verify provider buildClient was called
      expect(mockProvider.buildClient).toHaveBeenCalled();
    });

    it('should use custom timeout from config', () => {
      const customConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          enableOpenAILogging: false,
        }),
        getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      } as unknown as Config;

      const contentGeneratorConfig = {
        model: 'gpt-4',
        apiKey: 'test-key',
        baseUrl: 'http://localhost:8080',
        authType: AuthType.USE_OPENAI,
        timeout: 300000,
        maxRetries: 5,
      };

      // Create a custom mock provider for this test
      const customMockProvider: OpenAICompatibleProvider = {
        buildHeaders: vi.fn().mockReturnValue({
          'User-Agent': 'QwenCode/1.0.0 (test; test)',
        }),
        buildClient: vi.fn().mockReturnValue(mockOpenAIClient),
        buildRequest: vi.fn().mockImplementation((req) => req),
        getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
      };

      new OpenAIContentGenerator(
        contentGeneratorConfig,
        customConfig,
        customMockProvider,
      );

      // Verify provider buildClient was called
      expect(customMockProvider.buildClient).toHaveBeenCalled();
    });

    it('should handle missing timeout config gracefully', () => {
      const noTimeoutConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          enableOpenAILogging: false,
        }),
        getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      } as unknown as Config;

      const contentGeneratorConfig = {
        model: 'gpt-4',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'http://localhost:8080',
      };

      // Create a custom mock provider for this test
      const noTimeoutMockProvider: OpenAICompatibleProvider = {
        buildHeaders: vi.fn().mockReturnValue({
          'User-Agent': 'QwenCode/1.0.0 (test; test)',
        }),
        buildClient: vi.fn().mockReturnValue(mockOpenAIClient),
        buildRequest: vi.fn().mockImplementation((req) => req),
        getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
      };

      new OpenAIContentGenerator(
        contentGeneratorConfig,
        noTimeoutConfig,
        noTimeoutMockProvider,
      );

      // Verify provider buildClient was called
      expect(noTimeoutMockProvider.buildClient).toHaveBeenCalled();
    });
  });

  describe('token estimation on timeout', () => {
    it('should surface a clear timeout error when request times out', async () => {
      const timeoutError = new Error('Request timeout');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow(/Request timeout after \d+s/);
    });

    it('should fall back to character-based estimation if countTokens fails', async () => {
      const timeoutError = new Error('Request timeout');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      // Mock countTokens to throw error
      const mockCountTokens = vi.spyOn(generator, 'countTokens');
      mockCountTokens.mockRejectedValue(new Error('Count tokens failed'));

      const request = {
        contents: [{ role: 'user' as const, parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      // Should not throw due to token counting failure
      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow(/Request timeout after \d+s/);
    });
  });
});
