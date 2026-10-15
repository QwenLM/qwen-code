/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { isRateLimitError } from '../../utils/rateLimit.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  DEFAULT_TIMEOUT,
  DISABLED_REQUEST_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV,
} from '../openaiContentGenerator/constants.js';

const mockReportAnthropicRequest = vi.hoisted(() => vi.fn());
const mockReportAnthropicFollowingRequest = vi.hoisted(() => vi.fn());
const mockReportAnthropicResponse = vi.hoisted(() => vi.fn());
const mockReportAnthropicEvent = vi.hoisted(() => vi.fn());

vi.mock('../../telemetry/gen-ai-request.js', () => ({
  reportAnthropicRequest: mockReportAnthropicRequest,
  reportAnthropicFollowingRequest: mockReportAnthropicFollowingRequest,
  reportAnthropicResponse: mockReportAnthropicResponse,
  reportAnthropicEvent: mockReportAnthropicEvent,
}));

type AnthropicCreateArgs = [
  unknown,
  { signal?: AbortSignal; headers?: Record<string, string> }?,
];

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

const anthropicState = anthropicMockState;
const { createImpl } = anthropicMockState;
const sentBody = (call: number) => createImpl.mock.calls[call][0];

// Now import the modules that depend on the mocked modules.
import type { Config } from '../../config/config.js';
import {
  collect,
  content,
  drain,
  fnCall,
  fnResponse,
  modelText,
  streamOf,
  userText,
} from '../../test-utils/model-fixtures.js';

const importGenerator = async (): Promise<{
  AnthropicContentGenerator: typeof import('./anthropicContentGenerator.js').AnthropicContentGenerator;
}> => import('./anthropicContentGenerator.js');

const importConverter = async (): Promise<{
  AnthropicContentConverter: typeof import('./converter.js').AnthropicContentConverter;
}> => import('./converter.js');

const NATIVE = 'https://api.anthropic.com';
const DEEPSEEK = 'https://api.deepseek.com/anthropic';
const PROXY = 'https://proxy.example.com';
const ROUTIFY = 'https://proxy.routify.ai/v1';
const THINKING_BETA = 'interleaved-thinking-2025-05-14';
const EFFORT_BETA = 'effort-2025-11-24';
const SCOPE_BETA = 'prompt-caching-scope-2026-01-05';
const TTL_BETA = 'extended-cache-ttl-2025-04-11';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const BINDING_REJECTION =
  'thinking.adaptive.block_binding: Extra inputs are not permitted';
const ADAPTIVE = { type: 'adaptive', display: 'summarized' };
const GLOBAL_CACHE = { type: 'ephemeral', scope: 'global' };
const READ_A = '{"file_path":"a.sql"}';
const PWD = '{"command":"pwd"}';
const TRUNCATED = '{"command":"rm -rf /tmp/scra';
const MALFORMED = { name: 'InvalidStreamError', type: 'MALFORMED_TOOL_CALL' };
const NO_THINKING = expect.not.objectContaining({
  thinking: expect.anything(),
});

type SentRequest = {
  thinking?: unknown;
  system?: unknown;
  tools?: Array<{ cache_control?: unknown }>;
  messages: Array<{
    role: string;
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      signature?: string;
      cache_control?: unknown;
    }>;
  }>;
  [key: string]: unknown;
};

const hello = (extra: object = {}) =>
  ({
    model: 'models/ignored',
    contents: 'Hello',
    ...extra,
  }) as unknown as GenerateContentParameters;
const reply = (model: string, text = 'ok', id = 'msg-1') => ({
  id,
  model,
  content: [{ type: 'text', text }],
});
const status400 = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
const resetByPeer = () =>
  Object.assign(new Error('SSE connection reset by peer'), {
    code: 'ECONNRESET',
  });

// Anthropic SSE event builders.
type SseEvent = { type: string; [key: string]: unknown };
const blockStart = (index: number, content_block: object): SseEvent => ({
  type: 'content_block_start',
  index,
  content_block,
});
const toolStart = (index: number, id: string, name: string) =>
  blockStart(index, { type: 'tool_use', id, name, input: {} });
const textStart = (index: number) =>
  blockStart(index, { type: 'text', text: '' });
const blockDelta = (index: number, delta: object): SseEvent => ({
  type: 'content_block_delta',
  index,
  delta,
});
const textDelta = (index: number, text: string) =>
  blockDelta(index, { type: 'text_delta', text });
const jsonDelta = (index: number, partial_json: string) =>
  blockDelta(index, { type: 'input_json_delta', partial_json });
const thinkingDelta = (index: number, thinking: string) =>
  blockDelta(index, { type: 'thinking_delta', thinking });
const blockStop = (index: number): SseEvent => ({
  type: 'content_block_stop',
  index,
});
// A closed tool_use block: start, one argument delta, stop.
const toolBlock = (index: number, id: string, name: string, json: string) => [
  toolStart(index, id, name),
  jsonDelta(index, json),
  blockStop(index),
];
const messageStart = (
  usage: object = { input_tokens: 1 },
  model = 'claude-test',
): SseEvent => ({
  type: 'message_start',
  message: { id: 'msg-1', model, usage },
});
const messageDelta = (
  stop_reason: string,
  output_tokens: number,
  usage: object = {},
): SseEvent => ({
  type: 'message_delta',
  delta: { stop_reason },
  usage: { output_tokens, ...usage },
});
// Yields `events`, then fails with `error`.
const throwAfter = (error: unknown, ...events: unknown[]) =>
  (async function* () {
    yield* events;
    throw error;
  })();
const fnCalls = (chunks: GenerateContentResponse[]) =>
  chunks.flatMap((chunk) => chunk.functionCalls ?? []);
const textsOf = (chunks: GenerateContentResponse[]) =>
  chunks
    .flatMap((chunk) => chunk.candidates ?? [])
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .flatMap((part) => (part.text ? [part.text] : []));
const lastFinish = (chunks: GenerateContentResponse[]) =>
  chunks.flatMap((chunk) => chunk.candidates ?? []).at(-1)?.finishReason;
const readCall = (id: string) => ({
  id,
  name: 'read_file',
  args: { file_path: 'a.sql' },
});

describe('AnthropicContentGenerator', () => {
  const MAX_OUTPUT_TOKENS_ENV = 'QWEN_CODE_MAX_OUTPUT_TOKENS';
  let mockConfig: Config;
  let savedMaxOutputTokensEnv: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // The constructor builds undici fetch options synchronously; production
    // preloads undici in createContentGenerator, and resetModules() clears it.
    const { preloadRuntimeFetchModule } = await import(
      '../../utils/runtimeFetchOptions.js'
    );
    await preloadRuntimeFetchModule();
    savedMaxOutputTokensEnv = process.env[MAX_OUTPUT_TOKENS_ENV];
    delete process.env[MAX_OUTPUT_TOKENS_ENV];

    createImpl.mockReset();
    anthropicState.lastCreateArgs = undefined;
    anthropicState.constructorOptions = undefined;

    mockConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.2.3'),
      getProxy: vi.fn().mockReturnValue(undefined),
      getTelemetryEnabled: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
      getStaticSystemPrefix: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
  });

  afterEach(() => {
    if (savedMaxOutputTokensEnv === undefined) {
      delete process.env[MAX_OUTPUT_TOKENS_ENV];
    } else {
      process.env[MAX_OUTPUT_TOKENS_ENV] = savedMaxOutputTokensEnv;
    }
    vi.restoreAllMocks();
  });

  // Config with the defaults most cases share. No baseUrl key unless given:
  // an absent baseUrl is itself a case (the SDK default host).
  const cfg = (
    overrides: Partial<ContentGeneratorConfig> = {},
  ): ContentGeneratorConfig => ({
    model: 'claude-test',
    apiKey: 'test-key',
    timeout: 10_000,
    maxRetries: 2,
    samplingParams: {},
    schemaCompliance: 'auto',
    ...overrides,
  });
  const newGenerator = async (config: ContentGeneratorConfig) => {
    const { AnthropicContentGenerator } = await importGenerator();
    return new AnthropicContentGenerator(config, mockConfig);
  };
  const defaultHeaders = () =>
    (anthropicState.constructorOptions?.['defaultHeaders'] ?? {}) as Record<
      string,
      string
    >;
  // Constructs a generator; returns the SDK constructor options and headers.
  const construct = async (config: ContentGeneratorConfig) => {
    await newGenerator(config);
    return {
      opts: anthropicState.constructorOptions ?? {},
      headers: defaultHeaders(),
    };
  };
  const lastCall = () => {
    const [body, options] =
      anthropicState.lastCreateArgs as AnthropicCreateArgs;
    return {
      req: body as SentRequest,
      headers: options?.headers ?? ({} as Record<string, string>),
    };
  };
  // Construct, stub a text reply, send one non-streaming request.
  const send = async (
    config: ContentGeneratorConfig,
    request: object = {},
    replyModel = config.model,
  ) => {
    const generator = await newGenerator(config);
    createImpl.mockResolvedValue(reply(replyModel));
    await generator.generateContent(hello(request));
    return { ...lastCall(), generator };
  };
  const maxCfg = (
    max_tokens: number,
    overrides: Partial<ContentGeneratorConfig> = {},
  ) => cfg({ samplingParams: { max_tokens }, ...overrides });
  const nativeCfg = (
    model: string,
    overrides: Partial<ContentGeneratorConfig> = {},
  ) => maxCfg(500, { model, baseUrl: NATIVE, ...overrides });
  const openStream = async (config = maxCfg(100), request: object = {}) =>
    (await newGenerator(config)).generateContentStream(hello(request));
  const declareReasoning = (reasoning: object) => {
    mockConfig.getResolvedModelConfig = vi
      .fn()
      .mockReturnValue({ capabilities: { reasoning } });
  };
  type Built = Awaited<ReturnType<typeof construct>>;
  // Proxy identity: claude-cli UA + `x-app`, Bearer authToken, apiKey null.
  const expectProxyIdentity = ({ opts, headers }: Built, key = 'test-key') => {
    expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
    expect(headers['x-app']).toBe('cli');
    expect(opts['authToken']).toBe(key);
    expect(opts['apiKey']).toBeNull();
  };
  // Native identity: QwenCode UA, no `x-app`, apiKey auth, authToken null.
  const expectNativeIdentity = ({ opts, headers }: Built, key = 'test-key') => {
    expect(headers['User-Agent']).toContain('QwenCode/1.2.3');
    expect(headers['x-app']).toBeUndefined();
    expect(opts['apiKey']).toBe(key);
    expect(opts['authToken']).toBeNull();
  };
  // The SDK registers a never-removed 'abort' listener on whatever signal it
  // gets, so the caller's signal must only ever reach it via a child.
  const expectCallerSignalIsolated = (callerAc: AbortController) => {
    expect(getEventListeners(callerAc.signal, 'abort')).toHaveLength(0);
    const passedSignal = anthropicState.lastCreateArgs?.[1]?.signal;
    expect(passedSignal).toBeDefined();
    expect(passedSignal).not.toBe(callerAc.signal);
  };

  it.each([
    ['anthropic-manual', { type: 'enabled', budget_tokens: 31999 }],
    ['anthropic-adaptive', ADAPTIVE],
    ['deepseek-anthropic', { type: 'enabled', budget_tokens: 32000 }],
    ['deepseek-anthropic', { type: 'enabled' }, DEEPSEEK],
    ['anthropic-manual', { type: 'enabled' }, DEEPSEEK],
  ])(
    'uses %s for an unknown alias with its default effort',
    async (profile, thinking, baseUrl = 'https://example.test') => {
      declareReasoning({
        profile,
        efforts: ['low', 'medium', 'high', 'max'],
        defaultEffort: 'medium',
      });
      const { req, generator } = await send(
        {
          model: 'company-alias',
          authType: 'anthropic' as ContentGeneratorConfig['authType'],
          apiKey: 'dummy',
          baseUrl,
          samplingParams: { max_tokens: 32000, temperature: 0 },
        },
        { model: 'company-alias', contents: [userText('Hello')] },
      );
      expect(req).toMatchObject({
        thinking,
        output_config: { effort: 'medium' },
      });
      if (profile === 'anthropic-manual') {
        expect(req).toMatchObject({ temperature: 1 });
        await generator.generateContent({
          model: 'company-alias',
          contents: 'Hello',
          config: { maxOutputTokens: 500 },
        });
        expect(lastCall().req).not.toHaveProperty('thinking');
      }
    },
  );

  it('uses adaptive for a declared alias even with an explicit manual budget', async () => {
    declareReasoning({
      profile: 'anthropic-adaptive',
      efforts: ['medium', 'max'],
      defaultEffort: 'max',
    });
    const { req } = await send(
      {
        model: 'company-alias',
        authType: 'anthropic' as ContentGeneratorConfig['authType'],
        apiKey: 'dummy',
        reasoning: { budget_tokens: 2048 },
        samplingParams: { max_tokens: 64000 },
      },
      { model: 'company-alias', contents: [modelText('Partial answer')] },
    );
    expect(req).toMatchObject({
      thinking: ADAPTIVE,
      output_config: { effort: 'max' },
    });
    expect(req.messages.at(-1)?.role).toBe('user');
  });

  it('uses claude-cli identity (User-Agent + x-app + Bearer auth) for non-Anthropic baseURLs', async () => {
    // IdeaLab-style proxy path; Bearer `authToken` instead of `x-api-key`
    // avoids dual-header conflicts.
    const built = await construct(cfg({ baseUrl: 'https://example.invalid' }));
    expectProxyIdentity(built);
    expect(built.headers['User-Agent']).toContain('(external, cli)');
    expect(built.opts['fetch']).toEqual(expect.any(Function));
  });

  it('installs session ID injection on the runtime fetch', async () => {
    const runtimeFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    vi.doMock('../../utils/runtimeFetchOptions.js', async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import('../../utils/runtimeFetchOptions.js')
        >();
      return {
        ...actual,
        buildRuntimeFetchOptions: vi.fn(() => ({ fetch: runtimeFetch })),
      };
    });

    try {
      const route = 'https://routify-pub.alibaba-inc.com/protocol/anthropic';
      const { opts } = await construct(cfg({ baseUrl: route }));
      await (opts['fetch'] as typeof fetch)(`${route}/v1`);
      const headers = new Headers(runtimeFetch.mock.calls[0][1]?.headers);
      expect(headers.get('session_id')).toBe('test-session');
    } finally {
      vi.doUnmock('../../utils/runtimeFetchOptions.js');
    }
  });

  it('uses QwenCode identity + apiKey auth when baseURL is api.anthropic.com', async () => {
    // A truthful QwenCode UA, so usage isn't misattributed to Claude CLI in
    // Anthropic's logs/quotas.
    const built = await construct(
      cfg({ model: 'claude-opus-4-7', baseUrl: NATIVE }),
    );
    expectNativeIdentity(built);
    expect(built.headers['User-Agent']).not.toContain('claude-cli');
  });

  it('disables the request timeout when configured to 0', async () => {
    const { opts } = await construct(
      cfg({ model: 'claude-opus-4-7', baseUrl: NATIVE, timeout: 0 }),
    );
    expect(opts['timeout']).toBe(DISABLED_REQUEST_TIMEOUT_MS);
  });

  it('falls back to the default request timeout when unset', async () => {
    const config = cfg({ model: 'claude-opus-4-7', baseUrl: NATIVE });
    delete config.timeout;
    expect((await construct(config)).opts['timeout']).toBe(DEFAULT_TIMEOUT);
  });

  it.each([
    [
      'treats unset baseURL as Anthropic-native (SDK default targets api.anthropic.com)',
      'claude-opus-4-7',
      undefined,
      true,
    ],
    // Regional/internal Anthropic subdomains share the native contract.
    [
      'treats *.anthropic.com subdomains as Anthropic-native',
      'claude-opus-4-7',
      'https://eu.api.anthropic.com',
      true,
    ],
    // The detector's `new URL()` catch branch must not throw.
    [
      'treats malformed baseURL as proxy (URL parse failure falls through to claude-cli identity)',
      'claude-test',
      'not a valid url',
      false,
    ],
    // The gate is a native allow-list, so DeepSeek gets the proxy bundle; if
    // DeepSeek ever rejects Bearer, this surfaces that auth decision.
    [
      'pins DeepSeek anthropic-compatible baseURL onto the proxy auth/identity path',
      'deepseek-v4-pro',
      DEEPSEEK,
      false,
    ],
    // Untrimmed, a pasted URL fails `new URL()` and real api.anthropic.com
    // gets Bearer auth and 401s. Mirrors the env side's trimming.
    [
      'trims whitespace on config.baseUrl before classification',
      'claude-opus-4-7',
      '  https://api.anthropic.com  ',
      true,
    ],
    // Else a DNS-controlling attacker receives real Anthropic credentials via
    // `x-api-key` (mirror of the DeepSeek spoof test).
    [
      'does not match spoofed anthropic.com.evil.com hostnames',
      'claude-test',
      'https://api.anthropic.com.evil.com',
      false,
    ],
  ] as const)('%s', async (_title, model, baseUrl, native) => {
    const built = await construct(
      cfg({ model, ...(baseUrl !== undefined && { baseUrl }) }),
    );
    if (native) expectNativeIdentity(built);
    else expectProxyIdentity(built);
  });

  // Regression for #4020 review: the SDK's env defaults
  // (`apiKey = readEnv('ANTHROPIC_API_KEY') ?? null`) fire only for
  // `undefined`, so without an explicit `apiKey: null` an exported
  // ANTHROPIC_API_KEY reached an IdeaLab proxy as `X-Api-Key` (the resolver
  // preferred it). Pins the explicit null on both branches and the env URL.
  describe('env back-fill suppression and baseURL env resolution', () => {
    const IDEALAB = 'https://idealab.example/anthropic';
    const ENV_KEYS = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
    ];
    const savedEnv: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    });
    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    });

    it('suppresses ANTHROPIC_API_KEY back-fill on the proxy branch (prevents credential leak)', async () => {
      // A Claude Code shell exports the real key while qwen-code targets an
      // IdeaLab proxy; the explicit `null` keeps the env default from firing.
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret-do-not-leak';
      const { opts } = await construct(
        cfg({ apiKey: 'idealab-token', baseUrl: IDEALAB }),
      );
      expect(opts['apiKey']).toBeNull();
      expect(opts['authToken']).toBe('idealab-token');
    });

    it('suppresses ANTHROPIC_AUTH_TOKEN back-fill on the Anthropic-native branch', async () => {
      // Inverse: an env-filled `authToken` could win if the SDK's precedence
      // ever flipped, so our explicit `apiKey` must be the only credential.
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'env-bearer-token';
      const { opts } = await construct(
        cfg({
          model: 'claude-opus-4-7',
          apiKey: 'config-api-key',
          baseUrl: NATIVE,
        }),
      );
      expect(opts['apiKey']).toBe('config-api-key');
      expect(opts['authToken']).toBeNull();
    });

    it('applies proxy identity when ANTHROPIC_BASE_URL env points to a proxy and config.baseUrl is unset', async () => {
      // Pre-fix only `config.baseUrl` was read, so an env-only proxy URL was
      // treated as native: wrong UA and auth, plus the cache-scope beta and
      // scope:'global' sent to a proxy. baseUrl is omitted on purpose.
      process.env['ANTHROPIC_BASE_URL'] = IDEALAB;
      const built = await construct(cfg({ apiKey: 'idealab-token' }));
      expectProxyIdentity(built, 'idealab-token');
    });

    it('keeps Anthropic-native identity when ANTHROPIC_BASE_URL is unset (SDK default applies)', async () => {
      // The SDK then defaults to api.anthropic.com; our predicate must agree.
      delete process.env['ANTHROPIC_BASE_URL'];
      const built = await construct(
        cfg({ model: 'claude-opus-4-7', apiKey: 'config-key' }),
      );
      expectNativeIdentity(built, 'config-key');
    });

    it('config.baseUrl wins over ANTHROPIC_BASE_URL when both are set', async () => {
      // Mirrors the SDK, so a stray ANTHROPIC_BASE_URL can't flip a deliberate
      // api.anthropic.com config onto the proxy path.
      process.env['ANTHROPIC_BASE_URL'] = IDEALAB;
      const built = await construct(
        cfg({
          model: 'claude-opus-4-7',
          apiKey: 'config-key',
          baseUrl: NATIVE,
        }),
      );
      expectNativeIdentity(built, 'config-key');
    });
  });

  it('merges customHeaders into defaultHeaders (does not replace defaults)', async () => {
    const { headers } = await construct(
      cfg({
        baseUrl: 'https://example.invalid',
        reasoning: { effort: 'medium' },
        customHeaders: { 'X-Custom': '1' },
      }),
    );
    // Beta headers moved out of defaultHeaders (PR #3788 review feedback):
    // only User-Agent and customHeaders remain at construction time.
    expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
    expect(headers['X-Custom']).toBe('1');
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  // anthropic-beta is computed per request from the body's fields, not the
  // constructor-time config, so a per-request opt-out that drops `thinking` /
  // `output_config` drops their flags too (PR #3788 review feedback).
  describe('per-request anthropic-beta header', () => {
    // Native baseURL: the cache-scope beta needs both `enableCacheControl`
    // and a native host (proxies are covered below).
    const base = (overrides: Partial<ContentGeneratorConfig> = {}) =>
      maxCfg(100, { baseUrl: NATIVE, ...overrides });
    const weatherTools = () => [
      {
        functionDeclarations: [
          { name: 'get_weather', description: 'Get weather' },
        ],
      },
    ];
    const sysAndTools = () => ({
      contents: 'Hi',
      config: { systemInstruction: 'sys', tools: weatherTools() },
    });

    // The systemInstruction gives the body the scope:'global' cache_control
    // that `buildPerRequestHeaders` scans for the cache-scope beta; with no
    // system or tools the beta is suppressed (see below).
    const callOnce = async (
      config: ContentGeneratorConfig,
      requestConfig?: object,
    ) =>
      (
        await send(config, {
          contents: 'Hi',
          config: { systemInstruction: 'sys', ...(requestConfig ?? {}) },
        })
      ).headers;
    // callOnce at medium effort with these customHeaders.
    const callWithHeaders = (customHeaders: Record<string, string>) =>
      callOnce(base({ reasoning: { effort: 'medium' }, customHeaders }));
    const opus55Proxy = () =>
      base({ model: 'claude-opus-5-5', baseUrl: PROXY });
    const opus55Hi = () => hello({ model: 'claude-opus-5-5', contents: 'Hi' });

    it('keeps Claude Opus 5.5 block-binding controls stable as tools change', async () => {
      const bound = {
        ...ADAPTIVE,
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      };
      const tools = (description: string) => [
        { functionDeclarations: [{ name: 'exec', description }] },
      ];

      const first = await send(opus55Proxy(), {
        contents: [userText('search')],
        config: { tools: tools('initial tools') },
      });
      expect(first.req.thinking).toEqual(bound);
      expect(first.headers['anthropic-beta']).toContain(BINDING_BETA);

      await first.generator.generateContent(
        hello({
          contents: [
            userText('search'),
            content(
              'model',
              { text: 'planning\n\n', thought: true, thoughtSignature: 'sig' },
              fnCall('exec', {}, 'call-1'),
            ),
            content('user', fnResponse('exec', { output: 'found' }, 'call-1')),
          ],
          config: { tools: tools('updated tools') },
        }),
      );
      const { req, headers } = lastCall();
      expect(req.tools).not.toEqual(first.req.tools);
      expect(req.thinking).toEqual(bound);
      expect(headers['anthropic-beta']).toContain(BINDING_BETA);
      expect(req.messages[1]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            { type: 'thinking', thinking: 'planning\n\n', signature: 'sig' },
          ]),
        }),
      );
    });

    it.each([
      ['claude-fable-5-1', true],
      ['bedrock/claude-fable-5.1', true],
      ['vertex_ai/claude-opus-5.5', true],
      ['claude-fable-5', false],
      ['claude-opus-5-1', false],
    ])('sets block binding for %s: %s', async (model, expected) => {
      const { req, headers } = await send(base({ model }), {
        model,
        contents: 'Hi',
      });
      const thinking = req.thinking as { block_binding?: unknown } | undefined;
      expect(Boolean(thinking?.block_binding)).toBe(expected);
      expect(headers['anthropic-beta']?.includes(BINDING_BETA) ?? false).toBe(
        expected,
      );
    });

    it('retries a proxy without block binding when it rejects the field', async () => {
      createImpl
        .mockRejectedValueOnce(status400(BINDING_REJECTION))
        .mockResolvedValue(reply('claude-opus-5-5'));
      const generator = await newGenerator(opus55Proxy());
      const request = opus55Hi();

      await generator.generateContent(request);
      await generator.generateContent(request);

      expect(createImpl).toHaveBeenCalledTimes(3);
      expect(sentBody(0).thinking).toHaveProperty('block_binding');
      for (const [body, options] of createImpl.mock.calls.slice(1)) {
        expect(body.thinking).not.toHaveProperty('block_binding');
        expect(options.headers['anthropic-beta']).not.toContain(BINDING_BETA);
      }
    });

    it('does not retry an unrelated proxy 400', async () => {
      createImpl.mockRejectedValue(
        status400('Invalid signature in thinking block'),
      );
      const generator = await newGenerator(opus55Proxy());

      await expect(generator.generateContent(opus55Hi())).rejects.toThrow(
        'Invalid signature',
      );
      expect(createImpl).toHaveBeenCalledTimes(1);
    });

    it.each<[string, Partial<ContentGeneratorConfig>, string[], string[]?]>([
      [
        'sends interleaved-thinking + effort beta when both are present in the body',
        { reasoning: { effort: 'medium' } },
        [THINKING_BETA, EFFORT_BETA],
      ],
      // No reasoning config: thinking defaults to enabled, no effort.
      [
        'sends only interleaved-thinking when effort is not set',
        {},
        [THINKING_BETA, SCOPE_BETA],
      ],
      // Reasoning flags still ride; only cache-scope is gated off, as the body
      // has no cache_control to pair it with.
      [
        'drops only the cache-scope beta when enableCacheControl is false but reasoning is on',
        { reasoning: { effort: 'medium' }, enableCacheControl: false },
        [THINKING_BETA, EFFORT_BETA],
        [SCOPE_BETA],
      ],
      [
        'passes user-supplied customHeaders[anthropic-beta] through even when no thinking/effort is enabled',
        {
          reasoning: false,
          customHeaders: { 'anthropic-beta': 'experimental-x' },
        },
        ['experimental-x', SCOPE_BETA],
      ],
      [
        'sends extended-cache-ttl-2025-04-11 when cacheRetention is "1h"',
        { reasoning: false, cacheRetention: '1h' },
        [TTL_BETA],
      ],
      [
        'omits extended-cache-ttl-2025-04-11 when cacheRetention is unset (ephemeral default)',
        { reasoning: false },
        [],
        [TTL_BETA],
      ],
    ])('%s', async (_title, overrides, present, absent = []) => {
      const beta = (await callOnce(base(overrides)))['anthropic-beta'];
      for (const flag of present) expect(beta).toContain(flag);
      for (const flag of absent) expect(beta).not.toContain(flag);
    });

    it.each<
      [string, Partial<ContentGeneratorConfig>, object | undefined, unknown]
    >([
      [
        'sends only prompt-caching-scope when reasoning is disabled (no thinking, no effort)',
        { reasoning: false },
        undefined,
        SCOPE_BETA,
      ],
      // Without body cache_control the cache-scope beta is dead weight (and
      // risks 4xx); with reasoning off too, no header is sent at all.
      [
        'drops the prompt-caching-scope beta when enableCacheControl is false',
        { reasoning: false, enableCacheControl: false },
        undefined,
        undefined,
      ],
      // The per-request opt-out drops `thinking` and `output_config`, so
      // their beta flags go too despite the global effort.
      [
        'sends only prompt-caching-scope when per-request thinkingConfig.includeThoughts=false',
        { reasoning: { effort: 'medium' } },
        { thinkingConfig: { includeThoughts: false } },
        SCOPE_BETA,
      ],
    ])('%s', async (_title, overrides, requestConfig, expected) => {
      const headers = await callOnce(base(overrides), requestConfig);
      expect(headers['anthropic-beta']).toBe(expected);
    });

    it('reflects hot enableCacheControl flips between requests (no stale converter cache)', async () => {
      // `Config.setModel()` mutates `enableCacheControl` in place; a cached
      // constructor value would let the body's cache_control (system, last
      // user message, last tool) and the cache-scope beta drift apart.
      const config = base({ reasoning: false });
      const request = sysAndTools();

      // Cache on (default).
      const { req, headers, generator } = await send(config, request);
      expect(headers['anthropic-beta']).toBe(SCOPE_BETA);
      expect(req.system).toEqual([
        { type: 'text', text: 'sys', cache_control: GLOBAL_CACHE },
      ]);
      expect(req.tools).toHaveLength(1);
      expect(req.tools?.[0]?.cache_control).toEqual(GLOBAL_CACHE);
      expect(req.messages[0].content[0].cache_control).toEqual({
        type: 'ephemeral',
      });

      // Hot-flip off: header and every body cache_control follow in lockstep.
      config.enableCacheControl = false;
      await generator.generateContent(hello(request));
      const second = lastCall();
      expect(second.headers['anthropic-beta']).toBeUndefined();
      expect(second.req.system).toBe('sys');
      expect(second.req.tools?.[0]).not.toHaveProperty('cache_control');
      expect(second.req.messages[0].content[0]).not.toHaveProperty(
        'cache_control',
      );
    });

    it('suppresses the cache-scope beta when the body has no scope field (empty system + no tools)', async () => {
      // The gate body-scans system/tools for a scope:'global' entry instead
      // of re-reading `useGlobalCacheScope()`, which is true here.
      const { headers } = await send(base({ reasoning: false }), {
        contents: 'Hi',
      });
      expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('ships the cache-scope beta when only tools (no systemInstruction) carry scope:"global"', async () => {
      // scope:'global' on the last tool alone fires the body-scan.
      const { headers } = await send(base({ reasoning: false }), {
        contents: 'Hi',
        config: { tools: weatherTools() },
      });
      expect(headers['anthropic-beta']).toBe(SCOPE_BETA);
    });

    it('strips the cache-scope beta and scope:"global" field on non-Anthropic baseURLs', async () => {
      // Both are Anthropic-only extensions that proxies may not ignore
      // safely. Proxies keep per-session ephemeral cache_control (pre-PR
      // behavior), so prompt caching is preserved.
      const { req, headers } = await send(
        base({ baseUrl: DEEPSEEK, reasoning: false }),
        sysAndTools(),
      );
      expect(headers['anthropic-beta']).toBeUndefined();
      expect(req.system).toEqual([
        { type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } },
      ]);
      expect(req.tools?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('emits scope:"global" on non-Anthropic baseURLs when forceGlobalCacheScope is true (#6642)', async () => {
      // Proxies such as Routify or OpenRouter opt in to both extensions.
      const { req, headers } = await send(
        base({
          baseUrl: ROUTIFY,
          forceGlobalCacheScope: true,
          reasoning: false,
        }),
        sysAndTools(),
      );
      expect(headers['anthropic-beta']).toContain(SCOPE_BETA);
      expect(req.system).toEqual([
        { type: 'text', text: 'sys', cache_control: GLOBAL_CACHE },
      ]);
      expect(req.tools?.[0]?.cache_control).toEqual(GLOBAL_CACHE);
    });

    it('splits the system prompt at the Config-recorded static prefix (4-breakpoint layout)', async () => {
      // `LlmClient` records the gitStatus-free base on Config and the
      // converter splits there: a global prefix and a per-session suffix,
      // which with the last-tool and last-message markers fill 4 breakpoints.
      vi.mocked(mockConfig.getStaticSystemPrefix).mockReturnValue('sys-base');
      const { req, headers } = await send(base({ reasoning: false }), {
        contents: 'Hi',
        config: { systemInstruction: 'sys-base\n\n# Git Status\nbranch: main' },
      });
      expect(req.system).toEqual([
        { type: 'text', text: 'sys-base', cache_control: GLOBAL_CACHE },
        {
          type: 'text',
          text: '\n\n# Git Status\nbranch: main',
          cache_control: { type: 'ephemeral' },
        },
      ]);
      // The prefix block's scope alone fires the body-scan gate.
      expect(headers['anthropic-beta']).toContain(SCOPE_BETA);
    });

    it('suppresses scope:"global" when enableCacheControl is false even with forceGlobalCacheScope', async () => {
      const { req } = await send(
        base({
          baseUrl: ROUTIFY,
          enableCacheControl: false,
          forceGlobalCacheScope: true,
          reasoning: false,
        }),
        { contents: 'Hi', config: { systemInstruction: 'sys' } },
      );
      // A plain string system: no cache_control at all.
      expect(req.system).toBe('sys');
    });

    it('merges user-supplied customHeaders[anthropic-beta] with computed flags (no overwrite)', async () => {
      // Users add Anthropic beta flags via customHeaders; the per-request
      // override must add to that list, not replace it.
      const headers = await callWithHeaders({
        'anthropic-beta': 'experimental-x,experimental-y',
      });
      expect((headers['anthropic-beta'] ?? '').split(',')).toEqual(
        expect.arrayContaining([
          'experimental-x',
          'experimental-y',
          THINKING_BETA,
          EFFORT_BETA,
        ]),
      );
    });

    it('does not leak customHeaders[anthropic-beta] (any casing) into defaultHeaders', async () => {
      // The per-request path owns anthropic-beta; a mixed-case copy here would
      // put two physical headers for one name on the wire (undefined in SDK).
      const { headers } = await construct(
        base({
          customHeaders: { 'Anthropic-Beta': 'user-flag', 'X-Other': 'kept' },
        }),
      );
      expect(headers['Anthropic-Beta']).toBeUndefined();
      expect(headers['anthropic-beta']).toBeUndefined();
      expect(headers['ANTHROPIC-BETA']).toBeUndefined();
      expect(headers['X-Other']).toBe('kept');
    });

    it('honors customHeaders[anthropic-beta] under mixed-case keys (Anthropic-Beta / ANTHROPIC-BETA)', async () => {
      // The SDK lower-cases header names when merging, so a case-sensitive
      // merge would silently overwrite the user's flag.
      for (const [key, flag] of [
        ['ANTHROPIC-BETA', 'experimental-x'],
        ['Anthropic-Beta', 'experimental-y'],
      ]) {
        const headers = await callWithHeaders({ [key]: flag });
        expect(headers['anthropic-beta']).toContain(flag);
        expect(headers['anthropic-beta']).toContain(THINKING_BETA);
      }
    });

    it('dedupes beta flags so duplicates from customHeaders are not repeated', async () => {
      const headers = await callWithHeaders({
        'anthropic-beta': THINKING_BETA,
      });
      const occurrences = (headers['anthropic-beta'] ?? '')
        .split(',')
        .filter((f) => f.trim() === THINKING_BETA);
      expect(occurrences).toHaveLength(1);
    });

    it('keeps customHeaders + User-Agent in defaultHeaders while sending computed anthropic-beta per-request', async () => {
      // The per-request override only adds anthropic-beta; guards against a
      // path that wipes the constructor-time defaults.
      const reqHeaders = await callWithHeaders({ 'X-Custom': 'v1' });

      // `base` targets api.anthropic.com, hence the native QwenCode UA.
      const defaults = defaultHeaders();
      expect(defaults['User-Agent']).toContain('QwenCode/1.2.3');
      expect(defaults['X-Custom']).toBe('v1');
      expect(defaults['anthropic-beta']).toBeUndefined();

      expect(reqHeaders['User-Agent']).toBeUndefined();
      expect(reqHeaders['X-Custom']).toBeUndefined();
      expect(reqHeaders['anthropic-beta']).toContain(THINKING_BETA);
      expect(reqHeaders['anthropic-beta']).toContain(SCOPE_BETA);
    });

    it('also sends the computed beta header on streaming requests', async () => {
      // A separate code path from generateContent(). message_delta, not a
      // bare message_stop, which signals an empty stream and a fallback retry.
      createImpl.mockResolvedValue(streamOf(messageDelta('end_turn', 1)));
      const telemetryAttempt = {};
      mockReportAnthropicRequest.mockReturnValueOnce(telemetryAttempt);
      // systemInstruction: the body-scan gate needs a scope:'global' field.
      const stream = await openStream(
        base({ reasoning: { effort: 'medium' } }),
        {
          contents: 'Hi',
          config: { systemInstruction: 'sys' },
        },
      );
      await drain(stream);

      // A normal stream must not trigger the empty-stream fallback (double
      // latency and cost).
      expect(createImpl).toHaveBeenCalledTimes(1);

      const { req, headers } = lastCall();
      expect(mockReportAnthropicRequest).toHaveBeenCalledWith(req);
      expect(mockReportAnthropicEvent).toHaveBeenCalledWith(
        telemetryAttempt,
        expect.objectContaining({ type: 'message_delta' }),
      );
      expect(headers['anthropic-beta']).toContain(THINKING_BETA);
      expect(headers['anthropic-beta']).toContain(EFFORT_BETA);
      expect(headers['anthropic-beta']).toContain(SCOPE_BETA);
    });
  });

  describe('generateContent', () => {
    it('redacts proxy credentials from request-time SDK errors', async () => {
      createImpl.mockRejectedValue(
        new Error('connect ECONNREFUSED token@proxy.local:8080'),
      );
      const generator = await newGenerator(maxCfg(100));

      await expect(generator.generateContent(hello())).rejects.toThrow(
        'connect ECONNREFUSED <redacted>@proxy.local:8080',
      );
    });

    it('does not leak abort listeners onto the caller signal across non-streaming requests', async () => {
      // Model the SDK's never-removed 'abort' listener (see the stream twin).
      createImpl.mockImplementation(
        (_req: unknown, opts: { signal?: AbortSignal }) => {
          opts.signal?.addEventListener('abort', () => {});
          return reply('claude-test', 'Hello', 'anthropic-1');
        },
      );
      const generator = await newGenerator(maxCfg(100));

      const callerAc = new AbortController();
      for (let i = 0; i < 5; i++) {
        await generator.generateContent(
          hello({ config: { abortSignal: callerAc.signal } }),
        );
      }

      expectCallerSignalIsolated(callerAc);
    });

    it('propagates a caller abort to the per-request child signal', async () => {
      const callerAc = new AbortController();
      let capturedSignal: AbortSignal | undefined;
      createImpl.mockImplementation(
        (_req: unknown, opts: { signal?: AbortSignal }) => {
          capturedSignal = opts.signal;
          callerAc.abort(); // the caller aborts while the request is in flight
          return reply('claude-test', 'hi', 'anthropic-1');
        },
      );
      const generator = await newGenerator(maxCfg(100));

      await generator.generateContent(
        hello({ config: { abortSignal: callerAc.signal } }),
      );

      // The SDK gets a child that still sees the caller's abort.
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).not.toBe(callerAc.signal);
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('builds request with config sampling params (config overrides request; max_tokens takes the smaller) and thinking budget', async () => {
      const { AnthropicContentConverter } = await importConverter();
      const converted = new GenerateContentResponse();
      converted.responseId = 'gemini-1';
      const convertResponseSpy = vi
        .spyOn(
          AnthropicContentConverter.prototype,
          'convertAnthropicResponseToLlm',
        )
        .mockReturnValue(converted);
      createImpl.mockResolvedValue(reply('claude-test', 'hi', 'anthropic-1'));
      const generator = await newGenerator(
        cfg({
          baseUrl: 'https://example.invalid',
          samplingParams: {
            temperature: 0.7,
            max_tokens: 1000,
            top_p: 0.9,
            top_k: 20,
          },
          reasoning: { effort: 'high', budget_tokens: 1000 },
        }),
      );

      const abortController = new AbortController();
      const telemetryAttempt = {};
      mockReportAnthropicRequest.mockReturnValueOnce(telemetryAttempt);
      const result = await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hello',
        config: {
          temperature: 0.1,
          maxOutputTokens: 200,
          thinkingConfig: { thinkingBudget: 199 },
          topP: 0.5,
          topK: 5,
          abortSignal: abortController.signal,
        },
      });
      expect(result.responseId).toBe('gemini-1');

      expect(anthropicState.lastCreateArgs).toBeDefined();
      const [anthropicRequest, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;

      // A per-request child isolates the SDK's abort-listener leak.
      expect(options?.signal).toBeDefined();
      expect(options?.signal).not.toBe(abortController.signal);

      expect(anthropicRequest).toEqual(
        expect.objectContaining({
          model: 'claude-test',
          // Config sampling params win, EXCEPT max_tokens: the smaller wins
          // so the send-path window clamp can never be raised.
          max_tokens: 200,
          temperature: 0.7,
          top_p: 0.9,
          top_k: 20,
          thinking: { type: 'enabled', budget_tokens: 199 },
          output_config: { effort: 'high' },
        }),
      );
      expect(mockReportAnthropicRequest).toHaveBeenCalledWith(anthropicRequest);
      expect(mockReportAnthropicResponse).toHaveBeenCalledWith(
        telemetryAttempt,
        expect.objectContaining({ id: 'anthropic-1' }),
      );

      expect(convertResponseSpy).toHaveBeenCalledTimes(1);
    });

    it('caps an effort-derived thinking budget with the request budget', async () => {
      const { req } = await send(
        maxCfg(200, { baseUrl: NATIVE, reasoning: { effort: 'high' } }),
        { config: { thinkingConfig: { thinkingBudget: 199 } } },
      );
      expect(req).toEqual(
        expect.objectContaining({
          max_tokens: 200,
          thinking: { type: 'enabled', budget_tokens: 199 },
          output_config: { effort: 'high' },
        }),
      );
    });

    // Per-model effort gating: Opus 4.7/4.8 and 5.x accept xhigh/max
    // natively; other models clamp to 'high'.
    it.each<
      [string, string, ContentGeneratorConfig['reasoning'], object, string?]
    >([
      // DeepSeek's extra 'max' tier. The clamp is hostname-only, so this
      // needs a DeepSeek baseURL (see the next row).
      [
        "passes effort: 'max' through to output_config and bumps thinking budget",
        'deepseek-v4-pro',
        { effort: 'max' },
        {
          output_config: { effort: 'max' },
          thinking: { type: 'enabled', budget_tokens: 128_000 },
        },
        DEEPSEEK,
      ],
      // Provider detection also matches model names (self-hosted sglang/vllm)
      // but the clamp must not, or real api.anthropic.com gets 'max' and 400s.
      [
        "still clamps effort: 'max' when model name says 'deepseek' but hostname is api.anthropic.com",
        'deepseek-distill',
        { effort: 'max' },
        { output_config: { effort: 'high' } },
      ],
      // A DeepSeek config reused against Anthropic must not 400; the budget
      // drops to the 'high' tier too, keeping label and budget consistent.
      [
        "clamps effort: 'max' to 'high' on a non-DeepSeek anthropic provider",
        'claude-test',
        { effort: 'max' },
        {
          output_config: { effort: 'high' },
          thinking: { type: 'enabled', budget_tokens: 64_000 },
        },
      ],
      // 4.6+ uses adaptive thinking; the server controls the budget.
      [
        "passes effort: 'max' through on Opus 4.8 (native support)",
        'claude-opus-4-8',
        { effort: 'max' },
        { output_config: { effort: 'max' }, thinking: ADAPTIVE },
      ],
      [
        "passes effort: 'xhigh' through on Opus 4.8 (native support)",
        'claude-opus-4-8',
        { effort: 'xhigh' },
        { output_config: { effort: 'xhigh' }, thinking: ADAPTIVE },
      ],
      [
        "clamps effort: 'xhigh' to 'max' on Opus 4.6 (has max, lacks xhigh)",
        'claude-opus-4-6',
        { effort: 'xhigh' },
        { output_config: { effort: 'max' } },
      ],
      [
        "clamps effort: 'max' to 'high' on Opus 4.5 (lacks xhigh/max)",
        'claude-opus-4-5',
        { effort: 'max' },
        { output_config: { effort: 'high' } },
      ],
      // Regression: reading the date as the minor made atLeast(4, 6/7) true
      // and granted max/xhigh (a 400).
      [
        "clamps effort: 'max' to 'high' on dated Opus 4.0 (date suffix is not a minor version)",
        'claude-opus-4-20250514',
        { effort: 'max' },
        { output_config: { effort: 'high' } },
      ],
      // The version regex is unanchored on purpose; anchoring it would
      // silently clamp xhigh away for prefixed ids.
      [
        "passes effort: 'xhigh' through on a reseller-prefixed Opus 4.7 (bedrock/…)",
        'bedrock/claude-opus-4-7',
        { effort: 'xhigh' },
        { output_config: { effort: 'xhigh' } },
      ],
      // Locks in that the `major >= 5` branch covers every 5.x family.
      [
        "passes effort: 'max' through on a 5.x family model (claude-sonnet-5-0)",
        'claude-sonnet-5-0',
        { effort: 'max' },
        { output_config: { effort: 'max' } },
      ],
      // `max` on 4.x is opus/sonnet only (a 400 otherwise); 5.x haiku still
      // gets it via the major>=5 branch.
      [
        "clamps effort: 'max' to 'high' on claude-haiku-4-6 (haiku 4.x lacks max)",
        'claude-haiku-4-6',
        { effort: 'max' },
        { output_config: { effort: 'high' } },
      ],
      // Explicit budget_tokens bypasses the effort ladder: effort clamps (the
      // enum would 400) but any in-window budget is accepted verbatim.
      [
        "preserves explicit budget_tokens even when effort: 'max' is clamped",
        'claude-test',
        { effort: 'max', budget_tokens: 128_000 },
        {
          output_config: { effort: 'high' },
          thinking: { type: 'enabled', budget_tokens: 128_000 },
        },
      ],
    ])('%s', async (_title, model, reasoning, expected, baseUrl = NATIVE) => {
      const { req } = await send(nativeCfg(model, { baseUrl, reasoning }));
      expect(req).toEqual(expect.objectContaining(expected));
    });

    // DeepSeek's output_config.effort accepts only high/max (else a 400),
    // mirroring the DeepSeek OpenAI adapter.
    it("lifts effort: 'low'/'medium' to 'high' on the DeepSeek anthropic path", async () => {
      for (const effort of ['low', 'medium'] as const) {
        const { req } = await send(
          nativeCfg('deepseek-v4-pro', {
            baseUrl: DEEPSEEK,
            reasoning: { effort },
          }),
        );
        expect(req).toEqual(
          expect.objectContaining({ output_config: { effort: 'high' } }),
        );
      }
    });

    // Claude 4.8+ deprecated `temperature` (the server 400s when it is sent):
    // omit it for 4.8+ and keep it for older models.
    it.each([
      [
        'omits temperature on Opus 4.8 (deprecated)',
        'claude-opus-4-8',
        0.7,
        false,
      ],
      [
        'keeps temperature on Opus 4.7 (still accepted)',
        'claude-opus-4-7',
        0.7,
        true,
      ],
      [
        'omits temperature on Sonnet 5 (5.x family, deprecated)',
        'claude-sonnet-5',
        0.5,
        false,
      ],
      [
        'keeps temperature on unknown/unversioned model id',
        'some-custom-model',
        0.3,
        true,
      ],
    ])('%s', async (_title, model, temperature, kept) => {
      const { req } = await send(
        nativeCfg(model, { samplingParams: { max_tokens: 500, temperature } }),
      );
      if (kept) expect(req).toEqual(expect.objectContaining({ temperature }));
      else expect(req).not.toHaveProperty('temperature');
    });

    describe('adaptive thinking (Claude 4.6+ models)', () => {
      // 4.6+ models require `{ type: 'adaptive' }`. Detection compares numeric
      // major/minor so future versions don't fall back to the budget path.
      const thinkingFor = async (
        model: string,
        reasoning: ContentGeneratorConfig['reasoning'] = { effort: 'medium' },
      ) => (await send(nativeCfg(model, { reasoning }))).req.thinking;

      it.each([
        [
          'selects adaptive for claude-opus-4-6 / sonnet-4-6 / opus-4-7',
          ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7'],
        ],
        // A single-digit character-class regex would have missed haiku.
        [
          'selects adaptive for claude-haiku-4-6 (haiku family is in scope)',
          ['claude-haiku-4-6'],
        ],
        // A single-digit `[6-9]` would send an invalid budget body here.
        [
          'selects adaptive for two-digit minors like claude-opus-4-10',
          ['claude-opus-4-10'],
        ],
        [
          'selects adaptive for a future major like claude-opus-5-1',
          ['claude-opus-5-1'],
        ],
        // LiteLLM/Vertex/Bedrock model groups use dotted minors; a hyphen-only
        // parser reads `minor=0` and sends the budget shape to an
        // adaptive-only group (a 400).
        [
          'selects adaptive for dotted-minor aliases (claude-opus-4.7 / 4.8, claude-sonnet-4.6)',
          ['claude-opus-4.7', 'claude-opus-4.8', 'claude-sonnet-4.6'],
        ],
        [
          'selects adaptive for dotted-minor Opus 5 aliases (claude-opus-5.0 / 5.1)',
          ['claude-opus-5.0', 'claude-opus-5.1'],
        ],
      ])('%s', async (_title, models) => {
        for (const model of models) {
          expect(await thinkingFor(model)).toEqual(ADAPTIVE);
        }
      });

      it.each<[string, string, ContentGeneratorConfig['reasoning'], object]>([
        [
          'keeps the budget_tokens config for older 4.x models (e.g. claude-opus-4-5)',
          'claude-opus-4-5',
          undefined,
          { type: 'enabled', budget_tokens: 32_000 },
        ],
        // Regression: Opus 4.0 lacks adaptive thinking; `{ type: 'adaptive' }`
        // would 400.
        [
          'keeps the budget path for dated Opus 4.0 (claude-opus-4-20250514, date suffix is not a minor)',
          'claude-opus-4-20250514',
          undefined,
          { type: 'enabled', budget_tokens: 32_000 },
        ],
        // The escape hatch for models that still accept the manual shape (Opus
        // 4.5/4.6, Sonnet 4.6); adaptive would silently drop the budget.
        [
          'honors explicit reasoning.budget_tokens on models that still accept manual thinking (e.g. claude-opus-4-6)',
          'claude-opus-4-6',
          { effort: 'medium', budget_tokens: 42_000 },
          { type: 'enabled', budget_tokens: 42_000 },
        ],
        // Opus 4.7+ and 5.x 400 on the manual shape
        // (https://platform.claude.com/docs/en/build-with-claude/effort).
        [
          'drops manual budget_tokens for adaptive-only models that reject it (e.g. claude-opus-4-7)',
          'claude-opus-4-7',
          { effort: 'medium', budget_tokens: 42_000 },
          ADAPTIVE,
        ],
      ])('%s', async (_title, model, reasoning, expected) => {
        expect(await thinkingFor(model, reasoning)).toEqual(expected);
      });

      it('never sets display on the budget_tokens shape (pre-4.6 models and the explicit-override escape hatch)', async () => {
        // The `display` default change (summarized to omitted) only concerns
        // adaptive thinking; the manual budget shape must not carry it.
        expect(await thinkingFor('claude-opus-4-5')).not.toHaveProperty(
          'display',
        );
        expect(
          await thinkingFor('claude-opus-4-6', {
            effort: 'medium',
            budget_tokens: 42_000,
          }),
        ).not.toHaveProperty('display');
      });

      it('still ships adaptive (no output_config, no effort beta) when reasoning is undefined on a 4.6+ model', async () => {
        // No `reasoning` key (unlike `reasoning: false`): no effort to emit,
        // while cache-scope rides on the default enableCacheControl (the
        // systemInstruction supplies its scope field). If Anthropic ever
        // requires `output_config.effort` with adaptive thinking, this
        // surfaces here instead of as a 400.
        const { req, headers } = await send(nativeCfg('claude-opus-4-7'), {
          config: { systemInstruction: 'sys' },
        });
        expect(req.thinking).toEqual(ADAPTIVE);
        expect(req).toEqual(
          expect.not.objectContaining({ output_config: expect.anything() }),
        );
        expect(headers['anthropic-beta']).toContain(THINKING_BETA);
        expect(headers['anthropic-beta']).not.toContain(EFFORT_BETA);
        expect(headers['anthropic-beta']).toContain(SCOPE_BETA);
      });
    });

    describe('assistant-turn prefill stripping (generator wiring)', () => {
      // stripTrailingAssistantPrefill shares the 4.6+ adaptive gate; these pin
      // that the generator sets the converter option per model.
      const lastMessageFor = async (model: string) =>
        (
          await send(nativeCfg(model), {
            contents: [userText('Hi'), modelText('Sure, here you go.')],
          })
        ).req.messages.at(-1);

      it('strips a trailing assistant turn and appends a synthetic user turn on claude-opus-4-6', async () => {
        // enableCacheControl defaults on here, so the synthetic turn gets the
        // trailing user message's cache_control.
        expect(await lastMessageFor('claude-opus-4-6')).toEqual({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Continue.',
              cache_control: { type: 'ephemeral' },
            },
          ],
        });
      });

      it('leaves a trailing assistant turn untouched on claude-opus-4-5 (pre-4.6)', async () => {
        expect(await lastMessageFor('claude-opus-4-5')).toEqual({
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure, here you go.' }],
        });
      });
    });

    it('omits thinking when request.config.thinkingConfig.includeThoughts is false', async () => {
      const { req } = await send(
        maxCfg(500, { reasoning: { effort: 'high' } }),
        { config: { thinkingConfig: { includeThoughts: false } } },
      );
      expect(req).toEqual(NO_THINKING);
    });

    describe('output token limits', () => {
      it.each<
        [
          string,
          ContentGeneratorConfig['samplingParams'],
          object | undefined,
          number,
          string?,
        ]
      >([
        [
          'caps configured samplingParams.max_tokens to model output limit',
          { max_tokens: 200_000 },
          undefined,
          65536,
        ],
        [
          'caps request.config.maxOutputTokens to model output limit when config max_tokens is missing',
          {},
          { maxOutputTokens: 100_000 },
          65536,
        ],
        [
          'uses model default when max_tokens is not explicitly configured',
          {},
          undefined,
          64000,
        ],
        [
          'respects configured max_tokens for unknown models',
          { max_tokens: 100_000 },
          undefined,
          100_000,
          'unknown-model',
        ],
        [
          'treats null maxOutputTokens as not configured',
          {},
          { maxOutputTokens: null },
          64000,
        ],
      ])(
        '%s',
        async (
          _title,
          samplingParams,
          config,
          max_tokens,
          model = 'claude-sonnet-4',
        ) => {
          const { req } = await send(
            cfg({ model, samplingParams }),
            config && { config },
          );
          expect(req).toEqual(expect.objectContaining({ max_tokens }));
        },
      );

      it('ignores malformed QWEN_CODE_MAX_OUTPUT_TOKENS values', async () => {
        for (const envValue of ['1.5', '2k', 'abc']) {
          process.env[MAX_OUTPUT_TOKENS_ENV] = envValue;
          createImpl.mockResolvedValueOnce(
            reply('claude-sonnet-4', 'hi', `anthropic-${envValue}`),
          );
          const generator = await newGenerator(
            cfg({ model: 'claude-sonnet-4' }),
          );
          await generator.generateContent(hello());
          expect(lastCall().req).toEqual(
            expect.objectContaining({ max_tokens: 64000 }),
          );
        }
      });

      it('respects a valid QWEN_CODE_MAX_OUTPUT_TOKENS value', async () => {
        process.env[MAX_OUTPUT_TOKENS_ENV] = '9000';
        const { req } = await send(cfg({ model: 'claude-sonnet-4' }));
        expect(req).toEqual(expect.objectContaining({ max_tokens: 9000 }));
      });
    });
  });

  describe('Anthropic-compatible proxy thinking history', () => {
    const unsignedThinkingConversation = [
      userText('First'),
      content(
        'model',
        { text: 'unsigned reasoning', thought: true },
        { text: 'Visible answer' },
      ),
      userText('Second'),
    ];

    const sendWithBaseUrl = async (
      baseUrl: string,
      contents: GenerateContentParameters['contents'] = unsignedThinkingConversation,
    ) =>
      (await send(nativeCfg('claude-opus-4-6', { baseUrl }), { contents })).req;

    it('drops unsigned thinking for Claude 4.6 through a non-native proxy', async () => {
      const request = await sendWithBaseUrl(
        'https://internal-proxy.example/anthropic',
      );

      expect(request.thinking).toEqual(ADAPTIVE);
      expect(request.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible answer' }],
      });
    });

    it('does not rewrite unsigned history for the native Anthropic API', async () => {
      const request = await sendWithBaseUrl(NATIVE);

      expect(request.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'unsigned reasoning' },
          { type: 'text', text: 'Visible answer' },
        ],
      });
    });

    it('fails before sending an unsigned tool-use turn through a proxy', async () => {
      const toolUseConversation = [
        userText('Run tool'),
        content(
          'model',
          { text: 'unsigned reasoning', thought: true },
          fnCall('tool', {}, 't1'),
        ),
        content('user', fnResponse('tool', { output: 'ok' }, 't1')),
      ];

      await expect(
        sendWithBaseUrl(
          'https://internal-proxy.example/anthropic',
          toolUseConversation,
        ),
      ).rejects.toThrow('proxy omitted the thinking signature');
      expect(createImpl).not.toHaveBeenCalled();
    });
  });

  // Regression: Anthropic rejects a thinking-enabled tool loop whose final
  // assistant turn doesn't begin with thinking, and the straight concatenation
  // in mergeConsecutiveAssistantMessages can put text first (see converter.ts
  // ensureLeadingAssistantThinking).
  describe('manual-mode leading-thinking normalization', () => {
    // Two model turns merged into the latest assistant message; the first has
    // no leading thinking (adaptive mode permits that). t1 is answered: an
    // unanswered tool_use would get a synthetic 'Continue.' turn after it,
    // leaving it without a tool_result (the HTTP 400 shape).
    const mergedToolTurns = () => [
      userText('Run tool'),
      modelText('Sure, one moment.'),
      content(
        'model',
        {
          text: 'reasoning about the tool call',
          thought: true,
          thoughtSignature: 'sig-1',
        },
        fnCall('tool', {}, 't1'),
      ),
      content('user', fnResponse('tool', { output: 'ok' }, 't1')),
    ];
    const latestAssistant = (req: SentRequest) =>
      req.messages.filter((m) => m.role === 'assistant').at(-1)!;

    it.each<[string, string, ContentGeneratorConfig['reasoning'], number]>([
      // Explicit budget_tokens keeps claude-opus-4-6 on the manual shape.
      [
        'reorders the latest assistant turn to lead with thinking under an explicit-budget (manual) configuration',
        'claude-opus-4-6',
        { budget_tokens: 42_000 },
        42_000,
      ],
      // The effort ladder also builds `{ type: 'enabled' }` for pre-4.6 ids,
      // and the gate reads the BUILT config's type, not budget_tokens.
      [
        'reorders the latest assistant turn to lead with thinking under an effort-ladder (manual) configuration on a pre-4.6 model',
        'claude-opus-4-5',
        { effort: 'medium' },
        32_000,
      ],
    ])('%s', async (_title, model, reasoning, budget_tokens) => {
      const { req, headers } = await send(
        // Above budget_tokens: the real API requires budget_tokens <
        // max_tokens and nothing clamps the two, so a smaller value would
        // pass only because the client is mocked.
        maxCfg(64_000, { model, baseUrl: NATIVE, reasoning }),
        { contents: mergedToolTurns() },
      );

      expect(req.thinking).toEqual({ type: 'enabled', budget_tokens });
      expect(headers['anthropic-beta']).toContain(THINKING_BETA);
      // Manual mode requires the merged turn to begin with thinking.
      const [first, second, third] = latestAssistant(req).content;
      expect(first?.type).toBe('thinking');
      expect(first?.thinking).toBe('reasoning about the tool call');
      expect(first?.signature).toBe('sig-1');
      expect(second).toEqual({ type: 'text', text: 'Sure, one moment.' });
      expect(third?.type).toBe('tool_use');
    });

    it('leaves the latest assistant turn in chronological order under adaptive thinking (no explicit budget)', async () => {
      // Guards the `thinking?.type === 'enabled'` gate: `!!thinking` would
      // reintroduce the hoist-every-thinking corruption on adaptive models,
      // which the manual cases can't catch. No budget: opus-4-6 is adaptive.
      const { req } = await send(nativeCfg('claude-opus-4-6'), {
        contents: mergedToolTurns(),
      });

      expect(req.thinking).toEqual(ADAPTIVE);
      expect(latestAssistant(req).content.map((b) => b.type)).toEqual([
        'text',
        'thinking',
        'tool_use',
      ]);
    });
  });

  // https://github.com/QwenLM/qwen-code/issues/3786: in thinking mode,
  // DeepSeek's anthropic API rejects a prior tool_use assistant turn without
  // a thinking block (plain-text turns are accepted unchanged).
  describe('DeepSeek anthropic-compatible provider', () => {
    // The only shape that triggers DeepSeek's HTTP 400.
    const toolUseConversation = [
      userText('Run tool'),
      content('model', fnCall('tool', {}, 't1')),
      content('user', fnResponse('tool', { output: 'ok' }, 't1')),
    ];
    const toolOnlyAssistant = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'tool', input: {} }],
    };
    const injectedAssistant = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: '' },
        { type: 'tool_use', id: 't1', name: 'tool', input: {} },
      ],
    };
    const sendDeepSeek = async (
      overrides: Partial<ContentGeneratorConfig>,
      request: object = { contents: toolUseConversation },
    ) =>
      (
        await send(
          nativeCfg('deepseek-v4-pro', { baseUrl: DEEPSEEK, ...overrides }),
          request,
        )
      ).req;

    it.each([
      [
        'injects empty thinking blocks on tool-use assistant turns when baseUrl is api.deepseek.com',
        'deepseek-v4-pro',
        DEEPSEEK,
        true,
      ],
      [
        'detects deepseek by model name even when baseUrl is different',
        'deepseek-v4-pro',
        'https://my-proxy.example.com/anthropic',
        true,
      ],
      [
        'matches regional DeepSeek subdomains (e.g. us.api.deepseek.com)',
        'unrelated-model',
        'https://us.api.deepseek.com/anthropic',
        true,
      ],
      [
        'does not inject empty thinking blocks for non-deepseek providers',
        'claude-test',
        NATIVE,
        false,
      ],
      [
        'does not match spoofed hostnames like api.deepseek.com.evil.com',
        'claude-test',
        'https://api.deepseek.com.evil.com/anthropic',
        false,
      ],
    ])('%s', async (_title, model, baseUrl, injected) => {
      const req = await sendDeepSeek({ model, baseUrl });
      expect(req.messages[1]).toEqual(
        injected ? injectedAssistant : toolOnlyAssistant,
      );
    });

    it('does not inject when reasoning is explicitly disabled', async () => {
      // Without top-level `thinking`, synthetic thinking blocks would be a
      // protocol violation even on a confirmed-DeepSeek tool-use turn.
      const req = await sendDeepSeek({ reasoning: false });

      expect(req).toEqual(NO_THINKING);
      expect(req.messages[1]).toEqual(toolOnlyAssistant);
    });

    it('strips real thought parts from assistant history when reasoning is disabled', async () => {
      // suggestionGenerator / forkedAgent: history may still carry thought
      // parts that would replay as thinking blocks, the same mismatch.
      const req = await sendDeepSeek(
        { reasoning: false },
        {
          contents: [
            userText('Hi'),
            content(
              'model',
              { text: 'real reasoning', thought: true, thoughtSignature: 's1' },
              { text: 'Hello!' },
            ),
            userText('Bye'),
          ],
        },
      );

      expect(req).toEqual(NO_THINKING);
      expect(req.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
      });
    });

    it('reflects runtime model changes (no stale provider cache)', async () => {
      // Config.setModel() mutates the model in place; injection must follow a
      // switch to DeepSeek without re-creating the generator.
      const config = maxCfg(500, { baseUrl: 'https://example.invalid' });
      const request = { contents: toolUseConversation };

      const { req, generator } = await send(config, request);
      expect(req.messages[1]).toEqual(toolOnlyAssistant);

      config.model = 'deepseek-chat';
      await generator.generateContent(hello(request));
      expect(lastCall().req.messages[1]).toEqual(injectedAssistant);
    });

    it('does not inject when request sets thinkingConfig.includeThoughts=false', async () => {
      // The same per-request override (suggestionGenerator / forkedAgent /
      // ArenaManager) must drop both `thinking` and `output_config`.
      const req = await sendDeepSeek(
        { reasoning: { effort: 'medium' } },
        {
          contents: toolUseConversation,
          config: { thinkingConfig: { includeThoughts: false } },
        },
      );

      expect(req).toEqual(NO_THINKING);
      expect(req).toEqual(
        expect.not.objectContaining({ output_config: expect.anything() }),
      );
      expect(req.messages[1]).toEqual(toolOnlyAssistant);
    });
  });

  describe('generateContentStream', () => {
    // Opens a stream; returns its chunks and whatever error ends it.
    const collectGeneratedStream = async (baseUrl?: string) => {
      const stream = await openStream(maxCfg(100, { baseUrl }));
      const chunks: GenerateContentResponse[] = [];
      let error: unknown;
      try {
        for await (const chunk of stream) chunks.push(chunk);
      } catch (caughtError) {
        error = caughtError;
      }
      return { chunks, error };
    };
    // The WeakMaps behind these live per module instance, so import them
    // afresh after resetModules().
    const importPreparations = async () =>
      (await import('../tool-call-preparation.js')).getToolCallPreparations;
    const importProvenance = async () =>
      (await import('../../telemetry/gen-ai-usage.js')).getGenAiUsageProvenance;
    // Stubs the SDK's stream source, then collects as above.
    const collectFrom = (source: unknown, baseUrl?: string) => {
      createImpl.mockResolvedValue(source);
      return collectGeneratedStream(baseUrl);
    };
    const collectEvents = (...events: unknown[]) =>
      collectFrom(streamOf(...events));
    const collectThenThrow = (error: unknown, ...events: unknown[]) =>
      collectFrom(throwAfter(error, ...events));
    // Stubs one successful stream of `events`, then opens and collects it.
    const streamChunks = async (
      config: ContentGeneratorConfig,
      ...events: unknown[]
    ) => {
      createImpl.mockResolvedValue(streamOf(...events));
      return collect(await openStream(config));
    };
    const openOpus55Proxy = () =>
      openStream(
        {
          model: 'claude-opus-5-5',
          apiKey: 'test-key',
          baseUrl: PROXY,
          samplingParams: { max_tokens: 100 },
        },
        { model: 'claude-opus-5-5', contents: 'Hi' },
      );

    it.each(['creation', 'stream'])(
      'retries an unsupported proxy binding at %s',
      async (stage) => {
        const unsupported = status400(BINDING_REJECTION);
        if (stage === 'creation') {
          createImpl.mockRejectedValueOnce(unsupported);
        } else {
          createImpl.mockResolvedValueOnce({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                throw unsupported;
              },
            }),
          });
        }
        createImpl.mockResolvedValueOnce(
          streamOf(
            messageStart({ input_tokens: 1 }, 'claude-opus-5-5'),
            textDelta(0, 'ok'),
            messageDelta('end_turn', 1),
          ),
        );

        const chunks = await collect(await openOpus55Proxy());

        expect(chunks.some((chunk) => chunk.text === 'ok')).toBe(true);
        expect(createImpl).toHaveBeenCalledTimes(2);
        expect(sentBody(0).thinking).toHaveProperty('block_binding');
        expect(sentBody(1).thinking).not.toHaveProperty('block_binding');
      },
    );

    it('does not retry a stream after yielding assistant content', async () => {
      createImpl.mockResolvedValue(
        throwAfter(status400(BINDING_REJECTION), textDelta(0, 'partial')),
      );
      const stream = await openOpus55Proxy();
      const chunks: GenerateContentResponse[] = [];

      await expect(async () => {
        for await (const chunk of stream) chunks.push(chunk);
      }).rejects.toThrow('block_binding');
      expect(chunks.some((chunk) => chunk.text === 'partial')).toBe(true);
      expect(createImpl).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'api_error',
        'Streaming error: 404: Rate limit exceeded on Anthropic API.',
        429,
      ],
      ['api_error', 'Streaming error: 404: Model not found.', undefined],
      ['api_error', 'Streaming error: 404: Account quota exceeded.', undefined],
      [
        'authentication_error',
        'Streaming error: 404: Rate limit exceeded on Anthropic API.',
        undefined,
      ],
      [
        'api_error',
        'Invalid prompt containing Rate limit exceeded on Anthropic API.',
        undefined,
      ],
    ])(
      'normalizes actual SDK SSE %s / %s to status %s',
      async (type, message, status) => {
        const { default: ActualAnthropic } =
          await vi.importActual<typeof import('@anthropic-ai/sdk')>(
            '@anthropic-ai/sdk',
          );
        const client = new ActualAnthropic({
          apiKey: 'test-key',
          maxRetries: 0,
          fetch: vi.fn().mockResolvedValue(
            new Response(
              `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`,
              {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              },
            ),
          ),
        });
        const stream = await client.messages.create({
          model: 'test-model',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
        });
        const { chunks, error } = await collectFrom(
          stream,
          'https://anthropic-proxy.example.test',
        );
        expect(chunks).toEqual([]);
        expect(error).toBeInstanceOf(Error);
        expect((error as { status?: number }).status).toBe(status);
        expect(isRateLimitError(error)).toBe(status === 429);
        if (status === 429) {
          expect(error).toHaveProperty('cause', expect.any(Error));
          expect((error as Error).cause).not.toHaveProperty('status', 429);
        }
      },
    );

    it.each([401, 404])(
      'preserves explicit status %s on stream errors',
      async (status) => {
        const original = Object.assign(
          new Error(
            JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message:
                  'Streaming error: 404: Rate limit exceeded on Anthropic API.',
              },
            }),
          ),
          { status },
        );
        const { error } = await collectFrom(throwAfter(original));
        expect(error).toBe(original);
        expect(isRateLimitError(error)).toBe(false);
      },
    );

    it.each([
      {
        case: 'multi-delta arguments',
        jsonParts: ['{"file_path":', '"a.sql"}'],
        expectedArgs: { file_path: 'a.sql' },
        expectedEmission: 'message_delta',
      },
      {
        case: 'empty arguments',
        jsonParts: [''],
        expectedArgs: {},
        expectedEmission: 'message_delta',
      },
    ])(
      'emits tool preparation metadata before a function call with $case',
      async ({ jsonParts, expectedArgs, expectedEmission }) => {
        const getToolCallPreparations = await importPreparations();
        let currentEvent = '';
        // Reading `type` records which event the generator is handling.
        const tracked = (event: SseEvent) => ({
          ...event,
          get type() {
            currentEvent = event.type;
            return event.type;
          },
        });
        createImpl.mockResolvedValue(
          streamOf(
            messageStart(),
            toolStart(0, 'call-1', 'read_file'),
            ...jsonParts.map((partialJson) => jsonDelta(0, partialJson)),
            tracked(blockStop(0)),
            tracked(messageDelta('tool_use', 5)),
            { type: 'message_stop' },
          ),
        );

        const chunks: GenerateContentResponse[] = [];
        let eventWhenFunctionCallEmitted: string | undefined;
        for await (const chunk of await openStream()) {
          chunks.push(chunk);
          if (chunk.functionCalls) eventWhenFunctionCallEmitted = currentEvent;
        }

        expect(getToolCallPreparations(chunks[0]!)).toEqual([
          { callId: 'call-1', toolName: 'read_file' },
        ]);
        const functionCallChunks = chunks.filter(
          (chunk) => chunk.functionCalls,
        );
        expect(functionCallChunks).toHaveLength(1);
        expect(eventWhenFunctionCallEmitted).toBe(expectedEmission);
        expect(functionCallChunks[0]!.functionCalls).toEqual([
          { id: 'call-1', name: 'read_file', args: expectedArgs },
        ]);
      },
    );

    it('defers parallel tool calls after empty arguments until the stop reason confirms them', async () => {
      const { chunks, error } = await collectEvents(
        ...toolBlock(0, 'call-empty', 'list_directory', ''),
        ...toolBlock(1, 'call-full', 'read_file', READ_A),
        messageDelta('tool_use', 5),
      );

      expect(error).toBeUndefined();
      expect(fnCalls(chunks)).toEqual([
        { id: 'call-empty', name: 'list_directory', args: {} },
        readCall('call-full'),
      ]);
    });

    it.each([
      { case: 'a retryable socket cut', error: resetByPeer() },
      {
        // A gateway error frame in an already-200 stream: no status and no
        // allow-listed socket code, only the provider's request id. LlmChat's
        // mid-stream boundary admits it, so the release gate does too (the
        // scheduler's repair flow takes over, as after a socket cut). A socket
        // code at any cause level would make it transport and skip the
        // status-less disjunct.
        case: 'a status-less upstream error the provider traced with a request id',
        error: Object.assign(new Error("'id'"), {
          code: 'KeyError',
          requestID: 'req-1',
        }),
      },
    ])(
      'releases closed valid tool calls before rethrowing $case',
      async ({ error: upstreamError }) => {
        const { chunks, error } = await collectThenThrow(
          upstreamError,
          ...toolBlock(0, 'call-complete', 'read_file', READ_A),
        );

        expect(fnCalls(chunks)).toEqual([readCall('call-complete')]);
        expect(error).toBe(upstreamError);
      },
    );

    it.each([
      {
        case: 'an HTTP provider error',
        error: Object.assign(new Error('credit balance is too low'), {
          status: 402,
        }),
      },
      {
        case: 'an abort',
        error: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      },
      {
        case: 'a transport error outside the stream-retry allow-list',
        error: Object.assign(new Error('connection refused'), {
          code: 'ECONNREFUSED',
        }),
      },
    ])(
      'does not release a closed call before rethrowing $case',
      async ({ error }) => {
        const result = await collectThenThrow(
          error,
          ...toolBlock(0, 'call-complete', 'run_shell_command', PWD),
        );

        expect(fnCalls(result.chunks)).toEqual([]);
        expect(result.error).toBe(error);
      },
    );

    it('does not release a closed call when an upstream error leaves a sibling tool block open', async () => {
      const networkError = resetByPeer();
      const { chunks, error } = await collectThenThrow(
        networkError,
        ...toolBlock(0, 'call-complete', 'run_shell_command', PWD),
        toolStart(1, 'call-truncated', 'run_shell_command'),
        jsonDelta(1, TRUNCATED),
      );

      expect(fnCalls(chunks)).toEqual([]);
      expect(error).toBe(networkError);
    });

    it.each([
      { case: 'empty arguments', partialJson: '' },
      { case: 'malformed arguments', partialJson: '{"command":' },
      { case: 'a non-object argument root', partialJson: '[]' },
    ])(
      'does not release a closed call before an upstream error when a sibling closes with $case',
      async ({ partialJson }) => {
        const networkError = resetByPeer();
        const { chunks, error } = await collectThenThrow(
          networkError,
          ...toolBlock(0, 'call-complete', 'run_shell_command', PWD),
          ...toolBlock(1, 'call-invalid', 'run_shell_command', partialJson),
        );

        expect(fnCalls(chunks)).toEqual([]);
        expect(error).toBe(networkError);
      },
    );

    it('routes an unterminated tool call through max-token recovery without emitting the batch', async () => {
      const { chunks, error } = await collectEvents(
        textStart(2),
        textDelta(2, 'partial response'),
        blockStop(2),
        ...toolBlock(0, 'call-full', 'run_shell_command', PWD),
        toolStart(1, 'call-truncated', 'run_shell_command'),
        jsonDelta(1, TRUNCATED),
        messageDelta('max_tokens', 100),
      );

      expect(error).toBeUndefined();
      expect(textsOf(chunks).join('')).toContain('partial response');
      expect(fnCalls(chunks)).toEqual([]);
      expect(lastFinish(chunks)).toBe(FinishReason.MAX_TOKENS);
    });

    it.each([
      { case: 'an empty argument buffer', partialJson: '' },
      { case: 'an unterminated string', partialJson: TRUNCATED },
      { case: 'an unclosed object', partialJson: '{"command":"pwd"' },
      { case: 'a missing argument value', partialJson: '{"command":' },
      { case: 'a trailing comma', partialJson: '{"command":"pwd",}' },
    ])(
      'routes $case through max-token recovery without emitting a call',
      async ({ partialJson }) => {
        const { chunks, error } = await collectEvents(
          ...toolBlock(0, 'call-truncated', 'run_shell_command', partialJson),
          messageDelta('max_tokens', 100),
        );

        expect(error).toBeUndefined();
        expect(fnCalls(chunks)).toEqual([]);
        expect(lastFinish(chunks)).toBe(FinishReason.MAX_TOKENS);
      },
    );

    it.each(['[]', 'null', '42'])(
      'rejects a non-object argument root under max_tokens: %s',
      async (partialJson) => {
        const { chunks, error } = await collectEvents(
          ...toolBlock(0, 'call-invalid', 'run_shell_command', partialJson),
          messageDelta('max_tokens', 100),
        );

        expect(error).toMatchObject(MALFORMED);
        expect(fnCalls(chunks)).toEqual([]);
        expect(
          chunks.some((chunk) =>
            chunk.candidates?.some(
              (candidate) => candidate.finishReason === FinishReason.MAX_TOKENS,
            ),
          ),
        ).toBe(false);
      },
    );

    it('emits a complete non-empty tool call even when the stop reason is max_tokens', async () => {
      const { chunks, error } = await collectEvents(
        ...toolBlock(0, 'call-complete', 'read_file', READ_A),
        messageDelta('max_tokens', 100),
      );

      expect(error).toBeUndefined();
      expect(fnCalls(chunks)).toEqual([readCall('call-complete')]);
      expect(lastFinish(chunks)).toBe(FinishReason.MAX_TOKENS);
    });

    it('releases a complete tool call when a non-tool block remains open at the stop reason', async () => {
      const { chunks, error } = await collectEvents(
        ...toolBlock(0, 'call-complete', 'read_file', READ_A),
        textStart(1),
        textDelta(1, 'done'),
        messageDelta('tool_use', 5),
      );

      expect(error).toBeUndefined();
      expect(fnCalls(chunks)).toEqual([readCall('call-complete')]);
    });

    it('accepts a stop reason when no tool calls are pending', async () => {
      const { chunks, error } = await collectEvents(
        textStart(0),
        textDelta(0, 'done'),
        blockStop(0),
        messageDelta('end_turn', 1),
      );

      expect(error).toBeUndefined();
      expect(fnCalls(chunks)).toEqual([]);
      expect(lastFinish(chunks)).toBe(FinishReason.STOP);
    });

    it.each([
      [
        'rejects an open tool-use block after assistant payload at end of stream',
        [
          textStart(1),
          textDelta(1, 'partial response'),
          blockStop(1),
          toolStart(0, 'call-open', 'run_shell_command'),
          jsonDelta(0, PWD),
        ],
      ],
      [
        'rejects a confirmed turn with an open tool-use block without releasing closed siblings',
        [
          ...toolBlock(0, 'call-complete', 'run_shell_command', PWD),
          toolStart(1, 'call-open', 'run_shell_command'),
          jsonDelta(1, '{"command":"whoami"}'),
          messageDelta('tool_use', 100),
        ],
      ],
    ])('%s', async (_title, events) => {
      const { chunks, error } = await collectEvents(...events);

      expect(error).toMatchObject(MALFORMED);
      expect(fnCalls(chunks)).toEqual([]);
    });

    it.each([
      {
        case: 'an empty argument buffer without a finish reason',
        partialJson: '',
        stopReason: undefined,
      },
      {
        case: 'an empty argument buffer confirmed by end_turn',
        partialJson: '',
        stopReason: 'end_turn',
      },
      {
        case: 'a malformed argument buffer without a finish reason',
        partialJson: '{"command":',
        stopReason: undefined,
      },
      {
        case: 'a non-object argument root without a finish reason',
        partialJson: '[]',
        stopReason: undefined,
      },
      {
        case: 'an unterminated string',
        partialJson: TRUNCATED,
        stopReason: 'tool_use',
      },
      {
        case: 'an unclosed object',
        partialJson: '{"command":"pwd"',
        stopReason: 'tool_use',
      },
      {
        case: 'a missing argument value',
        partialJson: '{"command":',
        stopReason: 'tool_use',
      },
      {
        case: 'a trailing comma',
        partialJson: '{"command":"pwd",}',
        stopReason: 'tool_use',
      },
      { case: 'an array root', partialJson: '[]', stopReason: 'tool_use' },
      { case: 'a null root', partialJson: 'null', stopReason: 'tool_use' },
      { case: 'a numeric root', partialJson: '42', stopReason: 'tool_use' },
    ])(
      'rejects tool arguments with $case without emitting a function call',
      async ({ partialJson, stopReason }) => {
        const { chunks, error } = await collectEvents(
          ...toolBlock(0, 'call-invalid', 'run_shell_command', partialJson),
          ...(stopReason ? [messageDelta(stopReason, 100)] : []),
          { type: 'message_stop' },
        );

        expect(error).toMatchObject(MALFORMED);
        expect(fnCalls(chunks)).toEqual([]);
      },
    );

    it('emits preparations before both function calls in a multi-tool stream', async () => {
      const getToolCallPreparations = await importPreparations();
      const chunks = await streamChunks(
        maxCfg(100),
        toolStart(0, 'call-1', 'read_file'),
        toolStart(1, 'call-2', 'run_shell_command'),
        jsonDelta(0, READ_A),
        blockStop(0),
        jsonDelta(1, PWD),
        blockStop(1),
        messageDelta('tool_use', 5),
      );

      // Tags each item with the index of the chunk that carried it.
      const indexed = <T extends object>(
        of: (chunk: GenerateContentResponse) => readonly T[],
      ) =>
        chunks.flatMap((chunk, index) =>
          of(chunk).map((x) => ({ ...x, index })),
        );
      expect(indexed(getToolCallPreparations)).toEqual([
        { callId: 'call-1', toolName: 'read_file', index: 0 },
        { callId: 'call-2', toolName: 'run_shell_command', index: 1 },
      ]);
      expect(indexed((chunk) => chunk.functionCalls ?? [])).toEqual([
        { ...readCall('call-1'), index: 2 },
        {
          id: 'call-2',
          name: 'run_shell_command',
          args: { command: 'pwd' },
          index: 3,
        },
      ]);
    });

    it.each([
      { label: 'id is missing', contentBlock: { name: 'read_file' } },
      { label: 'name is missing', contentBlock: { id: 'call-1' } },
      { label: 'id is empty', contentBlock: { id: '', name: 'read_file' } },
      { label: 'name is empty', contentBlock: { id: 'call-1', name: '' } },
      {
        label: 'id is not a string',
        contentBlock: { id: 42, name: 'read_file' },
      },
      {
        label: 'name is not a string',
        contentBlock: { id: 'call-1', name: 42 },
      },
    ])(
      'does not emit tool preparation metadata when $label',
      async ({ contentBlock }) => {
        const getToolCallPreparations = await importPreparations();
        const chunks = await streamChunks(
          maxCfg(100),
          blockStart(0, { type: 'tool_use', ...contentBlock, input: {} }),
          blockStop(0),
          messageDelta('tool_use', 1),
        );

        expect(
          chunks.every((chunk) => getToolCallPreparations(chunk).length === 0),
        ).toBe(true);
      },
    );

    it('redacts proxy credentials from stream creation errors', async () => {
      createImpl.mockRejectedValue(
        new Error('407 via http://user:pass@proxy.local'),
      );

      await expect(openStream()).rejects.toThrow(
        '407 via http://<redacted>@proxy.local',
      );
    });

    it('does not leak abort listeners onto the caller signal across streamed requests', async () => {
      // Model the SDK leak: core.mjs fetchWithTimeout never removes the
      // 'abort' listener it adds to whatever signal it is handed.
      createImpl.mockImplementation(
        (_req: unknown, opts: { signal?: AbortSignal }) => {
          opts.signal?.addEventListener('abort', () => {});
          return streamOf(
            blockStart(0, { type: 'text' }),
            textDelta(0, 'Hello'),
            blockStop(0),
          );
        },
      );
      const generator = await newGenerator(maxCfg(100));

      // One long-lived caller signal, like a session-scoped controller.
      const callerAc = new AbortController();
      for (let i = 0; i < 5; i++) {
        const stream = await generator.generateContentStream(
          hello({ config: { abortSignal: callerAc.signal } }),
        );
        await drain(stream);
      }

      // Listeners land on short-lived children, aborted once a stream drains.
      expectCallerSignalIsolated(callerAc);
    });

    it('redacts proxy credentials from stream iteration errors', async () => {
      createImpl.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: vi
            .fn()
            .mockRejectedValue(
              new Error('connect ECONNREFUSED token@proxy.local:8080'),
            ),
        }),
      });

      await expect(drain(await openStream())).rejects.toThrow(
        'connect ECONNREFUSED <redacted>@proxy.local:8080',
      );
    });

    it('preserves message_start usage when the stream fails after content', async () => {
      const getGenAiUsageProvenance = await importProvenance();
      createImpl.mockResolvedValue(
        throwAfter(
          new Error('stream interrupted'),
          messageStart({
            input_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          }),
          textDelta(0, 'partial'),
        ),
      );
      const stream = await openStream();

      const chunks: GenerateContentResponse[] = [];
      await expect(async () => {
        for await (const chunk of stream) chunks.push(chunk);
      }).rejects.toThrow('stream interrupted');

      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.usageMetadata).toEqual({
        promptTokenCount: 9,
        cachedContentTokenCount: 3,
      });
      expect(getGenAiUsageProvenance(chunks[0]?.usageMetadata)).toEqual({
        cachedInputTokensReported: true,
        cacheCreationInputTokens: 4,
      });
    });

    it('requests stream=true and converts streamed events into Gemini chunks', async () => {
      const getGenAiUsageProvenance = await importProvenance();
      const chunks = await streamChunks(
        maxCfg(123),
        messageStart({ cache_read_input_tokens: 2, input_tokens: 3 }),
        blockStart(0, { type: 'text' }),
        textDelta(0, 'Hello'),
        blockStop(0),
        blockStart(1, { type: 'thinking', signature: '' }),
        thinkingDelta(1, 'Think'),
        blockDelta(1, { type: 'signature_delta', signature: 'abc' }),
        blockStop(1),
        toolStart(2, 't1', 'tool'),
        jsonDelta(2, '{"x":'),
        jsonDelta(2, '1}'),
        blockStop(2),
        messageDelta('end_turn', 5, {
          input_tokens: 2,
          cache_read_input_tokens: 7,
        }),
        { type: 'message_stop' },
      );

      expect(lastCall().req).toEqual(expect.objectContaining({ stream: true }));

      const firstPart = (i: number) =>
        chunks[i]?.candidates?.[0]?.content?.parts?.[0];
      expect(firstPart(0)).toEqual({ text: 'Hello' }); // text
      expect(firstPart(1)).toEqual({ text: 'Think', thought: true }); // thinking
      expect(firstPart(2)).toEqual({ thought: true, thoughtSignature: 'abc' }); // signature

      // The preparation-only chunk precedes the complete tool call chunk.
      expect(chunks[3]?.functionCalls).toBeUndefined();
      expect(firstPart(4)).toEqual(fnCall('tool', { x: 1 }, 't1'));

      // Usage/finish chunks exist; check the last one.
      const last = chunks[chunks.length - 1]!;
      expect(
        chunks.every((chunk) => chunk.modelVersion === 'claude-test'),
      ).toBe(true);
      expect(last.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(last.usageMetadata).toEqual({
        cachedContentTokenCount: 7,
        promptTokenCount: 9, // input(2) + cached(7) — Anthropic-true (input < cache_read)
        candidatesTokenCount: 5,
        totalTokenCount: 14,
      });
      expect(getGenAiUsageProvenance(last.usageMetadata)).toEqual({
        cachedInputTokensReported: true,
        cacheCreationInputTokens: undefined,
      });
    });

    it('accumulates cache_creation_input_tokens through the streaming pipeline', async () => {
      // Mid-conversation `message_start` reports cache_read, cache_creation
      // and input; dropping cache_creation from the prompt total makes the
      // Footer under-report by exactly that many tokens.
      const getGenAiUsageProvenance = await importProvenance();
      const chunks = await streamChunks(
        maxCfg(123),
        messageStart({
          input_tokens: 2_500,
          cache_read_input_tokens: 32_088,
          cache_creation_input_tokens: 8_700,
        }),
        blockStart(0, { type: 'text' }),
        textDelta(0, 'ok'),
        blockStop(0),
        messageDelta('end_turn', 400),
        { type: 'message_stop' },
      );

      const last = chunks[chunks.length - 1]!;
      expect(last.usageMetadata).toEqual({
        // 2,500 + 32,088 + 8,700; cachedContentTokenCount is cache_read only.
        promptTokenCount: 43_288,
        candidatesTokenCount: 400,
        totalTokenCount: 43_688,
        cachedContentTokenCount: 32_088,
      });
      expect(getGenAiUsageProvenance(last.usageMetadata)).toEqual({
        cachedInputTokensReported: true,
        cacheCreationInputTokens: 8_700,
      });
    });

    it('does not substitute the requested model when a stream omits it', async () => {
      const chunks = await streamChunks(
        maxCfg(123, { model: 'requested-model' }),
        {
          type: 'message_start',
          message: { id: 'msg-1', usage: { input_tokens: 1 } },
        },
        textDelta(0, 'ok'),
        messageDelta('end_turn', 1),
      );
      expect(chunks).not.toHaveLength(0);
      expect(chunks.every((chunk) => chunk.modelVersion === undefined)).toBe(
        true,
      );
    });

    it('falls back to non-streaming when the stream is empty and surfaces provider errors', async () => {
      createImpl
        // Empty stream: compatible gateways can return HTTP 200 with no SSE
        // events when the real failure body is only available non-streaming.
        .mockResolvedValueOnce(streamOf())
        .mockRejectedValueOnce(new Error('400 quota exceeded'));

      const stream = await openStream(maxCfg(123));

      await expect(drain(stream)).rejects.toThrow('400 quota exceeded');

      expect(createImpl).toHaveBeenCalledTimes(2);
      const [[streamingRequest], [fallbackRequest]] = createImpl.mock
        .calls as AnthropicCreateArgs[];
      expect(streamingRequest).toEqual(
        expect.objectContaining({ stream: true }),
      );
      expect(fallbackRequest).not.toHaveProperty('stream');
      expect(mockReportAnthropicFollowingRequest).toHaveBeenCalledWith(
        fallbackRequest,
        undefined,
      );
    });

    // The probe regressions below need the stream guards ON: an ambient
    // `QWEN_STREAM_*=0` in the shell must not switch them off.
    const withGuardsOn = async (body: () => Promise<void>) => {
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, undefined);
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, undefined);
      try {
        await body();
      } finally {
        vi.unstubAllEnvs();
      }
    };
    const abortError = () => {
      const abortErr = new Error('The operation was aborted');
      abortErr.name = 'AbortError';
      return abortErr;
    };

    it('keeps the fallback probe signal live after the drain abort (no spurious AbortError)', async () => {
      // The stream guard aborts the per-request controller once the source
      // drains, before the probe runs; inheriting it would surface a spurious
      // AbortError instead of the provider's real 402. Like the SDK, `create`
      // rejects an aborted signal at call time.
      await withGuardsOn(async () => {
        createImpl
          .mockResolvedValueOnce(streamOf()) // empty: drains at once
          .mockImplementationOnce(
            (_req: unknown, opts: { signal?: AbortSignal }) =>
              Promise.reject(
                opts?.signal?.aborted
                  ? abortError()
                  : new Error('402 credit balance is too low'),
              ),
          );

        const stream = await openStream(maxCfg(123));

        await expect(drain(stream)).rejects.toThrow(
          '402 credit balance is too low',
        );
        expect(createImpl).toHaveBeenCalledTimes(2);
      });
    });

    it('aborts the fallback probe when the caller signal cancels mid-probe', async () => {
      // The probe's signal is a child of the caller's, so a Ctrl-C during the
      // probe (a 200-but-empty quota response) aborts it instead of spending
      // quota on a cancelled turn. Mutant: a child of `undefined` leaves the
      // hung probe unsettled and this fails on the timeout.
      await withGuardsOn(async () => {
        const callerAc = new AbortController();
        createImpl
          .mockResolvedValueOnce(streamOf()) // empty: drains at once
          .mockImplementationOnce(
            // Hangs until its signal aborts, like an in-flight request.
            (_req: unknown, opts: { signal?: AbortSignal }) =>
              new Promise((_resolve, reject) => {
                const abortErr = abortError();
                if (opts?.signal?.aborted) {
                  reject(abortErr);
                  return;
                }
                opts?.signal?.addEventListener('abort', () => reject(abortErr));
              }),
          );

        const stream = await openStream(maxCfg(123), {
          config: { abortSignal: callerAc.signal },
        });
        const settled = drain(stream).catch((e: unknown) => e);

        // Cancel like a user once the probe is in flight.
        await vi.waitFor(() => expect(createImpl).toHaveBeenCalledTimes(2));
        callerAc.abort();
        const err = await settled;
        expect((err as Error).name).toBe('AbortError');
        expect((err as Error).message).toBe('The operation was aborted');
      });
    });

    it.each([
      { case: 'an empty buffer', partialJson: '' },
      { case: 'a partial buffer', partialJson: '{"file_path":' },
    ])(
      'falls back to non-streaming when an unconfirmed tool block with $case is the only stream payload',
      async ({ partialJson }) => {
        createImpl
          .mockResolvedValueOnce(
            streamOf(
              toolStart(0, 'call-open', 'read_file'),
              jsonDelta(0, partialJson),
            ),
          )
          .mockRejectedValueOnce(new Error('402 credit balance is too low'));
        const { chunks, error } = await collectGeneratedStream();

        expect(error).toMatchObject({
          message: '402 credit balance is too low',
        });
        expect(fnCalls(chunks)).toEqual([]);
        expect(createImpl).toHaveBeenCalledTimes(2);
      },
    );

    it('converts the non-streaming fallback response when an empty stream is recoverable', async () => {
      const streamingAttempt = { generation: 1 };
      const fallbackAttempt = { generation: 2 };
      mockReportAnthropicRequest.mockReturnValueOnce(streamingAttempt);
      mockReportAnthropicFollowingRequest.mockReturnValueOnce(fallbackAttempt);
      createImpl
        .mockResolvedValueOnce(streamOf({ type: 'message_stop' }))
        .mockResolvedValueOnce({
          id: 'msg-fallback',
          model: 'claude-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'fallback ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        });

      const chunks = await collect(await openStream(maxCfg(123)));

      expect(createImpl).toHaveBeenCalledTimes(2);
      const [fallbackRequest, fallbackOptions] = createImpl.mock
        .calls[1] as AnthropicCreateArgs;
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.responseId).toBe('msg-fallback');
      expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([
        { text: 'fallback ok' },
      ]);
      expect(chunks[0]?.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(mockReportAnthropicFollowingRequest).toHaveBeenCalledWith(
        fallbackRequest,
        streamingAttempt,
      );
      expect(mockReportAnthropicResponse).toHaveBeenCalledWith(
        fallbackAttempt,
        expect.objectContaining({ id: 'msg-fallback' }),
      );
      expect(mockReportAnthropicResponse).not.toHaveBeenCalledWith(
        streamingAttempt,
        expect.anything(),
      );
      // Aborting the probe's child once it settles releases the SDK's listener
      // instead of leaving it until the caller's round signal ends.
      expect(fallbackOptions?.signal?.aborted).toBe(true);
    });
  });

  // Issue #9005 finding 4: unlike the OpenAI wire (`withStreamGuards`), the
  // Anthropic wire had no idle watchdog or non-resetting lifetime cap, so a
  // 200 stream that went silent, or drip-fed `thinking_delta` frames forever
  // (resetting any idle-only timer), hung the CLI until killed. Mirrors the
  // OpenAI pipeline's watchdog suite.
  describe('stream watchdog guards (issue #9005 finding 4)', () => {
    // Events arrive only when pushed, modelling a silent or drip-fed stream
    // (mirrors `gatedStream` in openaiContentGenerator/pipeline.test.ts).
    function gatedEventStream() {
      let resolveNext: ((r: IteratorResult<unknown>) => void) | null = null;
      const buffered: unknown[] = [];
      let ended = false;
      let returned = false;
      const DONE = { done: true, value: undefined } as const;
      const item = (value: unknown) => ({ done: false, value }) as const;
      const deliver = (r: IteratorResult<unknown>) => {
        const r2 = resolveNext;
        resolveNext = null;
        r2?.(r);
      };
      return {
        push(event: unknown) {
          if (resolveNext) deliver(item(event));
          else buffered.push(event);
        },
        end() {
          ended = true;
          if (resolveNext) deliver(DONE);
        },
        wasReturned: () => returned,
        stream: {
          [Symbol.asyncIterator]: () => ({
            next(): Promise<IteratorResult<unknown>> {
              if (buffered.length)
                return Promise.resolve(item(buffered.shift()));
              if (ended) return Promise.resolve(DONE);
              return new Promise((res) => {
                resolveNext = res;
              });
            },
            return(): Promise<IteratorResult<unknown>> {
              returned = true;
              ended = true;
              if (resolveNext) deliver(DONE);
              return Promise.resolve(DONE);
            },
          }),
        },
      };
    }

    type GuardConfig = {
      streamIdleTimeoutMs?: number;
      streamMaxLifetimeMs?: number;
    };
    // Feed a gated source to a fresh guarded generator and open one stream.
    const openGated = async (
      guardConfig: GuardConfig,
      request: object = {},
    ) => {
      const gated = gatedEventStream();
      createImpl.mockResolvedValue(gated.stream);
      const stream = await openStream(maxCfg(100, guardConfig), request);
      return { gated, stream };
    };

    // Without the guards a silent source never settles, so callers race the
    // result against a sentinel: a missing watchdog fails, not hangs.
    const consumeUntilSettled = (
      stream: AsyncGenerator<GenerateContentResponse>,
    ) => drain(stream).catch((e: unknown) => e);
    // Flush pending timer work, then take the settled result or the sentinel
    // (given, or made from a label).
    const settledOr = async (
      captured: Promise<unknown>,
      sentinel: symbol | string,
    ) => {
      await vi.advanceTimersByTimeAsync(0);
      const s = typeof sentinel === 'string' ? Symbol(sentinel) : sentinel;
      return Promise.race([captured, Promise.resolve(s)]);
    };
    const idleTimeout = (idleMs: number) => ({
      name: 'StreamInactivityTimeoutError',
      code: 'ETIMEDOUT',
      idleMs,
      chunksReceived: 0,
    });
    const lifetimeExceeded = (maxLifetimeMs: number) => ({
      name: 'StreamLifetimeExceededError',
      code: 'ETIMEDOUT',
      maxLifetimeMs,
    });

    beforeEach(() => {
      // Ignore ambient QWEN_STREAM_* knobs from the dev/CI shell so the
      // explicit-config tests aren't silently overridden.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, undefined);
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, undefined);
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it('aborts and throws a retryable ETIMEDOUT when the stream is silent past the idle timeout', async () => {
      const { gated, stream } = await openGated({
        streamIdleTimeoutMs: 1000,
        streamMaxLifetimeMs: 0,
      }); // never pushes → silent
      const captured = consumeUntilSettled(stream);
      await vi.advanceTimersByTimeAsync(1000);
      const err = await settledOr(captured, 'idle-watchdog-did-not-fire');
      expect(err).toMatchObject(idleTimeout(1000));
      expect((err as Error).message).toContain('QWEN_STREAM_IDLE_TIMEOUT_MS');
      expect(gated.wasReturned()).toBe(true);
    });

    it('uses the shared default idle timeout when no override is configured', async () => {
      const { stream } = await openGated({}); // never pushes → silent
      const captured = consumeUntilSettled(stream);
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      const err = await settledOr(
        captured,
        'default-idle-watchdog-did-not-fire',
      );
      expect(err).toMatchObject(idleTimeout(DEFAULT_STREAM_IDLE_TIMEOUT_MS));
    });

    it('honours QWEN_STREAM_IDLE_TIMEOUT_MS when no explicit config is set', async () => {
      // Twin of the OpenAI pipeline case. Mutant: using
      // `streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS` in place of
      // `resolveStreamIdleTimeoutMs` ignores the env knob.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '3000');
      const { gated, stream } = await openGated({}); // never pushes → silent
      const captured = consumeUntilSettled(stream);
      await vi.advanceTimersByTimeAsync(2999); // inside the env window
      const earlySentinel = Symbol('idle-watchdog-fired-before-env-value');
      const early = await settledOr(captured, earlySentinel);
      expect(early).toBe(earlySentinel); // not yet at the env value
      await vi.advanceTimersByTimeAsync(1); // t=3000 — the env value
      const err = await settledOr(captured, 'env-idle-watchdog-did-not-fire');
      expect(err).toMatchObject(idleTimeout(3000));
      expect((err as Error).message).toContain('QWEN_STREAM_IDLE_TIMEOUT_MS');
      expect(gated.wasReturned()).toBe(true);
    });

    it('does not interrupt a stream whose events keep arriving inside the idle window', async () => {
      const { gated, stream } = await openGated({
        streamIdleTimeoutMs: 1000,
        streamMaxLifetimeMs: 0,
      });
      let done = false;
      let error: unknown;
      let chunks: GenerateContentResponse[] = [];
      const consume = collect(stream).then(
        (all) => {
          chunks = all;
          done = true;
        },
        (e: unknown) => (error = e),
      );
      gated.push(messageStart());
      gated.push(textStart(0));
      gated.push(textDelta(0, 'hel'));
      await vi.advanceTimersByTimeAsync(500); // < 1000ms idle window
      gated.push(textDelta(0, 'lo'));
      await vi.advanceTimersByTimeAsync(500);
      gated.push(blockStop(0));
      gated.push(messageDelta('end_turn', 1));
      gated.push({ type: 'message_stop' });
      gated.end();
      await vi.advanceTimersByTimeAsync(0);
      await consume;
      expect(error).toBeUndefined();
      expect(done).toBe(true);
      expect(textsOf(chunks)).toEqual(['hel', 'lo']);
    });

    it('caps total stream lifetime when thinking deltas keep resetting the idle watchdog', async () => {
      // The finding-4 shape (#8597): thinking_delta drips reset the idle timer
      // while the message never completes; the lifetime cap does not reset.
      const { gated, stream } = await openGated({
        streamIdleTimeoutMs: 1000,
        streamMaxLifetimeMs: 3000,
      }); // drip-fed, never ends
      const captured = consumeUntilSettled(stream);
      gated.push(messageStart());
      await vi.advanceTimersByTimeAsync(500);
      gated.push(blockStart(0, { type: 'thinking', thinking: '' }));
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 4; i++) {
        gated.push(thinkingDelta(0, 't'));
        await vi.advanceTimersByTimeAsync(500); // each drip resets the 1s idle watchdog
      }
      await vi.advanceTimersByTimeAsync(1000); // now past the 3000ms cap
      const err = await settledOr(captured, 'lifetime-cap-did-not-fire');
      expect(err).toMatchObject({
        ...lifetimeExceeded(3000),
        chunksReceived: 6,
      });
      expect((err as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
      expect(gated.wasReturned()).toBe(true);
    });

    it('honours QWEN_STREAM_MAX_LIFETIME_MS when no explicit config is set', async () => {
      // Twin of the OpenAI pipeline case. Mutant: `streamMaxLifetimeMs ?? 0`
      // in place of `resolveStreamMaxLifetimeMs` disables the cap.
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, '4000');
      const { stream, gated } = await openGated({}); // drip-fed, never ends
      const captured = consumeUntilSettled(stream);
      gated.push(messageStart());
      for (let i = 0; i < 7; i++) {
        gated.push(thinkingDelta(0, 't'));
        await vi.advanceTimersByTimeAsync(500); // each drip resets the idle watchdog
      }
      await vi.advanceTimersByTimeAsync(1000); // t=4500 — past the 4s env cap
      const err = await settledOr(captured, 'env-lifetime-cap-did-not-fire');
      expect(err).toMatchObject(lifetimeExceeded(4000));
      expect((err as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
    });

    it('uses the default lifetime cap when nothing overrides it', async () => {
      // Drips every 200s stay inside the 240s default idle window, so only
      // the 900s default lifetime cap can fire.
      const { stream, gated } = await openGated({}); // drip-fed, never ends
      const captured = consumeUntilSettled(stream);
      gated.push(messageStart());
      for (let i = 0; i < 5; i++) {
        gated.push(thinkingDelta(0, 't'));
        await vi.advanceTimersByTimeAsync(200_000);
      }
      // The cap fires at t=900s; the t=800s drip holds the idle timer to 1040s.
      const err = await settledOr(
        captured,
        'default-lifetime-cap-did-not-fire',
      );
      expect(err).toMatchObject(
        lifetimeExceeded(DEFAULT_STREAM_MAX_LIFETIME_MS),
      );
      expect((err as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
    });

    it('leaves streams unguarded when both timeouts are disabled (<= 0)', async () => {
      const { gated, stream } = await openGated({
        streamIdleTimeoutMs: 0,
        streamMaxLifetimeMs: 0,
      });
      let done = false;
      let error: unknown;
      const consume = drain(stream).then(
        () => (done = true),
        (e: unknown) => (error = e),
      );
      gated.push(textStart(0));
      // A silence far beyond the default idle timeout, survivable only when
      // the guards are explicitly disabled.
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS + 1000);
      gated.push(textDelta(0, 'still here'));
      gated.push(blockStop(0));
      gated.push(messageDelta('end_turn', 1));
      gated.end();
      await vi.advanceTimersByTimeAsync(0);
      await consume;
      expect(error).toBeUndefined();
      expect(done).toBe(true);
    });

    it('propagates a user AbortError (not ETIMEDOUT) when the parent signal is aborted', async () => {
      // Twin of the OpenAI pipeline case: a retryable ETIMEDOUT would make the
      // retry loop resume the turn the user just cancelled. Pins the
      // `parentSignal` passed to `withStreamGuards` (`undefined` fails this).
      const callerAc = new AbortController();
      const { gated, stream } = await openGated(
        { streamIdleTimeoutMs: 1000, streamMaxLifetimeMs: 0 },
        { config: { abortSignal: callerAc.signal } },
      ); // never pushes → silent
      const captured = consumeUntilSettled(stream);
      callerAc.abort();
      await vi.advanceTimersByTimeAsync(1000);
      const sentinel = Symbol('user-abort-did-not-propagate');
      const err = await settledOr(captured, sentinel);
      expect(err).not.toBe(sentinel);
      expect((err as Error).name).toBe('AbortError');
      expect((err as { code?: string }).code).not.toBe('ETIMEDOUT');
      expect(gated.wasReturned()).toBe(true);
    });
  });

  describe('tool_choice mapping from Gemini toolConfig', () => {
    const sendWithToolConfig = async (
      mode: string | undefined,
      hasTools: boolean,
    ) => {
      const tools = hasTools
        ? [
            {
              functionDeclarations: [
                {
                  name: 'respond_in_schema',
                  description: 'test',
                  parameters: {
                    type: 'object' as const,
                    properties: {
                      shouldBlock: { type: 'boolean' as const },
                    },
                  },
                },
              ],
            },
          ]
        : undefined;
      const { req } = await send(nativeCfg('claude-opus-4-6'), {
        contents: [userText('test')],
        config: {
          tools,
          ...(mode !== undefined && {
            toolConfig: { functionCallingConfig: { mode } },
          }),
        },
      });
      return req;
    };

    it.each<[string, string | undefined, boolean, unknown]>([
      ['sets tool_choice=any when mode is ANY', 'ANY', true, { type: 'any' }],
      [
        'omits tool_choice when mode is NONE (Anthropic has no none type)',
        'NONE',
        true,
        undefined,
      ],
      ['omits tool_choice when mode is AUTO', 'AUTO', true, undefined],
      [
        'omits tool_choice when no toolConfig is set',
        undefined,
        true,
        undefined,
      ],
      [
        'omits tool_choice when there are no tools even with mode ANY',
        'ANY',
        false,
        undefined,
      ],
    ])('%s', async (_title, mode, hasTools, expected) => {
      const req = await sendWithToolConfig(mode, hasTools);
      expect(req['tool_choice']).toEqual(expected);
    });
  });
});
