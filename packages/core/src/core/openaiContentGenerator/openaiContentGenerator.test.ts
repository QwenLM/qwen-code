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
import { userText } from '../../test-utils/model-fixtures.js';

const samplingParams = () => ({
  temperature: 0.7,
  max_tokens: 1000,
  top_p: 0.9,
});

const createContentGeneratorConfig = () => ({
  model: 'gpt-4',
  apiKey: 'test-key',
  authType: AuthType.USE_OPENAI,
  enableOpenAILogging: false,
  timeout: 120000,
  maxRetries: 3,
  samplingParams: samplingParams(),
});

/** A minimal mock provider. */
const createMockProvider = (): OpenAICompatibleProvider => ({
  buildHeaders: vi.fn().mockReturnValue({}),
  buildClient: vi.fn().mockReturnValue({
    chat: { completions: { create: vi.fn() } },
    embeddings: { create: vi.fn() },
  } as unknown as OpenAI),
  buildRequest: vi.fn().mockImplementation((req) => req),
  getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
});

describe('OpenAIContentGenerator (Refactored)', () => {
  let generator: OpenAIContentGenerator;
  let mockConfig: Config;

  const generatorArgs = () =>
    [createContentGeneratorConfig(), mockConfig, createMockProvider()] as const;

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'openai',
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: samplingParams(),
      }),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    } as unknown as Config;

    generator = new OpenAIContentGenerator(...generatorArgs());
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
          client: { embeddings: { create: ReturnType<typeof vi.fn> } };
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
    // A test subclass to access the protected method
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
      testGenerator = new TestGenerator(...generatorArgs());
    });

    const abortError = () =>
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
      });

    /** Asks `target` about `error` on a 'Hello' request, optionally carrying an aborted or live signal. */
    const suppresses = (
      error: unknown,
      signal?: 'aborted' | 'live',
      target: TestGenerator = testGenerator,
    ) => {
      const request: GenerateContentParameters = {
        contents: [userText('Hello')],
        model: 'gpt-4',
      };
      if (signal) {
        const abortController = new AbortController();
        if (signal === 'aborted') abortController.abort();
        request.config = { abortSignal: abortController.signal };
      }
      return target.testShouldSuppressErrorLogging(error, request);
    };

    it('should return false for regular errors', () => {
      expect(suppresses(new Error('Test error'))).toBe(false);
    });

    it('should return true for AbortError when signal is also aborted (user cancellation)', () => {
      expect(suppresses(abortError(), 'aborted')).toBe(true);
    });

    it('should return false for AbortError when signal is NOT aborted (network abort)', () => {
      // AbortError but signal not aborted - could be network issue
      expect(suppresses(abortError(), 'live')).toBe(false);
    });

    it('should return false for AbortError without any signal', () => {
      // AbortError but no signal at all - unknown source
      expect(suppresses(abortError())).toBe(false);
    });

    it('should return false for non-AbortError even when signal is aborted', () => {
      // Regular error even though signal is aborted - should still be logged
      expect(suppresses(new Error('Network error'), 'aborted')).toBe(false);
    });

    it('should return false for errors with non-aborted signal', () => {
      expect(suppresses(new Error('Network error'), 'live')).toBe(false);
    });

    it('should allow subclasses to override error suppression behavior', async () => {
      class CustomTestGenerator extends TestGenerator {
        protected override shouldSuppressErrorLogging(
          _error: unknown,
          _request: GenerateContentParameters,
        ): boolean {
          return true; // Always suppress for this test
        }
      }

      const customGenerator = new CustomTestGenerator(...generatorArgs());
      expect(
        suppresses(new Error('Test error'), undefined, customGenerator),
      ).toBe(true);
    });
  });
});
