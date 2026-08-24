/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  AuthType,
  preloadContentGenerator,
  resetPreloadedContentGenerator,
  validateModelConfig,
} from './contentGenerator.js';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from './contentGenerator.js';

vi.mock('@google/genai');

const openaiMockState = vi.hoisted(() => ({
  generatorError: null as Error | null,
  createCount: 0,
  constructionGates: [] as Array<Promise<void> | undefined>,
  deferredErrors: [] as Array<Error | undefined>,
}));

const qwenMockState = vi.hoisted(() => ({
  oauthError: null as Error | null,
  oauthCount: 0,
  constructorCount: 0,
  constructorModels: [] as Array<string | undefined>,
}));

const openaiLoggerMockState = vi.hoisted(() => ({
  constructorCalls: [] as Array<{
    customLogDir: string | undefined;
    cwd: string | undefined;
  }>,
}));

vi.mock('./openaiContentGenerator/index.js', () => ({
  createOpenAIContentGenerator: () => {
    if (openaiMockState.generatorError) {
      throw openaiMockState.generatorError;
    }
    const attempt = openaiMockState.createCount;
    openaiMockState.createCount += 1;
    const createGenerator = () => ({
      generateContent: async () => ({}),
      generateContentStream: async () =>
        (async function* () {
          yield {};
        })(),
      embedContent: async () => ({ embeddings: [] }),
    });
    const gate = openaiMockState.constructionGates[attempt];
    if (!gate) {
      return createGenerator();
    }
    return gate.then(() => {
      const error = openaiMockState.deferredErrors[attempt];
      if (error) throw error;
      return createGenerator();
    });
  },
}));

vi.mock('../qwen/qwenOAuth2.js', () => ({
  getQwenOAuthClient: async () => {
    qwenMockState.oauthCount += 1;
    if (qwenMockState.oauthError) {
      throw qwenMockState.oauthError;
    }
    return {};
  },
}));

vi.mock('../qwen/qwenContentGenerator.js', () => ({
  QwenContentGenerator: class {
    constructor(_client: unknown, generatorConfig: { model?: string }) {
      qwenMockState.constructorCount += 1;
      qwenMockState.constructorModels.push(generatorConfig.model);
    }

    async embedContent() {
      return { embeddings: [] };
    }
  },
}));

vi.mock('../utils/openaiLogger.js', () => ({
  OpenAILogger: class {
    constructor(customLogDir?: string, cwd?: string) {
      openaiLoggerMockState.constructorCalls.push({ customLogDir, cwd });
    }
  },
}));

describe('createContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openaiMockState.generatorError = null;
    openaiMockState.createCount = 0;
    openaiMockState.constructionGates = [];
    openaiMockState.deferredErrors = [];
    qwenMockState.oauthError = null;
    qwenMockState.oauthCount = 0;
    qwenMockState.constructorCount = 0;
    qwenMockState.constructorModels = [];
    openaiLoggerMockState.constructorCalls = [];
  });

  it('should defer Gemini content generator creation until first use', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    const mockGenerator = {
      models: {
        embedContent: vi.fn().mockResolvedValue({ embeddings: [] }),
      },
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      mockConfig,
    );
    expect(GoogleGenAI).not.toHaveBeenCalled();

    await generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });

    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: undefined,
      httpOptions: {
        headers: {
          'User-Agent': expect.any(String),
          'x-gemini-api-privileged-user-id': expect.any(String),
        },
      },
    });
  });

  it('should create a Gemini content generator with client install id logging disabled', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const mockGenerator = {
      models: {
        embedContent: vi.fn().mockResolvedValue({ embeddings: [] }),
      },
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      mockConfig,
    );
    expect(GoogleGenAI).not.toHaveBeenCalled();
    await generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: undefined,
      httpOptions: {
        headers: {
          'User-Agent': expect.any(String),
        },
      },
    });
  });

  it('loads a provider once across concurrent first calls', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    expect(openaiMockState.createCount).toBe(0);
    await Promise.all([
      generator.embedContent({ model: 'test-model', contents: 'one' }),
      generator.embedContent({ model: 'test-model', contents: 'two' }),
    ]);
    expect(openaiMockState.createCount).toBe(1);
  });

  it('does not preload non-lazy content generators', async () => {
    const generator: ContentGenerator = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn(),
    };

    await expect(preloadContentGenerator(generator)).resolves.toBeUndefined();
    resetPreloadedContentGenerator(generator);
    expect(generator.generateContent).not.toHaveBeenCalled();
    expect(generator.generateContentStream).not.toHaveBeenCalled();
    expect(generator.embedContent).not.toHaveBeenCalled();
  });

  it('loads a provider once across concurrent preload and first use', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    await Promise.all([
      preloadContentGenerator(generator),
      generator.embedContent({ model: 'test-model', contents: 'hello' }),
    ]);

    expect(openaiMockState.createCount).toBe(1);
  });

  it('discards an unused preload after session configuration changes', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    await preloadContentGenerator(generator);
    resetPreloadedContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });

    expect(openaiMockState.createCount).toBe(2);
  });

  it('does not discard a generator that has already been used', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    await preloadContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'first',
    });
    resetPreloadedContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'second',
    });

    expect(openaiMockState.createCount).toBe(1);
  });

  it('does not discard an in-flight preload after real use begins', async () => {
    let releaseConstruction: () => void = () => undefined;
    openaiMockState.constructionGates = [
      new Promise<void>((resolve) => {
        releaseConstruction = resolve;
      }),
    ];
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    const preload = preloadContentGenerator(generator);
    await vi.waitFor(() => expect(openaiMockState.createCount).toBe(1));
    const firstUse = generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });
    resetPreloadedContentGenerator(generator);
    releaseConstruction();

    await expect(preload).resolves.toBeUndefined();
    await expect(firstUse).resolves.toEqual({ embeddings: [] });
    expect(openaiMockState.createCount).toBe(1);
  });

  it('isolates a reset in-flight preload from the replacement first use', async () => {
    let releasePreload: () => void = () => undefined;
    let releaseFirstUse: () => void = () => undefined;
    const preloadError = new Error('discarded preload failed');
    openaiMockState.constructionGates = [
      new Promise<void>((resolve) => {
        releasePreload = resolve;
      }),
      new Promise<void>((resolve) => {
        releaseFirstUse = resolve;
      }),
    ];
    openaiMockState.deferredErrors = [preloadError];
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    const discardedPreload = preloadContentGenerator(generator).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(openaiMockState.createCount).toBe(1));
    resetPreloadedContentGenerator(generator);
    const firstUse = generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });
    await vi.waitFor(() => expect(openaiMockState.createCount).toBe(2));

    releaseFirstUse();
    await expect(firstUse).resolves.toEqual({ embeddings: [] });
    releasePreload();
    await expect(discardedPreload).resolves.toBe(preloadError);
    await expect(
      generator.embedContent({
        model: 'test-model',
        contents: 'still uses the replacement',
      }),
    ).resolves.toEqual({ embeddings: [] });
    expect(openaiMockState.createCount).toBe(2);
  });

  it('rebuilds a preloaded Qwen generator from a hot-switched config', async () => {
    const generatorConfig: ContentGeneratorConfig = {
      model: 'qwen3-coder-flash',
      authType: AuthType.QWEN_OAUTH,
    };
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => generatorConfig,
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(generatorConfig, mockConfig);

    await preloadContentGenerator(generator);
    generatorConfig.model = 'coder-model';
    resetPreloadedContentGenerator(generator);
    await generator.embedContent({
      model: 'coder-model',
      contents: 'hello',
    });

    expect(qwenMockState.constructorModels).toEqual([
      'qwen3-coder-flash',
      'coder-model',
    ]);
  });

  it('rebuilds OpenAI logging with the relocated working directory', async () => {
    let workingDir = '/workspace/before';
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
      getWorkingDir: () => workingDir,
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
        enableOpenAILogging: true,
        openAILoggingDir: 'logs',
      },
      mockConfig,
    );

    await preloadContentGenerator(generator);
    workingDir = '/workspace/after';
    resetPreloadedContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });

    expect(openaiLoggerMockState.constructorCalls).toEqual([
      { customLogDir: 'logs', cwd: '/workspace/before' },
      { customLogDir: 'logs', cwd: '/workspace/after' },
    ]);
  });

  it('memoizes preload rejection for the first use', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const moduleError = new Error(
      "Cannot find module './openaiContentGenerator-STALE.js'",
    );
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    openaiMockState.generatorError = moduleError;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    const preloadError = await preloadContentGenerator(generator).catch(
      (error: unknown) => error,
    );
    const firstUseError = await generator
      .embedContent({ model: 'test-model', contents: 'hello' })
      .catch((error: unknown) => error);

    expect(preloadError).toBeInstanceOf(Error);
    expect(firstUseError).toBe(preloadError);
    expect((preloadError as Error).cause).toBe(moduleError);
  });

  it('checks Qwen credentials before deferring provider creation', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        authType: AuthType.QWEN_OAUTH,
      },
      mockConfig,
      true,
    );

    expect(qwenMockState.oauthCount).toBe(1);
    expect(qwenMockState.constructorCount).toBe(0);
    await generator.embedContent({ model: 'test-model', contents: 'hello' });
    expect(qwenMockState.constructorCount).toBe(1);
  });

  it('rejects Qwen credential failures before returning a lazy generator', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    qwenMockState.oauthError = new Error('cached credentials are missing');

    await expect(
      createContentGenerator(
        {
          model: 'test-model',
          authType: AuthType.QWEN_OAUTH,
        },
        mockConfig,
        true,
      ),
    ).rejects.toThrow('cached credentials are missing');
    expect(qwenMockState.oauthCount).toBe(1);
    expect(qwenMockState.constructorCount).toBe(0);
  });

  it('should throw when the config has no authType', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    await expect(
      createContentGenerator(
        { model: 'test-model', apiKey: 'test-key' } as Parameters<
          typeof createContentGenerator
        >[0],
        mockConfig,
      ),
    ).rejects.toThrow('must have an authType');
  });

  it('should throw on an unsupported authType', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    await expect(
      createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          authType: 'bogus',
        } as unknown as Parameters<typeof createContentGenerator>[0],
        mockConfig,
      ),
    ).rejects.toThrow('Unsupported authType');
  });
});

describe('createContentGenerator - ERR_MODULE_NOT_FOUND handling', () => {
  const mockConfig = {
    getUsageStatisticsEnabled: () => true,
    getContentGeneratorConfig: () => ({}),
    getCliVersion: () => '1.0.0',
    getTelemetryEnabled: () => false,
    getSessionId: () => 'test-session',
  } as unknown as Config;

  beforeEach(() => {
    openaiMockState.generatorError = null;
    openaiMockState.createCount = 0;
    openaiMockState.constructionGates = [];
    openaiMockState.deferredErrors = [];
    qwenMockState.oauthError = null;
    qwenMockState.oauthCount = 0;
    qwenMockState.constructorCount = 0;
    qwenMockState.constructorModels = [];
    openaiLoggerMockState.constructorCalls = [];
    vi.resetModules();
  });

  it('should re-throw non-module errors unchanged', async () => {
    openaiMockState.generatorError = new Error('network timeout');

    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );
    await expect(
      generator.embedContent({ model: 'test-model', contents: 'hello' }),
    ).rejects.toThrow('network timeout');
  });

  it('should preserve module-not-found errors from QWEN OAuth setup', async () => {
    const moduleError = new Error("Cannot find module '../qwen/stale.js'");
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    qwenMockState.oauthError = moduleError;

    try {
      await createContentGenerator(
        {
          model: 'test-model',
          authType: AuthType.QWEN_OAUTH,
        },
        mockConfig,
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const err = error as Error;
      expect(err.message).toMatch(
        /updated in the background and needs to be restarted/,
      );
      expect(err.message).toMatch(/qwen-oauth/);
      expect(err.cause).toBe(moduleError);
    }
  });

  it('should throw friendly restart message with cause when dynamic import fails with ERR_MODULE_NOT_FOUND', async () => {
    const moduleError = new Error(
      "Cannot find module './openaiContentGenerator-STALE.js'",
    );
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    vi.doMock('./openaiContentGenerator/index.js', () => {
      throw moduleError;
    });
    const { createContentGenerator: createWithMissingProvider } = await import(
      './contentGenerator.js'
    );

    try {
      const generator = await createWithMissingProvider(
        {
          model: 'test-model',
          apiKey: 'test-key',
          authType: AuthType.USE_OPENAI,
        },
        mockConfig,
      );
      await generator.embedContent({ model: 'test-model', contents: 'hello' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const err = error as Error;
      expect(err.message).toMatch(
        /updated in the background and needs to be restarted/,
      );
      expect(err.message).toMatch(/openai/);
      expect(err.cause).toBe(moduleError);
    }
  });
});

describe('createContentGeneratorConfig', () => {
  const mockConfig = {
    getProxy: () => undefined,
  } as unknown as Config;

  it('should preserve provided fields and set authType for QWEN_OAUTH', () => {
    const cfg = createContentGeneratorConfig(mockConfig, AuthType.QWEN_OAUTH, {
      model: 'coder-model',
      apiKey: 'QWEN_OAUTH_DYNAMIC_TOKEN',
    });
    expect(cfg.authType).toBe(AuthType.QWEN_OAUTH);
    expect(cfg.model).toBe('coder-model');
    expect(cfg.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
  });

  it('should not warn or fallback for QWEN_OAUTH (resolution handled by ModelConfigResolver)', () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const cfg = createContentGeneratorConfig(mockConfig, AuthType.QWEN_OAUTH, {
      model: 'some-random-model',
    });
    expect(cfg.model).toBe('some-random-model');
    expect(cfg.apiKey).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('validateModelConfig - Vertex AI Application Default Credentials', () => {
  const vertexConfig = {
    authType: AuthType.USE_VERTEX_AI,
    model: 'gemini-2.5-pro',
  } as ContentGeneratorConfig;

  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a keyless Vertex config when a project is configured', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'my-project');

    expect(validateModelConfig(vertexConfig).valid).toBe(true);
    expect(validateModelConfig(vertexConfig, true).valid).toBe(true);
  });

  it('still requires credentials for Vertex when no project is configured', () => {
    const result = validateModelConfig(vertexConfig);

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('GOOGLE_API_KEY');
    expect(result.errors[0].message).toContain('GOOGLE_CLOUD_PROJECT');
  });

  it('builds the client in Vertex mode from the auth type alone', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'my-project');
    // Deliberately unset: the mode must not depend on the side effect that
    // only the CLI pre-flight check writes.
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', '');
    vi.mocked(GoogleGenAI).mockClear();
    vi.mocked(GoogleGenAI).mockImplementation(
      () =>
        ({
          models: {
            embedContent: vi.fn().mockResolvedValue({ embeddings: [] }),
          },
        }) as unknown as GoogleGenAI,
    );

    const generator = await createContentGenerator(
      { model: 'gemini-2.5-pro', authType: AuthType.USE_VERTEX_AI },
      {
        getUsageStatisticsEnabled: () => false,
        getContentGeneratorConfig: () => ({}),
        getCliVersion: () => '1.0.0',
        getTelemetryEnabled: () => false,
        getSessionId: () => 'test-session',
      } as unknown as Config,
    );
    await generator.embedContent({
      model: 'gemini-2.5-pro',
      contents: 'hello',
    });

    expect(GoogleGenAI).toHaveBeenCalledWith(
      expect.objectContaining({ vertexai: true, apiKey: undefined }),
    );
  });

  it('keeps the strict error pointing at the keyless alternative', () => {
    const result = validateModelConfig(vertexConfig, true);

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('GOOGLE_CLOUD_PROJECT');
  });

  it('does not extend the keyless path to the Gemini API auth type', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'my-project');

    const result = validateModelConfig({
      authType: AuthType.USE_GEMINI,
      model: 'gemini-2.5-pro',
    } as ContentGeneratorConfig);

    expect(result.valid).toBe(false);
    // The keyless hint is Vertex-specific: recommending a project to a Gemini
    // API user is the misleading-placeholder advice it exists to prevent.
    expect(result.errors[0].message).not.toContain('GOOGLE_CLOUD_PROJECT');
  });

  it('keeps failing on the declared key variable when the entry has an envKey', () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'my-project');

    const withEnvKey = {
      ...vertexConfig,
      apiKeyEnvKey: 'MY_VERTEX_KEY',
    } as ContentGeneratorConfig;

    expect(validateModelConfig(withEnvKey).valid).toBe(false);
    expect(validateModelConfig(withEnvKey).errors[0].message).toContain(
      'MY_VERTEX_KEY',
    );
    // Such an entry never takes the ADC path, so the keyless hint must not
    // appear: it would be advice that cannot work.
    expect(validateModelConfig(withEnvKey).errors[0].message).not.toContain(
      'GOOGLE_CLOUD_PROJECT',
    );
    expect(validateModelConfig(withEnvKey, true).valid).toBe(false);
    expect(
      validateModelConfig(withEnvKey, true).errors[0].message,
    ).not.toContain('GOOGLE_CLOUD_PROJECT');
  });
});
