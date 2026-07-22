/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  AuthType,
} from './contentGenerator.js';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config/config.js';

vi.mock('@google/genai');

const openaiMockState = vi.hoisted(() => ({
  generatorError: null as Error | null,
  createCount: 0,
}));

const qwenMockState = vi.hoisted(() => ({
  oauthError: null as Error | null,
  oauthCount: 0,
  constructorCount: 0,
}));

vi.mock('./openaiContentGenerator/index.js', () => ({
  createOpenAIContentGenerator: () => {
    if (openaiMockState.generatorError) {
      throw openaiMockState.generatorError;
    }
    openaiMockState.createCount += 1;
    return {
      generateContent: async () => ({}),
      generateContentStream: async () =>
        (async function* () {
          yield {};
        })(),
      countTokens: async () => ({ totalTokens: 1 }),
      embedContent: async () => ({ embeddings: [] }),
      useSummarizedThinking: () => false,
    };
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
    constructor() {
      qwenMockState.constructorCount += 1;
    }

    async countTokens() {
      return { totalTokens: 1 };
    }

    useSummarizedThinking() {
      return false;
    }
  },
}));

describe('createContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openaiMockState.generatorError = null;
    openaiMockState.createCount = 0;
    qwenMockState.oauthError = null;
    qwenMockState.oauthCount = 0;
    qwenMockState.constructorCount = 0;
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
        countTokens: vi.fn().mockResolvedValue({ totalTokens: 1 }),
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
    expect(generator.useSummarizedThinking()).toBe(true);

    await generator.countTokens({
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
        countTokens: vi.fn().mockResolvedValue({ totalTokens: 1 }),
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
    await generator.countTokens({
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
    expect(generator.useSummarizedThinking()).toBe(false);
    await Promise.all([
      generator.countTokens({ model: 'test-model', contents: 'one' }),
      generator.countTokens({ model: 'test-model', contents: 'two' }),
    ]);
    expect(openaiMockState.createCount).toBe(1);
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
    expect(generator.useSummarizedThinking()).toBe(false);
    await generator.countTokens({ model: 'test-model', contents: 'hello' });
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
    qwenMockState.oauthError = null;
    qwenMockState.oauthCount = 0;
    qwenMockState.constructorCount = 0;
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
      generator.countTokens({ model: 'test-model', contents: 'hello' }),
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
      await generator.countTokens({ model: 'test-model', contents: 'hello' });
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
