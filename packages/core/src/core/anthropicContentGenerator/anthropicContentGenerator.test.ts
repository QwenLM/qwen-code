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
        // See the systemInstruction note in the non-streaming sibling
        // test above — the body-scan beta gate needs an actual scope:
        // 'global' field on the wire to fire.
        config: { systemInstruction: 'sys' },
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
      expect(headers['anthropic-beta']).toContain(
        'prompt-caching-scope-2026-01-05',
      );
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
        });
        expect(await thinkingFor('claude-sonnet-4-6')).toEqual({
          type: 'adaptive',
        });
        expect(await thinkingFor('claude-opus-4-7')).toEqual({
          type: 'adaptive',
        });
      });

      it('selects adaptive for claude-haiku-4-6 (haiku family is in scope)', async () => {
        // Single-digit character-class regex would have missed haiku entirely.
        expect(await thinkingFor('claude-haiku-4-6')).toEqual({
          type: 'adaptive',
        });
      });

      it('selects adaptive for two-digit minors like claude-opus-4-10', async () => {
        // Single-digit `[6-9]` would have skipped this and produced an
        // invalid `{ type: 'enabled', budget_tokens: ... }` body.
        expect(await thinkingFor('claude-opus-4-10')).toEqual({
          type: 'adaptive',
        });
      });

      it('selects adaptive for a future major like claude-opus-5-1', async () => {
        expect(await thinkingFor('claude-opus-5-1')).toEqual({
          type: 'adaptive',
        });
      });

      it('keeps the budget_tokens config for older 4.x models (e.g. claude-opus-4-5)', async () => {
        expect(await thinkingFor('claude-opus-4-5')).toEqual({
          type: 'enabled',
          budget_tokens: 32_000,
        });
      });

      it('honors explicit reasoning.budget_tokens before falling back to adaptive', async () => {
        // Explicit budget_tokens is a user escape hatch — adaptive thinking
        // would otherwise silently drop the user-supplied value because the
        // adaptive shape carries no budget field. The explicit branch must
        // run first.
        expect(
          await thinkingFor('claude-opus-4-7', {
            effort: 'medium',
            budget_tokens: 42_000,
          }),
        ).toEqual({ type: 'enabled', budget_tokens: 42_000 });
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
