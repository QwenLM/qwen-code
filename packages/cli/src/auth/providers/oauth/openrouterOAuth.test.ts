/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOpenRouterAuthorizationUrl,
  createOpenRouterOAuthSession,
  createOAuthState,
  createPkcePair,
  exchangeAuthCodeForApiKey,
  fetchOpenRouterModels,
  getOpenRouterModelsWithFallback,
  getPreferredOpenRouterModelId,
  mergeOpenRouterConfigs,
  OPENROUTER_DEFAULT_MODELS,
  OPENROUTER_MODELS_URL,
  OPENROUTER_OAUTH_AUTHORIZE_URL,
  OPENROUTER_OAUTH_CALLBACK_PORT,
  OPENROUTER_OAUTH_EXCHANGE_URL,
  runOpenRouterOAuthLogin,
  selectRecommendedOpenRouterModels,
  startOAuthCallbackListener,
  startOAuthCallbackListenerWithRetry,
  type OAuthCallbackListenerWithPort,
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
      state: 'state-123',
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
    expect(parsed.searchParams.get('state')).toBe('state-123');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('limit')).toBe('100');
  });

  it('creates a random OAuth state token', () => {
    const state = createOAuthState();

    expect(state).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(state.length).toBeGreaterThan(20);
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
      'state-123',
    );
    await listener.ready;

    const codePromise = listener.waitForCode;
    await new Promise<void>((resolve, reject) => {
      const req = request(
        'http://localhost:3100/openrouter/callback?code=fast-code-123&state=state-123',
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

  it('rejects callback codes with mismatched OAuth state', async () => {
    const listener = startOAuthCallbackListener(
      'http://localhost:3101/openrouter/callback',
      5000,
      'expected-state',
    );
    await listener.ready;

    const codePromise = listener.waitForCode.catch((error: unknown) => error);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        'http://localhost:3101/openrouter/callback?code=fast-code-123&state=wrong-state',
        (res) => {
          expect(res.statusCode).toBe(400);
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });

    await expect(codePromise).resolves.toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Invalid OAuth state'),
      }),
    );
  }, 15_000);

  it('creates a reusable OAuth session for manual fallback links', () => {
    const session = createOpenRouterOAuthSession(
      'http://localhost:3000/openrouter/callback',
      {
        codeVerifier: 'verifier-123',
        codeChallenge: 'challenge-123',
      },
      'state-123',
    );

    expect(session).toEqual({
      callbackUrl: 'http://localhost:3000/openrouter/callback',
      codeVerifier: 'verifier-123',
      state: 'state-123',
      authorizationUrl: expect.stringContaining('code_challenge=challenge-123'),
    });
    expect(session.authorizationUrl).toContain('state=state-123');
  });

  it('returns OAuth result without waiting for slow listener close', async () => {
    let resolveClose!: () => void;
    const listener: OAuthCallbackListenerWithPort = {
      ready: Promise.resolve(),
      waitForCode: Promise.resolve('auth-code-123'),
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveClose = resolve;
          }),
      ),
      port: OPENROUTER_OAUTH_CALLBACK_PORT,
    };
    const openBrowser = vi.fn(async () => ({}) as never);
    const exchangeApiKey = vi.fn(async () => ({
      apiKey: 'or-key-123',
      userId: 'user-1',
    }));
    const resultPromise = runOpenRouterOAuthLogin(
      'http://localhost:3000/openrouter/callback',
      {
        openBrowser,
        startListener: vi.fn(async () => listener),
        exchangeApiKey,
        now: () => 1000,
      },
    );

    await expect(resultPromise).resolves.toMatchObject({
      apiKey: 'or-key-123',
      userId: 'user-1',
      authorizationUrl: expect.stringContaining('https://openrouter.ai/auth'),
    });
    expect(listener.close).toHaveBeenCalled();
    resolveClose();
  });

  it('passes the session state to the OAuth callback listener', async () => {
    const listener: OAuthCallbackListenerWithPort = {
      ready: Promise.resolve(),
      waitForCode: Promise.resolve('auth-code-123'),
      close: vi.fn(async () => undefined),
      port: OPENROUTER_OAUTH_CALLBACK_PORT,
    };
    const openBrowser = vi.fn(async () => ({}) as never);
    const startListener = vi.fn(async () => listener);
    const exchangeApiKey = vi.fn(async () => ({
      apiKey: 'or-key-123',
      userId: 'user-1',
    }));

    await runOpenRouterOAuthLogin('http://localhost:3000/openrouter/callback', {
      openBrowser,
      startListener,
      exchangeApiKey,
      session: {
        callbackUrl: 'http://localhost:3000/openrouter/callback',
        codeVerifier: 'verifier-123',
        state: 'state-123',
        authorizationUrl:
          'https://openrouter.ai/auth?state=state-123&code_challenge=challenge-123',
      },
    });

    expect(startListener).toHaveBeenCalledWith(
      'http://localhost:3000/openrouter/callback',
      expect.any(Number),
      'state-123',
    );
  });

  it('records wait and exchange timings during OAuth login', async () => {
    const listener: OAuthCallbackListenerWithPort = {
      ready: Promise.resolve(),
      waitForCode: Promise.resolve('auth-code-123'),
      close: vi.fn(async () => undefined),
      port: OPENROUTER_OAUTH_CALLBACK_PORT,
    };
    const openBrowser = vi.fn(async () => ({}) as never);
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
        startListener: async () => listener,
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
      authorizationUrl: expect.stringContaining('https://openrouter.ai/auth'),
      authorizationCodeWaitMs: 1200,
      apiKeyExchangeMs: 450,
    });
    expect(listener.close).toHaveBeenCalled();
  });

  it('allows cancelling OAuth wait with process signals after opening the browser', async () => {
    let sigintHandler: ((signal: NodeJS.Signals) => void) | undefined;
    let sigtermHandler: ((signal: NodeJS.Signals) => void) | undefined;
    const signalTarget = {
      once: vi.fn(
        (
          event: 'SIGINT' | 'SIGTERM',
          handler: (signal: NodeJS.Signals) => void,
        ) => {
          if (event === 'SIGINT') {
            sigintHandler = handler;
          } else {
            sigtermHandler = handler;
          }
        },
      ),
      removeListener: vi.fn(
        (
          _event: 'SIGINT' | 'SIGTERM',
          _handler: (signal: NodeJS.Signals) => void,
        ) => undefined,
      ),
    };
    const listener: OAuthCallbackListenerWithPort = {
      ready: Promise.resolve(),
      waitForCode: new Promise<string>(() => undefined),
      close: vi.fn(async () => undefined),
      port: OPENROUTER_OAUTH_CALLBACK_PORT,
    };
    const openBrowser = vi.fn(async () => ({}) as never);
    const exchangeApiKey = vi.fn();

    const resultPromise = runOpenRouterOAuthLogin(
      'http://localhost:3000/openrouter/callback',
      {
        openBrowser,
        startListener: async () => listener,
        exchangeApiKey,
        signalTarget,
      },
    );

    await vi.waitFor(() => {
      expect(openBrowser).toHaveBeenCalledTimes(1);
      expect(sigintHandler).toBeTypeOf('function');
      expect(sigtermHandler).toBeTypeOf('function');
    });

    sigintHandler?.('SIGINT');

    await expect(resultPromise).rejects.toThrow(
      'OpenRouter OAuth cancelled by user (SIGINT) while waiting for browser authorization.',
    );
    expect(exchangeApiKey).not.toHaveBeenCalled();
    expect(listener.close).toHaveBeenCalled();
    expect(signalTarget.removeListener).toHaveBeenCalledWith(
      'SIGINT',
      sigintHandler,
    );
    expect(signalTarget.removeListener).toHaveBeenCalledWith(
      'SIGTERM',
      sigtermHandler,
    );
  });

  it('allows cancelling OAuth wait with an abort signal', async () => {
    const abortController = new AbortController();
    const listener: OAuthCallbackListenerWithPort = {
      ready: Promise.resolve(),
      waitForCode: new Promise<string>(() => undefined),
      close: vi.fn(async () => undefined),
      port: OPENROUTER_OAUTH_CALLBACK_PORT,
    };
    const openBrowser = vi.fn(async () => ({}) as never);
    const exchangeApiKey = vi.fn();

    const resultPromise = runOpenRouterOAuthLogin(
      'http://localhost:3000/openrouter/callback',
      {
        openBrowser,
        startListener: async () => listener,
        exchangeApiKey,
        abortSignal: abortController.signal,
      },
    );

    await vi.waitFor(() => {
      expect(openBrowser).toHaveBeenCalledTimes(1);
    });

    abortController.abort();

    await expect(resultPromise).rejects.toMatchObject({
      name: 'AbortError',
      message: 'OpenRouter OAuth cancelled.',
    });
    expect(exchangeApiKey).not.toHaveBeenCalled();
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

  it('selects verified free OpenRouter models', () => {
    const recommended = selectRecommendedOpenRouterModels([
      {
        id: 'qwen/qwen3-max',
        name: 'OpenRouter · Qwen3 Max',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'z-ai/glm-4.5-air:free',
        name: 'OpenRouter · GLM 4.5 Air',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'openai/gpt-oss-120b:free',
        name: 'OpenRouter · GPT OSS 120B',
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
        id: 'openai/gpt-5-mini',
        name: 'OpenRouter · GPT-5 Mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
        capabilities: { vision: true },
      },
    ]);

    expect(recommended.map((model) => model.id)).toEqual([
      'z-ai/glm-4.5-air:free',
      'openai/gpt-oss-120b:free',
    ]);
  });

  it('fills missing preferred free OpenRouter models with other free models', () => {
    const recommended = selectRecommendedOpenRouterModels([
      {
        id: 'custom/experimental-free-model:free',
        name: 'OpenRouter · Experimental Free Model',
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
        id: 'z-ai/glm-4.5-air:free',
        name: 'OpenRouter · GLM 4.5 Air',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
    ]);

    expect(recommended.map((model) => model.id)).toEqual([
      'z-ai/glm-4.5-air:free',
      'custom/experimental-free-model:free',
    ]);
  });

  it('prefers the default OpenRouter model when it remains enabled', () => {
    expect(
      getPreferredOpenRouterModelId([
        { id: 'openai/gpt-oss-120b:free' },
        { id: 'z-ai/glm-4.5-air:free' },
      ] as never),
    ).toBe('z-ai/glm-4.5-air:free');
  });

  it('falls back to the first enabled OpenRouter model when the default is unavailable', () => {
    expect(
      getPreferredOpenRouterModelId([
        { id: 'openai/gpt-oss-120b:free' },
      ] as never),
    ).toBe('openai/gpt-oss-120b:free');
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

  it('returns 404 for non-callback paths', async () => {
    const listener = startOAuthCallbackListener(
      'http://localhost:3102/openrouter/callback',
      5000,
      'state-123',
    );
    await listener.ready;

    const status = await new Promise<number>((resolve, reject) => {
      const req = request('http://localhost:3102/wrong-path', (res) => {
        resolve(res.statusCode!);
        res.resume();
      });
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(404);
    await listener.close();
  });

  it('rejects with error when OpenRouter returns an error parameter', async () => {
    const listener = startOAuthCallbackListener(
      'http://localhost:3103/openrouter/callback',
      5000,
      'state-123',
    );
    await listener.ready;

    const codePromise = listener.waitForCode.catch((err: unknown) => err);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        'http://localhost:3103/openrouter/callback?error=access_denied&state=state-123',
        (res) => {
          expect(res.statusCode).toBe(400);
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });

    await expect(codePromise).resolves.toEqual(
      expect.objectContaining({
        message: expect.stringContaining('access_denied'),
      }),
    );
  });

  it('rejects with missing code error', async () => {
    const listener = startOAuthCallbackListener(
      'http://localhost:3104/openrouter/callback',
      5000,
      'state-123',
    );
    await listener.ready;

    const codePromise = listener.waitForCode.catch((err: unknown) => err);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        'http://localhost:3104/openrouter/callback?state=state-123',
        (res) => {
          expect(res.statusCode).toBe(400);
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.end();
    });

    await expect(codePromise).resolves.toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Missing authorization code'),
      }),
    );
  });

  it('retries ports when address is in use', async () => {
    const blockingListener = startOAuthCallbackListener(
      'http://localhost:3150/openrouter/callback',
      10000,
      'block-state',
    );
    await blockingListener.ready;

    try {
      const retried = await startOAuthCallbackListenerWithRetry(
        'http://localhost:3150/openrouter/callback',
        5000,
        'retry-state',
        5,
      );

      expect(retried.port).toBeGreaterThan(3150);
      await retried.close();
    } finally {
      await blockingListener.close();
    }
  });

  it('throws non-http protocol error', () => {
    expect(() =>
      startOAuthCallbackListener(
        'https://localhost:3000/callback',
        5000,
        'state-123',
      ),
    ).toThrow('Only http localhost callback URLs are currently supported.');
  });
});
