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
import {
  DashScopeOpenAICompatibleProvider,
  selectDashScopeThinkingKnob,
} from './dashscope.js';
import { determineProvider } from '../index.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import type { ReasoningEffort } from '../../reasoning-effort.js';
import type { ChatCompletionToolWithCache } from './types.js';
import {
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DISABLED_REQUEST_TIMEOUT_MS,
} from '../constants.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import type { OpenAIRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

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

vi.mock('../../../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: vi.fn(),
}));

type Wire = Record<string, unknown>;
type Part = OpenAI.Chat.ChatCompletionContentPart;

const META = { sessionId: 'test-session-id', promptId: 'test-prompt-id' };
const EPHEMERAL = { type: 'ephemeral' };
const txt = (text: string) => ({ type: 'text' as const, text });
const cachedText = (text: string) => ({
  ...txt(text),
  cache_control: EPHEMERAL,
});
const img = (url: string) => ({
  type: 'image_url' as const,
  image_url: { url },
});
const tier = (effort: ReasoningEffort) => ({ reasoning: { effort } });
const ua = (version: string) =>
  `QwenCode/${version} (${process.platform}; ${process.arch})`;
const DASHSCOPE_HEADERS = {
  'User-Agent': ua('1.0.0'),
  'X-DashScope-CacheControl': 'enable',
  'X-DashScope-UserAgent': ua('1.0.0'),
  'X-DashScope-AuthType': AuthType.QWEN_OAUTH,
};
const sampling = () => ({
  temperature: 0.8,
  top_p: 0.9,
  frequency_penalty: 0.1,
  presence_penalty: 0.2,
  stop: ['END'],
  user: 'test-user',
});
// One expect per listed wire field.
const expectWire = (result: Wire, fields: Wire) => {
  for (const [key, value] of Object.entries(fields)) {
    expect(result[key]).toEqual(value);
  }
};
const expectDropped = (
  model: string,
  reasoningEffort: string | undefined,
  dropped: string[],
) =>
  expect(mockDebugLogger.warn).toHaveBeenCalledWith(
    'DashScope: dropped conflicting thinking knobs',
    { model, reasoningEffort, dropped },
  );

describe('DashScopeOpenAICompatibleProvider', () => {
  let provider: DashScopeOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  // A fresh provider over the default config plus overrides.
  const gen = (
    cfg: Partial<ContentGeneratorConfig> = {},
    cli = mockCliConfig,
  ) =>
    new DashScopeOpenAICompatibleProvider(
      { ...mockContentGeneratorConfig, ...cfg } as ContentGeneratorConfig,
      cli,
    );
  // One buildRequest on the shared provider with a hand-built request.
  const send = (
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    extra: Wire = {},
    reattachBlockCount?: number,
  ) =>
    provider.buildRequest(
      {
        model: 'qwen-max',
        messages,
        ...extra,
      } as OpenAI.Chat.ChatCompletionCreateParams,
      'test-prompt-id',
      reattachBlockCount,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    const mockedBuildRuntimeFetchOptions =
      buildRuntimeFetchOptions as unknown as MockedFunction<
        (sdkType: 'openai', proxyUrl?: string) => OpenAIRuntimeFetchOptions
      >;
    mockedBuildRuntimeFetchOptions.mockReturnValue(undefined);

    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      timeout: 60000,
      maxRetries: 2,
      model: 'qwen-max',
      authType: AuthType.QWEN_OAUTH,
    } as ContentGeneratorConfig;

    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        enableCacheControl: true,
      }),
      getProxy: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    provider = new DashScopeOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('constructor', () => {
    it('should initialize with provided configs', () => {
      expect(provider).toBeInstanceOf(DashScopeOpenAICompatibleProvider);
    });
  });

  it.each([
    [{ thinking_budget: 4096 }, { thinking_budget: 4096 }],
    [{ enable_thinking: false }, { reasoning_effort: 'none' }],
    [{ enable_thinking: true }, { reasoning_effort: 'low' }],
    [
      { reasoning_effort: 'medium', thinking_budget: 4096 },
      { reasoning_effort: 'medium' },
    ],
  ])(
    'honors configured tiered protocols with extra_body %j',
    (extraBody, expected) => {
      const model = 'qwen-custom-tiered';
      const getResolvedModelConfig = vi.fn().mockReturnValue({
        capabilities: {
          reasoning: {
            thinking: true,
            efforts: ['low', 'medium', 'xhigh'],
            defaultEffort: 'xhigh',
            disableField: 'reasoning_effort',
          },
        },
      });
      mockCliConfig.getResolvedModelConfig = getResolvedModelConfig;
      mockContentGeneratorConfig.authType = AuthType.USE_OPENAI;
      mockContentGeneratorConfig.model = 'qwen-configured-main';
      mockContentGeneratorConfig.reasoning = { effort: 'low' };
      mockContentGeneratorConfig.extra_body = extraBody;
      const wire = provider.buildRequest(
        { model, messages: [] },
        'test',
      ) as unknown as Wire;
      expect({
        enable_thinking: wire['enable_thinking'],
        reasoning_effort: wire['reasoning_effort'],
        thinking_budget: wire['thinking_budget'],
      }).toEqual({
        enable_thinking: undefined,
        reasoning_effort: undefined,
        thinking_budget: undefined,
        ...expected,
      });
      expect(getResolvedModelConfig).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        model,
        mockContentGeneratorConfig.baseUrl,
      );
      mockContentGeneratorConfig.reasoning = { effort: 'high' };
      mockContentGeneratorConfig.extra_body = undefined;
      const invalid = provider.buildRequest(
        { model, messages: [] },
        'test',
      ) as unknown as Wire;
      expect(invalid['reasoning_effort']).toBeUndefined();
    },
  );

  it('enables content-only thinking-tag leak detection', () => {
    expect(provider.getResponseParsingOptions()).toEqual({
      contentOnlyThinkingTagLeaks: true,
    });
  });

  describe('isDashScopeProvider', () => {
    const isDashScope = (baseUrl: string, authType = AuthType.USE_OPENAI) =>
      DashScopeOpenAICompatibleProvider.isDashScopeProvider({
        authType,
        baseUrl,
      } as ContentGeneratorConfig);
    const withProxy = (baseUrl: string) => {
      vi.stubEnv(
        'DASHSCOPE_PROXY_BASE_URL',
        'https://your-proxy.com/dashscope',
      );
      return isDashScope(baseUrl);
    };
    const PROXY_MISMATCH =
      'DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match';
    const INTERNAL_ORIGIN_LOG =
      'DashScope provider activated via internal origin: gateway.alibaba-inc.com';

    it('should return true for QWEN_OAUTH auth type', () => {
      expect(
        isDashScope('https://api.openai.com/v1', AuthType.QWEN_OAUTH),
      ).toBe(true);
    });

    it.each([
      [
        'should return true for DashScope domestic URL',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ],
      [
        'should return true for DashScope international URL',
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      ],
      [
        'should return true for DashScope US regional URL',
        'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      ],
      [
        'should return true for DashScope coding plan URL',
        'https://coding.dashscope.aliyuncs.com/v1',
      ],
      [
        'should return true for DashScope international coding plan URL',
        'https://coding-intl.dashscope-intl.aliyuncs.com/v1',
      ],
      [
        'should return true for Token Plan URL',
        'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      ],
      [
        'should return true for internal aliyun-inc.com subdomain',
        'https://model-gateway.aliyun-inc.com/dashscope/v1',
      ],
      [
        'should return true for multi-level internal subdomain',
        'https://a.b.alibaba-inc.com/dashscope/v1',
      ],
      [
        'should return true for port-bearing internal URL',
        'https://gateway.alibaba-inc.com:8443/dashscope/v1',
      ],
      [
        'should return true for port-bearing alicloudapi.com URL',
        'https://gateway.alicloudapi.com:8443/v1',
      ],
    ])('%s', (_title, baseUrl) => {
      expect(isDashScope(baseUrl)).toBe(true);
    });

    it.each([
      [
        'should return false for bare alicloudapi.com domain',
        'https://alicloudapi.com/v1',
      ],
      [
        'should return false for bare alibaba-inc.com domain',
        'https://alibaba-inc.com/v1',
      ],
      [
        'should return false for bare aliyun-inc.com domain',
        'https://aliyun-inc.com/v1',
      ],
      [
        'should return false when the dashscope domain only appears in the URL path',
        'https://evil.example.com/dashscope.aliyuncs.com/v1',
      ],
      [
        'should return false for a domain that only ends with dashscope.aliyuncs.com as a suffix without a dot',
        'https://notdashscope.aliyuncs.com/v1',
      ],
      ['should return false for an unparseable baseUrl', 'not a url'],
    ])('%s', (_title, baseUrl) => {
      expect(isDashScope(baseUrl)).toBe(false);
    });

    it('should return true for internal alibaba-inc.com subdomain', () => {
      expect(isDashScope('https://gateway.alibaba-inc.com/dashscope/v1')).toBe(
        true,
      );
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(INTERNAL_ORIGIN_LOG);
    });

    it('should return true for alicloudapi.com subdomain', () => {
      expect(isDashScope('https://api-id.cn-hangzhou.alicloudapi.com/v1')).toBe(
        true,
      );
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'DashScope provider activated via alicloudapi origin: api-id.cn-hangzhou.alicloudapi.com',
      );
    });

    it('should return false for lookalike internal domains without dot boundary', () => {
      [
        'https://notalibaba-inc.com/v1',
        'https://notaliyun-inc.com/v1',
        'https://alibaba-inc.com.evil.com/v1',
        'https://aliyun-inc.com.evil.com/v1',
        'https://not-token-plan.cn-beijing.maas.aliyuncs.com/v1',
        'https://token-plan.cn-beijing.maas.aliyuncs.com.evil.com/v1',
        'https://notalicloudapi.com/v1',
        'https://alicloudapi.com.evil.com/v1',
      ].forEach((baseUrl) => {
        expect(isDashScope(baseUrl)).toBe(false);
      });
    });

    it('should return false for non-DashScope configurations', () => {
      [
        'https://api.openai.com/v1',
        'https://api.anthropic.com/v1',
        'https://openrouter.ai/api/v1',
      ].forEach((baseUrl) => {
        expect(isDashScope(baseUrl)).toBe(false);
      });
    });

    it.each([
      [
        'should return true when baseUrl matches DASHSCOPE_PROXY_BASE_URL',
        'https://your-proxy.com/dashscope',
        true,
      ],
      [
        'should return false when baseUrl does not match DASHSCOPE_PROXY_BASE_URL',
        'https://other-proxy.com/dashscope',
        false,
      ],
      [
        'should return true when baseUrl matches DASHSCOPE_PROXY_BASE_URL with trailing slash',
        'https://your-proxy.com/dashscope/',
        true,
      ],
    ])('%s', (_title, baseUrl, expected) => {
      expect(withProxy(baseUrl)).toBe(expected);
    });

    it('should debug log when baseUrl does not match DASHSCOPE_PROXY_BASE_URL', () => {
      expect(withProxy('https://other-proxy.com/dashscope')).toBe(false);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(PROXY_MISMATCH),
      );
    });

    it('should log internal-origin activation instead of proxy mismatch for internal domains', () => {
      expect(withProxy('https://gateway.alibaba-inc.com/dashscope/v1')).toBe(
        true,
      );
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(INTERNAL_ORIGIN_LOG);
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining(PROXY_MISMATCH),
      );
    });
  });

  // Guards the full acceptance path end-to-end: an alicloudapi.com base URL
  // must route through the DashScope provider so buildRequest injects the
  // session-tracking metadata into the request body.
  describe('determineProvider routing for alicloudapi.com', () => {
    const alicloudapiConfig = {
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api-id.cn-hangzhou.alicloudapi.com/v1',
      model: 'qwen-max',
    } as ContentGeneratorConfig;

    it('routes alicloudapi.com base URLs to the DashScope provider', () => {
      expect(
        determineProvider(alicloudapiConfig, mockCliConfig),
      ).toBeInstanceOf(DashScopeOpenAICompatibleProvider);
    });

    it('injects session-tracking metadata into the request body', () => {
      const routed = determineProvider(
        alicloudapiConfig,
        mockCliConfig,
      ) as DashScopeOpenAICompatibleProvider;
      const result = routed.buildRequest(
        { model: 'qwen-max', messages: [{ role: 'user', content: 'Hello!' }] },
        'test-prompt-id',
      );
      expect(result.metadata).toEqual(META);
    });
  });

  describe('buildHeaders', () => {
    const omniHeaders = (enabled: boolean) =>
      new DashScopeOpenAICompatibleProvider(mockContentGeneratorConfig, {
        ...mockCliConfig,
        isOmniEnabled: vi.fn().mockReturnValue(enabled),
      } as unknown as Config).buildHeaders();

    it('should build DashScope-specific headers', () => {
      expect(provider.buildHeaders()).toEqual(DASHSCOPE_HEADERS);
    });

    it('should merge custom headers with DashScope defaults', () => {
      const headers = gen({
        customHeaders: {
          'X-Custom': '1',
          'X-DashScope-CacheControl': 'disable',
        },
      }).buildHeaders();

      expect(headers['User-Agent']).toContain('QwenCode/1.0.0');
      expect(headers['X-DashScope-UserAgent']).toContain('QwenCode/1.0.0');
      expect(headers['X-DashScope-AuthType']).toBe(AuthType.QWEN_OAUTH);
      expect(headers['X-Custom']).toBe('1');
      expect(headers['X-DashScope-CacheControl']).toBe('disable');
    });

    it('should handle unknown CLI version', () => {
      vi.mocked(mockCliConfig.getCliVersion).mockReturnValue(undefined);
      const headers = provider.buildHeaders();
      expect(headers['User-Agent']).toBe(ua('unknown'));
      expect(headers['X-DashScope-UserAgent']).toBe(ua('unknown'));
    });

    it('should add the OssResourceResolve header when omni is enabled', () => {
      expect(omniHeaders(true)['X-DashScope-OssResourceResolve']).toBe(
        'enable',
      );
    });

    it('should omit the OssResourceResolve header when omni is disabled', () => {
      expect(omniHeaders(false)).not.toHaveProperty(
        'X-DashScope-OssResourceResolve',
      );
    });
  });

  describe('buildClient', () => {
    it('should create OpenAI client with DashScope configuration', () => {
      const client = provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-api-key',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          timeout: 60000,
          maxRetries: 2,
          defaultHeaders: DASHSCOPE_HEADERS,
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

      const headers = new Headers(runtimeFetch.mock.calls[0][1]?.headers);
      expect(headers.get('session_id')).toBe('test-session-id');
    });

    it('should use default timeout and maxRetries when not provided', () => {
      mockContentGeneratorConfig.timeout = undefined;
      mockContentGeneratorConfig.maxRetries = undefined;
      provider.buildClient();
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-api-key',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          timeout: DEFAULT_TIMEOUT,
          maxRetries: DEFAULT_MAX_RETRIES,
          defaultHeaders: expect.any(Object),
        }),
      );
    });

    it('should disable the timeout when configured to 0', () => {
      mockContentGeneratorConfig.timeout = 0;
      provider.buildClient();
      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({ timeout: DISABLED_REQUEST_TIMEOUT_MS }),
      );
    });
  });

  describe('buildMetadata', () => {
    it('should build metadata with session and prompt IDs', () => {
      expect(provider.buildMetadata('test-prompt-id')).toEqual({
        metadata: META,
      });
    });

    it('should handle missing session ID', () => {
      // Remove the method entirely (optional chaining yields undefined).
      delete (mockCliConfig as unknown as Record<string, unknown>)[
        'getSessionId'
      ];
      expect(provider.buildMetadata('test-prompt-id')).toEqual({
        metadata: { sessionId: undefined, promptId: 'test-prompt-id' },
      });
    });
  });

  describe('buildRequest', () => {
    const baseRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'qwen-max',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' },
      ],
      temperature: 0.7,
    };
    // baseRequest plus overrides through the given provider.
    const build = (
      p: DashScopeOpenAICompatibleProvider,
      req: object = {},
      promptId = 'test-prompt-id',
    ) =>
      p.buildRequest(
        { ...baseRequest, ...req } as OpenAI.Chat.ChatCompletionCreateParams,
        promptId,
      ) as unknown as Wire;
    const wire = (
      cfg?: Partial<ContentGeneratorConfig>,
      req?: object,
      cli?: Config,
    ) => build(gen(cfg, cli), req);
    // Same model on the config and the request.
    const wireM = (
      model: string,
      cfg: Partial<ContentGeneratorConfig> = {},
      req: object = {},
    ) => wire({ model, ...cfg }, { model, ...req });
    const sessionCli = (session: object) =>
      ({
        ...mockCliConfig,
        getContentGeneratorConfig: () => session,
      }) as unknown as Config;

    // DashScope is an aggregating gateway. `metadata` is a platform-private
    // tracing object that only its own inference path understands; forwarded to a
    // third-party vendor backend that types `metadata` as a string it fails to
    // deserialize and the request comes back as a flat 400, which made those
    // models unusable through Qwen Code entirely.
    it.each([['qwen-max'], ['qwen3.8-max'], ['coder-model']] as const)(
      'ships metadata for the qwen-family model %s',
      (model) => {
        expect(build(provider, { model })['metadata']).toEqual(META);
      },
    );

    it.each([
      ['ZHIPU/GLM-5.3-Flash'],
      ['deepseek-v4-pro'],
      ['moonshot/kimi-k3'],
    ] as const)('omits metadata for the non-qwen model %s', (model) => {
      const result = build(provider, { model });
      expect(result['metadata']).toBeUndefined();
      // The gate is metadata-only: everything else the provider ships is untouched.
      expect(result['messages']).toBeDefined();
      expect(result['preserve_thinking']).toBe(true);
    });

    it.each([['ZHIPU/GLM-5.3-Flash'], ['glm-5.2']] as const)(
      'sends metadata for the non-qwen model %s when enableRequestMetadata is true',
      (model) => {
        // The client cannot tell a forwarded request from one DashScope serves
        // itself, so an operator whose first-party non-qwen sessions still need
        // sessionId/promptId correlation can force the field back on.
        const result = wire({ enableRequestMetadata: true }, { model });
        expect(result['metadata']).toEqual(META);
      },
    );

    it('omits metadata even for a qwen model when enableRequestMetadata is false', () => {
      const result = wire(
        { enableRequestMetadata: false },
        { model: 'qwen-max' },
      );
      expect(result['metadata']).toBeUndefined();
    });

    // buildRequest has a second, separate return for vision models with its own
    // metadata spread. The gate tests above only exercise the non-vision return, so
    // a regression at the vision call site would ship `metadata` for a non-qwen
    // vision model while every test above stayed green.
    it('ships metadata on the vision path for a qwen-family vision model', () => {
      expectWire(build(provider, { model: 'qwen-vl-max' }), {
        vl_high_resolution_images: true,
        metadata: META,
      });
    });

    it('omits metadata on the vision path when enableRequestMetadata is false', () => {
      // Still the vision branch, so the gate is what changed and not the route.
      expectWire(
        wire({ enableRequestMetadata: false }, { model: 'qwen-vl-max' }),
        { vl_high_resolution_images: true, metadata: undefined },
      );
    });

    it('gates the vision path on the request model, not the configured model', () => {
      // resolveWireModel falls back to the configured model when the request
      // model is missing. A non-qwen configured model with a qwen vision request
      // model is the one input where the two disagree, so it pins which one the
      // vision call site hands the gate.
      expectWire(
        wire({ model: 'ZHIPU/GLM-5.3-Flash' }, { model: 'qwen-vl-max' }),
        { vl_high_resolution_images: true, metadata: META },
      );
    });

    // A side-model generator is built with its own per-model config but shares
    // the session Config, so the gate reads only the provider's own value. The
    // session's value must neither override a per-model opt-out nor fill in a
    // value the cross-provider agent config deliberately cleared.
    it('prefers the provider config enableRequestMetadata over the session value', () => {
      const result = wire(
        { enableRequestMetadata: false },
        { model: 'ZHIPU/GLM-5.3-Flash' },
        sessionCli({ enableRequestMetadata: true }),
      );
      expect(result['metadata']).toBeUndefined();
    });

    it('honours a provider config enableRequestMetadata when the session sets none', () => {
      const result = wire(
        { enableRequestMetadata: true },
        { model: 'ZHIPU/GLM-5.3-Flash' },
        sessionCli({}),
      );
      expect(result['metadata']).toEqual(META);
    });

    it('ignores the session enableRequestMetadata when the provider config has none', () => {
      // buildAgentContentGeneratorConfig clears every generation field for a
      // cross-provider agent, so undefined here is deliberate and the ambient
      // session value must not fill it in for a vendor-forwarded model.
      const result = wire(
        { enableRequestMetadata: undefined },
        { model: 'ZHIPU/GLM-5.3-Flash' },
        sessionCli({ enableRequestMetadata: true }),
      );
      expect(result['metadata']).toBeUndefined();
    });

    it('ignores a session false when the provider config has none', () => {
      // Same isolation in the other direction: a session opt-out must not
      // strip tracing from a cross-provider agent running a first-party model.
      const result = wire(
        { enableRequestMetadata: undefined },
        { model: 'qwen-max' },
        sessionCli({ enableRequestMetadata: false }),
      );
      expect(result['metadata']).toEqual(META);
    });

    it.each([
      ['gpt-5.4', 'high', 'high'],
      ['gpt-5.4', 'max', 'xhigh'],
      ['gpt-6-astra', 'max', 'max'],
    ] as const)(
      'maps %s effort %s to flat %s on an IdeaLab gateway',
      (model, effort, expected) => {
        const result = wireM(
          model,
          {
            authType: AuthType.USE_OPENAI,
            baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
            ...tier(effort),
            samplingParams: { max_completion_tokens: 1024 },
          },
          { ...tier(effort), max_completion_tokens: 1024 },
        );
        expectWire(result, {
          reasoning_effort: expected,
          reasoning: undefined,
          max_completion_tokens: 1024,
        });
      },
    );

    it('should add cache control to system message only for non-streaming requests', () => {
      const result = provider.buildRequest(
        { ...baseRequest, stream: false },
        'test-prompt-id',
      );
      expect(result.messages).toHaveLength(2);
      const [systemMessage, lastMessage] = result.messages;
      expect(systemMessage.role).toBe('system');
      expect(systemMessage.content).toEqual([
        cachedText('You are a helpful assistant.'),
      ]);
      // Last message should NOT have cache control for non-streaming requests
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe('Hello!');
    });

    it('sends enable_thinking:true on a qwen model when a reasoning effort is set', () => {
      expect(wire(tier('high'))['enable_thinking']).toBe(true);
    });

    describe.each(['qwen3.8-max', 'qwen3.8-max-preview'])(
      '%s reasoning effort',
      (model) => {
        it.each(['low', 'medium', 'high', 'xhigh'] as const)(
          'passes %s through as reasoning_effort',
          (effort) => {
            expectWire(wireM(model, tier(effort), tier(effort)), {
              reasoning_effort: effort,
              enable_thinking: undefined,
              reasoning: undefined,
            });
          },
        );
      },
    );

    describe.each([
      'qwen3.8-max',
      'qwen3.8-max-preview',
      'qwen3.8-max-latest',
      'qwen3.8-max-2026-01-15',
    ])('%s reasoning effort ceiling', (model) => {
      it('warns once however many requests the same provider builds', () => {
        const generator = gen({ model, ...tier('max') });
        const request = { model, ...tier('max') };
        build(generator, request, 'first');
        build(generator, request, 'second');

        const clampWarnings = mockDebugLogger.warn.mock.calls.filter(
          (call: unknown[]) =>
            typeof call[0] === 'string' &&
            call[0].includes('tiered-effort family'),
        );
        expect(clampWarnings).toHaveLength(1);
      });

      it('clamps the max tier to xhigh, the strongest tier DashScope accepts', () => {
        const result = wireM(model, tier('max'), tier('max'));
        expect(result['reasoning_effort']).toBe('xhigh');
      });
    });

    it('caps a non-qwen model on a DashScope host at the generic ceiling', () => {
      const result = wireM('vendor-compatible-model', tier('max'), tier('max'));
      expect(result['reasoning']).toEqual({ effort: 'xhigh' });
    });

    it('caps a GLM model served over DashScope, which is not a Z.ai host', () => {
      const result = wireM('glm-5.2', tier('max'), tier('max'));
      expect(result['reasoning']).toEqual({ effort: 'xhigh' });
    });

    it('lets extra_body override qwen3.8-max reasoning_effort', () => {
      const result = wireM(
        'qwen3.8-max',
        { ...tier('low'), extra_body: { reasoning_effort: 'max' } },
        tier('low'),
      );
      expect(result['reasoning_effort']).toBe('max');
    });

    it('preserves a request-level qwen3.8-max reasoning_effort override', () => {
      const result = wireM('qwen3.8-max', tier('low'), {
        reasoning_effort: 'max',
        ...tier('low'),
      });
      expectWire(result, { reasoning_effort: 'max', reasoning: undefined });
    });

    // Omitted row keys are undefined/false/{}.
    it.each([
      {
        name: 'extra_body thinking_budget over request-level effort',
        extraBody: { enable_thinking: true, thinking_budget: 4096 },
        requestFields: { reasoning_effort: 'max' },
        expectedBudget: 4096,
        expectedThinking: true,
      },
      {
        name: 'request-level thinking_budget over configured effort',
        requestFields: { thinking_budget: 2048 },
        configuredReasoning: true,
        expectedBudget: 2048,
      },
      {
        name: 'extra_body thinking_budget over configured effort',
        extraBody: { thinking_budget: 3072 },
        configuredReasoning: true,
        expectedBudget: 3072,
      },
      {
        name: 'extra_body effort over request-level thinking_budget',
        extraBody: { reasoning_effort: 'max' },
        requestFields: { thinking_budget: 2048 },
        expectedEffort: 'max',
      },
      {
        name: 'request-level effort over a same-layer thinking_budget',
        requestFields: { reasoning_effort: 'high', thinking_budget: 1024 },
        expectedEffort: 'high',
      },
      {
        name: 'null extra_body thinking_budget falls through to configured effort',
        extraBody: { thinking_budget: null },
        configuredReasoning: true,
        expectedEffort: 'low',
      },
      {
        name: 'null extra_body reasoning_effort falls through to configured effort',
        extraBody: { reasoning_effort: null },
        configuredReasoning: true,
        expectedEffort: 'low',
      },
      {
        name: 'null request-level thinking_budget falls through to configured effort',
        requestFields: { thinking_budget: null },
        configuredReasoning: true,
        expectedEffort: 'low',
      },
      {
        name: 'null request-level reasoning_effort falls through to configured effort',
        requestFields: { reasoning_effort: null },
        configuredReasoning: true,
        expectedEffort: 'low',
      },
      {
        name: 'null extra_body enable_thinking is omitted without a configured effort',
        extraBody: { enable_thinking: null },
      },
      {
        name: 'null request-level enable_thinking is omitted without a configured effort',
        requestFields: { enable_thinking: null },
      },
    ])('resolves $name', (testCase) => {
      const result = wireM(
        'qwen3.8-max-preview',
        {
          ...(testCase.configuredReasoning ? tier('low') : {}),
          extra_body: testCase.extraBody,
        },
        testCase.requestFields,
      );
      expectWire(result, {
        reasoning_effort: testCase.expectedEffort,
        thinking_budget: testCase.expectedBudget,
        enable_thinking: testCase.expectedThinking,
        reasoning: undefined,
      });
    });

    it('warns that the dropped budget came from a request-level same-layer pair', () => {
      wireM(
        'qwen3.8-max-preview',
        {},
        {
          reasoning_effort: 'high',
          thinking_budget: 1024,
        },
      );
      expectDropped('qwen3.8-max-preview', 'high', ['thinking_budget']);
    });

    it('drops the preset enable_thinking when an effort tier ships on qwen3.8-max-preview', () => {
      // The Token Plan preset ships qwen3.8-max-preview with enableThinking,
      // which provider-config.ts turns into extra_body.enable_thinking; the
      // provider merges that extra_body last. With an effort tier selected the
      // wire body must carry reasoning_effort alone, not both competing knobs.
      const model = 'qwen3.8-max-preview';
      const generator = gen({
        model,
        ...tier('high'),
        extra_body: { enable_thinking: true },
      });
      expectWire(build(generator, { model, ...tier('high') }), {
        reasoning_effort: 'high',
        enable_thinking: undefined,
        reasoning: undefined,
      });
      expectDropped(model, 'high', ['enable_thinking']);

      // The conflict is persistent for this generator; the warn fires once,
      // not on every request.
      build(generator, { model, ...tier('high') }, 'test-prompt-id-2');
      expect(mockDebugLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('keeps enable_thinking when a request-level reasoning_effort override ships on a legacy qwen model', () => {
      // Legacy hybrids read enable_thinking, not reasoning_effort; the
      // override passes through as an opaque parameter and must not delete
      // the thinking switch, or the wire would carry no thinking signal.
      const result = wireM('qwen3.7-max', tier('high'), {
        reasoning_effort: 'max',
        ...tier('high'),
      });
      expectWire(result, { reasoning_effort: 'max', enable_thinking: true });
    });

    it('drops the inert reasoning_effort when it conflicts with thinking_budget on a legacy qwen model', () => {
      // DashScope rejects the reasoning_effort + thinking_budget pair. Legacy
      // hybrids read enable_thinking/thinking_budget, not reasoning_effort, so
      // the inert field goes and the knobs the model reads survive.
      const result = wireM(
        'qwen3.7-max',
        { ...tier('high'), extra_body: { thinking_budget: 1024 } },
        { reasoning_effort: 'max', ...tier('high') },
      );
      expectWire(result, {
        reasoning_effort: undefined,
        enable_thinking: true,
        thinking_budget: 1024,
      });
    });

    it('drops the inert reasoning_effort for a legacy qwen model with only a user thinking_budget', () => {
      // No config tier: the wire would otherwise carry a single ignored
      // parameter (reasoning_effort) with the meaningful thinking_budget
      // deleted. The user's budget must survive.
      const result = wireM('qwen3.7-max', {
        extra_body: { thinking_budget: 4096, reasoning_effort: 'max' },
      });
      expectWire(result, {
        reasoning_effort: undefined,
        thinking_budget: 4096,
        enable_thinking: undefined,
      });
    });

    it('keeps every knob for a non-qwen model with an extra_body enable_thinking and reasoning_effort', () => {
      // glm/kimi presets inject enable_thinking via extra_body; a user
      // reasoning_effort override is an opaque sampling override there, not
      // a thinking switch, and must not delete the preset's switch.
      const result = wireM('glm-5.2', {
        extra_body: { enable_thinking: true, reasoning_effort: 'high' },
      });
      expectWire(result, { enable_thinking: true, reasoning_effort: 'high' });
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps every knob for a non-qwen model with an extra_body thinking_budget and reasoning_effort', () => {
      // The family gate's observable effect for non-qwen models: a user
      // thinking_budget survives alongside an opaque reasoning_effort
      // override (mutation check: deleting the gate's early return drops
      // the budget here).
      const result = wireM('glm-5.2', {
        extra_body: { reasoning_effort: 'high', thinking_budget: 1024 },
      });
      expectWire(result, { reasoning_effort: 'high', thinking_budget: 1024 });
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps the thinking knobs when reasoning_effort is the none disable value', () => {
      // 'none' is an explicit disable that stays on the wire (pipeline
      // semantics), not a tier that overrides the thinking knobs.
      const result = wireM('qwen3.8-max', {
        ...tier('high'),
        extra_body: { enable_thinking: true, reasoning_effort: 'none' },
      });
      expectWire(result, { reasoning_effort: 'none', enable_thinking: true });
    });

    it('honours an explicit extra_body enable_thinking: false over the tier on qwen3.8-max', () => {
      // The off-switch arrives through the documented extra_body escape
      // hatch; deleting it would silently turn thinking back on. Translate
      // it into the family's canonical disable instead.
      const result = wireM('qwen3.8-max', {
        ...tier('high'),
        extra_body: { enable_thinking: false },
      });
      expectWire(result, {
        reasoning_effort: 'none',
        enable_thinking: undefined,
      });
    });

    it('honours samplingParams enable_thinking: false over the configured tier', () => {
      const result = wireM('qwen3.8-max', tier('high'), {
        enable_thinking: false,
      });
      expectWire(result, {
        reasoning_effort: 'none',
        enable_thinking: undefined,
      });
    });

    it('keeps extra_body effort over a lower-priority samplingParams disable', () => {
      const result = wireM(
        'qwen3.8-max',
        { ...tier('high'), extra_body: { reasoning_effort: 'max' } },
        { enable_thinking: false },
      );
      expectWire(result, {
        reasoning_effort: 'max',
        enable_thinking: undefined,
      });
    });

    it('keeps the tier over a lower-priority samplingParams disable when extra_body enables thinking', () => {
      // Regression: selection used to register only `enable_thinking ===
      // false`, so the lower-priority disable won cross-layer resolution
      // and rewrote the shipping tier to `none` — inverting the documented
      // extra_body > samplingParams precedence.
      const result = wireM(
        'qwen3.8-max',
        { ...tier('high'), extra_body: { enable_thinking: true } },
        { enable_thinking: false },
      );
      expectWire(result, {
        reasoning_effort: 'high',
        enable_thinking: undefined,
      });
      expectDropped('qwen3.8-max', 'high', ['enable_thinking']);
    });

    it('keeps a higher-priority extra_body enable_thinking over a samplingParams disable without a tier', () => {
      const result = wireM(
        'qwen3.8-max',
        { extra_body: { enable_thinking: true } },
        { enable_thinking: false },
      );
      expectWire(result, {
        enable_thinking: true,
        reasoning_effort: undefined,
      });
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps a samplingParams budget over the configured tier under an extra_body on-switch', () => {
      // The on-switch blocks lower-priority off-switches but does not choose
      // a value, so the next value-bearing layer still wins over reasoning.
      const result = wireM(
        'qwen3.8-max',
        { ...tier('high'), extra_body: { enable_thinking: true } },
        { thinking_budget: 2048 },
      );
      expectWire(result, {
        reasoning_effort: undefined,
        enable_thinking: true,
        thinking_budget: 2048,
      });
      expectDropped('qwen3.8-max', 'high', ['reasoning_effort']);
    });

    it('keeps higher-priority extra_body thinking knobs over a configured tier', () => {
      // Both extra_body fields outrank the configured reasoning effort, so
      // the lower-priority tier is removed without discarding user knobs.
      const result = wireM('qwen3.8-max', {
        ...tier('high'),
        extra_body: { enable_thinking: true, thinking_budget: 1024 },
      });
      expectWire(result, {
        reasoning_effort: undefined,
        enable_thinking: true,
        thinking_budget: 1024,
      });
      expectDropped('qwen3.8-max', 'high', ['reasoning_effort']);
    });

    it('keeps a higher-priority budget over a request-level none sentinel', () => {
      const result = wireM(
        'qwen3.8-max',
        { extra_body: { thinking_budget: 4096 } },
        { reasoning_effort: 'none' },
      );
      expectWire(result, {
        reasoning_effort: undefined,
        thinking_budget: 4096,
      });
      expectDropped('qwen3.8-max', 'none', ['reasoning_effort']);
    });

    it('keeps a higher-priority budget over a request-level disable', () => {
      const result = wireM(
        'qwen3.8-max',
        { extra_body: { thinking_budget: 4096 } },
        { enable_thinking: false },
      );
      expectWire(result, {
        reasoning_effort: undefined,
        enable_thinking: undefined,
        thinking_budget: 4096,
      });
      expectDropped('qwen3.8-max', undefined, ['enable_thinking']);
    });

    it.each([
      {
        name: 'extra_body disable over a request-level budget',
        extraBody: { enable_thinking: false },
        requestFields: { thinking_budget: 4096 },
      },
      {
        name: 'same-layer extra_body disable and budget',
        extraBody: { enable_thinking: false, thinking_budget: 1024 },
      },
      {
        name: 'same-layer request-level disable and budget',
        requestFields: { enable_thinking: false, thinking_budget: 2048 },
      },
    ])('canonicalizes $name without a configured tier', (testCase) => {
      const result = wireM(
        'qwen3.8-max',
        { extra_body: testCase.extraBody },
        testCase.requestFields,
      );
      expectWire(result, {
        reasoning_effort: 'none',
        enable_thinking: undefined,
        thinking_budget: undefined,
      });
      expectDropped('qwen3.8-max', undefined, [
        'enable_thinking',
        'thinking_budget',
      ]);
    });

    it('keeps a legacy Qwen budget over an opaque none effort', () => {
      const result = wireM('qwen3.7-max', {
        extra_body: { thinking_budget: 4096, reasoning_effort: 'none' },
      });
      expectWire(result, {
        reasoning_effort: undefined,
        thinking_budget: 4096,
      });
    });

    it('drops every conflicting knob when extra_body explicitly disables thinking', () => {
      const result = wireM('qwen3.8-max', {
        ...tier('high'),
        extra_body: { enable_thinking: false, thinking_budget: 1024 },
      });
      expectWire(result, {
        reasoning_effort: 'none',
        enable_thinking: undefined,
        thinking_budget: undefined,
      });
      expectDropped('qwen3.8-max', 'high', [
        'enable_thinking',
        'thinking_budget',
      ]);
    });

    it('drops an explicit budget when none disables thinking', () => {
      const result = wireM(
        'qwen3.8-max',
        { extra_body: { enable_thinking: false, thinking_budget: 1024 } },
        { reasoning_effort: 'none' },
      );
      expectWire(result, {
        reasoning_effort: 'none',
        enable_thinking: undefined,
        thinking_budget: undefined,
      });
      expectDropped('qwen3.8-max', 'none', [
        'enable_thinking',
        'thinking_budget',
      ]);
    });

    it.each(['qwen3.8-max-2026-01-15', 'qwen3.8-max-latest'])(
      'passes effort through and drops the preset enable_thinking for the %s snapshot/alias id',
      (model) => {
        const result = wireM(model, {
          ...tier('xhigh'),
          extra_body: { enable_thinking: true },
        });
        expectWire(result, {
          reasoning_effort: 'xhigh',
          enable_thinking: undefined,
        });
      },
    );

    it('reports cross-layer and same-layer drops together', () => {
      const result = wireM('qwen3.8-max', {
        extra_body: {
          enable_thinking: true,
          reasoning_effort: 'high',
          thinking_budget: 1024,
        },
      });
      expectWire(result, {
        reasoning_effort: 'high',
        enable_thinking: undefined,
        thinking_budget: undefined,
      });
      expectDropped('qwen3.8-max', 'high', [
        'thinking_budget',
        'enable_thinking',
      ]);
    });

    it('does not warn about an undefined thinking_budget key', () => {
      const result = wireM('qwen3.8-max', {
        extra_body: { reasoning_effort: 'high', thinking_budget: undefined },
      });
      expectWire(result, {
        reasoning_effort: 'high',
        thinking_budget: undefined,
      });
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps thinking_budget alongside enable_thinking on legacy qwen models', () => {
      // thinking_budget + enable_thinking is a valid pair on hybrid models;
      // only the reasoning_effort combination is rejected.
      const result = wireM('qwen3.7-max', {
        ...tier('high'),
        extra_body: { thinking_budget: 1024 },
      });
      expectWire(result, { enable_thinking: true, thinking_budget: 1024 });
    });

    it('vision model: keeps enable_thinking when extra_body ships a reasoning_effort override', () => {
      // qwen-vl-max is a legacy hybrid that reads enable_thinking; the
      // vision branch merges extra_body last like the text path, and the
      // override must not delete the thinking switch there either.
      const result = wireM('qwen-vl-max', {
        ...tier('high'),
        extra_body: { reasoning_effort: 'max' },
      });
      expectWire(result, {
        reasoning_effort: 'max',
        enable_thinking: true,
        vl_high_resolution_images: true,
      });
    });

    it('vision model: drops the inert reasoning_effort against a thinking_budget on the vision branch too', () => {
      // qwen-vl-max is a legacy hybrid; the vision branch resolves the budget
      // conflict the same way as the text path: the inert reasoning_effort
      // goes, the knobs the model reads survive.
      const result = wireM(
        'qwen-vl-max',
        { ...tier('high'), extra_body: { thinking_budget: 2048 } },
        { reasoning_effort: 'max' },
      );
      expectWire(result, {
        reasoning_effort: undefined,
        enable_thinking: true,
        thinking_budget: 2048,
        vl_high_resolution_images: true,
      });
    });

    it('strips the pipeline-injected nested reasoning when enable_thinking is added on a qwen model', () => {
      // The pipeline injects a nested `reasoning: { effort }` object for
      // OpenAI-compatible endpoints. qwen drives thinking via `enable_thinking`,
      // so shipping both would send two competing knobs — the nested form must
      // be dropped (mirrors deepseek.ts / zai.ts).
      expectWire(wire(tier('high'), tier('high')), {
        enable_thinking: true,
        reasoning: undefined,
      });
    });

    it('vision model: injects enable_thinking and strips nested reasoning on a qwen-vl model', () => {
      // The vision branch of buildRequest duplicates the enable_thinking / strip
      // logic; exercise it directly so a divergence from the text path is caught.
      expectWire(wireM('qwen-vl-max', tier('high'), tier('high')), {
        enable_thinking: true,
        reasoning: undefined,
        vl_high_resolution_images: true,
      });
    });

    it('keeps the nested reasoning for a non-qwen wire model (no enable_thinking, no strip)', () => {
      expectWire(wireM('glm-4.6', tier('high'), tier('high')), {
        enable_thinking: undefined,
        reasoning: { effort: 'high' },
      });
    });

    it('omits enable_thinking when no reasoning effort is set', () => {
      expect(build(provider)['enable_thinking']).toBeUndefined();
    });

    it('does not send enable_thinking for a non-qwen wire model even with effort set', () => {
      expect(wireM('glm-4.6', tier('high'))['enable_thinking']).toBeUndefined();
    });

    const toolHistory = (): OpenAI.Chat.ChatCompletionMessageParam[] => [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'tool', content: 'First tool output', tool_call_id: 'call_1' },
      { role: 'tool', content: 'Second tool output', tool_call_id: 'call_2' },
      { role: 'user', content: 'Hello!' },
    ];
    const mockTools = (): OpenAI.Chat.ChatCompletionTool[] => [
      {
        type: 'function',
        function: {
          name: 'mockTool',
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    // System message cached; tool messages left unchanged.
    const expectCachedSystemAndTools = (
      result: OpenAI.Chat.ChatCompletionCreateParams,
    ) => {
      expect(result.messages).toHaveLength(4);
      expect(result.messages[0].content).toEqual([
        cachedText('You are a helpful assistant.'),
      ]);
      expect(result.messages[1].role).toBe('tool');
      expect(result.messages[1].content).toBe('First tool output');
      expect(result.messages[2].role).toBe('tool');
      expect(result.messages[2].content).toBe('Second tool output');
    };

    it('should add cache control to system message only for non-streaming requests with tools', () => {
      const result = provider.buildRequest(
        {
          ...baseRequest,
          messages: toolHistory(),
          tools: mockTools(),
          stream: false,
        },
        'test-prompt-id',
      );
      expectCachedSystemAndTools(result);
      // Neither the last message nor the tools get cache control when not streaming.
      expect(result.messages[3].role).toBe('user');
      expect(result.messages[3].content).toBe('Hello!');
      const tools = result.tools as ChatCompletionToolWithCache[];
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(1);
      expect(tools[0].cache_control).toBeUndefined();
    });

    it('should add cache control to system, last history message, and last tool definition for streaming requests', () => {
      const result = provider.buildRequest(
        {
          ...baseRequest,
          stream: true,
          messages: toolHistory(),
          tools: mockTools(),
        },
        'test-prompt-id',
      );
      expectCachedSystemAndTools(result);
      expect(result.messages[3].content).toEqual([cachedText('Hello!')]);
      const tools = result.tools as ChatCompletionToolWithCache[];
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(1);
      expect(tools[0].cache_control).toEqual(EPHEMERAL);
    });

    it('should not add cache control to tool messages when request.tools is undefined', () => {
      const result = provider.buildRequest(
        {
          ...baseRequest,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'tool', content: 'Tool output', tool_call_id: 'call_1' },
            { role: 'user', content: 'Hello!' },
          ],
        },
        'test-prompt-id',
      );

      expect(result.messages).toHaveLength(3);
      expect(result.messages[1].role).toBe('tool');
      expect(result.messages[1].content).toBe('Tool output');
      expect(result.tools).toBeUndefined();
    });

    it('should include metadata in the request', () => {
      expect(
        provider.buildRequest(baseRequest, 'test-prompt-id').metadata,
      ).toEqual(META);
    });

    it('should preserve all original request parameters', () => {
      const result = build(provider, { max_tokens: 1000, ...sampling() });
      expect(result['model']).toBe('qwen-max');
      expect(result['max_tokens']).toBe(1000);
      expectWire(result, sampling());
    });

    it('should skip cache control when disabled', () => {
      vi.mocked(mockCliConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'qwen-max',
        enableCacheControl: false,
      });
      const result = provider.buildRequest(baseRequest, 'test-prompt-id');
      // Messages should remain as strings (not converted to array format)
      expect(result.messages[0].content).toBe('You are a helpful assistant.');
      expect(result.messages[1].content).toBe('Hello!');
    });

    it('should handle messages with array content for streaming requests', () => {
      // stream: true triggers cache control on the last message.
      const result = send(
        [{ role: 'user', content: [txt('Hello'), txt('World')] }],
        { stream: true },
      );
      const message = result.messages[0];
      expect(Array.isArray(message.content)).toBe(true);
      const content = message.content as Part[];
      expect(content).toHaveLength(2);
      expect(content[1]).toEqual(cachedText('World'));
    });

    // glm-* on DashScope drop array-form content on tool-less ("plain") chat
    // requests. For glm models with no function-calling context the provider
    // skips cache control and collapses text content to plain strings, so
    // side-queries like web_fetch aren't silently emptied. Other models and
    // tool-bearing requests keep the existing cache-control path untouched.
    describe('glm array-drop fix (plain-text flatten)', () => {
      const glm = (
        messages: OpenAI.Chat.ChatCompletionMessageParam[],
        extra: Wire = {},
      ) => send(messages, { model: 'glm-5.2', stream: false, ...extra });

      it('should flatten system and user text content to strings for a glm tool-less request', () => {
        const result = glm([
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: [txt('Summarize this page.')] },
        ]);
        // No cache_control is applied; both messages become plain strings.
        expect(result.messages[0].content).toBe('You are a helpful assistant.');
        expect(result.messages[1].content).toBe('Summarize this page.');
      });

      it('should join multi-part text-only array content with blank lines', () => {
        const result = glm([
          { role: 'user', content: [txt('First block'), txt('Second block')] },
        ]);
        expect(result.messages[0].content).toBe('First block\n\nSecond block');
      });

      it('should flatten the streamed last message too for a glm tool-less request', () => {
        const result = glm([{ role: 'user', content: [txt('Hello')] }], {
          stream: true,
        });
        expect(result.messages[0].content).toBe('Hello');
      });

      it('should NOT flatten array content that contains a non-text (media) part', () => {
        const result = glm([
          {
            role: 'user',
            content: [txt('What is this?'), img('https://example.com/x.jpg')],
          },
        ]);
        // The whole message is left untouched (cannot be a plain string).
        expect(result.messages[0].content).toEqual([
          txt('What is this?'),
          img('https://example.com/x.jpg'),
        ]);
      });

      it('should leave an empty content array unchanged for a glm tool-less request', () => {
        const result = glm([{ role: 'user', content: [] }]);
        expect(result.messages[0].content).toEqual([]);
      });

      it('should flatten glm content even when cache control is disabled', () => {
        vi.mocked(mockCliConfig.getContentGeneratorConfig).mockReturnValue({
          model: 'glm-5.2',
          enableCacheControl: false,
        });
        const result = glm([
          { role: 'system', content: [txt('Sys')] },
          { role: 'user', content: [txt('Hi')] },
        ]);
        expect(result.messages[0].content).toBe('Sys');
        expect(result.messages[1].content).toBe('Hi');
      });

      // Any function-calling signal (a tools field, an assistant tool_call, or a
      // tool result in history) keeps glm out of the flatten path: cache control
      // is applied and array content is preserved.
      const functionCallingCases: Array<{
        name: string;
        extraMessages: OpenAI.Chat.ChatCompletionMessageParam[];
        tools?: OpenAI.Chat.ChatCompletionTool[];
        userIndex: number;
      }> = [
        {
          name: 'declares tools',
          extraMessages: [],
          tools: [
            {
              type: 'function',
              function: {
                name: 'noop',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          userIndex: 1,
        },
        {
          name: 'has an assistant turn with tool_calls',
          extraMessages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'noop', arguments: '{}' },
                },
              ],
            },
          ],
          userIndex: 2,
        },
        {
          name: 'has tool-result history',
          extraMessages: [
            { role: 'tool', content: 'tool result', tool_call_id: 'call_1' },
          ],
          userIndex: 2,
        },
      ];

      it.each(functionCallingCases)(
        'should keep cache control and array content for a glm request that $name',
        ({ extraMessages, tools, userIndex }) => {
          const result = glm(
            [
              { role: 'system', content: 'Sys' },
              ...extraMessages,
              { role: 'user', content: [txt('Hi')] },
            ],
            tools ? { tools } : {},
          );
          expect(result.messages[0].content).toEqual([cachedText('Sys')]);
          expect(Array.isArray(result.messages[userIndex].content)).toBe(true);
        },
      );

      it('should NOT flatten content for a non-glm tool-less request', () => {
        const result = send(
          [
            { role: 'system', content: 'Sys' },
            { role: 'user', content: [txt('Hi')] },
          ],
          { stream: false },
        );
        // Non-glm: existing behavior — system cached as array, user untouched.
        expect(result.messages[0].content).toEqual([cachedText('Sys')]);
        expect(result.messages[1].content).toEqual([txt('Hi')]);
      });
    });

    it('should handle empty messages array', () => {
      const result = send([]);
      expect(result.messages).toEqual([]);
      expect(result.metadata).toBeDefined();
    });

    it('should handle messages without content for streaming requests', () => {
      const result = send(
        [
          { role: 'assistant', content: null },
          { role: 'user', content: 'Hello' },
        ],
        { stream: true },
      );
      expect(result.messages[0].content).toBeNull();
      // The last message gets cache control when streaming.
      expect(result.messages[1].content).toEqual([cachedText('Hello')]);
    });

    it('should add cache control to last text item in mixed content for streaming requests', () => {
      const result = send(
        [
          {
            role: 'user',
            content: [
              txt('Look at this image:'),
              img('https://example.com/image.jpg'),
              txt('What do you see?'),
            ],
          },
        ],
        { stream: true },
      );
      const content = result.messages[0].content as Part[];
      expect(content).toHaveLength(3);
      expect(content[2]).toEqual(cachedText('What do you see?'));
      // Image item should remain unchanged
      expect(content[1]).toEqual(img('https://example.com/image.jpg'));
    });

    it('should add cache control to last item even if not text for streaming requests', () => {
      const result = send(
        [
          {
            role: 'user',
            content: [
              txt('Look at this:'),
              img('https://example.com/image.jpg'),
            ],
          },
        ],
        { stream: true },
      );
      const content = result.messages[0].content as Part[];
      expect(content).toHaveLength(2);
      expect(content[1]).toEqual({
        ...img('https://example.com/image.jpg'),
        cache_control: EPHEMERAL,
      });
    });
  });

  describe('cache control edge cases', () => {
    it('should handle request with only system message', () => {
      const result = send([{ role: 'system', content: 'System prompt' }]);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toEqual([cachedText('System prompt')]);
    });

    it('should handle request without system message for streaming requests', () => {
      const result = send(
        [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'Response' },
          { role: 'user', content: 'Second message' },
        ],
        { stream: true },
      );
      expect(result.messages).toHaveLength(3);
      // Only the last message gets cache control (no system message).
      expect(result.messages[0].content).toBe('First message');
      expect(result.messages[1].content).toBe('Response');
      expect(result.messages[2].content).toEqual([
        cachedText('Second message'),
      ]);
    });

    it('should handle empty content array for streaming requests', () => {
      const result = send([{ role: 'user', content: [] }], { stream: true });
      expect(result.messages[0].content).toEqual([]);
    });
  });

  describe('reattach boundary cache control (issue #11627)', () => {
    const reattachImageBlock = {
      type: 'image_url' as const,
      image_url: { url: 'data:image/png;base64,AAAA' },
    };
    const streamed = (
      messages: OpenAI.Chat.ChatCompletionMessageParam[],
      reattachBlockCount?: number,
    ) => send(messages, { stream: true }, reattachBlockCount);
    const contentAt = (
      result: OpenAI.Chat.ChatCompletionCreateParams,
      index: number,
    ) => result.messages[index]?.content as Part[] | undefined;

    it('places the conversation breakpoint before reattached parts appended to the last user message', () => {
      const result = streamed(
        [
          { role: 'system', content: 'System prompt' },
          {
            role: 'user',
            content: [
              txt('Stable user text'),
              txt('Recent images reattached'),
              reattachImageBlock,
            ],
          },
        ],
        2,
      );
      const content = contentAt(result, 1);
      expect(content).toHaveLength(3);
      // Breakpoint lands on the stable text block, not the reattach marker/image.
      expect(content?.[0]).toMatchObject(cachedText('Stable user text'));
      expect(content?.[1]).not.toHaveProperty('cache_control');
      expect(content?.[2]).not.toHaveProperty('cache_control');
    });

    it('walks back to the previous message when the whole last message is reattach', () => {
      const result = streamed(
        [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: 'Stable user text' },
          {
            role: 'user',
            content: [txt('Recent images reattached'), reattachImageBlock],
          },
        ],
        2,
      );
      // The last message is entirely reattach content: it must not be marked.
      const lastContent = contentAt(result, 2);
      expect(lastContent?.[0]).not.toHaveProperty('cache_control');
      expect(lastContent?.[1]).not.toHaveProperty('cache_control');
      // The breakpoint moves onto the previous stable message instead.
      expect(result.messages[1]?.content).toEqual([
        cachedText('Stable user text'),
      ]);
    });

    it('keeps the last-block anchor when no reattach boundary is supplied', () => {
      const result = streamed([
        { role: 'system', content: 'System prompt' },
        {
          role: 'user',
          content: [txt('Stable user text'), reattachImageBlock],
        },
      ]);
      const content = contentAt(result, 1);
      // Unchanged behavior: last block keeps the breakpoint.
      expect(content?.[1]).toMatchObject({
        type: 'image_url',
        cache_control: EPHEMERAL,
      });
      expect(content?.[0]).not.toHaveProperty('cache_control');
    });

    it('skips an empty-string tool result when walking back to a stable block', () => {
      const result = streamed(
        [
          { role: 'system', content: 'System prompt' },
          { role: 'tool', tool_call_id: 'call_1', content: '' },
          {
            role: 'user',
            content: [txt('Recent images reattached'), reattachImageBlock],
          },
        ],
        2,
      );
      // The empty tool result stays a bare string — not rewritten into a
      // fabricated zero-length text part carrying cache_control.
      expect(result.messages[1]?.content).toBe('');
      // The breakpoint degrades to the system message (system-only caching).
      expect(result.messages[0]?.content).toEqual([
        cachedText('System prompt'),
      ]);
    });

    it('walks the anchor back past a current-turn inline image to stable text', () => {
      const result = streamed(
        [
          { role: 'system', content: 'System prompt' },
          {
            role: 'user',
            content: [
              txt('look at this screenshot'),
              reattachImageBlock,
              txt('Recent images reattached'),
              reattachImageBlock,
            ],
          },
        ],
        2,
      );
      const content = contentAt(result, 1);
      // Breakpoint lands on the prompt text, not the inline image the next
      // turn textualizes.
      expect(content?.[0]).toMatchObject(cachedText('look at this screenshot'));
      expect(content?.[1]).not.toHaveProperty('cache_control');
    });
  });

  describe('output token limits', () => {
    const hello = (
      model: string,
      extra: Wire = {},
      p: DashScopeOpenAICompatibleProvider = provider,
    ) =>
      p.buildRequest(
        {
          model,
          messages: [{ role: 'user', content: 'Hello' }],
          ...extra,
        } as OpenAI.Chat.ChatCompletionCreateParams,
        'test-prompt-id',
      ) as unknown as Wire;

    it.each([
      // qwen3-max caps output at 32K.
      [
        'should limit max_tokens when it exceeds model limit',
        'qwen3-max',
        { max_tokens: 100000 },
        32768,
      ],
      [
        'should not modify max_tokens when it is within model limit',
        'qwen3-max',
        { max_tokens: 1000 },
        1000,
      ],
      [
        'should set model max_tokens default when not present in request',
        'qwen3-max',
        {},
        32768,
      ],
      [
        'should set model max_tokens when null is provided',
        'qwen3-max',
        { max_tokens: null },
        32768,
      ],
      // Unknown models: respect the user's value (the backend may support it).
      [
        'should respect user max_tokens for unknown models',
        'unknown-model',
        { max_tokens: 40000 },
        40000,
      ],
    ])('%s', (_title, model, extra, expected) => {
      expect(hello(model, extra)['max_tokens']).toBe(expected);
    });

    it('should preserve other request parameters when limiting max_tokens', () => {
      const result = hello('qwen3-max', { max_tokens: 100000, ...sampling() });
      expect(result['max_tokens']).toBe(32768);
      expectWire(result, sampling());
    });

    it('should set high resolution flag for the coder-model model', () => {
      const result = send(
        [
          {
            role: 'user',
            content: [
              txt('Alias payload'),
              img('https://example.com/alias.png'),
            ],
          },
        ],
        { model: 'coder-model', max_tokens: 100000 },
      ) as unknown as Wire;
      // Limited to the model's 64K output limit.
      expect(result['max_tokens']).toBe(65536);
      expect(result['vl_high_resolution_images']).toBe(true);
    });

    it('should handle streaming requests with output token limits', () => {
      const result = hello('qwen3-max', { max_tokens: 100000, stream: true });
      expect(result['max_tokens']).toBe(32768);
      expect(result['stream']).toBe(true);
    });

    it('should merge extra_body into the request', () => {
      const result = hello(
        'qwen3-coder-plus',
        {},
        gen({
          extra_body: {
            custom_param: 'custom_value',
            nested: { key: 'value' },
          },
        }),
      );
      expect(result['custom_param']).toBe('custom_value');
      expect(result['nested']).toEqual({ key: 'value' });
    });

    it('should merge extra_body into vision model requests', () => {
      const result = hello(
        'qwen-vl-max',
        {},
        gen({ extra_body: { custom_param: 'custom_value' } }),
      );
      expect(result['custom_param']).toBe('custom_value');
      expect(result['vl_high_resolution_images']).toBe(true);
    });

    it('should not include extra_body when not configured', () => {
      expect(hello('qwen3-coder-plus')).not.toHaveProperty('custom_param');
    });

    it('should default preserve_thinking to true on the request', () => {
      expect(hello('qwen3.7-max')['preserve_thinking']).toBe(true);
    });

    it('should let user extra_body.preserve_thinking override the default', () => {
      const optOut = gen({ extra_body: { preserve_thinking: false } });
      expect(hello('qwen3.7-max', {}, optOut)['preserve_thinking']).toBe(false);
    });

    it('should default preserve_thinking to true on vision model requests', () => {
      // qwen3.7-plus is a reasoning model routed through the vision path
      // (matches VISION_MODEL_PREFIX_PATTERNS); it still needs the flag.
      const result = hello('qwen3.7-plus');
      expect(result['preserve_thinking']).toBe(true);
      expect(result['vl_high_resolution_images']).toBe(true);
    });

    it('should let user extra_body.preserve_thinking override the default on vision models', () => {
      const optOut = gen({ extra_body: { preserve_thinking: false } });
      expect(hello('qwen3.7-plus', {}, optOut)['preserve_thinking']).toBe(
        false,
      );
    });
  });
});

describe('selectDashScopeThinkingKnob', () => {
  const model = 'qwen3.8-max';
  type Layer = Record<string, unknown> | undefined;
  const select = (extraBody: Layer, samplingParams: Layer, effort?: string) =>
    selectDashScopeThinkingKnob(model, extraBody, samplingParams, effort);
  const knob = (source: string, field: string, value: unknown) => ({
    source,
    field,
    value,
  });
  const HIGH_TIER = knob('reasoning', 'reasoning_effort', 'high');

  it('returns undefined for non-tiered or missing models', () => {
    expect(
      selectDashScopeThinkingKnob(
        'qwen3-max',
        { enable_thinking: false },
        { thinking_budget: 100 },
        'high',
      ),
    ).toBeUndefined();
    expect(
      selectDashScopeThinkingKnob(
        undefined,
        { reasoning_effort: 'high' },
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });

  it('matches the tiered family case-insensitively', () => {
    expect(
      selectDashScopeThinkingKnob(
        'QWEN3.8-MAX-preview',
        undefined,
        undefined,
        'high',
      ),
    ).toEqual(HIGH_TIER);
  });

  it('keeps reasoning_effort over an explicit same-layer thinking_budget', () => {
    expect(
      select({ reasoning_effort: 'low', thinking_budget: 300 }, undefined),
    ).toEqual(knob('extra_body', 'reasoning_effort', 'low'));
    expect(
      select(undefined, { reasoning_effort: 'low', thinking_budget: 100 }),
    ).toEqual(knob('samplingParams', 'reasoning_effort', 'low'));
  });

  it.each([
    [
      'returns undefined when no layer carries a knob',
      undefined,
      undefined,
      undefined,
      undefined,
    ],
    [
      'falls back to the unified reasoning tier',
      undefined,
      undefined,
      'high',
      HIGH_TIER,
    ],
    [
      'lets an extra_body disable win over same-layer values and lower layers',
      { enable_thinking: false, reasoning_effort: 'low' },
      { thinking_budget: 100 },
      'high',
      knob('extra_body', 'enable_thinking', false),
    ],
    [
      'lets an extra_body budget win over lower-priority layers',
      { thinking_budget: 300 },
      { reasoning_effort: 'low' },
      'high',
      knob('extra_body', 'thinking_budget', 300),
    ],
    [
      'ignores nullish extra_body knobs',
      {
        enable_thinking: null,
        reasoning_effort: null,
        thinking_budget: undefined,
      },
      undefined,
      'high',
      HIGH_TIER,
    ],
    [
      'lets a samplingParams disable win over the reasoning tier',
      undefined,
      { enable_thinking: false },
      'high',
      knob('samplingParams', 'enable_thinking', false),
    ],
    [
      'lets a samplingParams budget win over the reasoning tier',
      undefined,
      { thinking_budget: 128 },
      'high',
      knob('samplingParams', 'thinking_budget', 128),
    ],
    [
      'lets the reasoning tier decide under a samplingParams on-switch',
      undefined,
      { enable_thinking: true },
      'high',
      HIGH_TIER,
    ],
    [
      'keeps a lone samplingParams on-switch as the selection',
      undefined,
      { enable_thinking: true },
      undefined,
      knob('samplingParams', 'enable_thinking', true),
    ],
  ])('%s', (_title, extraBody, samplingParams, effort, expected) => {
    expect(select(extraBody, samplingParams, effort)).toEqual(expected);
  });

  describe('extra_body on-switch', () => {
    it.each([
      [
        'lets a samplingParams value decide',
        { thinking_budget: 200 },
        'high',
        knob('samplingParams', 'thinking_budget', 200),
      ],
      [
        'lets the reasoning tier decide when samplingParams has no value',
        undefined,
        'high',
        HIGH_TIER,
      ],
      [
        'is itself the selection when nothing below carries a value',
        undefined,
        undefined,
        knob('extra_body', 'enable_thinking', true),
      ],
      [
        'blocks a lower-priority samplingParams disable',
        { enable_thinking: false },
        'high',
        HIGH_TIER,
      ],
    ])('%s', (_title, samplingParams, effort, expected) => {
      expect(select({ enable_thinking: true }, samplingParams, effort)).toEqual(
        expected,
      );
    });
  });
});
