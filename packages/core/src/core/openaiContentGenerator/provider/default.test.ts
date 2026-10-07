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
  afterEach,
  type MockedFunction,
} from 'vitest';
import OpenAI from 'openai';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import {
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DISABLED_REQUEST_TIMEOUT_MS,
} from '../constants.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import type { OpenAIRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';

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

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

vi.mock('../../../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: vi.fn(),
}));

type ReasoningTurn = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
  reasoning?: string;
};

// `{ model, messages: [a 'Hello' user turn], ...extra }`.
const hello = (model: string, extra: Record<string, unknown> = {}) =>
  ({
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    ...extra,
  }) as OpenAI.Chat.ChatCompletionCreateParams;

const UA = `QwenCode/1.0.0 (${process.platform}; ${process.arch})`;

describe('DefaultOpenAICompatibleProvider', () => {
  const MAX_OUTPUT_TOKENS_ENV = 'QWEN_CODE_MAX_OUTPUT_TOKENS';
  let provider: DefaultOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;
  let savedMaxOutputTokensEnv: string | undefined;

  // A provider over the shared config plus `extra` fields.
  const providerWith = (extra: Record<string, unknown>) =>
    new DefaultOpenAICompatibleProvider(
      { ...mockContentGeneratorConfig, ...extra } as ContentGeneratorConfig,
      mockCliConfig,
    );
  // buildRequest(request, 'prompt-id'), with the result readable by key.
  const build = (request: unknown, p = provider) =>
    p.buildRequest(
      request as OpenAI.Chat.ChatCompletionCreateParams,
      'prompt-id',
    ) as OpenAI.Chat.ChatCompletionCreateParams & Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    savedMaxOutputTokensEnv = process.env[MAX_OUTPUT_TOKENS_ENV];
    delete process.env[MAX_OUTPUT_TOKENS_ENV];
    const mockedBuildRuntimeFetchOptions =
      buildRuntimeFetchOptions as unknown as MockedFunction<
        (sdkType: 'openai', proxyUrl?: string) => OpenAIRuntimeFetchOptions
      >;
    mockedBuildRuntimeFetchOptions.mockReturnValue(undefined);

    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://api.openai.com/v1',
      timeout: 60000,
      maxRetries: 2,
      model: 'gpt-4',
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getSessionId: vi.fn().mockReturnValue('session-1'),
    } as unknown as Config;

    provider = new DefaultOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  it('preserves the explicit output cap on a non-GPT batch route', () => {
    const request = provider.buildRequest(
      {
        model: 'google/gemini-2.5-flash:batch',
        messages: [],
        max_tokens: 65536,
      },
      'test',
    );
    expect(request.max_tokens).toBe(65536);
  });

  afterEach(() => {
    if (savedMaxOutputTokensEnv === undefined) {
      delete process.env[MAX_OUTPUT_TOKENS_ENV];
    } else {
      process.env[MAX_OUTPUT_TOKENS_ENV] = savedMaxOutputTokensEnv;
    }
  });

  describe('constructor', () => {
    it('should initialize with provided configs', () => {
      expect(provider).toBeInstanceOf(DefaultOpenAICompatibleProvider);
    });
  });

  describe('getResponseParsingOptions', () => {
    it('keeps balanced tags visible for generic models', () => {
      expect(provider.getResponseParsingOptions('gpt-4o')).toEqual({
        contentOnlyThinkingTagLeaks: true,
      });
    });

    it('parses tagged thinking for Qwen3 models', () => {
      expect(provider.getResponseParsingOptions('qwen3.8-max')).toEqual({
        contentOnlyThinkingTagLeaks: true,
        taggedThinkingTagsAfterReasoning: true,
      });
    });
  });

  describe('buildHeaders', () => {
    it('should build headers with User-Agent', () => {
      const headers = provider.buildHeaders();

      expect(headers).toEqual({ 'User-Agent': UA });
    });

    it('should merge customHeaders with defaults (and allow overrides)', () => {
      const headers = providerWith({
        customHeaders: {
          'X-Custom': '1',
          'User-Agent': 'custom-agent',
        },
      }).buildHeaders();

      expect(headers).toEqual({
        'User-Agent': 'custom-agent',
        'X-Custom': '1',
      });
    });

    it('should handle unknown CLI version', () => {
      vi.mocked(mockCliConfig.getCliVersion).mockReturnValue(undefined);

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
          defaultHeaders: { 'User-Agent': UA },
          fetch: expect.any(Function),
        }),
      );

      expect(client).toBeDefined();
    });

    it('installs session ID injection on the runtime fetch', async () => {
      const runtimeFetch = vi.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response(),
      );
      vi.mocked(buildRuntimeFetchOptions).mockReturnValue({
        fetch: runtimeFetch,
      });

      const client = provider.buildClient() as unknown as {
        config: { fetch: typeof fetch };
      };
      await client.config.fetch(
        'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
      );
      await client.config.fetch('https://api.openai.com/v1');

      const routifyHeaders = new Headers(
        runtimeFetch.mock.calls[0][1]?.headers,
      );
      expect(routifyHeaders.get('session_id')).toBe('session-1');
      expect(runtimeFetch.mock.calls[1][1]).toBeUndefined();
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
          defaultHeaders: { 'User-Agent': UA },
        }),
      );
    });

    it('should disable the timeout when configured to 0', () => {
      mockContentGeneratorConfig.timeout = 0;

      provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: DISABLED_REQUEST_TIMEOUT_MS,
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

    it('forwards a parameterless tool without a parameters key', () => {
      // Negative pin for the MiniMax-only scoping in minimax.ts: the default
      // provider must not synthesize a schema for zero-argument tools.
      // converter.ts deliberately omits `parameters` for them (#11431), and
      // the endpoints #10080 was written for (llama.cpp, LM Studio, vLLM)
      // reject the empty-object shape. Assert on the serialized body because
      // a converter-shaped tool carries `parameters: undefined` present,
      // which JSON.stringify drops — matching what actually ships.
      const result = build({
        model: 'some-model',
        messages: [{ role: 'user', content: 'Hello' }],
        tools: [
          {
            type: 'function',
            function: { name: 'no_args', description: 'd' },
          },
        ],
      });

      expect(JSON.stringify(result.tools)).not.toContain('"parameters"');
    });

    it.each([
      [
        'should set model max_tokens default when not configured',
        hello('gpt-4'),
        16384,
      ],
      [
        'should set the 128K output default for Claude Opus 4.8',
        hello('vertex/claude-opus-4-8'),
        128_000,
      ],
      // Unknown models (deployment aliases, self-hosted): the user's 100K is
      // kept, since the backend may support larger limits.
      [
        'should respect user max_tokens for unknown models (deployment aliases, self-hosted)',
        hello('unknown-model', { max_tokens: 100000 }),
        100000,
      ],
      [
        'should use default output limit for unknown models when max_tokens not configured',
        hello('custom-deployment-alias'),
        32000,
      ],
      // Known models: 100K exceeds GPT-4's limit and is capped to its 16K.
      [
        'should cap max_tokens for known models to avoid API errors',
        hello('gpt-4', { max_tokens: 100000 }),
        16384,
      ],
      [
        'should treat null max_tokens as not configured',
        hello('gpt-4', { max_tokens: null }),
        16384,
      ],
    ])('%s', (_title, request, expected) => {
      expect(build(request).max_tokens).toBe(expected);
    });

    it('should ignore malformed QWEN_CODE_MAX_OUTPUT_TOKENS values', () => {
      const request = hello('gpt-4');

      for (const envValue of ['1.5', '2k', 'abc']) {
        process.env[MAX_OUTPUT_TOKENS_ENV] = envValue;

        const result = provider.buildRequest(request, 'prompt-id');

        expect(result.max_tokens).toBe(16384);
      }
    });

    it('should respect a valid QWEN_CODE_MAX_OUTPUT_TOKENS value', () => {
      process.env[MAX_OUTPUT_TOKENS_ENV] = '9000';

      expect(build(hello('gpt-4')).max_tokens).toBe(9000);
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
      const minimalRequest = hello('gpt-4');

      const result = build(minimalRequest);

      expect(result.model).toBe('gpt-4');
      expect(result.messages).toEqual(minimalRequest.messages);
      expect(result.max_tokens).toBe(16384);
    });

    it('should not inject max_tokens when samplingParams is set without it (e.g. GPT-5 / o-series)', () => {
      // GPT-5 / o-series on Azure reject max_tokens entirely, so samplingParams
      // without max_tokens is an opt-out to honor.
      const p = providerWith({
        samplingParams: { max_completion_tokens: 4096 },
      });

      expect(build(hello('gpt-4'), p).max_tokens).toBeUndefined();
    });

    it('should pass samplingParams.max_tokens through verbatim, bypassing the model cap', () => {
      // samplingParams is the source of truth: a max_tokens above the known
      // model's output limit (gpt-4: 16K, normally capped) passes unchanged.
      const p = providerWith({ samplingParams: { max_tokens: 100000 } });

      const result = build(hello('gpt-4', { max_tokens: 100000 }), p);

      expect(result.max_tokens).toBe(100000);
    });

    it('should handle streaming requests', () => {
      const streamingRequest = hello('gpt-4', { stream: true });

      const result = build(streamingRequest);

      expect(result.model).toBe('gpt-4');
      expect(result.messages).toEqual(streamingRequest.messages);
      expect(result.stream).toBe(true);
      expect(result.max_tokens).toBe(16384);
    });

    it('should not modify the original request object', () => {
      const originalRequest = hello('gpt-4', { temperature: 0.7 });

      const originalRequestCopy = { ...originalRequest };
      const result = build(originalRequest);

      expect(originalRequest).toEqual(originalRequestCopy);
      expect(result).not.toBe(originalRequest);
    });

    it.each([
      [
        'clamps a configured max effort to xhigh for a generic endpoint',
        'max',
        'xhigh',
      ],
      ['leaves an accepted effort tier untouched', 'xhigh', 'xhigh'],
      [
        'keeps an unrecognized effort string as-is rather than rewriting it',
        'ludicrous',
        'ludicrous',
      ],
    ])('%s', (_title, effort, expected) => {
      const result = build(hello('gpt-5.4', { reasoning: { effort } }));

      expect(result['reasoning_effort']).toBe(expected);
      expect(result['reasoning']).toBeUndefined();
    });

    it('preserves generic clamping for a legacy non-GPT declaration', () => {
      mockContentGeneratorConfig.authType =
        'openai' as ContentGeneratorConfig['authType'];
      mockCliConfig.getResolvedModelConfig = vi.fn().mockReturnValue({
        capabilities: {
          reasoning: {
            thinking: true,
            efforts: ['high', 'max'],
            defaultEffort: 'high',
            disableField: 'thinking',
          },
        },
      });
      const request = {
        model: 'deepseek-v4-pro',
        messages: [],
        reasoning: { effort: 'low' },
      } as unknown as OpenAI.Chat.ChatCompletionCreateParams;
      expect(provider.buildRequest(request, 'prompt-id')).toMatchObject({
        reasoning: { effort: 'low' },
      });
    });

    it.each(['', 42])(
      'does not translate an invalid configured effort %j',
      (effort) => {
        const result = build({
          model: 'gpt-5.4',
          messages: [],
          reasoning: { effort },
        });
        expect(result['reasoning_effort']).toBeUndefined();
        expect(result['reasoning']).toEqual({ effort });
      },
    );

    it('warns once however many requests the same provider clamps', () => {
      mockDebugLogger.warn.mockClear();
      const req = hello('gpt-5.4', { reasoning: { effort: 'max' } });

      provider.buildRequest(req, 'first');
      provider.buildRequest(req, 'second');

      expect(mockDebugLogger.warn).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['gpt-5.1', 'max', 'high'],
      ['gpt-5.1-codex-max', 'max', 'xhigh'],
      ['gpt-5.4', 'max', 'xhigh'],
      ['gpt-5.6-sol', 'max', 'max'],
      ['gpt-6-astra', 'high', 'high'],
      ['gpt-6-astra', 'max', 'max'],
      ['gpt-5-pro', 'low', 'high'],
      ['gpt-5.4-pro', 'low', 'medium'],
    ])(
      'maps %s effort %s to %s without mutating the input',
      (model, effort, expected) => {
        const request = {
          model,
          messages: [{ role: 'user' as const, content: 'Hello' }],
          reasoning: { effort },
        };
        const result = build(request);
        expect(result['reasoning_effort']).toBe(expected);
        expect(result['reasoning']).toBeUndefined();
        expect(request.reasoning).toEqual({ effort });
      },
    );

    it.each([undefined, null, ''])(
      'preserves a sibling budget with a %s flat override',
      (override) => {
        mockContentGeneratorConfig.extra_body = { reasoning_effort: override };
        const request = {
          model: 'gpt-5.4',
          messages: [],
          reasoning: { effort: 'high', budget_tokens: 42000 },
        };
        const result = build(request);
        expect(result['reasoning_effort']).toBe('high');
        expect(result['reasoning']).toEqual({ budget_tokens: 42000 });
        expect(request.reasoning).toEqual({
          effort: 'high',
          budget_tokens: 42000,
        });
      },
    );

    it('keeps the OpenRouter nested reasoning protocol', () => {
      mockContentGeneratorConfig.baseUrl = 'https://openrouter.ai/api/v1';
      const result = build({
        model: 'openai/gpt-5.4',
        messages: [],
        reasoning: { effort: 'max' },
      });
      expect(result['reasoning']).toEqual({ effort: 'xhigh' });
      expect(result['reasoning_effort']).toBeUndefined();
    });

    it('preserves an explicit flat effort over the configured effort', () => {
      mockContentGeneratorConfig.extra_body = { reasoning_effort: 'low' };
      const result = build({
        model: 'gpt-5.4',
        messages: [],
        reasoning: { effort: 'high' },
      });
      expect(result['reasoning_effort']).toBe('low');
      expect(result['reasoning']).toBeUndefined();
    });

    it('answers the ceiling for the request model, not the configured one', () => {
      const result = build(
        hello('some-other-model', { reasoning: { effort: 'max' } }),
      );

      expect(result['reasoning']).toEqual({ effort: 'xhigh' });
    });

    it('leaves a samplingParams reasoning object verbatim', () => {
      // Explicit nested reasoning bypasses injection and clamping, unlike
      // unrelated GPT sampling options that retain the configured effort.
      const p = providerWith({
        samplingParams: { reasoning: { effort: 'max' } },
      });

      const result = build(
        hello('gpt-5.4', { reasoning: { effort: 'max' } }),
        p,
      );

      expect(result['reasoning']).toEqual({ effort: 'max' });
    });

    it('lets an extra_body reasoning override ship verbatim', () => {
      const p = providerWith({ extra_body: { reasoning: { effort: 'max' } } });

      const result = build(
        hello('gpt-5.4', { reasoning: { effort: 'max' } }),
        p,
      );

      expect(result['reasoning']).toEqual({ effort: 'max' });
    });

    it('should merge extra_body into the request', () => {
      const p = providerWith({
        extra_body: {
          custom_param: 'custom_value',
          nested: { key: 'value' },
        },
      });
      const originalRequest = hello('gpt-4', { temperature: 0.7 });

      const result = build(originalRequest, p);

      expect(result).toEqual({
        ...originalRequest,
        max_tokens: 16384,
        custom_param: 'custom_value',
        nested: { key: 'value' },
      });
    });

    it('should not include extra_body when not configured', () => {
      const originalRequest = hello('gpt-4', { temperature: 0.7 });

      const result = build(originalRequest);

      expect(result.model).toBe('gpt-4');
      expect(result.messages).toEqual(originalRequest.messages);
      expect(result.temperature).toBe(0.7);
      expect(result.max_tokens).toBe(16384);
      expect(result).not.toHaveProperty('custom_param');
    });

    it('mirrors reasoning_content into reasoning for Qwen3 assistant history turns without mutating the source request', () => {
      const originalRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'Qwen/Qwen3.6-35B-A3B',
        messages: [
          { role: 'user', content: 'First turn' },
          {
            role: 'assistant',
            content: 'Visible answer',
            reasoning_content: 'Preserved chain of thought',
          } as ReasoningTurn,
          { role: 'user', content: 'Second turn' },
        ],
      };

      const result = build(originalRequest);
      const assistant = result.messages?.[1] as ReasoningTurn;

      expect(assistant.reasoning_content).toBe('Preserved chain of thought');
      expect(assistant.reasoning).toBe('Preserved chain of thought');
      expect(
        (originalRequest.messages[1] as ReasoningTurn).reasoning,
      ).toBeUndefined();
    });

    it('does not overwrite an explicit reasoning field on Qwen3 assistant history turns', () => {
      const result = build({
        model: 'Qwen3-32B',
        messages: [
          {
            role: 'assistant',
            content: 'Visible answer',
            reasoning_content: 'Legacy reasoning field',
            reasoning: 'Canonical reasoning field',
          },
        ],
      });
      const assistant = result.messages?.[0] as ReasoningTurn;

      expect(assistant.reasoning).toBe('Canonical reasoning field');
      expect(assistant.reasoning_content).toBe('Legacy reasoning field');
    });

    it('does not mirror reasoning_content for non-Qwen3 OpenAI-compatible models', () => {
      const result = build({
        model: 'gpt-4o',
        messages: [
          {
            role: 'assistant',
            content: 'Visible answer',
            reasoning_content: 'Preserved chain of thought',
          },
        ],
      });
      const assistant = result.messages?.[0] as ReasoningTurn;

      expect(assistant.reasoning_content).toBe('Preserved chain of thought');
      expect(assistant.reasoning).toBeUndefined();
    });
  });
});
