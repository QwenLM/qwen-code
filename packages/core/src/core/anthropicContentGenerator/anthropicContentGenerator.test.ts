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

// Now import the modules that depend on the mocked modules.
import type { Config } from '../../config/config.js';

const importGenerator = async (): Promise<{
  AnthropicContentGenerator: typeof import('./anthropicContentGenerator.js').AnthropicContentGenerator;
}> => import('./anthropicContentGenerator.js');

const importConverter = async (): Promise<{
  AnthropicContentConverter: typeof import('./converter.js').AnthropicContentConverter;
}> => import('./converter.js');

describe('AnthropicContentGenerator', () => {
  const MAX_OUTPUT_TOKENS_ENV = 'QWEN_CODE_MAX_OUTPUT_TOKENS';
  let mockConfig: Config;
  let anthropicState: {
    constructorOptions?: Record<string, unknown>;
    lastCreateArgs?: AnthropicCreateArgs;
    createImpl: ReturnType<typeof vi.fn>;
  };
  let savedMaxOutputTokensEnv: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // The generator's constructor builds undici-backed fetch options
    // synchronously; production code preloads undici in
    // createContentGenerator, and resetModules() clears that state.
    const { preloadRuntimeFetchModule } = await import(
      '../../utils/runtimeFetchOptions.js'
    );
    await preloadRuntimeFetchModule();
    savedMaxOutputTokensEnv = process.env[MAX_OUTPUT_TOKENS_ENV];
    delete process.env[MAX_OUTPUT_TOKENS_ENV];

    anthropicState = anthropicMockState;

    anthropicState.createImpl.mockReset();
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

  it('uses claude-cli identity (User-Agent + x-app + Bearer auth) for non-Anthropic baseURLs', async () => {
    // Non-Anthropic-native baseURL → IdeaLab-style proxy path:
    //  - User-Agent presents as `claude-cli/<version> (external, cli)`
    //  - `x-app: cli` is sent
    //  - SDK is constructed with `authToken` (sends `Authorization: Bearer`)
    //    rather than `apiKey` (`x-api-key`), avoiding dual-header conflicts.
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
    expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
    expect(headers['User-Agent']).toContain('(external, cli)');
    expect(headers['x-app']).toBe('cli');
    expect(anthropicState.constructorOptions?.['authToken']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['apiKey']).toBeNull();
  });

  it('uses QwenCode identity + apiKey auth when baseURL is api.anthropic.com', async () => {
    // Anthropic-native baseURL: keep the SDK-default `x-api-key` auth and
    // a truthful `QwenCode` User-Agent (no `x-app` header) so usage isn't
    // misattributed to Claude CLI in Anthropic's logs/quotas.
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-opus-4-7',
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com',
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
    expect(headers['User-Agent']).not.toContain('claude-cli');
    expect(headers['x-app']).toBeUndefined();
    expect(anthropicState.constructorOptions?.['apiKey']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['authToken']).toBeNull();
  });

  it('treats unset baseURL as Anthropic-native (SDK default targets api.anthropic.com)', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-opus-4-7',
        apiKey: 'test-key',
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
    expect(headers['x-app']).toBeUndefined();
    expect(anthropicState.constructorOptions?.['apiKey']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['authToken']).toBeNull();
  });

  it('disables the request timeout when configured to 0', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-opus-4-7',
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com',
        timeout: 0,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    expect(anthropicState.constructorOptions?.['timeout']).toBe(
      DISABLED_REQUEST_TIMEOUT_MS,
    );
  });

  it('falls back to the default request timeout when unset', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-opus-4-7',
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com',
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    expect(anthropicState.constructorOptions?.['timeout']).toBe(
      DEFAULT_TIMEOUT,
    );
  });

  it('treats *.anthropic.com subdomains as Anthropic-native', async () => {
    // Anthropic's own subdomains (regional endpoints, internal routes) all
    // share the native auth/identity contract — none of them want the
    // proxy-flavored Bearer auth or claude-cli UA.
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-opus-4-7',
        apiKey: 'test-key',
        baseUrl: 'https://eu.api.anthropic.com',
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
    expect(headers['x-app']).toBeUndefined();
    expect(anthropicState.constructorOptions?.['apiKey']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['authToken']).toBeNull();
  });

  it('treats malformed baseURL as proxy (URL parse failure falls through to claude-cli identity)', async () => {
    // A bogus baseUrl string trips `new URL()`. The detector's catch
    // branch must fall through to the proxy path rather than throw or
    // silently treat the broken value as Anthropic-native.
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'not a valid url',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
    expect(headers['x-app']).toBe('cli');
    expect(anthropicState.constructorOptions?.['authToken']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['apiKey']).toBeNull();
  });

  it('pins DeepSeek anthropic-compatible baseURL onto the proxy auth/identity path', async () => {
    // The auth/identity gate uses an Anthropic-native allow-list rather
    // than an IdeaLab-only allow-list, so `api.deepseek.com/anthropic`
    // gets the same Bearer + claude-cli + x-app bundle that proxies get.
    // This documents the assumption — if DeepSeek's anthropic-compatible
    // endpoint ever rejects `Authorization: Bearer`, this test pins the
    // shape we'd need to flip back, and any future change here surfaces
    // the auth contract decision instead of silently flipping behavior.
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'deepseek-v4-pro',
        apiKey: 'test-key',
        baseUrl: 'https://api.deepseek.com/anthropic',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
    expect(headers['x-app']).toBe('cli');
    expect(anthropicState.constructorOptions?.['authToken']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['apiKey']).toBeNull();
  });

  it('trims whitespace on config.baseUrl before classification', async () => {
    // A copy-pasted baseURL with leading/trailing whitespace would
    // otherwise trip `new URL(...)` in `isAnthropicNativeBaseUrl` and
    // fall through to proxy identity — meaning real api.anthropic.com
    // gets Bearer auth + claude-cli UA and 401s. Trim the config side
    // before classification, mirroring how the env-side already
    // handles whitespace.
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-opus-4-7',
        apiKey: 'test-key',
        baseUrl: '  https://api.anthropic.com  ',
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
    expect(headers['x-app']).toBeUndefined();
    expect(anthropicState.constructorOptions?.['apiKey']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['authToken']).toBeNull();
  });

  it('does not match spoofed anthropic.com.evil.com hostnames', async () => {
    // Mirror of the DeepSeek hostname-spoof test: a suffix like
    // `anthropic.com.evil.com` must NOT be classified as Anthropic-native —
    // otherwise an attacker controlling DNS could route real Anthropic
    // credentials with `x-api-key` to their endpoint.
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com.evil.com',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
    expect(headers['x-app']).toBe('cli');
    expect(anthropicState.constructorOptions?.['authToken']).toBe('test-key');
    expect(anthropicState.constructorOptions?.['apiKey']).toBeNull();
  });

  // Regression coverage for #4020 review: the SDK destructures with
  // defaults (`apiKey = readEnv('ANTHROPIC_API_KEY') ?? null`), which only
  // fire for `undefined`. Spreading `{ authToken }` alone — without an
  // explicit `apiKey: null` — used to let the env back-fill `apiKey`, and
  // the SDK's auth resolver then preferred `apiKey` over `authToken`, so a
  // user with `ANTHROPIC_API_KEY=sk-ant-…` exported alongside an IdeaLab
  // proxy `baseUrl` shipped their real Anthropic key to the proxy as
  // `X-Api-Key`. These tests pin the explicit-null suppression on both
  // branches, plus the matching baseURL-env resolution.
  describe('env back-fill suppression and baseURL env resolution', () => {
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
      // Scenario: user runs Claude Code in the same shell so
      // ANTHROPIC_API_KEY is exported with their real Anthropic key, and
      // separately configures qwen-code with an IdeaLab proxy + IdeaLab
      // token. Pre-fix, the SDK's destructuring default would back-fill
      // `apiKey` from the env, then the auth resolver would prefer it
      // over our `authToken` and ship `X-Api-Key: <real Anthropic key>`
      // to the third-party proxy.
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret-do-not-leak';
      const { AnthropicContentGenerator } = await importGenerator();
      void new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'idealab-token',
          baseUrl: 'https://idealab.example/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {},
          schemaCompliance: 'auto',
        },
        mockConfig,
      );
      // The constructor must receive an explicit `null` so the SDK
      // destructuring default for ANTHROPIC_API_KEY does NOT fire.
      expect(anthropicState.constructorOptions?.['apiKey']).toBeNull();
      expect(anthropicState.constructorOptions?.['authToken']).toBe(
        'idealab-token',
      );
    });

    it('suppresses ANTHROPIC_AUTH_TOKEN back-fill on the Anthropic-native branch', async () => {
      // Inverse of the leak: if the user has ANTHROPIC_AUTH_TOKEN set
      // (an Anthropic-supported alt) and routes to api.anthropic.com,
      // we should still ship our explicit `apiKey` rather than letting
      // the env back-fill `authToken` and risk the SDK picking the wrong
      // one if precedence flips in a future SDK version.
      process.env['ANTHROPIC_AUTH_TOKEN'] = 'env-bearer-token';
      const { AnthropicContentGenerator } = await importGenerator();
      void new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-7',
          apiKey: 'config-api-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {},
          schemaCompliance: 'auto',
        },
        mockConfig,
      );
      expect(anthropicState.constructorOptions?.['apiKey']).toBe(
        'config-api-key',
      );
      expect(anthropicState.constructorOptions?.['authToken']).toBeNull();
    });

    it('applies proxy identity when ANTHROPIC_BASE_URL env points to a proxy and config.baseUrl is unset', async () => {
      // Symmetric concern: pre-fix, `isAnthropicNativeBaseUrl` only read
      // `config.baseUrl`, so a user who set ANTHROPIC_BASE_URL only via
      // env (leaving qwen-code's baseUrl unset) had the SDK route to the
      // proxy while our predicate thought it was Anthropic-native — wrong
      // UA, wrong auth shape, and the cache-scope beta + scope:'global'
      // shipped to a proxy that likely doesn't recognize them.
      process.env['ANTHROPIC_BASE_URL'] = 'https://idealab.example/anthropic';
      const { AnthropicContentGenerator } = await importGenerator();
      void new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'idealab-token',
          // baseUrl intentionally omitted; SDK uses ANTHROPIC_BASE_URL env.
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {},
          schemaCompliance: 'auto',
        },
        mockConfig,
      );
      const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
        {}) as Record<string, string>;
      expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
      expect(headers['x-app']).toBe('cli');
      expect(anthropicState.constructorOptions?.['authToken']).toBe(
        'idealab-token',
      );
      expect(anthropicState.constructorOptions?.['apiKey']).toBeNull();
    });

    it('keeps Anthropic-native identity when ANTHROPIC_BASE_URL is unset (SDK default applies)', async () => {
      // With no config.baseUrl and no env, the SDK defaults to
      // api.anthropic.com — our predicate must agree and ship the native
      // identity bundle (so the SDK default isn't silently misclassified
      // as a proxy).
      delete process.env['ANTHROPIC_BASE_URL'];
      const { AnthropicContentGenerator } = await importGenerator();
      void new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-7',
          apiKey: 'config-key',
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
      expect(headers['x-app']).toBeUndefined();
      expect(anthropicState.constructorOptions?.['apiKey']).toBe('config-key');
      expect(anthropicState.constructorOptions?.['authToken']).toBeNull();
    });

    it('config.baseUrl wins over ANTHROPIC_BASE_URL when both are set', async () => {
      // Mirror the SDK's own resolution: explicit config beats env. A
      // user who deliberately points qwen-code at api.anthropic.com
      // shouldn't have a stray ANTHROPIC_BASE_URL silently flip them
      // onto the proxy path.
      process.env['ANTHROPIC_BASE_URL'] = 'https://idealab.example/anthropic';
      const { AnthropicContentGenerator } = await importGenerator();
      void new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-7',
          apiKey: 'config-key',
          baseUrl: 'https://api.anthropic.com',
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
      expect(headers['x-app']).toBeUndefined();
      expect(anthropicState.constructorOptions?.['apiKey']).toBe('config-key');
      expect(anthropicState.constructorOptions?.['authToken']).toBeNull();
    });
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
    expect(headers['User-Agent']).toContain('claude-cli/1.2.3');
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
    // baseURL points at api.anthropic.com so cache-scope (beta +
    // body-side `scope: 'global'`) participates by default. The
    // `prompt-caching-scope-2026-01-05` beta is now gated jointly on
    // `enableCacheControl` AND `isAnthropicNativeBaseUrl`, so tests that
    // want to observe the beta need a native baseURL. Proxy-baseURL
    // behavior is covered separately below.
    const baseConfig: ContentGeneratorConfig = {
      model: 'claude-test',
      apiKey: 'test-key',
      baseUrl: 'https://api.anthropic.com',
      timeout: 10_000,
      maxRetries: 2,
      samplingParams: { max_tokens: 100 },
      schemaCompliance: 'auto',
    };

    // Default request shape carries a systemInstruction so the converter
    // attaches `cache_control: { …, scope: 'global' }` to the system text
    // — that's what `buildPerRequestHeaders` scans to decide whether the
    // `prompt-caching-scope-2026-01-05` beta ships. Without a system or
    // tools the body has nothing to attach scope to, and the beta is
    // correctly suppressed (covered by a separate degenerate-case test
    // below). Tests can merge their own `requestConfig` to override.
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
        config: {
          systemInstruction: 'sys',
          ...(requestConfig ?? {}),
        },
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
      expect(headers['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );
      expect(headers['anthropic-beta']).toContain(
        'prompt-caching-scope-2026-01-05',
      );
    });

    it('sends only prompt-caching-scope when reasoning is disabled (no thinking, no effort)', async () => {
      const headers = await callOnce({ ...baseConfig, reasoning: false });
      expect(headers['anthropic-beta']).toBe('prompt-caching-scope-2026-01-05');
    });

    it('drops the prompt-caching-scope beta when enableCacheControl is false', async () => {
      // The cache-scope beta is dead weight (and risks 4xx on backends that
      // don't recognize it) when the converter isn't actually attaching
      // `cache_control` to the request body. With both cache and reasoning
      // disabled, the betas list is empty and no header should be sent.
      const headers = await callOnce({
        ...baseConfig,
        reasoning: false,
        enableCacheControl: false,
      } as ContentGeneratorConfig);
      expect(headers['anthropic-beta']).toBeUndefined();
    });

    it('drops only the cache-scope beta when enableCacheControl is false but reasoning is on', async () => {
      // With reasoning enabled, `interleaved-thinking` (and `effort` when
      // applicable) still ride the per-request header — only the cache-scope
      // flag is gated off, since there's no cache_control on the body to
      // pair it with.
      const headers = await callOnce({
        ...baseConfig,
        reasoning: { effort: 'medium' },
        enableCacheControl: false,
      } as ContentGeneratorConfig);
      expect(headers['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );
      expect(headers['anthropic-beta']).toContain('effort-2025-11-24');
      expect(headers['anthropic-beta']).not.toContain(
        'prompt-caching-scope-2026-01-05',
      );
    });

    it('reflects hot enableCacheControl flips between requests (no stale converter cache)', async () => {
      // `Config.setModel()` mutates `contentGeneratorConfig.enableCacheControl`
      // in place. A constructor-time cache on the converter would let the
      // body-side `cache_control` and the per-request `prompt-caching-scope`
      // beta header drift apart on a hot flip. Verify all three downstream
      // surfaces — system block, last user message, and last tool entry —
      // sample the same live value so the wire shape stays coherent.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      const config: ContentGeneratorConfig = {
        ...baseConfig,
        reasoning: false,
      };
      const generator = new AnthropicContentGenerator(config, mockConfig);

      const requestWithTool = {
        model: 'models/ignored',
        contents: 'Hi',
        config: {
          systemInstruction: 'sys',
          tools: [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
        },
      } as unknown as GenerateContentParameters;

      // 1st request: cache on (default). Beta header AND body cache_control
      // both present on system + last user msg + last tool.
      await generator.generateContent(requestWithTool);
      let [req, options] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      let reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(reqHeaders['anthropic-beta']).toBe(
        'prompt-caching-scope-2026-01-05',
      );
      expect((req as { system?: unknown }).system).toEqual([
        {
          type: 'text',
          text: 'sys',
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
      ]);
      const reqTools = (req as { tools?: Array<{ cache_control?: unknown }> })
        .tools;
      expect(reqTools).toHaveLength(1);
      expect(reqTools?.[0]?.cache_control).toEqual({
        type: 'ephemeral',
        scope: 'global',
      });
      const reqMessages = (req as { messages?: Array<{ content?: unknown }> })
        .messages;
      const userBlocks = reqMessages?.[0]?.content as Array<{
        cache_control?: unknown;
      }>;
      expect(userBlocks[0].cache_control).toEqual({ type: 'ephemeral' });

      // Hot-flip enableCacheControl off (Config.setModel mutates in place).
      config.enableCacheControl = false;

      // 2nd request: beta header dropped AND body cache_control gone on
      // every surface, in lockstep — the converter must not be reading a
      // stale constructor value.
      await generator.generateContent(requestWithTool);
      [req, options] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(reqHeaders['anthropic-beta']).toBeUndefined();
      expect((req as { system?: unknown }).system).toBe('sys');
      const reqTools2 = (req as { tools?: Array<{ cache_control?: unknown }> })
        .tools;
      expect(reqTools2?.[0]).not.toHaveProperty('cache_control');
      const reqMessages2 = (req as { messages?: Array<{ content?: unknown }> })
        .messages;
      const userBlocks2 = reqMessages2?.[0]?.content as Array<
        Record<string, unknown>
      >;
      expect(userBlocks2[0]).not.toHaveProperty('cache_control');
    });

    it('suppresses the cache-scope beta when the body has no scope field (empty system + no tools)', async () => {
      // The beta gate is a body-scan over `req.system` / `req.tools` for
      // any `cache_control.scope === 'global'` entry, not a re-read of
      // the `useGlobalCacheScope()` predicate. So a request with no
      // systemInstruction AND no tools — predicate true but no body
      // surface to attach scope to — correctly omits the beta.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });
      const generator = new AnthropicContentGenerator(
        { ...baseConfig, reasoning: false },
        mockConfig,
      );
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
        // No systemInstruction, no tools.
      } as unknown as GenerateContentParameters);

      const [, options] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(reqHeaders['anthropic-beta']).toBeUndefined();
    });

    it('ships the cache-scope beta when only tools (no systemInstruction) carry scope:"global"', async () => {
      // Mirror of the above: scope:'global' on the last tool is enough
      // for the body-scan to fire, even with no systemInstruction.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });
      const generator = new AnthropicContentGenerator(
        { ...baseConfig, reasoning: false },
        mockConfig,
      );
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
        config: {
          tools: [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
        },
      } as unknown as GenerateContentParameters);

      const [, options] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(reqHeaders['anthropic-beta']).toBe(
        'prompt-caching-scope-2026-01-05',
      );
    });

    it('strips the cache-scope beta and scope:"global" field on non-Anthropic baseURLs', async () => {
      // Symmetry with the auth/identity gate: the
      // `prompt-caching-scope-2026-01-05` beta and the body-side
      // `scope: 'global'` field are Anthropic-only wire-shape extensions.
      // DeepSeek / IdeaLab proxies should still get per-session
      // `cache_control: { type: 'ephemeral' }` so existing prompt-caching
      // behavior is preserved, but without the new beta or scope field
      // (their server side likely doesn't understand them, and silently
      // ignoring them isn't guaranteed across proxies).
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          ...baseConfig,
          baseUrl: 'https://api.deepseek.com/anthropic',
          reasoning: false,
        },
        mockConfig,
      );
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
        config: {
          systemInstruction: 'sys',
          tools: [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
        },
      } as unknown as GenerateContentParameters);

      const [req, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      // Beta header must not be sent to non-Anthropic baseURL.
      expect(reqHeaders['anthropic-beta']).toBeUndefined();
      // Body still carries per-session cache_control (pre-PR behavior).
      expect((req as { system?: unknown }).system).toEqual([
        {
          type: 'text',
          text: 'sys',
          cache_control: { type: 'ephemeral' },
        },
      ]);
      const reqTools = (req as { tools?: Array<{ cache_control?: unknown }> })
        .tools;
      expect(reqTools?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    });

    it('emits scope:"global" on non-Anthropic baseURLs when forceGlobalCacheScope is true (#6642)', async () => {
      // Proxy providers (e.g. Routify, OpenRouter) can opt-in to global
      // cache scope via `forceGlobalCacheScope: true`. The
      // `prompt-caching-scope-2026-01-05` beta and body-side
      // `scope: 'global'` must be emitted even when the base URL is not
      // Anthropic-native.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          ...baseConfig,
          baseUrl: 'https://proxy.routify.ai/v1',
          forceGlobalCacheScope: true,
          reasoning: false,
        },
        mockConfig,
      );
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
        config: {
          systemInstruction: 'sys',
          tools: [
            {
              functionDeclarations: [
                { name: 'get_weather', description: 'Get weather' },
              ],
            },
          ],
        },
      } as unknown as GenerateContentParameters);

      const [req, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      // Beta header must be sent when forceGlobalCacheScope is true.
      expect(reqHeaders['anthropic-beta']).toContain(
        'prompt-caching-scope-2026-01-05',
      );
      // Body carries scope:'global' on system block.
      expect((req as { system?: unknown }).system).toEqual([
        {
          type: 'text',
          text: 'sys',
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
      ]);
      // And on the last tool.
      const reqTools = (req as { tools?: Array<{ cache_control?: unknown }> })
        .tools;
      expect(reqTools?.[0]?.cache_control).toEqual({
        type: 'ephemeral',
        scope: 'global',
      });
    });

    it('splits the system prompt at the Config-recorded static prefix (4-breakpoint layout)', async () => {
      // End-to-end through the generator: `LlmClient` records the
      // gitStatus-free base on Config, the generator reads it per request,
      // and the converter splits the system prompt there — static prefix
      // carries scope:'global' (cross-session reuse), volatile suffix stays
      // per-session. Together with the last-tool and last-user-message
      // markers this fills all 4 Anthropic breakpoints.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      (
        mockConfig.getStaticSystemPrefix as ReturnType<typeof vi.fn>
      ).mockReturnValue('sys-base');
      const generator = new AnthropicContentGenerator(
        { ...baseConfig, reasoning: false },
        mockConfig,
      );
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
        config: {
          systemInstruction: 'sys-base\n\n# Git Status\nbranch: main',
        },
      } as unknown as GenerateContentParameters);

      const [req, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect((req as { system?: unknown }).system).toEqual([
        {
          type: 'text',
          text: 'sys-base',
          cache_control: { type: 'ephemeral', scope: 'global' },
        },
        {
          type: 'text',
          text: '\n\n# Git Status\nbranch: main',
          cache_control: { type: 'ephemeral' },
        },
      ]);
      // The scope entry on the split prefix block is enough for the
      // body-scan beta gate to fire.
      const reqHeaders = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(reqHeaders['anthropic-beta']).toContain(
        'prompt-caching-scope-2026-01-05',
      );
    });

    it('suppresses scope:"global" when enableCacheControl is false even with forceGlobalCacheScope', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          ...baseConfig,
          baseUrl: 'https://proxy.routify.ai/v1',
          enableCacheControl: false,
          forceGlobalCacheScope: true,
          reasoning: false,
        },
        mockConfig,
      );
      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hi',
        config: {
          systemInstruction: 'sys',
        },
      } as unknown as GenerateContentParameters);

      const [req] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      // System should be a plain string (no cache_control at all).
      expect((req as { system?: unknown }).system).toBe('sys');
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
      expect(headers['anthropic-beta']).toContain('experimental-x');
      expect(headers['anthropic-beta']).toContain(
        'prompt-caching-scope-2026-01-05',
      );
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

    it('sends only prompt-caching-scope when per-request thinkingConfig.includeThoughts=false', async () => {
      // Even though the global reasoning config sets effort, the per-request
      // opt-out drops both `thinking` and `output_config` from the body — and
      // the thinking/effort beta flags must not be present.
      const headers = await callOnce(
        { ...baseConfig, reasoning: { effort: 'medium' } },
        { thinkingConfig: { includeThoughts: false } },
      );
      expect(headers['anthropic-beta']).toBe('prompt-caching-scope-2026-01-05');
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
        // Include a system instruction so the converter attaches
        // `cache_control: { …, scope: 'global' }` on the system block —
        // the beta-header builder body-scans for that field, so a
        // realistic request shape is needed to observe the
        // `prompt-caching-scope-2026-01-05` beta.
        config: { systemInstruction: 'sys' },
      } as unknown as GenerateContentParameters);

      // defaultHeaders carries User-Agent and customHeaders (not beta).
      // baseConfig now targets api.anthropic.com, so this asserts the
      // Anthropic-native UA (QwenCode) — the claude-cli identity bundle
      // is covered by the proxy-baseURL tests at the top of the suite.
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
      expect(reqHeaders['anthropic-beta']).toContain(
        'prompt-caching-scope-2026-01-05',
      );
    });

    it('also sends the computed beta header on streaming requests', async () => {
      // generateContentStream() goes through a separate code path from
      // generateContent(); make sure the per-request header attaches there
      // too so streaming Anthropic/DeepSeek requests stay consistent.
      const { AnthropicContentGenerator } = await importGenerator();
      // Use message_delta (not bare message_stop) so the empty-stream
      // fallback is not triggered — bare message_stop now indicates an empty
      // stream and causes a non-streaming retry.
      anthropicState.createImpl.mockResolvedValue(
        (async function* () {
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          };
        })(),
      );

      const generator = new AnthropicContentGenerator(
        { ...baseConfig, reasoning: { effort: 'medium' } },
        mockConfig,
      );
      const telemetryAttempt = {};
      mockReportAnthropicRequest.mockReturnValueOnce(telemetryAttempt);
      const stream = await generator.generateContentStream({
        model: 'models/ignored',
        contents: 'Hi',
        // See the systemInstruction note in the non-streaming sibling
        // test above — the body-scan beta gate needs an actual scope:
        // 'global' field on the wire to fire.
        config: { systemInstruction: 'sys' },
      } as unknown as GenerateContentParameters);
      // Drain the stream so create() has been called.
      for await (const _chunk of stream) {
        void _chunk;
      }

      // Regression guard: normal streams must NOT trigger the empty-stream
      // fallback (which would double latency + API cost).
      expect(anthropicState.createImpl).toHaveBeenCalledTimes(1);

      const [streamingRequest, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(mockReportAnthropicRequest).toHaveBeenCalledWith(streamingRequest);
      expect(mockReportAnthropicEvent).toHaveBeenCalledWith(
        telemetryAttempt,
        expect.objectContaining({ type: 'message_delta' }),
      );
      const headers = ((options as { headers?: Record<string, string> })
        ?.headers || {}) as Record<string, string>;
      expect(headers['anthropic-beta']).toContain(
        'interleaved-thinking-2025-05-14',
      );
      expect(headers['anthropic-beta']).toContain('effort-2025-11-24');
      expect(headers['anthropic-beta']).toContain(
        'prompt-caching-scope-2026-01-05',
      );
    });

    it('sends extended-cache-ttl-2025-04-11 when cacheRetention is "1h"', async () => {
      const headers = await callOnce({
        ...baseConfig,
        reasoning: false,
        cacheRetention: '1h',
      });
      expect(headers['anthropic-beta']).toContain(
        'extended-cache-ttl-2025-04-11',
      );
    });

    it('omits extended-cache-ttl-2025-04-11 when cacheRetention is unset (ephemeral default)', async () => {
      const headers = await callOnce({
        ...baseConfig,
        reasoning: false,
      });
      expect(headers['anthropic-beta']).not.toContain(
        'extended-cache-ttl-2025-04-11',
      );
    });
  });

  describe('generateContent', () => {
    it('redacts proxy credentials from request-time SDK errors', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockRejectedValue(
        new Error('connect ECONNREFUSED token@proxy.local:8080'),
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await expect(
        generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
        } as unknown as GenerateContentParameters),
      ).rejects.toThrow('connect ECONNREFUSED <redacted>@proxy.local:8080');
    });

    it('does not leak abort listeners onto the caller signal across non-streaming requests', async () => {
      const { AnthropicContentGenerator } = await importGenerator();

      // Reproduce the SDK leak (see the generateContentStream test): the client
      // registers a non-removed 'abort' listener on whatever signal it gets.
      anthropicState.createImpl.mockImplementation(
        (_req: unknown, opts: { signal?: AbortSignal }) => {
          opts.signal?.addEventListener('abort', () => {});
          return {
            id: 'anthropic-1',
            model: 'claude-test',
            content: [{ type: 'text', text: 'Hello' }],
          };
        },
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const callerAc = new AbortController();
      for (let i = 0; i < 5; i++) {
        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
          config: { abortSignal: callerAc.signal },
        } as unknown as GenerateContentParameters);
      }

      expect(getEventListeners(callerAc.signal, 'abort')).toHaveLength(0);
      const passedSignal = (
        anthropicState.lastCreateArgs?.[1] as { signal?: AbortSignal }
      )?.signal;
      expect(passedSignal).toBeDefined();
      expect(passedSignal).not.toBe(callerAc.signal);
    });

    it('propagates a caller abort to the per-request child signal', async () => {
      const { AnthropicContentGenerator } = await importGenerator();

      const callerAc = new AbortController();
      let capturedSignal: AbortSignal | undefined;
      anthropicState.createImpl.mockImplementation(
        (_req: unknown, opts: { signal?: AbortSignal }) => {
          capturedSignal = opts.signal;
          // The caller aborts while the request is in flight.
          callerAc.abort();
          return {
            id: 'anthropic-1',
            model: 'claude-test',
            content: [{ type: 'text', text: 'hi' }],
          };
        },
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hello',
        config: { abortSignal: callerAc.signal },
      } as unknown as GenerateContentParameters);

      // The SDK is handed a child, and the caller's abort still reaches it, so
      // cancellation behaviour is preserved.
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal).not.toBe(callerAc.signal);
      expect(capturedSignal!.aborted).toBe(true);
    });

    it('builds request with config sampling params (config overrides request; max_tokens takes the smaller) and thinking budget', async () => {
      const { AnthropicContentConverter } = await importConverter();
      const { AnthropicContentGenerator } = await importGenerator();

      const convertResponseSpy = vi
        .spyOn(
          AnthropicContentConverter.prototype,
          'convertAnthropicResponseToLlm',
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
          thinkingConfig: { thinkingBudget: 199 },
          topP: 0.5,
          topK: 5,
          abortSignal: abortController.signal,
        },
      };

      const telemetryAttempt = {};
      mockReportAnthropicRequest.mockReturnValueOnce(telemetryAttempt);
      const result = await generator.generateContent(request);
      expect(result.responseId).toBe('gemini-1');

      expect(anthropicState.lastCreateArgs).toBeDefined();
      const [anthropicRequest, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;

      // The generator wraps the caller's signal in a per-request child to
      // isolate the SDK's abort-listener leak, so the SDK sees the child rather
      // than the caller's signal.
      expect(options?.signal).toBeDefined();
      expect(options?.signal).not.toBe(abortController.signal);

      expect(anthropicRequest).toEqual(
        expect.objectContaining({
          model: 'claude-test',
          // Sampling params override the request — EXCEPT max_tokens, where
          // the smaller of config (1000) and request (200) wins so the
          // send-path window clamp can never be overridden upward.
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
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 200 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'high' },
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hello',
        config: { thinkingConfig: { thinkingBudget: 199 } },
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(anthropicRequest).toEqual(
        expect.objectContaining({
          max_tokens: 200,
          thinking: { type: 'enabled', budget_tokens: 199 },
          output_config: { effort: 'high' },
        }),
      );
    });

    // DeepSeek extends reasoning_effort with a 'max' tier; the Anthropic
    // converter passes it through to output_config.effort and bumps the
    // thinking budget accordingly.
    it("passes effort: 'max' through to output_config and bumps thinking budget", async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'deepseek-v4-pro',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'deepseek-v4-pro',
          apiKey: 'test-key',
          // The clamp decision uses hostname only, so a DeepSeek-shaped
          // baseURL is required for `'max'` to pass through (model-name
          // alone won't bypass the clamp — that would let "deepseek-clone"
          // routed to api.anthropic.com sneak past it).
          baseUrl: 'https://api.deepseek.com/anthropic',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({
          output_config: { effort: 'max' },
          thinking: { type: 'enabled', budget_tokens: 128_000 },
        }),
      );
    });

    // DeepSeek's anthropic-compatible output_config.effort accepts only
    // high/max, so low/medium must lift to high (mirroring the DeepSeek OpenAI
    // adapter) instead of passing through verbatim, which the endpoint 400s on.
    it("lifts effort: 'low'/'medium' to 'high' on the DeepSeek anthropic path", async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      for (const effort of ['low', 'medium'] as const) {
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'deepseek-v4-pro',
          content: [{ type: 'text', text: 'hi' }],
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
            reasoning: { effort },
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
          expect.objectContaining({ output_config: { effort: 'high' } }),
        );
      }
    });

    it("still clamps effort: 'max' when model name says 'deepseek' but hostname is api.anthropic.com", async () => {
      // The broader `isDeepSeekAnthropicProvider` falls back to model-name
      // matching to cover sglang/vllm self-hosted DeepSeek deployments,
      // but trusting that for the 'max' clamp decision would let a model
      // configured as e.g. "deepseek-distill" but routed to real
      // api.anthropic.com bypass the clamp and trip a 400. The clamp
      // therefore uses hostname-only detection.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'deepseek-distill', // model name suggests DeepSeek...
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com', // ...but routed to real Anthropic.
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({ output_config: { effort: 'high' } }),
      );
    });

    it("clamps effort: 'max' to 'high' on a non-DeepSeek anthropic provider", async () => {
      // 'max' is a DeepSeek extension; real Anthropic only accepts
      // low/medium/high. Clamp so a config targeting DeepSeek doesn't 400
      // when reused against a stricter Anthropic backend. The thinking
      // budget must also drop from the 'max' tier (128K) to the 'high'
      // tier (64K) so the effort label and the budget stay consistent.
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
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({
          output_config: { effort: 'high' },
          thinking: { type: 'enabled', budget_tokens: 64_000 },
        }),
      );
    });

    // Per-model gating: Opus 4.7/4.8 and the 5.x families accept xhigh/max
    // natively, so those tiers must pass through to output_config.effort
    // instead of being clamped to 'high'.
    it("passes effort: 'max' through on Opus 4.8 (native support)", async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-8',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({
          output_config: { effort: 'max' },
          // 4.6+ uses adaptive thinking; the server controls the budget.
          thinking: { type: 'adaptive', display: 'summarized' },
        }),
      );
    });

    it("passes effort: 'xhigh' through on Opus 4.8 (native support)", async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-8',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'xhigh' },
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
        expect.objectContaining({
          output_config: { effort: 'xhigh' },
          thinking: { type: 'adaptive', display: 'summarized' },
        }),
      );
    });

    // Claude 4.8+ deprecated the `temperature` sampling parameter — the
    // server responds with a 400 when it is sent. Verify the generator
    // omits it for 4.8+ and keeps it for older models.
    it('omits temperature on Opus 4.8 (deprecated)', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-8',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500, temperature: 0.7 },
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
      expect(anthropicRequest).not.toHaveProperty('temperature');
    });

    it('keeps temperature on Opus 4.7 (still accepted)', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-7',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500, temperature: 0.7 },
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
        expect.objectContaining({ temperature: 0.7 }),
      );
    });

    it('omits temperature on Sonnet 5 (5.x family, deprecated)', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-sonnet-5',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500, temperature: 0.5 },
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
      expect(anthropicRequest).not.toHaveProperty('temperature');
    });

    it('keeps temperature on unknown/unversioned model id', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'some-custom-model',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'some-custom-model',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500, temperature: 0.3 },
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
        expect.objectContaining({ temperature: 0.3 }),
      );
    });

    it("clamps effort: 'xhigh' to 'max' on Opus 4.6 (has max, lacks xhigh)", async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-6',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'xhigh' },
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
        expect.objectContaining({ output_config: { effort: 'max' } }),
      );
    });

    it("clamps effort: 'max' to 'high' on Opus 4.5 (lacks xhigh/max)", async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-opus-4-5',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-5',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({ output_config: { effort: 'high' } }),
      );
    });

    it("clamps effort: 'max' to 'high' on dated Opus 4.0 (date suffix is not a minor version)", async () => {
      // Regression: `claude-opus-4-20250514` is Opus 4.0, which lacks
      // xhigh/max. The 8-digit date suffix must not be parsed as the minor
      // version (which would make atLeast(4, 6)/atLeast(4, 7) true and wrongly
      // grant max/xhigh, yielding a server 400).
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-opus-4-20250514',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-20250514',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({ output_config: { effort: 'high' } }),
      );
    });

    it("passes effort: 'xhigh' through on a reseller-prefixed Opus 4.7 (bedrock/…)", async () => {
      // The version regex is intentionally unanchored so reseller-prefixed ids
      // gate identically to bare Anthropic ids. If it ever gets anchored, this
      // model would fall back to low/medium/high and silently clamp xhigh away.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'bedrock/claude-opus-4-7',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'bedrock/claude-opus-4-7',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'xhigh' },
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
        expect.objectContaining({ output_config: { effort: 'xhigh' } }),
      );
    });

    it("passes effort: 'max' through on a 5.x family model (claude-sonnet-5-0)", async () => {
      // Every 5.x family grants xhigh/max via the `major >= 5` branch,
      // regardless of family. Locks in that the 5.x gating isn't accidentally
      // narrowed to specific families.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-sonnet-5-0',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-sonnet-5-0',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({ output_config: { effort: 'max' } }),
      );
    });

    it("clamps effort: 'max' to 'high' on claude-haiku-4-6 (haiku 4.x lacks max)", async () => {
      // The `max` tier on 4.x is documented as opus/sonnet only; the family
      // guard keeps haiku 4.x off `max` (which would 400) even though it is
      // >= 4.6. (5.x haiku still gets max via the major>=5 branch.)
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-haiku-4-6',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-haiku-4-6',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max' },
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
        expect.objectContaining({ output_config: { effort: 'high' } }),
      );
    });

    it("preserves explicit budget_tokens even when effort: 'max' is clamped", async () => {
      // User-supplied budget_tokens is an escape hatch: it bypasses the
      // effort-based ladder unconditionally, including the 'max' clamp.
      // So `{ effort: 'max', budget_tokens: 128_000 }` against real
      // api.anthropic.com lands as `output_config.effort: 'high'`
      // (clamped — the effort enum would otherwise 400) but
      // `thinking.budget_tokens: 128_000` (preserved verbatim — the
      // server accepts any int within the model's context window).
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
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'max', budget_tokens: 128_000 },
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
        expect.objectContaining({
          output_config: { effort: 'high' },
          thinking: { type: 'enabled', budget_tokens: 128_000 },
        }),
      );
    });

    describe('adaptive thinking (Claude 4.6+ models)', () => {
      // Claude 4.6+ models reject the budget_tokens-shaped thinking config and
      // require `{ type: 'adaptive' }`. The detection uses numeric major/minor
      // comparison so future families/versions are recognized instead of
      // silently falling back to the budget path.
      async function thinkingFor(
        model: string,
        reasoningOverride?: ContentGeneratorConfig['reasoning'],
      ): Promise<unknown> {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model,
          content: [{ type: 'text', text: 'hi' }],
        });
        const generator = new AnthropicContentGenerator(
          {
            model,
            apiKey: 'test-key',
            baseUrl: 'https://api.anthropic.com',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: { max_tokens: 500 },
            schemaCompliance: 'auto',
            reasoning: reasoningOverride ?? { effort: 'medium' },
          },
          mockConfig,
        );
        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
        } as unknown as GenerateContentParameters);
        const [req] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
        return (req as { thinking?: unknown }).thinking;
      }

      it('selects adaptive for claude-opus-4-6 / sonnet-4-6 / opus-4-7', async () => {
        expect(await thinkingFor('claude-opus-4-6')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
        expect(await thinkingFor('claude-sonnet-4-6')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
        expect(await thinkingFor('claude-opus-4-7')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
      });

      it('selects adaptive for claude-haiku-4-6 (haiku family is in scope)', async () => {
        // Single-digit character-class regex would have missed haiku entirely.
        expect(await thinkingFor('claude-haiku-4-6')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
      });

      it('selects adaptive for two-digit minors like claude-opus-4-10', async () => {
        // Single-digit `[6-9]` would have skipped this and produced an
        // invalid `{ type: 'enabled', budget_tokens: ... }` body.
        expect(await thinkingFor('claude-opus-4-10')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
      });

      it('selects adaptive for a future major like claude-opus-5-1', async () => {
        expect(await thinkingFor('claude-opus-5-1')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
      });

      it('selects adaptive for dotted-minor aliases (claude-opus-4.7 / 4.8, claude-sonnet-4.6)', async () => {
        // LiteLLM/Vertex/Bedrock-style proxies expose Anthropic Model Groups
        // with dotted minor versions. A hyphen-only parser silently degrades
        // these to `minor=0`, sending `thinking.type.enabled` to an adaptive-
        // only model group and taking a 400. parseClaudeModelVersion must
        // accept `[-.]` between major and minor so the version-gated shape
        // is picked correctly regardless of alias convention.
        expect(await thinkingFor('claude-opus-4.7')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
        expect(await thinkingFor('claude-opus-4.8')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
        expect(await thinkingFor('claude-sonnet-4.6')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
      });

      it('selects adaptive for dotted-minor Opus 5 aliases (claude-opus-5.0 / 5.1)', async () => {
        expect(await thinkingFor('claude-opus-5.0')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
        expect(await thinkingFor('claude-opus-5.1')).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
      });

      it('keeps the budget_tokens config for older 4.x models (e.g. claude-opus-4-5)', async () => {
        expect(await thinkingFor('claude-opus-4-5')).toEqual({
          type: 'enabled',
          budget_tokens: 32_000,
        });
      });

      it('never sets display on the budget_tokens shape (pre-4.6 models and the explicit-override escape hatch)', async () => {
        // display is a field on the 'enabled'/'adaptive' Anthropic thinking
        // shapes, but the summarized-default-changed-to-omitted problem
        // documented by Anthropic is scoped to adaptive thinking only
        // (Opus 4.7+ / every 5.x family). Pre-4.6 models on the manual
        // budget path, and the explicit reasoning.budget_tokens escape
        // hatch on models that still accept it, must not carry `display`.
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

      it('keeps the budget path for dated Opus 4.0 (claude-opus-4-20250514, date suffix is not a minor)', async () => {
        // Regression: the 8-digit date suffix must not be parsed as the minor
        // version. Opus 4.0 lacks adaptive thinking, so it must fall to the
        // budget path rather than emitting `{ type: 'adaptive' }` (server 400).
        expect(await thinkingFor('claude-opus-4-20250514')).toEqual({
          type: 'enabled',
          budget_tokens: 32_000,
        });
      });

      it('honors explicit reasoning.budget_tokens on models that still accept manual thinking (e.g. claude-opus-4-6)', async () => {
        // Explicit budget_tokens is a user escape hatch on models that still
        // accept the manual `{ type: 'enabled', budget_tokens }` shape (Opus
        // 4.5/4.6, Sonnet 4.6): adaptive thinking would otherwise silently drop
        // the user-supplied value because the adaptive shape carries no budget
        // field. The explicit branch must run first for these models.
        expect(
          await thinkingFor('claude-opus-4-6', {
            effort: 'medium',
            budget_tokens: 42_000,
          }),
        ).toEqual({ type: 'enabled', budget_tokens: 42_000 });
      });

      it('drops manual budget_tokens for adaptive-only models that reject it (e.g. claude-opus-4-7)', async () => {
        // Opus 4.7+ and every 5.x family reject the manual
        // `{ type: 'enabled', budget_tokens }` shape with a 400 and require
        // adaptive thinking, so an explicit budget must be dropped in favor of
        // adaptive thinking + output_config.effort rather than shipped verbatim
        // (https://platform.claude.com/docs/en/build-with-claude/effort).
        expect(
          await thinkingFor('claude-opus-4-7', {
            effort: 'medium',
            budget_tokens: 42_000,
          }),
        ).toEqual({ type: 'adaptive', display: 'summarized' });
      });

      it('still ships adaptive (no output_config, no effort beta) when reasoning is undefined on a 4.6+ model', async () => {
        // Pins the existing wire shape for the corner case where a 4.6+
        // model runs with no `reasoning` config at all: the thinking field
        // takes the adaptive shape, but `resolveEffectiveEffort` returns
        // undefined (no effort enum to emit), so `output_config` is
        // omitted and the `effort-2025-11-24` beta isn't pushed.
        // `prompt-caching-scope-2026-01-05` rides along because
        // enableCacheControl defaults to true. If Anthropic ever requires
        // `output_config.effort` to accompany adaptive thinking, this
        // pinned shape will surface the regression at this test instead
        // of at runtime as a server 400.
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text: 'hi' }],
        });
        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-opus-4-7',
            apiKey: 'test-key',
            baseUrl: 'https://api.anthropic.com',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: { max_tokens: 500 },
            schemaCompliance: 'auto',
            // No `reasoning` key at all — different from `reasoning: false`.
          },
          mockConfig,
        );
        await generator.generateContent({
          model: 'models/ignored',
          contents: 'Hello',
          // Include systemInstruction so the body carries a
          // `cache_control: { scope: 'global' }` field — the beta gate
          // is now a body-scan, so the test needs an actual scope field
          // on the wire to observe the `prompt-caching-scope` flag.
          config: { systemInstruction: 'sys' },
        } as unknown as GenerateContentParameters);

        const [req, options] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        expect((req as { thinking?: unknown }).thinking).toEqual({
          type: 'adaptive',
          display: 'summarized',
        });
        expect(req).toEqual(
          expect.not.objectContaining({ output_config: expect.anything() }),
        );
        const headers = ((options as { headers?: Record<string, string> })
          ?.headers || {}) as Record<string, string>;
        expect(headers['anthropic-beta']).toContain(
          'interleaved-thinking-2025-05-14',
        );
        expect(headers['anthropic-beta']).not.toContain('effort-2025-11-24');
        expect(headers['anthropic-beta']).toContain(
          'prompt-caching-scope-2026-01-05',
        );
      });
    });

    describe('assistant-turn prefill stripping (generator wiring)', () => {
      // stripTrailingAssistantPrefill is derived from
      // modelSupportsAdaptiveThinking() (anthropicContentGenerator.ts),
      // the same 4.6+ gate used for the thinking shape. These pin that the
      // generator actually turns the converter option on/off per model,
      // not just that the converter behaves correctly when told to.
      it('strips a trailing assistant turn and appends a synthetic user turn on claude-opus-4-6', async () => {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'hi' }],
        });

        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-opus-4-6',
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
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            { role: 'model', parts: [{ text: 'Sure, here you go.' }] },
          ],
        } as unknown as GenerateContentParameters);

        const [anthropicRequest] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        const messages = (anthropicRequest as { messages: unknown[] }).messages;
        // enableCacheControl defaults to on at the generator level (unlike
        // the converter-level tests above, which pass it explicitly), so
        // the synthetic turn also picks up the same cache_control the
        // trailing user message would otherwise carry.
        expect(messages[messages.length - 1]).toEqual({
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
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl.mockResolvedValue({
          id: 'anthropic-1',
          model: 'claude-opus-4-5',
          content: [{ type: 'text', text: 'hi' }],
        });

        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-opus-4-5',
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
          contents: [
            { role: 'user', parts: [{ text: 'Hi' }] },
            { role: 'model', parts: [{ text: 'Sure, here you go.' }] },
          ],
        } as unknown as GenerateContentParameters);

        const [anthropicRequest] =
          anthropicState.lastCreateArgs as AnthropicCreateArgs;
        const messages = (anthropicRequest as { messages: unknown[] }).messages;
        expect(messages[messages.length - 1]).toEqual({
          role: 'assistant',
          content: [{ type: 'text', text: 'Sure, here you go.' }],
        });
      });
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

      it('uses model default when max_tokens is not explicitly configured', async () => {
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
          expect.objectContaining({ max_tokens: 64000 }),
        );
      });

      it('ignores malformed QWEN_CODE_MAX_OUTPUT_TOKENS values', async () => {
        const { AnthropicContentGenerator } = await importGenerator();

        for (const envValue of ['1.5', '2k', 'abc']) {
          process.env[MAX_OUTPUT_TOKENS_ENV] = envValue;
          anthropicState.createImpl.mockResolvedValueOnce({
            id: `anthropic-${envValue}`,
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
            expect.objectContaining({ max_tokens: 64000 }),
          );
        }
      });

      it('respects a valid QWEN_CODE_MAX_OUTPUT_TOKENS value', async () => {
        const { AnthropicContentGenerator } = await importGenerator();
        process.env[MAX_OUTPUT_TOKENS_ENV] = '9000';
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
          expect.objectContaining({ max_tokens: 9000 }),
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
          expect.objectContaining({ max_tokens: 64000 }),
        );
      });
    });
  });

  describe('Anthropic-compatible proxy thinking history', () => {
    const unsignedThinkingConversation = [
      { role: 'user' as const, parts: [{ text: 'First' }] },
      {
        role: 'model' as const,
        parts: [
          { text: 'unsigned reasoning', thought: true },
          { text: 'Visible answer' },
        ],
      },
      { role: 'user' as const, parts: [{ text: 'Second' }] },
    ];

    async function sendWithBaseUrl(
      baseUrl: string,
      contents: GenerateContentParameters['contents'] = unsignedThinkingConversation,
    ) {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'ok' }],
      });
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-6',
          apiKey: 'test-key',
          baseUrl,
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents,
      } as unknown as GenerateContentParameters);

      return anthropicState.lastCreateArgs?.[0] as {
        thinking?: unknown;
        messages: Array<{ role: string; content: unknown[] }>;
      };
    }

    it('drops unsigned thinking for Claude 4.6 through a non-native proxy', async () => {
      const request = await sendWithBaseUrl(
        'https://internal-proxy.example/anthropic',
      );

      expect(request.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });
      expect(request.messages[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'Visible answer' }],
      });
    });

    it('does not rewrite unsigned history for the native Anthropic API', async () => {
      const request = await sendWithBaseUrl('https://api.anthropic.com');

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
        { role: 'user' as const, parts: [{ text: 'Run tool' }] },
        {
          role: 'model' as const,
          parts: [
            { text: 'unsigned reasoning', thought: true },
            { functionCall: { id: 't1', name: 'tool', args: {} } },
          ],
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

      await expect(
        sendWithBaseUrl(
          'https://internal-proxy.example/anthropic',
          toolUseConversation,
        ),
      ).rejects.toThrow('proxy omitted the thinking signature');
      expect(anthropicState.createImpl).not.toHaveBeenCalled();
    });
  });

  // Regression for the manual-mode leading-thinking requirement: Anthropic
  // rejects a thinking-enabled tool loop whose final assistant turn doesn't
  // begin with a thinking block. mergeConsecutiveAssistantMessages's
  // straight concatenation can otherwise leave a leading text block ahead
  // of a later thinking run (see converter.ts's
  // ensureLeadingAssistantThinking doc).
  describe('manual-mode leading-thinking normalization', () => {
    it('reorders the latest assistant turn to lead with thinking under an explicit-budget (manual) configuration', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-6',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          // Must stay above budget_tokens below: Anthropic requires
          // budget_tokens < max_tokens (documented in buildThinkingConfig)
          // and buildSamplingParameters does not clamp between the two, so a
          // smaller value here would make this canonical manual-mode fixture
          // model a request the real API rejects -- passing only because the
          // client is mocked.
          samplingParams: { max_tokens: 64_000 },
          schemaCompliance: 'auto',
          // Explicit budget_tokens is the escape hatch that keeps
          // claude-opus-4-6 (a 4.6+ model that otherwise defaults to
          // adaptive) on the manual `{ type: 'enabled', budget_tokens }`
          // shape -- see "honors explicit reasoning.budget_tokens" above.
          reasoning: { budget_tokens: 42_000 },
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: [
          { role: 'user' as const, parts: [{ text: 'Run tool' }] },
          {
            // No leading thinking block on this earlier turn -- adaptive
            // mode explicitly permits this, and it's what the merge
            // concatenates ahead of the next turn's thinking block.
            role: 'model' as const,
            parts: [{ text: 'Sure, one moment.' }],
          },
          {
            role: 'model' as const,
            parts: [
              {
                text: 'reasoning about the tool call',
                thought: true,
                thoughtSignature: 'sig-1',
              },
              { functionCall: { id: 't1', name: 'tool', args: {} } },
            ],
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
        ],
      } as unknown as GenerateContentParameters);

      const [rawRequest, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const anthropicRequest = rawRequest as {
        thinking?: unknown;
        messages: Array<{ role: string; content: unknown[] }>;
      };

      expect(anthropicRequest.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 42_000,
      });
      expect(
        (options as { headers?: Record<string, string> })?.headers?.[
          'anthropic-beta'
        ],
      ).toContain('interleaved-thinking-2025-05-14');

      // The two model turns are merged into one assistant message by
      // mergeConsecutiveAssistantMessages; the merged turn is also the
      // request's latest assistant message, and manual mode requires it
      // to begin with thinking.
      const assistantMessages = anthropicRequest.messages.filter(
        (m) => m.role === 'assistant',
      );
      const latestAssistant = assistantMessages.at(-1) as {
        content: Array<{
          type: string;
          text?: string;
          thinking?: string;
          signature?: string;
        }>;
      };
      expect(latestAssistant.content[0]?.type).toBe('thinking');
      expect(latestAssistant.content[0]?.thinking).toBe(
        'reasoning about the tool call',
      );
      expect(latestAssistant.content[0]?.signature).toBe('sig-1');
      expect(latestAssistant.content[1]).toEqual({
        type: 'text',
        text: 'Sure, one moment.',
      });
      expect(latestAssistant.content[2]?.type).toBe('tool_use');
    });

    it('reorders the latest assistant turn to lead with thinking under an effort-ladder (manual) configuration on a pre-4.6 model', async () => {
      // buildThinkingConfig reaches `{ type: 'enabled' }` two ways: the
      // explicit-budget escape hatch (covered by the test above) and the
      // effort ladder for pre-4.6 / unversioned ids (covered here). The
      // generator gates ensureLeadingAssistantThinking on the BUILT config's
      // `type === 'enabled'`, not on the presence of reasoning.budget_tokens,
      // so the ladder path must reorder the same way. claude-opus-4-5 with
      // effort only (no budget_tokens) resolves to the manual budget shape
      // `{ type: 'enabled', budget_tokens: 32_000 }` -- see "keeps the
      // budget_tokens config for older 4.x models" above.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1b',
        model: 'claude-opus-4-5',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-5',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          // Must stay above the effort-ladder budget_tokens (32_000 for
          // medium): Anthropic requires budget_tokens < max_tokens, so a
          // smaller value would model a request the real API rejects.
          samplingParams: { max_tokens: 64_000 },
          schemaCompliance: 'auto',
          // Effort only, no budget_tokens: claude-opus-4-5 (pre-4.6) takes
          // the effort ladder to `{ type: 'enabled', budget_tokens: 32_000 }`.
          reasoning: { effort: 'medium' },
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: [
          { role: 'user' as const, parts: [{ text: 'Run tool' }] },
          {
            // No leading thinking block on this earlier turn -- it's what the
            // merge concatenates ahead of the next turn's thinking block.
            role: 'model' as const,
            parts: [{ text: 'Sure, one moment.' }],
          },
          {
            role: 'model' as const,
            parts: [
              {
                text: 'reasoning about the tool call',
                thought: true,
                thoughtSignature: 'sig-1',
              },
              { functionCall: { id: 't1', name: 'tool', args: {} } },
            ],
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
        ],
      } as unknown as GenerateContentParameters);

      const [rawRequest, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const anthropicRequest = rawRequest as {
        thinking?: unknown;
        messages: Array<{ role: string; content: unknown[] }>;
      };

      expect(anthropicRequest.thinking).toEqual({
        type: 'enabled',
        budget_tokens: 32_000,
      });
      expect(
        (options as { headers?: Record<string, string> })?.headers?.[
          'anthropic-beta'
        ],
      ).toContain('interleaved-thinking-2025-05-14');

      // The two model turns are merged into one assistant message; the merged
      // turn is also the request's latest assistant message, and manual mode
      // requires it to begin with thinking.
      const assistantMessages = anthropicRequest.messages.filter(
        (m) => m.role === 'assistant',
      );
      const latestAssistant = assistantMessages.at(-1) as {
        content: Array<{
          type: string;
          text?: string;
          thinking?: string;
          signature?: string;
        }>;
      };
      expect(latestAssistant.content[0]?.type).toBe('thinking');
      expect(latestAssistant.content[0]?.thinking).toBe(
        'reasoning about the tool call',
      );
      expect(latestAssistant.content[0]?.signature).toBe('sig-1');
      expect(latestAssistant.content[1]).toEqual({
        type: 'text',
        text: 'Sure, one moment.',
      });
      expect(latestAssistant.content[2]?.type).toBe('tool_use');
    });

    it('leaves the latest assistant turn in chronological order under adaptive thinking (no explicit budget)', async () => {
      // Guards the generator's `ensureLeadingAssistantThinking:
      // thinking?.type === 'enabled'` gate: a regression to `!!thinking`
      // (truthy for both `{type:'enabled'}` and `{type:'adaptive'}`) would
      // silently reintroduce the hoist-every-thinking corruption this PR
      // removed from the merge path, but only on adaptive-thinking models
      // -- which the manual-mode test above cannot catch.
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-2',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'ok' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-6',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          // No explicit budget_tokens: claude-opus-4-6 (a 4.6+ model)
          // defaults to adaptive thinking.
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: [
          { role: 'user' as const, parts: [{ text: 'Run tool' }] },
          {
            role: 'model' as const,
            parts: [{ text: 'Sure, one moment.' }],
          },
          {
            role: 'model' as const,
            parts: [
              {
                text: 'reasoning about the tool call',
                thought: true,
                thoughtSignature: 'sig-1',
              },
              { functionCall: { id: 't1', name: 'tool', args: {} } },
            ],
          },
          {
            // Answer t1 so the request ends on a tool_result rather than an
            // unanswered tool_use: without this, stripTrailingAssistantPrefill
            // appends a synthetic 'Continue.' user turn, leaving a tool_use
            // with no tool_result after it -- the exact HTTP 400 shape
            // mergeConsecutiveAssistantMessages documents. Mirrors the
            // manual-mode sibling above; the assertion is unaffected.
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
        ],
      } as unknown as GenerateContentParameters);

      const [rawRequest] = anthropicState.lastCreateArgs as AnthropicCreateArgs;
      const anthropicRequest = rawRequest as {
        thinking?: unknown;
        messages: Array<{
          role: string;
          content: Array<{ type: string; text?: string }>;
        }>;
      };

      expect(anthropicRequest.thinking).toEqual({
        type: 'adaptive',
        display: 'summarized',
      });

      const assistantMessages = anthropicRequest.messages.filter(
        (m) => m.role === 'assistant',
      );
      const latestAssistant = assistantMessages.at(-1)!;
      expect(latestAssistant.content.map((b) => b.type)).toEqual([
        'text',
        'thinking',
        'tool_use',
      ]);
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

  describe('generateContentStream', () => {
    const collectGeneratedStream = async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );
      const stream = await generator.generateContentStream({
        model: 'models/ignored',
        contents: 'Hello',
      } as unknown as GenerateContentParameters);
      const chunks: GenerateContentResponse[] = [];
      let error: unknown;
      try {
        for await (const chunk of stream) chunks.push(chunk);
      } catch (caughtError) {
        error = caughtError;
      }
      return { chunks, error };
    };

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
        const { AnthropicContentGenerator } = await importGenerator();
        const { getToolCallPreparations } = await import(
          '../tool-call-preparation.js'
        );
        let currentEvent = '';
        anthropicState.createImpl.mockResolvedValue(
          (async function* toolUseStream() {
            yield {
              type: 'message_start',
              message: {
                id: 'msg-1',
                model: 'claude-test',
                usage: { input_tokens: 1 },
              },
            };
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call-1',
                name: 'read_file',
                input: {},
              },
            };
            for (const partialJson of jsonParts) {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'input_json_delta',
                  partial_json: partialJson,
                },
              };
            }
            yield {
              get type() {
                currentEvent = 'content_block_stop';
                return 'content_block_stop' as const;
              },
              index: 0,
            };
            yield {
              get type() {
                currentEvent = 'message_delta';
                return 'message_delta' as const;
              },
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 5 },
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
            samplingParams: { max_tokens: 100 },
            schemaCompliance: 'auto',
          },
          mockConfig,
        );

        const stream = await generator.generateContentStream({
          model: 'models/ignored',
          contents: 'Hello',
        } as unknown as GenerateContentParameters);
        const chunks: GenerateContentResponse[] = [];
        let eventWhenFunctionCallEmitted: string | undefined;
        for await (const chunk of stream) {
          chunks.push(chunk);
          if (chunk.functionCalls) {
            eventWhenFunctionCallEmitted = currentEvent;
          }
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
          {
            id: 'call-1',
            name: 'read_file',
            args: expectedArgs,
          },
        ]);
      },
    );

    it('defers parallel tool calls after empty arguments until the stop reason confirms them', async () => {
      anthropicState.createImpl.mockResolvedValue(
        (async function* parallelToolUseStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-empty',
              name: 'list_directory',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '' },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'call-full',
              name: 'read_file',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"file_path":"a.sql"}',
            },
          };
          yield { type: 'content_block_stop', index: 1 };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 },
          };
        })(),
      );

      const { chunks, error } = await collectGeneratedStream();

      expect(error).toBeUndefined();
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([
        {
          id: 'call-empty',
          name: 'list_directory',
          args: {},
        },
        {
          id: 'call-full',
          name: 'read_file',
          args: { file_path: 'a.sql' },
        },
      ]);
    });

    it('releases closed valid tool calls before rethrowing an upstream stream error', async () => {
      const networkError = Object.assign(
        new Error('SSE connection reset by peer'),
        { code: 'ECONNRESET' },
      );
      anthropicState.createImpl.mockResolvedValue(
        (async function* interruptedToolUseStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-complete',
              name: 'read_file',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"file_path":"a.sql"}',
            },
          };
          yield { type: 'content_block_stop', index: 0 };
          throw networkError;
        })(),
      );
      const { chunks, error } = await collectGeneratedStream();

      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([
        {
          id: 'call-complete',
          name: 'read_file',
          args: { file_path: 'a.sql' },
        },
      ]);
      expect(error).toBe(networkError);
    });

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
        anthropicState.createImpl.mockResolvedValue(
          (async function* failedToolUseStream() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call-complete',
                name: 'run_shell_command',
                input: {},
              },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: '{"command":"pwd"}',
              },
            };
            yield { type: 'content_block_stop', index: 0 };
            throw error;
          })(),
        );
        const result = await collectGeneratedStream();

        expect(
          result.chunks.flatMap((chunk) => chunk.functionCalls ?? []),
        ).toEqual([]);
        expect(result.error).toBe(error);
      },
    );

    it('does not release a closed call when an upstream error leaves a sibling tool block open', async () => {
      const networkError = Object.assign(
        new Error('SSE connection reset by peer'),
        { code: 'ECONNRESET' },
      );
      anthropicState.createImpl.mockResolvedValue(
        (async function* interruptedParallelToolUseStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-complete',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"pwd"}',
            },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'call-truncated',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"rm -rf /tmp/scra',
            },
          };
          throw networkError;
        })(),
      );
      const { chunks, error } = await collectGeneratedStream();

      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([]);
      expect(error).toBe(networkError);
    });

    it.each([
      { case: 'empty arguments', partialJson: '' },
      { case: 'malformed arguments', partialJson: '{"command":' },
      { case: 'a non-object argument root', partialJson: '[]' },
    ])(
      'does not release a closed call before an upstream error when a sibling closes with $case',
      async ({ partialJson }) => {
        const networkError = Object.assign(
          new Error('SSE connection reset by peer'),
          { code: 'ECONNRESET' },
        );
        anthropicState.createImpl.mockResolvedValue(
          (async function* interruptedParallelToolUseStream() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call-complete',
                name: 'run_shell_command',
                input: {},
              },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: '{"command":"pwd"}',
              },
            };
            yield { type: 'content_block_stop', index: 0 };
            yield {
              type: 'content_block_start',
              index: 1,
              content_block: {
                type: 'tool_use',
                id: 'call-invalid',
                name: 'run_shell_command',
                input: {},
              },
            };
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: partialJson },
            };
            yield { type: 'content_block_stop', index: 1 };
            throw networkError;
          })(),
        );

        const { chunks, error } = await collectGeneratedStream();

        expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual(
          [],
        );
        expect(error).toBe(networkError);
      },
    );

    it('routes an unterminated tool call through max-token recovery without emitting the batch', async () => {
      anthropicState.createImpl.mockResolvedValue(
        (async function* parallelToolUseStream() {
          yield {
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'text', text: '' },
          };
          yield {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'text_delta', text: 'partial response' },
          };
          yield { type: 'content_block_stop', index: 2 };
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-full',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"pwd"}',
            },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'call-truncated',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"rm -rf /tmp/scra',
            },
          };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'max_tokens' },
            usage: { output_tokens: 100 },
          };
        })(),
      );

      const { chunks, error } = await collectGeneratedStream();

      expect(error).toBeUndefined();
      expect(
        chunks
          .flatMap((chunk) => chunk.candidates ?? [])
          .flatMap((candidate) => candidate.content?.parts ?? [])
          .map((part) => part.text ?? '')
          .join(''),
      ).toContain('partial response');
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([]);
      expect(
        chunks.flatMap((chunk) => chunk.candidates ?? []).at(-1)?.finishReason,
      ).toBe(FinishReason.MAX_TOKENS);
    });

    it.each([
      { case: 'an empty argument buffer', partialJson: '' },
      {
        case: 'an unterminated string',
        partialJson: '{"command":"rm -rf /tmp/scra',
      },
      { case: 'an unclosed object', partialJson: '{"command":"pwd"' },
      { case: 'a missing argument value', partialJson: '{"command":' },
      { case: 'a trailing comma', partialJson: '{"command":"pwd",}' },
    ])(
      'routes $case through max-token recovery without emitting a call',
      async ({ partialJson }) => {
        anthropicState.createImpl.mockResolvedValue(
          (async function* truncatedToolUseStream() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call-truncated',
                name: 'run_shell_command',
                input: {},
              },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: partialJson },
            };
            yield { type: 'content_block_stop', index: 0 };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'max_tokens' },
              usage: { output_tokens: 100 },
            };
          })(),
        );

        const { chunks, error } = await collectGeneratedStream();

        expect(error).toBeUndefined();
        expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual(
          [],
        );
        expect(
          chunks.flatMap((chunk) => chunk.candidates ?? []).at(-1)
            ?.finishReason,
        ).toBe(FinishReason.MAX_TOKENS);
      },
    );

    it.each(['[]', 'null', '42'])(
      'rejects a non-object argument root under max_tokens: %s',
      async (partialJson) => {
        anthropicState.createImpl.mockResolvedValue(
          (async function* nonObjectToolUseStream() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call-invalid',
                name: 'run_shell_command',
                input: {},
              },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: partialJson },
            };
            yield { type: 'content_block_stop', index: 0 };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'max_tokens' },
              usage: { output_tokens: 100 },
            };
          })(),
        );

        const { chunks, error } = await collectGeneratedStream();

        expect(error).toMatchObject({
          name: 'InvalidStreamError',
          type: 'MALFORMED_TOOL_CALL',
        });
        expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual(
          [],
        );
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
      anthropicState.createImpl.mockResolvedValue(
        (async function* completeToolUseStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-complete',
              name: 'read_file',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"file_path":"a.sql"}',
            },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'max_tokens' },
            usage: { output_tokens: 100 },
          };
        })(),
      );

      const { chunks, error } = await collectGeneratedStream();

      expect(error).toBeUndefined();
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([
        {
          id: 'call-complete',
          name: 'read_file',
          args: { file_path: 'a.sql' },
        },
      ]);
      expect(
        chunks.flatMap((chunk) => chunk.candidates ?? []).at(-1)?.finishReason,
      ).toBe(FinishReason.MAX_TOKENS);
    });

    it('releases a complete tool call when a non-tool block remains open at the stop reason', async () => {
      anthropicState.createImpl.mockResolvedValue(
        (async function* completeToolUseWithOpenTextStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-complete',
              name: 'read_file',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"file_path":"a.sql"}',
            },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '' },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'done' },
          };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 },
          };
        })(),
      );

      const { chunks, error } = await collectGeneratedStream();

      expect(error).toBeUndefined();
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([
        {
          id: 'call-complete',
          name: 'read_file',
          args: { file_path: 'a.sql' },
        },
      ]);
    });

    it('accepts a stop reason when no tool calls are pending', async () => {
      anthropicState.createImpl.mockResolvedValue(
        (async function* textStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'done' },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          };
        })(),
      );

      const { chunks, error } = await collectGeneratedStream();

      expect(error).toBeUndefined();
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([]);
      expect(
        chunks.flatMap((chunk) => chunk.candidates ?? []).at(-1)?.finishReason,
      ).toBe(FinishReason.STOP);
    });

    it('rejects an open tool-use block after assistant payload at end of stream', async () => {
      anthropicState.createImpl.mockResolvedValue(
        (async function* openToolUseStream() {
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: '' },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'text_delta', text: 'partial response' },
          };
          yield { type: 'content_block_stop', index: 1 };
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-open',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"pwd"}',
            },
          };
        })(),
      );

      const { chunks, error } = await collectGeneratedStream();

      expect(error).toMatchObject({
        name: 'InvalidStreamError',
        type: 'MALFORMED_TOOL_CALL',
      });
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([]);
    });

    it('rejects a confirmed turn with an open tool-use block without releasing closed siblings', async () => {
      anthropicState.createImpl.mockResolvedValue(
        (async function* openParallelToolUseStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-complete',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"pwd"}',
            },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'call-open',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"whoami"}',
            },
          };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 100 },
          };
        })(),
      );
      const { chunks, error } = await collectGeneratedStream();

      expect(error).toMatchObject({
        name: 'InvalidStreamError',
        type: 'MALFORMED_TOOL_CALL',
      });
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([]);
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
        partialJson: '{"command":"rm -rf /tmp/scra',
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
      {
        case: 'an array root',
        partialJson: '[]',
        stopReason: 'tool_use',
      },
      {
        case: 'a null root',
        partialJson: 'null',
        stopReason: 'tool_use',
      },
      {
        case: 'a numeric root',
        partialJson: '42',
        stopReason: 'tool_use',
      },
    ])(
      'rejects tool arguments with $case without emitting a function call',
      async ({ partialJson, stopReason }) => {
        anthropicState.createImpl.mockResolvedValue(
          (async function* invalidToolUseStream() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'call-invalid',
                name: 'run_shell_command',
                input: {},
              },
            };
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: partialJson,
              },
            };
            yield { type: 'content_block_stop', index: 0 };
            if (stopReason) {
              yield {
                type: 'message_delta',
                delta: { stop_reason: stopReason },
                usage: { output_tokens: 100 },
              };
            }
            yield { type: 'message_stop' };
          })(),
        );

        const { chunks, error } = await collectGeneratedStream();

        expect(error).toMatchObject({
          name: 'InvalidStreamError',
          type: 'MALFORMED_TOOL_CALL',
        });
        expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual(
          [],
        );
      },
    );

    it('emits preparations before both function calls in a multi-tool stream', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      const { getToolCallPreparations } = await import(
        '../tool-call-preparation.js'
      );
      anthropicState.createImpl.mockResolvedValue(
        (async function* multiToolStream() {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-1',
              name: 'read_file',
              input: {},
            },
          };
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: {
              type: 'tool_use',
              id: 'call-2',
              name: 'run_shell_command',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"file_path":"a.sql"}',
            },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"command":"pwd"}',
            },
          };
          yield { type: 'content_block_stop', index: 1 };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 5 },
          };
        })(),
      );
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
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

      const preparations = chunks.flatMap((chunk, index) =>
        getToolCallPreparations(chunk).map((preparation) => ({
          ...preparation,
          index,
        })),
      );
      const functionCalls = chunks.flatMap((chunk, index) =>
        (chunk.functionCalls ?? []).map((functionCall) => ({
          ...functionCall,
          index,
        })),
      );
      expect(preparations).toEqual([
        { callId: 'call-1', toolName: 'read_file', index: 0 },
        { callId: 'call-2', toolName: 'run_shell_command', index: 1 },
      ]);
      expect(functionCalls).toEqual([
        {
          id: 'call-1',
          name: 'read_file',
          args: { file_path: 'a.sql' },
          index: 2,
        },
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
      {
        label: 'id is empty',
        contentBlock: { id: '', name: 'read_file' },
      },
      {
        label: 'name is empty',
        contentBlock: { id: 'call-1', name: '' },
      },
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
        const { AnthropicContentGenerator } = await importGenerator();
        const { getToolCallPreparations } = await import(
          '../tool-call-preparation.js'
        );
        anthropicState.createImpl.mockResolvedValue(
          (async function* toolUseStream() {
            yield {
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                ...contentBlock,
                input: {},
              },
            };
            yield { type: 'content_block_stop', index: 0 };
            yield {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { output_tokens: 1 },
            };
          })(),
        );

        const generator = new AnthropicContentGenerator(
          {
            model: 'claude-test',
            apiKey: 'test-key',
            timeout: 10_000,
            maxRetries: 2,
            samplingParams: { max_tokens: 100 },
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

        expect(
          chunks.every((chunk) => getToolCallPreparations(chunk).length === 0),
        ).toBe(true);
      },
    );

    it('redacts proxy credentials from stream creation errors', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockRejectedValue(
        new Error('407 via http://user:pass@proxy.local'),
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      await expect(
        generator.generateContentStream({
          model: 'models/ignored',
          contents: 'Hello',
        } as unknown as GenerateContentParameters),
      ).rejects.toThrow('407 via http://<redacted>@proxy.local');
    });

    it('does not leak abort listeners onto the caller signal across streamed requests', async () => {
      const { AnthropicContentGenerator } = await importGenerator();

      // Reproduce the Anthropic SDK's listener leak: core.mjs fetchWithTimeout
      // registers an 'abort' listener on whatever signal it is handed and never
      // removes it. Whichever signal the generator passes to the client is
      // where that listener accumulates.
      anthropicState.createImpl.mockImplementation(
        (_req: unknown, opts: { signal?: AbortSignal }) => {
          opts.signal?.addEventListener('abort', () => {});
          return (async function* () {
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
          })();
        },
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      // A single long-lived caller signal reused across many requests, as a
      // session/turn-scoped AbortController would be.
      const callerAc = new AbortController();

      for (let i = 0; i < 5; i++) {
        const stream = await generator.generateContentStream({
          model: 'models/ignored',
          contents: 'Hello',
          config: { abortSignal: callerAc.signal },
        } as unknown as GenerateContentParameters);
        for await (const _chunk of stream) {
          // drain
        }
      }

      // The SDK's per-request listeners must land on short-lived child signals
      // (aborted once the stream drains), not pile up on the caller's signal.
      expect(getEventListeners(callerAc.signal, 'abort')).toHaveLength(0);

      // And the generator must not hand the caller signal straight to the SDK.
      const passedSignal = (
        anthropicState.lastCreateArgs?.[1] as { signal?: AbortSignal }
      )?.signal;
      expect(passedSignal).toBeDefined();
      expect(passedSignal).not.toBe(callerAc.signal);
    });

    it('redacts proxy credentials from stream iteration errors', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: vi
            .fn()
            .mockRejectedValue(
              new Error('connect ECONNREFUSED token@proxy.local:8080'),
            ),
        }),
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const stream = await generator.generateContentStream({
        model: 'models/ignored',
        contents: 'Hello',
      } as unknown as GenerateContentParameters);

      await expect(async () => {
        for await (const _ of stream) {
          // consume stream
        }
      }).rejects.toThrow('connect ECONNREFUSED <redacted>@proxy.local:8080');
    });

    it('preserves message_start usage when the stream fails after content', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      const { getGenAiUsageProvenance } = await import(
        '../../telemetry/gen-ai-usage.js'
      );
      anthropicState.createImpl.mockResolvedValue(
        (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'msg-1',
              model: 'claude-test',
              usage: {
                input_tokens: 2,
                cache_read_input_tokens: 3,
                cache_creation_input_tokens: 4,
              },
            },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'partial' },
          };
          throw new Error('stream interrupted');
        })(),
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );
      const stream = await generator.generateContentStream({
        model: 'models/ignored',
        contents: 'Hello',
      } as unknown as GenerateContentParameters);

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
      const { AnthropicContentGenerator } = await importGenerator();
      const { getGenAiUsageProvenance } = await import(
        '../../telemetry/gen-ai-usage.js'
      );
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
              input_tokens: 2,
              cache_read_input_tokens: 7,
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

      // The preparation-only chunk precedes the complete tool call chunk.
      expect(chunks[3]?.functionCalls).toBeUndefined();
      expect(chunks[4]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        functionCall: { id: 't1', name: 'tool', args: { x: 1 } },
      });

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
      // Real Anthropic mid-conversation: `message_start` reports the warm
      // prefix bucket (cache_read), the new cache write bucket
      // (cache_creation), and the fresh tail (input). The streaming
      // accumulator must hold onto cache_creation alongside the other
      // buckets so the final chunk's usageMetadata reflects the full
      // prompt size — otherwise the cache_creation portion is silently
      // dropped from the displayed total and the Footer under-reports by
      // exactly that many tokens.
      const { AnthropicContentGenerator } = await importGenerator();
      const { getGenAiUsageProvenance } = await import(
        '../../telemetry/gen-ai-usage.js'
      );
      anthropicState.createImpl.mockResolvedValue(
        (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'msg-1',
              model: 'claude-test',
              usage: {
                input_tokens: 2_500,
                cache_read_input_tokens: 32_088,
                cache_creation_input_tokens: 8_700,
              },
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
            delta: { type: 'text_delta', text: 'ok' },
          };
          yield { type: 'content_block_stop', index: 0 };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 400 },
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

      const last = chunks[chunks.length - 1]!;
      expect(last.usageMetadata).toEqual({
        // Sum of all three prompt buckets: 2,500 + 32,088 + 8,700 = 43,288.
        // cachedContentTokenCount reports cache_read only.
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
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue(
        (async function* () {
          yield {
            type: 'message_start',
            message: { id: 'msg-1', usage: { input_tokens: 1 } },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'ok' },
          };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1 },
          };
        })(),
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'requested-model',
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
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks).not.toHaveLength(0);
      expect(chunks.every((chunk) => chunk.modelVersion === undefined)).toBe(
        true,
      );
    });

    it('falls back to non-streaming when the stream is empty and surfaces provider errors', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl
        .mockResolvedValueOnce(
          (async function* () {
            // Empty stream: compatible gateways can return HTTP 200 with no SSE
            // events when the real failure body is only available non-streaming.
          })(),
        )
        .mockRejectedValueOnce(new Error('400 quota exceeded'));

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

      await expect(async () => {
        for await (const _chunk of stream) {
          void _chunk;
        }
      }).rejects.toThrow('400 quota exceeded');

      expect(anthropicState.createImpl).toHaveBeenCalledTimes(2);
      const [streamingRequest] = anthropicState.createImpl.mock
        .calls[0] as AnthropicCreateArgs;
      const [fallbackRequest] = anthropicState.createImpl.mock
        .calls[1] as AnthropicCreateArgs;
      expect(streamingRequest).toEqual(
        expect.objectContaining({ stream: true }),
      );
      expect(fallbackRequest).not.toHaveProperty('stream');
      expect(mockReportAnthropicFollowingRequest).toHaveBeenCalledWith(
        fallbackRequest,
        undefined,
      );
    });

    it('keeps the fallback probe signal live after the drain abort (no spurious AbortError)', async () => {
      // Regression for the empty-fallback probe: the shared stream guard aborts
      // the per-request controller the moment the source stream drains, which
      // happens before the probe runs. The probe must NOT inherit that
      // already-aborted signal, or the SDK rejects it immediately with a
      // spurious AbortError instead of surfacing the provider's real error
      // (e.g. a 402 credit-balance response). Model the SDK's abort semantics:
      // the probe's `create` rejects at call time when handed an aborted signal.
      //
      // The guards must be ON for this regression to bite — the spurious
      // AbortError only exists because the guard's drain-time abort precedes
      // the probe. Stub the env knobs so an ambient `QWEN_STREAM_*=0`
      // (documented disable values) in the dev/CI shell can't silently switch
      // the guards off and vacate the test.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, undefined);
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, undefined);
      try {
        const { AnthropicContentGenerator } = await importGenerator();
        anthropicState.createImpl
          .mockResolvedValueOnce(
            (async function* () {
              // Empty stream: drains immediately, after which the guard aborts
              // the per-request controller and the fallback probe runs.
            })(),
          )
          .mockImplementationOnce(
            (_req: unknown, opts: { signal?: AbortSignal }) => {
              if (opts?.signal?.aborted) {
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                return Promise.reject(abortErr);
              }
              return Promise.reject(new Error('402 credit balance is too low'));
            },
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

        await expect(async () => {
          for await (const _chunk of stream) {
            void _chunk;
          }
        }).rejects.toThrow('402 credit balance is too low');

        expect(anthropicState.createImpl).toHaveBeenCalledTimes(2);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('aborts the fallback probe when the caller signal cancels mid-probe', async () => {
      // Pins the probe's caller-signal linkage: the probe derives a child of
      // the caller's signal, so a user Ctrl-C landing while the non-streaming
      // probe is in flight (the quota/billing-shaped 200-but-empty response)
      // aborts the probe instead of letting it run to completion against the
      // provider and spend quota on a turn already cancelled. Mutant check:
      // deriving the child from `undefined` leaves the hung probe unsettled
      // and this test fails on the timeout assertion.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, undefined);
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, undefined);
      try {
        const { AnthropicContentGenerator } = await importGenerator();
        const callerAc = new AbortController();
        anthropicState.createImpl
          .mockResolvedValueOnce(
            (async function* () {
              // Empty stream: drains immediately, then the probe runs.
            })(),
          )
          .mockImplementationOnce(
            // A probe that hangs until its signal aborts, modelling an
            // in-flight non-streaming request.
            (_req: unknown, opts: { signal?: AbortSignal }) =>
              new Promise((_resolve, reject) => {
                const abortErr = new Error('The operation was aborted');
                abortErr.name = 'AbortError';
                if (opts?.signal?.aborted) {
                  reject(abortErr);
                  return;
                }
                opts?.signal?.addEventListener('abort', () => reject(abortErr));
              }),
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
          config: { abortSignal: callerAc.signal },
        } as unknown as GenerateContentParameters);

        const settled = (async () => {
          for await (const _chunk of stream) {
            void _chunk;
          }
        })().catch((e: unknown) => e);

        // Wait until the probe call is in flight, then cancel like a user.
        await vi.waitFor(() =>
          expect(anthropicState.createImpl).toHaveBeenCalledTimes(2),
        );
        callerAc.abort();
        const err = await settled;
        expect((err as Error).name).toBe('AbortError');
        expect((err as Error).message).toBe('The operation was aborted');
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each([
      { case: 'an empty buffer', partialJson: '' },
      { case: 'a partial buffer', partialJson: '{"file_path":' },
    ])(
      'falls back to non-streaming when an unconfirmed tool block with $case is the only stream payload',
      async ({ partialJson }) => {
        anthropicState.createImpl
          .mockResolvedValueOnce(
            (async function* unconfirmedToolUseStream() {
              yield {
                type: 'content_block_start',
                index: 0,
                content_block: {
                  type: 'tool_use',
                  id: 'call-open',
                  name: 'read_file',
                  input: {},
                },
              };
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: {
                  type: 'input_json_delta',
                  partial_json: partialJson,
                },
              };
            })(),
          )
          .mockRejectedValueOnce(new Error('402 credit balance is too low'));
        const { chunks, error } = await collectGeneratedStream();

        expect(error).toMatchObject({
          message: '402 credit balance is too low',
        });
        expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual(
          [],
        );
        expect(anthropicState.createImpl).toHaveBeenCalledTimes(2);
      },
    );

    it('converts the non-streaming fallback response when an empty stream is recoverable', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      const streamingAttempt = { generation: 1 };
      const fallbackAttempt = { generation: 2 };
      mockReportAnthropicRequest.mockReturnValueOnce(streamingAttempt);
      mockReportAnthropicFollowingRequest.mockReturnValueOnce(fallbackAttempt);
      anthropicState.createImpl
        .mockResolvedValueOnce(
          (async function* () {
            yield { type: 'message_stop' };
          })(),
        )
        .mockResolvedValueOnce({
          id: 'msg-fallback',
          model: 'claude-test',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'fallback ok' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        });

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

      expect(anthropicState.createImpl).toHaveBeenCalledTimes(2);
      const [fallbackRequest] = anthropicState.createImpl.mock
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
      // The probe's short-lived child must be aborted once the probe settles:
      // that is what releases the SDK's abort listener instead of leaving it
      // attached until the caller's long-lived round signal ends.
      const [, fallbackOptions] = anthropicState.createImpl.mock
        .calls[1] as AnthropicCreateArgs;
      expect(fallbackOptions?.signal?.aborted).toBe(true);
    });
  });

  // Issue #9005 finding 4: the OpenAI wire wraps its stream in an idle
  // watchdog plus a non-resetting lifetime cap (openaiContentGenerator
  // `withStreamGuards`), while the Anthropic wire had neither — a stream that
  // returns 200 and then goes silent (or drip-feeds `thinking_delta` frames
  // forever, which keep resetting any idle-only timer) hangs the CLI until
  // the process is killed. These tests pin the Anthropic wire to the same
  // guards, mirroring the OpenAI pipeline's watchdog suite.
  describe('stream watchdog guards (issue #9005 finding 4)', () => {
    // A manually gated SSE event source: events arrive only when pushed, so
    // tests can model a stream that goes silent or is drip-fed. Mirrors the
    // `gatedStream` helper in openaiContentGenerator/pipeline.test.ts.
    function gatedEventStream() {
      let resolveNext: ((r: IteratorResult<unknown>) => void) | null = null;
      const buffered: unknown[] = [];
      let ended = false;
      let returned = false;
      const deliver = (r: IteratorResult<unknown>) => {
        const r2 = resolveNext;
        resolveNext = null;
        r2?.(r);
      };
      return {
        push(event: unknown) {
          if (resolveNext) deliver({ done: false, value: event });
          else buffered.push(event);
        },
        end() {
          ended = true;
          if (resolveNext) deliver({ done: true, value: undefined as never });
        },
        wasReturned() {
          return returned;
        },
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<unknown>> {
                if (buffered.length) {
                  return Promise.resolve({
                    done: false,
                    value: buffered.shift()!,
                  });
                }
                if (ended) {
                  return Promise.resolve({
                    done: true,
                    value: undefined as never,
                  });
                }
                return new Promise((res) => {
                  resolveNext = res;
                });
              },
              return(): Promise<IteratorResult<unknown>> {
                returned = true;
                ended = true;
                if (resolveNext) {
                  deliver({ done: true, value: undefined as never });
                }
                return Promise.resolve({
                  done: true,
                  value: undefined as never,
                });
              },
            };
          },
        },
      };
    }

    const buildGenerator = async (guardConfig: {
      streamIdleTimeoutMs?: number;
      streamMaxLifetimeMs?: number;
    }) => {
      const { AnthropicContentGenerator } = await importGenerator();
      return new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 100 },
          schemaCompliance: 'auto',
          ...(guardConfig.streamIdleTimeoutMs !== undefined
            ? { streamIdleTimeoutMs: guardConfig.streamIdleTimeoutMs }
            : {}),
          ...(guardConfig.streamMaxLifetimeMs !== undefined
            ? { streamMaxLifetimeMs: guardConfig.streamMaxLifetimeMs }
            : {}),
        },
        mockConfig,
      );
    };

    const streamRequest = {
      model: 'models/ignored',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    // Drain the stream and capture whatever it ends with. Without the guards a
    // silent/drip-fed source never settles, so callers race the result
    // against a sentinel instead of awaiting it directly — a missing
    // watchdog then fails the assertion instead of hanging the test.
    const consumeUntilSettled = (
      stream: AsyncGenerator<GenerateContentResponse>,
    ) =>
      (async () => {
        for await (const _chunk of stream) {
          /* drain */
        }
      })().catch((e: unknown) => e);

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
      const gated = gatedEventStream(); // never pushes → silent
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({
        streamIdleTimeoutMs: 1000,
        streamMaxLifetimeMs: 0,
      });
      const stream = await generator.generateContentStream(streamRequest);
      const captured = consumeUntilSettled(stream);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      const sentinel = Symbol('idle-watchdog-did-not-fire');
      const err = await Promise.race([captured, Promise.resolve(sentinel)]);
      expect(err).toMatchObject({
        name: 'StreamInactivityTimeoutError',
        code: 'ETIMEDOUT',
        idleMs: 1000,
        chunksReceived: 0,
      });
      expect((err as Error).message).toContain('QWEN_STREAM_IDLE_TIMEOUT_MS');
      expect(gated.wasReturned()).toBe(true);
    });

    it('uses the shared default idle timeout when no override is configured', async () => {
      const gated = gatedEventStream(); // never pushes → silent
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({});
      const stream = await generator.generateContentStream(streamRequest);
      const captured = consumeUntilSettled(stream);
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      const sentinel = Symbol('default-idle-watchdog-did-not-fire');
      const err = await Promise.race([captured, Promise.resolve(sentinel)]);
      expect(err).toMatchObject({
        name: 'StreamInactivityTimeoutError',
        code: 'ETIMEDOUT',
        idleMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        chunksReceived: 0,
      });
    });

    it('honours QWEN_STREAM_IDLE_TIMEOUT_MS when no explicit config is set', async () => {
      // Anthropic twin of the OpenAI pipeline.test.ts case: with no explicit
      // `streamIdleTimeoutMs` config field, the constructor must resolve the
      // idle window from the deployment env knob. Mutant check: replacing the
      // constructor's `resolveStreamIdleTimeoutMs(contentGeneratorConfig)`
      // with `contentGeneratorConfig.streamIdleTimeoutMs ??
      // DEFAULT_STREAM_IDLE_TIMEOUT_MS` ignores the env knob (falls back to
      // the 240s default) and this test fails on the sentinel.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '3000');
      const gated = gatedEventStream(); // never pushes → silent
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({});
      const stream = await generator.generateContentStream(streamRequest);
      const captured = consumeUntilSettled(stream);
      await vi.advanceTimersByTimeAsync(2999); // inside the env window
      await vi.advanceTimersByTimeAsync(0);
      const earlySentinel = Symbol('idle-watchdog-fired-before-env-value');
      const early = await Promise.race([
        captured,
        Promise.resolve(earlySentinel),
      ]);
      expect(early).toBe(earlySentinel); // not yet at the env value
      await vi.advanceTimersByTimeAsync(1); // t=3000 — the env value
      await vi.advanceTimersByTimeAsync(0);
      const lateSentinel = Symbol('env-idle-watchdog-did-not-fire');
      const err = await Promise.race([captured, Promise.resolve(lateSentinel)]);
      expect(err).toMatchObject({
        name: 'StreamInactivityTimeoutError',
        code: 'ETIMEDOUT',
        idleMs: 3000,
        chunksReceived: 0,
      });
      expect((err as Error).message).toContain('QWEN_STREAM_IDLE_TIMEOUT_MS');
      expect(gated.wasReturned()).toBe(true);
    });

    it('does not interrupt a stream whose events keep arriving inside the idle window', async () => {
      const gated = gatedEventStream();
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({
        streamIdleTimeoutMs: 1000,
        streamMaxLifetimeMs: 0,
      });
      const stream = await generator.generateContentStream(streamRequest);
      let done = false;
      let error: unknown;
      const texts: string[] = [];
      const consume = (async () => {
        for await (const chunk of stream) {
          for (const candidate of chunk.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {
              if (part.text) texts.push(part.text);
            }
          }
        }
      })().then(
        () => (done = true),
        (e: unknown) => (error = e),
      );
      gated.push({
        type: 'message_start',
        message: {
          id: 'msg-1',
          model: 'claude-test',
          usage: { input_tokens: 1 },
        },
      });
      gated.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      gated.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hel' },
      });
      await vi.advanceTimersByTimeAsync(500); // < 1000ms idle window
      gated.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      });
      await vi.advanceTimersByTimeAsync(500);
      gated.push({ type: 'content_block_stop', index: 0 });
      gated.push({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      });
      gated.push({ type: 'message_stop' });
      gated.end();
      await vi.advanceTimersByTimeAsync(0);
      await consume;
      expect(error).toBeUndefined();
      expect(done).toBe(true);
      expect(texts).toEqual(['hel', 'lo']);
    });

    it('caps total stream lifetime when thinking deltas keep resetting the idle watchdog', async () => {
      // The issue #9005 finding-4 shape: adaptive thinking emits long runs of
      // `thinking_delta` frames, each resetting an idle-only timer, while the
      // message never completes (the #8597 drip-fed hang). The lifetime cap
      // does not reset.
      const gated = gatedEventStream(); // drip-fed, never ends
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({
        streamIdleTimeoutMs: 1000,
        streamMaxLifetimeMs: 3000,
      });
      const stream = await generator.generateContentStream(streamRequest);
      const captured = consumeUntilSettled(stream);
      gated.push({
        type: 'message_start',
        message: {
          id: 'msg-1',
          model: 'claude-test',
          usage: { input_tokens: 1 },
        },
      });
      await vi.advanceTimersByTimeAsync(500);
      gated.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      });
      await vi.advanceTimersByTimeAsync(500);
      for (let i = 0; i < 4; i++) {
        gated.push({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 't' },
        });
        await vi.advanceTimersByTimeAsync(500); // each drip resets the 1s idle watchdog
      }
      await vi.advanceTimersByTimeAsync(1000); // now past the 3000ms cap
      await vi.advanceTimersByTimeAsync(0);
      const sentinel = Symbol('lifetime-cap-did-not-fire');
      const err = await Promise.race([captured, Promise.resolve(sentinel)]);
      expect(err).toMatchObject({
        name: 'StreamLifetimeExceededError',
        code: 'ETIMEDOUT',
        maxLifetimeMs: 3000,
        chunksReceived: 6,
      });
      expect((err as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
      expect(gated.wasReturned()).toBe(true);
    });

    it('honours QWEN_STREAM_MAX_LIFETIME_MS when no explicit config is set', async () => {
      // Anthropic twin of the OpenAI pipeline.test.ts case: with no explicit
      // `streamMaxLifetimeMs` config field, the constructor must resolve the
      // cap from the deployment env knob. Mutant check: replacing the
      // constructor's `resolveStreamMaxLifetimeMs(contentGeneratorConfig)`
      // with `contentGeneratorConfig.streamMaxLifetimeMs ?? 0` disables the
      // cap and this test fails on the sentinel.
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, '4000');
      const gated = gatedEventStream(); // drip-fed, never ends
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({});
      const stream = await generator.generateContentStream(streamRequest);
      const captured = consumeUntilSettled(stream);
      gated.push({
        type: 'message_start',
        message: {
          id: 'msg-1',
          model: 'claude-test',
          usage: { input_tokens: 1 },
        },
      });
      for (let i = 0; i < 7; i++) {
        gated.push({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 't' },
        });
        await vi.advanceTimersByTimeAsync(500); // each drip resets the idle watchdog
      }
      await vi.advanceTimersByTimeAsync(1000); // t=4500 — past the 4s env cap
      await vi.advanceTimersByTimeAsync(0);
      const sentinel = Symbol('env-lifetime-cap-did-not-fire');
      const err = await Promise.race([captured, Promise.resolve(sentinel)]);
      expect(err).toMatchObject({
        name: 'StreamLifetimeExceededError',
        code: 'ETIMEDOUT',
        maxLifetimeMs: 4000,
      });
      expect((err as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
    });

    it('uses the default lifetime cap when nothing overrides it', async () => {
      // No explicit config, no QWEN_STREAM_* env: the cap must resolve to the
      // shared default. The drips land every 200s — inside the 240s default
      // idle window, so the idle watchdog stays quiet while the lifetime cap
      // accumulates upstream wait up to the 900s default.
      const gated = gatedEventStream(); // drip-fed, never ends
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({});
      const stream = await generator.generateContentStream(streamRequest);
      const captured = consumeUntilSettled(stream);
      gated.push({
        type: 'message_start',
        message: {
          id: 'msg-1',
          model: 'claude-test',
          usage: { input_tokens: 1 },
        },
      });
      for (let i = 0; i < 5; i++) {
        gated.push({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 't' },
        });
        // Inside the 240s default idle window, so only the cap can fire.
        await vi.advanceTimersByTimeAsync(200_000);
      }
      // The cap is reached at t=900s during the last advance; the final drip
      // at t=800s keeps the 240s idle watchdog pending until t=1040s.
      await vi.advanceTimersByTimeAsync(0);
      const sentinel = Symbol('default-lifetime-cap-did-not-fire');
      const err = await Promise.race([captured, Promise.resolve(sentinel)]);
      expect(err).toMatchObject({
        name: 'StreamLifetimeExceededError',
        code: 'ETIMEDOUT',
        maxLifetimeMs: DEFAULT_STREAM_MAX_LIFETIME_MS,
      });
      expect((err as Error).message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
    });

    it('leaves streams unguarded when both timeouts are disabled (<= 0)', async () => {
      const gated = gatedEventStream();
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({
        streamIdleTimeoutMs: 0,
        streamMaxLifetimeMs: 0,
      });
      const stream = await generator.generateContentStream(streamRequest);
      let done = false;
      let error: unknown;
      const consume = (async () => {
        for await (const _chunk of stream) {
          /* drain */
        }
      })().then(
        () => (done = true),
        (e: unknown) => (error = e),
      );
      gated.push({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      // A silence far beyond the default idle timeout — survivable only
      // when the guards are explicitly disabled.
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS + 1000);
      gated.push({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'still here' },
      });
      gated.push({ type: 'content_block_stop', index: 0 });
      gated.push({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      });
      gated.end();
      await vi.advanceTimersByTimeAsync(0);
      await consume;
      expect(error).toBeUndefined();
      expect(done).toBe(true);
    });

    it('propagates a user AbortError (not ETIMEDOUT) when the parent signal is aborted', async () => {
      // Anthropic twin of the OpenAI pipeline.test.ts case. A user Ctrl-C that
      // lands while the idle-watchdog timer is pending must surface as a
      // non-retryable AbortError, not the watchdog's retryable ETIMEDOUT —
      // ETIMEDOUT is in the retryable set, so the retry loop would otherwise
      // resume the turn the user just cancelled. This pins the `parentSignal`
      // argument threaded into `withStreamGuards`: replacing it with
      // `undefined` makes the timer reject with StreamInactivityTimeoutError
      // and this test fail.
      const callerAc = new AbortController();
      const gated = gatedEventStream(); // never pushes → silent
      anthropicState.createImpl.mockResolvedValue(gated.stream);
      const generator = await buildGenerator({
        streamIdleTimeoutMs: 1000,
        streamMaxLifetimeMs: 0,
      });
      const stream = await generator.generateContentStream({
        ...streamRequest,
        config: { abortSignal: callerAc.signal },
      } as unknown as GenerateContentParameters);
      const captured = consumeUntilSettled(stream);
      callerAc.abort();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(0);
      const sentinel = Symbol('user-abort-did-not-propagate');
      const err = await Promise.race([captured, Promise.resolve(sentinel)]);
      expect(err).not.toBe(sentinel);
      expect((err as Error).name).toBe('AbortError');
      expect((err as { code?: string }).code).not.toBe('ETIMEDOUT');
      expect(gated.wasReturned()).toBe(true);
    });
  });

  describe('tool_choice mapping from Gemini toolConfig', () => {
    async function sendWithToolConfig(
      mode: string | undefined,
      hasTools = true,
    ) {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'msg-1',
        model: 'claude-opus-4-6',
        content: [{ type: 'text', text: 'ok' }],
      });
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-opus-4-6',
          apiKey: 'test-key',
          baseUrl: 'https://api.anthropic.com',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

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

      await generator.generateContent({
        model: 'models/ignored',
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
        config: {
          tools,
          ...(mode !== undefined && {
            toolConfig: { functionCallingConfig: { mode } },
          }),
        },
      } as unknown as GenerateContentParameters);

      return anthropicState.lastCreateArgs?.[0] as Record<string, unknown>;
    }

    it('sets tool_choice=any when mode is ANY', async () => {
      const req = await sendWithToolConfig('ANY');
      expect(req['tool_choice']).toEqual({ type: 'any' });
    });

    it('omits tool_choice when mode is NONE (Anthropic has no none type)', async () => {
      const req = await sendWithToolConfig('NONE');
      expect(req['tool_choice']).toBeUndefined();
    });

    it('omits tool_choice when mode is AUTO', async () => {
      const req = await sendWithToolConfig('AUTO');
      expect(req['tool_choice']).toBeUndefined();
    });

    it('omits tool_choice when no toolConfig is set', async () => {
      const req = await sendWithToolConfig(undefined);
      expect(req['tool_choice']).toBeUndefined();
    });

    it('omits tool_choice when there are no tools even with mode ANY', async () => {
      const req = await sendWithToolConfig('ANY', false);
      expect(req['tool_choice']).toBeUndefined();
    });
  });
});
