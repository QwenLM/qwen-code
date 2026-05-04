/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountTokensParameters,
  GenerateContentParameters,
} from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';

// Mock the request tokenizer module BEFORE importing the class that uses it.
const mockTokenizer = {
  calculateTokens: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('../../utils/request-tokenizer/index.js', () => ({
  RequestTokenEstimator: vi.fn(() => mockTokenizer),
}));

type AnthropicCreateArgs = [unknown, { signal?: AbortSignal }?];

const anthropicMockState: {
  constructorOptions?: Record<string, unknown>;
  lastCreateArgs?: AnthropicCreateArgs;
  createImpl: ReturnType<typeof vi.fn>;
} = {
  constructorOptions: undefined,
  lastCreateArgs: undefined,
  createImpl: vi.fn(),
};

vi.mock('@anthropic-ai/sdk', () => {
  class AnthropicMock {
    messages: { create: (...args: AnthropicCreateArgs) => unknown };

    constructor(options: Record<string, unknown>) {
      anthropicMockState.constructorOptions = options;
      this.messages = {
        create: (...args: AnthropicCreateArgs) => {
          anthropicMockState.lastCreateArgs = args;
          return anthropicMockState.createImpl(...args);
        },
      };
    }
  }

  return {
    default: AnthropicMock,
    __anthropicState: anthropicMockState,
  };
});

// Now import the modules that depend on the mocked modules.
import type { Config } from '../../config/config.js';

const importGenerator = async (): Promise<{
  AnthropicContentGenerator: typeof import('./anthropicContentGenerator.js').AnthropicContentGenerator;
}> => import('./anthropicContentGenerator.js');

const importConverter = async (): Promise<{
  AnthropicContentConverter: typeof import('./converter.js').AnthropicContentConverter;
}> => import('./converter.js');

describe('AnthropicContentGenerator', () => {
  let mockConfig: Config;
  let anthropicState: {
    constructorOptions?: Record<string, unknown>;
    lastCreateArgs?: AnthropicCreateArgs;
    createImpl: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockTokenizer.calculateTokens.mockResolvedValue({
      totalTokens: 50,
      breakdown: {
        textTokens: 50,
        imageTokens: 0,
        audioTokens: 0,
        otherTokens: 0,
      },
      processingTime: 1,
    });
    anthropicState = anthropicMockState;

    anthropicState.createImpl.mockReset();
    anthropicState.lastCreateArgs = undefined;
    anthropicState.constructorOptions = undefined;

    mockConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.2.3'),
      getProxy: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a QwenCode User-Agent header to the Anthropic SDK', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['User-Agent']).toContain('QwenCode/1.2.3');
    expect(headers['User-Agent']).toContain(
      `(${process.platform}; ${process.arch})`,
    );
  });

  it('merges customHeaders into defaultHeaders (does not replace defaults)', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
        reasoning: { effort: 'medium' },
        customHeaders: {
          'X-Custom': '1',
        },
      } as unknown as Record<string, unknown> as ContentGeneratorConfig,
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    // Beta headers moved out of defaultHeaders — see PR #3788 review feedback.
    // Only User-Agent and customHeaders remain at construction time.
    expect(headers['User-Agent']).toContain('QwenCode/1.2.3');
    expect(headers['X-Custom']).toBe('1');
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  // Per-request header behavior moved into the generateContent describe
  // block below — see "anthropic-beta header" cases.

  // Per-request anthropic-beta is computed from the actual fields present
  // in the request body (rather than the constructor-time reasoning config),
  // so the wire shape stays consistent when a per-request opt-out drops
  // `thinking` / `output_config`. See PR #3788 review feedback.
  describe('per-request anthropic-beta header', () => {
    const baseConfig: ContentGeneratorConfig = {
      model: 'claude-test',
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid',
      timeout: 10_000,
      maxRetries: 2,
      samplingParams: { max_tokens: 100 },
      schemaCompliance: 'auto',
    };

    async function callOnce(
      config: ContentGeneratorConfig,
      requestConfig?: object,
    ) {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });
      const generator = new AnthropicContentGenerator(config, mockConfig);
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
        ...(requestConfig ? { config: requestConfig } : {}),
      } as unknown as GenerateContentParameters);
      const [, options] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      return ((options as { headers?: Record<string, string> })?.headers ||
        {}) as Record<string, string>;
    }

    it('sends interleaved-thinking + effort beta when both are present in the body', async () => {
      const headers = await callOnce({
        ...baseConfig,
        reasoning: { effort: 'medium' },
      });
      expect(headers['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );
      expect(headers['anthropic-beta']).toContain('effort-2025-11-24');
    });

    it('sends only interleaved-thinking when effort is not set', async () => {
      const headers = await callOnce({
        ...baseConfig,
        // No reasoning config: thinking defaults to enabled, no effort.
      });
      expect(headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    });

    it('omits beta header when reasoning is disabled (no thinking, no effort)', async () => {
      const headers = await callOnce({ ...baseConfig, reasoning: false });
      expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('merges user-supplied customHeaders[anthropic-beta] with computed flags (no overwrite)', async () => {
      // Users configure additional Anthropic beta flags via customHeaders.
      // The per-request override must add to that list, not replace it.
      const headers = await callOnce({
        ...baseConfig,
        reasoning: { effort: 'medium' },
        customHeaders: { 'anthropic-beta': 'experimental-x,experimental-y' },
      });
      const beta = headers['anthropic-beta'] ?? '';
      expect(beta.split(',')).toEqual(
        expect.arrayContaining([
          'experimental-x',
          'experimental-y',
          'interleaved-thinking-2025-05-14',
          'effort-2025-11-24',
        ]),
      );
    });

    it('passes user-supplied customHeaders[anthropic-beta] through even when no thinking/effort is enabled', async () => {
      const headers = await callOnce({
        ...baseConfig,
        reasoning: false,
        customHeaders: { 'anthropic-beta': 'experimental-x' },
      });
      expect(headers['anthropic-beta']).toBe('experimental-x');
    });

    it('does not leak customHeaders[anthropic-beta] (any casing) into defaultHeaders', async () => {
      // The per-request path owns anthropic-beta. If we also copied a
      // mixed-case `Anthropic-Beta` from customHeaders into defaultHeaders,
      // the wire request would carry two physical headers for the same
      // logical name — one mixed-case (verbatim from defaultHeaders) and one
      // lowercase (from the per-request override). SDK behavior on duplicate
      // headers with different casings is undefined.
      const { AnthropicContentGenerator } = await importGenerator();
      void new AnthropicContentGenerator(
        {
          ...baseConfig,
          customHeaders: {
            'Anthropic-Beta': 'user-flag',
            'X-Other': 'kept',
          },
        },
        mockConfig,
      );
      const defaultHeaders = (anthropicState.constructorOptions?.[
        'defaultHeaders'
      ] || {}) as Record<string, string>;
      expect(defaultHeaders['Anthropic-Beta']).toBeUndefined();
      expect(defaultHeaders['anthropic-beta']).toBeUndefined();
      expect(defaultHeaders['ANTHROPIC-BETA']).toBeUndefined();
      // Unrelated customHeaders are still passed through.
      expect(defaultHeaders['X-Other']).toBe('kept');
    });

    it('honors customHeaders[anthropic-beta] under mixed-case keys (Anthropic-Beta / ANTHROPIC-BETA)', async () => {
      // HTTP header names are case-insensitive; Anthropic SDK lower-cases
      // headers when merging. Make sure our merge logic also matches
      // case-insensitively so the user-configured beta flag isn't silently
      // overwritten by the per-request value.
      const headersUpper = await callOnce({
        ...baseConfig,
        reasoning: { effort: 'medium' },
        customHeaders: { 'ANTHROPIC-BETA': 'experimental-x' },
      });
      expect(headersUpper['anthropic-beta']).toContain('experimental-x');
      expect(headersUpper['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );

      const headersTitle = await callOnce({
        ...baseConfig,
        reasoning: { effort: 'medium' },
        customHeaders: { 'Anthropic-Beta': 'experimental-y' },
      });
      expect(headersTitle['anthropic-beta']).toContain('experimental-y');
      expect(headersTitle['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );
    });

    it('dedupes beta flags so duplicates from customHeaders are not repeated', async () => {
      const headers = await callOnce({
        ...baseConfig,
        reasoning: { effort: 'medium' },
        customHeaders: {
          'anthropic-beta': 'interleaved-thinking-2025-05-14',
        },
      });
      const beta = headers['anthropic-beta'] ?? '';
      const occurrences = beta
        .split(',')
        .filter((f) => f.trim() === 'interleaved-thinking-2025-05-14');
      expect(occurrences).toHaveLength(1);
    });

    it('omits beta header when per-request thinkingConfig.includeThoughts=false', async () => {
      // Even though the global reasoning config sets effort, the per-request
      // opt-out drops both `thinking` and `output_config` from the body — and
      // the beta header must follow.
      const headers = await callOnce(
        { ...baseConfig, reasoning: { effort: 'medium' } },
        { thinkingConfig: { includeThoughts: false } },
      );
      expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('keeps customHeaders + User-Agent in defaultHeaders while sending computed anthropic-beta per-request', async () => {
      // The per-request override must NOT replace existing defaultHeaders
      // (User-Agent and unrelated customHeaders entries) — it should only
      // contribute the computed `anthropic-beta` flags. Defends against a
      // future regression where headers might be set via a path that wipes
      // out the constructor-time defaults.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });
      const generator = new AnthropicContentGenerator(
        {
          ...baseConfig,
          reasoning: { effort: 'medium' },
          customHeaders: { 'X-Custom': 'v1' },
        },
        mockConfig,
      );
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
      } as unknown as GenerateContentParameters);

      // defaultHeaders carries User-Agent and customHeaders (not beta).
      const defaultHeaders = (anthropicState.constructorOptions?.[
        'defaultHeaders'
      ] || {}) as Record<string, string>;
      expect(defaultHeaders['User-Agent']).toContain('QwenCode/1.2.3');
      expect(defaultHeaders['X-Custom']).toBe('v1');
      expect(defaultHeaders['anthropic-beta']).toBeUndefined();

      // Per-request headers carry only the computed beta flags.
      const [, options] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(reqHeaders['User-Agent']).toBeUndefined();
      expect(reqHeaders['X-Custom']).toBeUndefined();
      expect(reqHeaders['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );
    });

    it('also sends the computed beta header on streaming requests', async () => {
      // generateContentStream() goes through a separate code path from
      // generateContent(); make sure the per-request header attaches there
      // too so streaming Anthropic/DeepSeek requests stay consistent.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue(
        (async function* () {
          yield { type: 'message_stop' };
        })(),
      );

      const generator = new AnthropicContentGenerator(
        { ...baseConfig, reasoning: { effort: 'medium' } },
        mockConfig,
      );
      const stream = await generator.generateContentStream({
        model: 'models/ignored',
        contents: 'Hi',
      } as unknown as GenerateContentParameters);
      // Drain the stream so create() has been called.
      for await (const _chunk of stream) {
        void _chunk;
      }

      const [, options] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const headers = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(headers['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );
      expect(headers['anthropic-beta']).toContain('effort-2025-11-24');
    });
  });

  describe('generateContent', () => {
    it('builds request with config sampling params (config overrides request) and thinking budget', async () => {
      const { AnthropicContentConverter } = await importConverter();
      const { AnthropicContentGenerator } = await importGenerator();

      const convertResponseSpy = vi
        .spyOn(
          AnthropicContentConverter.prototype,
          'convertAnthropicResponseToGemini',
        )
        .mockReturnValue(
          (() => {
            const r = new GenerateContentResponse();
            r.responseId = 'gemini-1';
            return r;
          })(),
        );

      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          baseUrl: 'https://example.invalid',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {
            temperature: 0.7,
            max_tokens: 1000,
            top_p: 0.9,
            top_k: 20,
          },
          schemaCompliance: 'auto',
          reasoning: { effort: 'high', budget_tokens: 1000 },
        },
        mockConfig,
      );

      const abortController = new AbortController();
      const request: GenerateContentParameters = {
        model: 'models/ignored',
        contents: 'Hello',
        config: {
          temperature: 0.1,
          maxOutputTokens: 200,
          topP: 0.5,
          topK: 5,
          abortSignal: abortController.signal,
        },
      };

      const result = await generator.generateContent(request);
      expect(result.responseId).toBe('gemini-1');

      expect(anthropicState.lastCreateArgs).toBeDefined();
      const [anthropicRequest, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;

      expect(options?.signal).toBe(abortController.signal);

      expect(anthropicRequest).toEqual(
        expect.objectContaining({
          model: 'claude-test',
          max_tokens: 1000,
          temperature: 0.7,
          top_p: 0.9,
          top_k: 20,
          thinking: { type: 'enabled', budget_tokens: 1000 },
          output_config: { effort: 'high' },
        }),
      );

      expect(convertResponseSpy).toHaveBeenCalledTimes(1);
    });

    it('omits thinking when request.config.thinkingConfig.includeThoughts is false', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'high' },
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hello',
        config: { thinkingConfig: { includeThoughts: false } },
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(anthropicRequest).toEqual(
        expect.not.objectContaining({ thinking: expect.anything() }),
      );
    });

    describe('output token limits', () => {
      it('caps configured samplingParams.max_tokens to model output limit', async () => {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hi' }],
        });

        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-sonnet-4',
            apiKey: 'test-key',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: { max_tokens: 200_000 },
            schemaCompliance: 'auto',
          },
          mockConfig,
        );

        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
        } as unknown as GenerateContentParameters);

        const [anthropicRequest] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        expect(anthropicRequest).toEqual(
          expect.objectContaining({ max_tokens: 65536 }),
        );
      });

      it('caps request.config.maxOutputTokens to model output limit when config max_tokens is missing', async () => {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hi' }],
        });

        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-sonnet-4',
            apiKey: 'test-key',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: {},
            schemaCompliance: 'auto',
          },
          mockConfig,
        );

        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
          config: { maxOutputTokens: 100_000 },
        } as unknown as GenerateContentParameters);

        const [anthropicRequest] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        expect(anthropicRequest).toEqual(
          expect.objectContaining({ max_tokens: 65536 }),
        );
      });

      it('uses conservative default when max_tokens is not explicitly configured', async () => {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hi' }],
        });

        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-sonnet-4',
            apiKey: 'test-key',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: {},
            schemaCompliance: 'auto',
          },
          mockConfig,
        );

        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
        } as unknown as GenerateContentParameters);

        const [anthropicRequest] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        expect(anthropicRequest).toEqual(
          expect.objectContaining({ max_tokens: 8000 }),
        );
      });

      it('respects configured max_tokens for unknown models', async () => {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'unknown-model',
          content: [{ type: 'text', text: 'hi' }],
        });

        const generator = new AnthropicContentGenerator(
          {
            model: 'unknown-model',
            apiKey: 'test-key',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: { max_tokens: 100_000 },
            schemaCompliance: 'auto',
          },
          mockConfig,
        );

        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
        } as unknown as GenerateContentParameters);

        const [anthropicRequest] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        expect(anthropicRequest).toEqual(
          expect.objectContaining({ max_tokens: 100_000 }),
        );
      });

      it('treats null maxOutputTokens as not configured', async () => {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: 'hi' }],
        });

        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-sonnet-4',
            apiKey: 'test-key',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: {},
            schemaCompliance: 'auto',
          },
          mockConfig,
        );

        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
          config: { maxOutputTokens: null as unknown as undefined },
        } as unknown as GenerateContentParameters);

        const [anthropicRequest] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        expect(anthropicRequest).toEqual(
          expect.objectContaining({ max_tokens: 8000 }),
        );
      });
    });
  });

  // https://github.com/QwenLM/qwen-code/issues/3786 — DeepSeek's
  // anthropic-compatible API rejects requests in thinking mode when a prior
  // assistant turn carrying `tool_use` omits a thinking block. Plain-text
  // assistant turns without thinking are accepted unchanged.
  describe('DeepSeek anthropic-compatible provider', () => {
    // Helper: tool-use assistant turn missing thinking — the only shape that
    // actually triggers DeepSeek's HTTP 400.
    const toolUseConversation = [
      { role: 'user' as const, parts: [{ text: 'Run tool' }] },
      {
        role: 'model' as const,
        parts: [{ functionCall: { id: 't1', name: 'tool', args: {} } }],
      },
      {
        role: 'user' as const,
        parts: [
          {
            functionResponse: {
              id: 't1',
              name: 'tool',
              response: { output: 'ok' },
            },
          },
        ],
      },
    ];

    it('injects empty thinking blocks on tool-use assistant turns when baseUrl is api.deepseek.com', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'deepseek-v4-pro',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'deepseek-v4-pro',
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('detects deepseek by model name even when baseUrl is different', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'deepseek-v4-pro',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'deepseek-v4-pro',
          apiKey: 'test-key',
          baseUrl: 'https://my-proxy.example.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('matches regional DeepSeek subdomains (e.g. us.api.deepseek.com)', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'unrelated-model',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'unrelated-model',
          apiKey: 'test-key',
          baseUrl: 'https://us.api.deepseek.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    const toolOnlyAssistant = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'tool', input: {} }],
    };

    it('does not inject empty thinking blocks for non-deepseek providers', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      // Non-deepseek provider: even tool_use turns get no injection.
      expect(messages[1]).toEqual(toolOnlyAssistant);
    });

    it('does not match spoofed hostnames like api.deepseek.com.evil.com', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com.evil.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      // Hostname differs from api.deepseek.com — must not inject even on
      // tool_use turns.
      expect(messages[1]).toEqual(toolOnlyAssistant);
    });

    it('does not inject when reasoning is explicitly disabled', async () => {
      // Even on a confirmed-DeepSeek provider with a tool-use turn, if the
      // request omits the top-level `thinking` parameter (because
      // reasoning=false), shipping synthetic thinking blocks would be a
      // protocol violation.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'deepseek-v4-pro',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'deepseek-v4-pro',
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: false,
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      expect(anthropicRequest).toEqual(
        expect.not.objectContaining({ thinking: expect.anything() }),
      );
      expect(messages[1]).toEqual(toolOnlyAssistant);
    });

    it('strips real thought parts from assistant history when reasoning is disabled', async () => {
      // suggestionGenerator / forkedAgent path: the top-level `thinking`
      // parameter is dropped, but the session history may still carry
      // `thought: true` parts that the converter would otherwise replay as
      // thinking blocks — same protocol mismatch the gate is meant to avoid.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'deepseek-v4-pro',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'deepseek-v4-pro',
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: false,
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: [
          { role: 'user', parts: [{ text: 'Hi' }] },
          {
            role: 'model',
            parts: [
              { text: 'real reasoning', thought: true, thoughtSignature: 's1' },
              { text: 'Hello!' },
            ],
          },
          { role: 'user', parts: [{ text: 'Bye' }] },
        ],
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      expect(anthropicRequest).toEqual(
        expect.not.objectContaining({ thinking: expect.anything() }),
      );
      // Existing thinking block dropped — no protocol mismatch.
      expect(messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      });
    });

    it('reflects runtime model changes (no stale provider cache)', async () => {
      // Config.setModel() mutates contentGeneratorConfig.model in place. A
      // generator constructed against a non-DeepSeek model must start
      // injecting thinking blocks once the model is switched to DeepSeek
      // without re-creating the generator.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      const config: ContentGeneratorConfig = {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: { max_tokens: 500 },
        schemaCompliance: 'auto',
      };

      const generator = new AnthropicContentGenerator(config, mockConfig);

      // Initial model isn't DeepSeek — no injection.
      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);
      let [req] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(
        (req as { messages: unknown[] }).messages[1] as { content: unknown },
      ).toEqual(toolOnlyAssistant);

      // Hot-update the model in place, mimicking Config.setModel().
      config.model = 'deepseek-chat';

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
      } as unknown as GenerateContentParameters);
      [req] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(
        (req as { messages: unknown[] }).messages[1] as { content: unknown },
      ).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', signature: '' },
          { type: 'tool_use', id: 't1', name: 'tool', input: {} },
        ],
      });
    });

    it('does not inject when request sets thinkingConfig.includeThoughts=false', async () => {
      // Same concern as above but for the per-request override used by
      // suggestionGenerator / forkedAgent / ArenaManager. Both the top-level
      // `thinking` field AND the reasoning-shaped `output_config` must be
      // suppressed — leaving either behind reintroduces the protocol
      // mismatch this gate is designed to avoid.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'deepseek-v4-pro',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'deepseek-v4-pro',
          apiKey: 'test-key',
          baseUrl: 'https://api.deepseek.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'medium' },
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: toolUseConversation,
        config: { thinkingConfig: { includeThoughts: false } },
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const messages = (anthropicRequest as { messages: unknown[] }).messages;

      expect(anthropicRequest).toEqual(
        expect.not.objectContaining({ thinking: expect.anything() }),
      );
      expect(anthropicRequest).toEqual(
        expect.not.objectContaining({ output_config: expect.anything() }),
      );
      expect(messages[1]).toEqual(toolOnlyAssistant);
    });
  });

  describe('countTokens', () => {
    it('counts tokens using the request tokenizer', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {},
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'claude-test',
      };

      const result = await generator.countTokens(request);
      expect(mockTokenizer.calculateTokens).toHaveBeenCalledWith(request);
      expect(result.totalTokens).toBe(50);
    });

    it('falls back to character approximation when tokenizer throws', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      mockTokenizer.calculateTokens.mockRejectedValueOnce(new Error('boom'));
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {},
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'claude-test',
      };

      const content = JSON.stringify(request.contents);
      const expected = Math.ceil(content.length / 4);
      const result = await generator.countTokens(request);
      expect(result.totalTokens).toBe(expected);
    });
  });

  describe('generateContentStream', () => {
    it('requests stream=true and converts streamed events into Gemini chunks', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue(
        (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'msg-1',
              model: 'claude-test',
              usage: { cache_read_input_tokens: 2, input_tokens: 3 },
            },
          };

          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text' },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello' },
          };
          yield { type: 'content_block_stop', index: 0 };

          yield {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'thinking', signature: '' },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'thinking_delta', thinking: 'Think' },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'signature_delta', signature: 'abc' },
          };
          yield { type: 'content_block_stop', index: 1 };

          yield {
            type: 'content_block_start',
            index: 2,
            content_block: {
              type: 'tool_use',
              id: 't1',
              name: 'tool',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"x":' },
          };
          yield {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '1}' },
          };
          yield { type: 'content_block_stop', index: 2 };

          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              output_tokens: 5,
              input_tokens: 7,
              cache_read_input_tokens: 2,
            },
          };
          yield { type: 'message_stop' };
        })(),
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 123 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const stream = await generator.generateContentStream({
        model: 'models/ignored',
        contents: 'Hello',
      } as unknown as GenerateContentParameters);

      const chunks: GenerateContentResponse[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(anthropicRequest).toEqual(
        expect.objectContaining({ stream: true }),
      );

      // Text chunk.
      expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        text: 'Hello',
      });

      // Thinking chunk.
      expect(chunks[1]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        text: 'Think',
        thought: true,
      });

      // Signature chunk.
      expect(chunks[2]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        thought: true,
        thoughtSignature: 'abc',
      });

      // Tool call chunk.
      expect(chunks[3]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        functionCall: { id: 't1', name: 'tool', args: { x: 1 } },
      });

      // Usage/finish chunks exist; check the last one.
      const last = chunks[chunks.length - 1]!;
      expect(last.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(last.usageMetadata).toEqual({
        cachedContentTokenCount: 2,
        promptTokenCount: 9, // cached(2) + input(7)
        candidatesTokenCount: 5,
        totalTokenCount: 14,
      });
    });
  });
});
