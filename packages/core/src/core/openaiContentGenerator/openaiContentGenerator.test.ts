/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';
import type { GenerateContentParameters } from '@google/genai';
import type { OpenAICompatibleProvider } from './provider/index.js';
import type OpenAI from 'openai';

describe('OpenAIContentGenerator (Refactored)', () => {
  let generator: OpenAIContentGenerator;
  let mockConfig: Config;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock config
    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'openai',
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        },
      }),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    // Create generator instance
    const contentGeneratorConfig = {
      model: 'gpt-4',
      apiKey: 'test-key',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
      timeout: 120000,
      maxRetries: 3,
      samplingParams: {
        temperature: 0.7,
        max_tokens: 1000,
        top_p: 0.9,
      },
    };

    // Create a minimal mock provider
    const mockProvider: OpenAICompatibleProvider = {
      buildHeaders: vi.fn().mockReturnValue({}),
      buildClient: vi.fn().mockReturnValue({
        chat: {
          completions: {
            create: vi.fn(),
          },
        },
        embeddings: {
          create: vi.fn(),
        },
      } as unknown as OpenAI),
      buildRequest: vi.fn().mockImplementation((req) => req),
      getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
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

  describe('constructor', () => {
    it('should initialize with basic configuration', () => {
      expect(generator).toBeDefined();
    });
  });

  describe('generateContent', () => {
    it('should delegate to pipeline.execute', async () => {
      // This test verifies the method exists and can be called
      expect(typeof generator.generateContent).toBe('function');
    });
  });

  describe('generateContentStream', () => {
    it('should delegate to pipeline.executeStream', async () => {
      // This test verifies the method exists and can be called
      expect(typeof generator.generateContentStream).toBe('function');
    });
  });

  describe('embedContent', () => {
    it('should delegate to pipeline.client.embeddings.create', async () => {
      // This test verifies the method exists and can be called
      expect(typeof generator.embedContent).toBe('function');
    });

    it('should redact proxy credentials from embedding request errors', async () => {
      const generatorWithClient = generator as unknown as {
        pipeline: {
          client: {
            embeddings: {
              create: ReturnType<typeof vi.fn>;
            };
          };
        };
      };
      generatorWithClient.pipeline.client.embeddings.create.mockRejectedValue(
        new Error('connect ECONNREFUSED token@proxy.local:8080'),
      );

      await expect(
        generator.embedContent({
          model: 'text-embedding-ada-002',
          contents: 'hello',
        }),
      ).rejects.toThrow(
        'OpenAI API error: connect ECONNREFUSED <redacted>@proxy.local:8080',
      );
    });
  });

  describe('shouldSuppressErrorLogging', () => {
    // Create a test subclass to access the protected method
    class TestGenerator extends OpenAIContentGenerator {
      testShouldSuppressErrorLogging(
        error: unknown,
        request: GenerateContentParameters,
      ): boolean {
        return this.shouldSuppressErrorLogging(error, request);
      }
    }

    let testGenerator: TestGenerator;

    beforeEach(() => {
      const contentGeneratorConfig = {
        model: 'gpt-4',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        },
      };

      // Create a minimal mock provider
      const mockProvider: OpenAICompatibleProvider = {
        buildHeaders: vi.fn().mockReturnValue({}),
        buildClient: vi.fn().mockReturnValue({
          chat: {
            completions: {
              create: vi.fn(),
            },
          },
          embeddings: {
            create: vi.fn(),
          },
        } as unknown as OpenAI),
        buildRequest: vi.fn().mockImplementation((req) => req),
        getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
      };

      testGenerator = new TestGenerator(
        contentGeneratorConfig,
        mockConfig,
        mockProvider,
      );
    });

    it('should return false for regular errors', () => {
      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const result = testGenerator.testShouldSuppressErrorLogging(
        new Error('Test error'),
        request,
      );

      expect(result).toBe(false);
    });

    it('should return true for AbortError when signal is also aborted (user cancellation)', () => {
      const abortController = new AbortController();
      abortController.abort();

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          abortSignal: abortController.signal,
        },
      };

      // Create an AbortError with aborted signal - this is user-initiated
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      const result = testGenerator.testShouldSuppressErrorLogging(
        abortError,
        request,
      );

      expect(result).toBe(true);
    });

    it('should return false for AbortError when signal is NOT aborted (network abort)', () => {
      const abortController = new AbortController();
      // Signal is NOT aborted - this simulates a network abort

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          abortSignal: abortController.signal,
        },
      };

      // AbortError but signal not aborted - could be network issue
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      const result = testGenerator.testShouldSuppressErrorLogging(
        abortError,
        request,
      );

      expect(result).toBe(false);
    });

    it('should return false for AbortError without any signal', () => {
      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      // AbortError but no signal at all - unknown source
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';

      const result = testGenerator.testShouldSuppressErrorLogging(
        abortError,
        request,
      );

      expect(result).toBe(false);
    });

    it('should return false for non-AbortError even when signal is aborted', () => {
      const abortController = new AbortController();
      abortController.abort();

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          abortSignal: abortController.signal,
        },
      };

      // Regular error even though signal is aborted - should still be logged
      const result = testGenerator.testShouldSuppressErrorLogging(
        new Error('Network error'),
        request,
      );

      expect(result).toBe(false);
    });

    it('should return false for errors with non-aborted signal', () => {
      const abortController = new AbortController();

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          abortSignal: abortController.signal,
        },
      };

      const result = testGenerator.testShouldSuppressErrorLogging(
        new Error('Network error'),
        request,
      );

      expect(result).toBe(false);
    });

    it('should allow subclasses to override error suppression behavior', async () => {
      class CustomTestGenerator extends OpenAIContentGenerator {
        testShouldSuppressErrorLogging(
          error: unknown,
          request: GenerateContentParameters,
        ): boolean {
          return this.shouldSuppressErrorLogging(error, request);
        }

        protected override shouldSuppressErrorLogging(
          _error: unknown,
          _request: GenerateContentParameters,
        ): boolean {
          return true; // Always suppress for this test
        }
      }

      const contentGeneratorConfig = {
        model: 'gpt-4',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        },
      };

      // Create a minimal mock provider
      const mockProvider: OpenAICompatibleProvider = {
        buildHeaders: vi.fn().mockReturnValue({}),
        buildClient: vi.fn().mockReturnValue({
          chat: {
            completions: {
              create: vi.fn(),
            },
          },
          embeddings: {
            create: vi.fn(),
          },
        } as unknown as OpenAI),
        buildRequest: vi.fn().mockImplementation((req) => req),
        getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
      };

      const customGenerator = new CustomTestGenerator(
        contentGeneratorConfig,
        mockConfig,
        mockProvider,
      );

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const result = customGenerator.testShouldSuppressErrorLogging(
        new Error('Test error'),
        request,
      );

      expect(result).toBe(true);
    });
  });
});
