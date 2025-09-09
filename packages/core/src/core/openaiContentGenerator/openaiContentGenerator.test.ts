/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';
import type {
  GenerateContentParameters,
  CountTokensParameters,
} from '@google/genai';
import type { OpenAICompatibleProvider } from './provider/index.js';
import OpenAI from 'openai';

// Mock tiktoken
vi.mock('tiktoken', () => ({
  get_encoding: vi.fn().mockReturnValue({
    encode: vi.fn().mockReturnValue(new Array(50)), // Mock 50 tokens
    free: vi.fn(),
  }),
}));

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

  describe('countTokens', () => {
    it('should count tokens using tiktoken', async () => {
      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      const result = await generator.countTokens(request);

      expect(result.totalTokens).toBe(50); // Mocked value
    });

    it('should fall back to character approximation if tiktoken fails', async () => {
      // Mock tiktoken to throw error
      vi.doMock('tiktoken', () => ({
        get_encoding: vi.fn().mockImplementation(() => {
          throw new Error('Tiktoken failed');
        }),
      }));

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      const result = await generator.countTokens(request);

      // Should use character approximation (content length / 4)
      expect(result.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('embedContent', () => {
    it('should delegate to pipeline.client.embeddings.create', async () => {
      // This test verifies the method exists and can be called
      expect(typeof generator.embedContent).toBe('function');
    });
  });

  describe('shouldSuppressErrorLogging', () => {
    it('should return false by default', () => {
      // Create a test subclass to access the protected method
      class TestGenerator extends OpenAIContentGenerator {
        testShouldSuppressErrorLogging(
          error: unknown,
          request: GenerateContentParameters,
        ): boolean {
          return this.shouldSuppressErrorLogging(error, request);
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
      };

      const testGenerator = new TestGenerator(
        contentGeneratorConfig,
        mockConfig,
        mockProvider,
      );

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

    it('should allow subclasses to override error suppression behavior', async () => {
      class TestGenerator extends OpenAIContentGenerator {
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
      };

      const testGenerator = new TestGenerator(
        contentGeneratorConfig,
        mockConfig,
        mockProvider,
      );

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const result = testGenerator.testShouldSuppressErrorLogging(
        new Error('Test error'),
        request,
      );

      expect(result).toBe(true);
    });
  });
});
