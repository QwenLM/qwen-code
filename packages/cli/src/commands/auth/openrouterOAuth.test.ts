/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenRouterAuthorizationUrl,
  createPkcePair,
  exchangeAuthCodeForApiKey,
  fetchOpenRouterModels,
  getOpenRouterModelsWithFallback,
  mergeOpenRouterConfigs,
  OPENROUTER_DEFAULT_MODELS,
  OPENROUTER_MODELS_URL,
  OPENROUTER_OAUTH_AUTHORIZE_URL,
  OPENROUTER_OAUTH_EXCHANGE_URL,
  runOpenRouterOAuthLogin,
  selectRecommendedOpenRouterModels,
  startOAuthCallbackListener,
} from './openrouterOAuth.js';
import { request } from 'node:http';

describe('openrouterOAuth', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates a valid PKCE pair', () => {
    const pkce = createPkcePair();

    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(pkce.codeVerifier.length).toBeGreaterThan(20);
    expect(pkce.codeChallenge.length).toBeGreaterThan(20);
  });

  it('builds OpenRouter authorization URL with required params', () => {
    const url = buildOpenRouterAuthorizationUrl({
      callbackUrl: 'http://localhost:3000/openrouter/callback',
      codeChallenge: 'challenge123',
      codeChallengeMethod: 'S256',
      limit: 100,
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      OPENROUTER_OAUTH_AUTHORIZE_URL,
    );
    expect(parsed.searchParams.get('callback_url')).toBe(
      'http://localhost:3000/openrouter/callback',
    );
    expect(parsed.searchParams.get('code_challenge')).toBe('challenge123');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('limit')).toBe('100');
  });

  it('exchanges auth code for API key', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        key: 'or-key-123',
        user_id: 'user-1',
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exchangeAuthCodeForApiKey({
      code: 'auth-code-123',
      codeVerifier: 'verifier-123',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      OPENROUTER_OAUTH_EXCHANGE_URL,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
      }),
    );
    expect(result).toEqual({
      apiKey: 'or-key-123',
      userId: 'user-1',
    });
    expect(typeof result.apiKey).toBe('string');
  });

  it('throws when exchange response does not contain key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({}),
      })),
    );

    await expect(
      exchangeAuthCodeForApiKey({
        code: 'auth-code-123',
        codeVerifier: 'verifier-123',
      }),
    ).rejects.toThrow('no key was returned');
  });

  it('resolves callback code without waiting for server close completion', async () => {
    const listener = startOAuthCallbackListener(
      'http://localhost:3100/openrouter/callback',
      5000,
    );
    await listener.ready;

    const codePromise = listener.waitForCode;
    await new Promise<void>((resolve, reject) => {
      const req = request(
        'http://localhost:3100/openrouter/callback?code=fast-code-123',
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });

    await expect(codePromise).resolves.toBe('fast-code-123');
  });

  it('returns OAuth result without waiting for slow listener close', async () => {
    let resolveClose!: () => void;
    const listener = {
      ready: Promise.resolve(),
      waitForCode: Promise.resolve('auth-code-123'),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      ),
    };
    const openBrowser = vi.fn(async () => undefined);
    const exchangeApiKey = vi.fn(async () => ({
      apiKey: 'or-key-123',
      userId: 'user-1',
    }));
    const resultPromise = runOpenRouterOAuthLogin(
      'http://localhost:3000/openrouter/callback',
      {
        openBrowser,
        startListener: () => listener,
        exchangeApiKey,
        now: () => 1000,
      },
    );

    await expect(resultPromise).resolves.toMatchObject({
      apiKey: 'or-key-123',
      userId: 'user-1',
    });
    expect(listener.close).toHaveBeenCalled();
    resolveClose();
  });

  it('records wait and exchange timings during OAuth login', async () => {
    const listener = {
      ready: Promise.resolve(),
      waitForCode: Promise.resolve('auth-code-123'),
      close: vi.fn(async () => undefined),
    };
    const openBrowser = vi.fn(async () => undefined);
    const exchangeApiKey = vi.fn(async () => ({
      apiKey: 'or-key-123',
      userId: 'user-1',
    }));
    const now = vi
      .fn<() => number>()
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2200)
      .mockReturnValueOnce(3000)
      .mockReturnValueOnce(3450);

    const result = await runOpenRouterOAuthLogin(
      'http://localhost:3000/openrouter/callback',
      {
        openBrowser,
        startListener: () => listener,
        exchangeApiKey,
        now,
      },
    );

    expect(openBrowser).toHaveBeenCalledWith(
      expect.stringContaining('https://openrouter.ai/auth'),
    );
    expect(exchangeApiKey).toHaveBeenCalledWith({
      code: 'auth-code-123',
      codeVerifier: expect.any(String),
    });
    expect(result).toEqual({
      apiKey: 'or-key-123',
      userId: 'user-1',
      authorizationCodeWaitMs: 1200,
      apiKeyExchangeMs: 450,
    });
    expect(listener.close).toHaveBeenCalled();
  });

  it('fetches dynamic OpenRouter text models with free-first ordering', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'openai/gpt-5-mini',
            name: 'GPT-5 Mini',
            context_length: 128000,
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['text'],
            },
            pricing: {
              prompt: '0.000001',
              completion: '0.000003',
            },
          },
          {
            id: 'minimax/minimax-m1',
            name: 'MiniMax M1',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            pricing: {
              prompt: '0',
              completion: '0',
            },
          },
          {
            id: 'qwen/qwen3-coder:free',
            name: 'Qwen3 Coder',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            pricing: {
              prompt: '0',
              completion: '0',
            },
          },
          {
            id: 'zhipu/glm-4.5',
            name: 'GLM 4.5',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
            pricing: {
              prompt: '0.000002',
              completion: '0.000004',
            },
          },
          {
            id: 'black-forest-labs/flux',
            name: 'Flux',
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['image'],
            },
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchOpenRouterModels();

    expect(fetchMock).toHaveBeenCalledWith(
      OPENROUTER_MODELS_URL,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(models).toEqual([
      {
        id: 'qwen/qwen3-coder:free',
        name: 'OpenRouter · Qwen3 Coder',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'minimax/minimax-m1',
        name: 'OpenRouter · MiniMax M1',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'openai/gpt-5-mini',
        name: 'OpenRouter · GPT-5 Mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
        capabilities: { vision: true },
        generationConfig: { contextWindowSize: 128000 },
      },
      {
        id: 'zhipu/glm-4.5',
        name: 'OpenRouter · GLM 4.5',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
    ]);
  });

  it('selects a recommended OpenRouter subset instead of returning the full catalog', () => {
    const recommended = selectRecommendedOpenRouterModels(
      [
        {
          id: 'qwen/qwen3-coder:free',
          name: 'OpenRouter · Qwen3 Coder',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'qwen/qwen3-max',
          name: 'OpenRouter · Qwen3 Max',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'glm/glm-4.5-air:free',
          name: 'OpenRouter · GLM 4.5 Air',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'minimax/minimax-m1',
          name: 'OpenRouter · MiniMax M1',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'anthropic/claude-3.7-sonnet',
          name: 'OpenRouter · Claude 3.7 Sonnet',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'google/gemini-2.5-flash',
          name: 'OpenRouter · Gemini 2.5 Flash',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'openai/gpt-5-mini',
          name: 'OpenRouter · GPT-5 Mini',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
          capabilities: { vision: true },
        },
        {
          id: 'deepseek/deepseek-r1',
          name: 'OpenRouter · DeepSeek R1',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
          generationConfig: { contextWindowSize: 1048576 },
        },
        {
          id: 'meta/llama-3.3-70b',
          name: 'OpenRouter · Llama 3.3 70B',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
      ],
      6,
    );

    expect(recommended.map((model) => model.id)).toEqual([
      'qwen/qwen3-coder:free',
      'glm/glm-4.5-air:free',
      'qwen/qwen3-max',
      'minimax/minimax-m1',
      'anthropic/claude-3.7-sonnet',
      'google/gemini-2.5-flash',
    ]);
  });

  it('falls back to default models when dynamic fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'server error',
      })),
    );

    await expect(getOpenRouterModelsWithFallback()).resolves.toEqual(
      OPENROUTER_DEFAULT_MODELS,
    );
  });

  it('replaces only existing OpenRouter configs when merging dynamic models', () => {
    const merged = mergeOpenRouterConfigs(
      [
        {
          id: 'old/model',
          name: 'Old OpenRouter Model',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
        {
          id: 'gpt-4.1',
          name: 'OpenAI GPT-4.1',
          baseUrl: 'https://api.openai.com/v1',
          envKey: 'OPENAI_API_KEY',
        },
      ],
      [
        {
          id: 'openai/gpt-5-mini',
          name: 'OpenRouter · GPT-5 Mini',
          baseUrl: 'https://openrouter.ai/api/v1',
          envKey: 'OPENROUTER_API_KEY',
        },
      ],
    );

    expect(merged).toEqual([
      {
        id: 'openai/gpt-5-mini',
        name: 'OpenRouter · GPT-5 Mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'gpt-4.1',
        name: 'OpenAI GPT-4.1',
        baseUrl: 'https://api.openai.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    ]);
  });
});
