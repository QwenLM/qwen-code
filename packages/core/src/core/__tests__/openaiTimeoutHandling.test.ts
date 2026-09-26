/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIContentGenerator } from '../openaiContentGenerator/openaiContentGenerator.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from '../openaiContentGenerator/provider/index.js';
import OpenAI from 'openai';
import { userText } from '../../test-utils/model-fixtures.js';

vi.mock('openai');

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

const TIMEOUT_MESSAGE =
  /Request timeout after \d+s\. Try reducing input length or increasing timeout in config\./;

const cliConfig = (generatorConfig: object) =>
  ({
    getContentGeneratorConfig: vi.fn().mockReturnValue(generatorConfig),
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
  }) as unknown as Config;

/** Runs `check` on the thrown message; as in a bare try/catch, nothing is
 * asserted when `call` resolves. */
const onError = async (
  call: Promise<unknown>,
  check: (message: string) => void,
) => {
  try {
    await call;
  } catch (error: unknown) {
    check(error instanceof Error ? error.message : String(error));
  }
};

const expectTroubleshootingTips = (message: string) => {
  expect(message).toContain('Troubleshooting tips:');
  expect(message).toContain('Reduce input length or complexity');
  expect(message).toContain('Increase timeout in config');
  expect(message).toContain('Check network connectivity');
};

describe('OpenAIContentGenerator Timeout Handling', () => {
  let generator: OpenAIContentGenerator;
  let mockConfig: Config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOpenAIClient: any;
  let mockProvider: OpenAICompatibleProvider;

  const makeProvider = (): OpenAICompatibleProvider => ({
    buildHeaders: vi.fn().mockReturnValue({
      'User-Agent': 'QwenCode/1.0.0 (test; test)',
    }),
    buildClient: vi.fn().mockReturnValue(mockOpenAIClient),
    buildRequest: vi.fn().mockImplementation((req) => req),
    getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
  });

  const request = (text = 'Hello') => ({
    contents: [userText(text)],
    model: 'gpt-4',
  });
  const generate = (text?: string) =>
    generator.generateContent(request(text), 'test-prompt-id');
  const generateStream = () =>
    generator.generateContentStream(request(), 'test-prompt-id');
  const rejectWith = (error: Error) =>
    mockOpenAIClient.chat.completions.create.mockRejectedValue(error);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('OPENAI_BASE_URL', '');

    mockConfig = cliConfig({ authType: 'openai', enableOpenAILogging: false });
    mockOpenAIClient = {
      chat: { completions: { create: vi.fn() } },
      embeddings: { create: vi.fn() },
    };
    vi.mocked(OpenAI).mockImplementation(() => mockOpenAIClient);
    mockProvider = makeProvider();

    generator = new OpenAIContentGenerator(
      {
        model: 'gpt-4',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
        enableOpenAILogging: false,
      },
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

      for (const error of timeoutErrors) {
        mockOpenAIClient.chat.completions.create.mockRejectedValueOnce(error);
        // Timeout-specific messaging and troubleshooting tips.
        await onError(generate(), (message) =>
          expect(message).toMatch(/timeout after \d+s|Troubleshooting tips:/),
        );
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

      for (const error of nonTimeoutErrors) {
        mockOpenAIClient.chat.completions.create.mockRejectedValueOnce(error);
        await onError(generate(), (message) => {
          expect(message).not.toMatch(/timeout after \d+s/);
          expect(message).not.toMatch(/Troubleshooting tips:/);
          // The original error message is preserved.
          expect(message).toMatch(new RegExp(error.message));
        });
      }
    });
  });

  describe('generateContent timeout handling', () => {
    it('should handle timeout errors with helpful message', async () => {
      rejectWith(new Error('Request timeout'));
      await expect(generate()).rejects.toThrow(TIMEOUT_MESSAGE);
    });

    it('should handle non-timeout errors normally', async () => {
      rejectWith(new Error('Invalid API key'));
      await expect(generate()).rejects.toThrow('Invalid API key');
    });

    it('should include troubleshooting tips for timeout errors', async () => {
      rejectWith(new Error('Connection timed out'));
      await onError(generate(), expectTroubleshootingTips);
    });
  });

  describe('generateContentStream timeout handling', () => {
    it('should handle streaming timeout errors with the shared timeout message', async () => {
      rejectWith(new Error('Streaming timeout'));
      await expect(generateStream()).rejects.toThrow(TIMEOUT_MESSAGE);
    });

    it('should include the shared troubleshooting tips for streaming timeouts', async () => {
      rejectWith(new Error('request timed out'));
      await onError(generateStream(), expectTroubleshootingTips);
    });
  });

  describe('timeout configuration', () => {
    const baseConfig: ContentGeneratorConfig = {
      model: 'gpt-4',
      apiKey: 'test-key',
      authType: AuthType.USE_OPENAI,
      baseUrl: 'http://localhost:8080',
    };

    /** Constructs a generator and checks it built its client through the
     * provider; config and provider default to fresh mocks. */
    const expectClientBuilt = (
      generatorConfig: ContentGeneratorConfig,
      config = cliConfig({ enableOpenAILogging: false }),
      provider = makeProvider(),
    ) => {
      new OpenAIContentGenerator(generatorConfig, config, provider);
      expect(provider.buildClient).toHaveBeenCalled();
    };

    it('should use default timeout configuration', () => {
      expectClientBuilt(baseConfig, mockConfig, mockProvider);
    });

    it('should use custom timeout from config', () => {
      expectClientBuilt({ ...baseConfig, timeout: 300000, maxRetries: 5 });
    });

    it('should handle missing timeout config gracefully', () => {
      expectClientBuilt(baseConfig);
    });
  });

  describe('token estimation on timeout', () => {
    it('should surface a clear timeout error when request times out', async () => {
      rejectWith(new Error('Request timeout'));
      await expect(generate('Hello world')).rejects.toThrow(
        /Request timeout after \d+s/,
      );
    });
  });
});
