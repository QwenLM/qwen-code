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
  Protocol,
} from './contentGenerator.js';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator/index.js';

vi.mock('@google/genai');

const openaiMockState = vi.hoisted(() => ({
  importError: null as Error | null,
  generatorError: null as Error | null,
}));

const qwenMockState = vi.hoisted(() => ({
  oauthError: null as Error | null,
}));

vi.mock('./openaiContentGenerator/index.js', () => {
  if (openaiMockState.importError) {
    throw openaiMockState.importError;
  }

  return {
    createOpenAIContentGenerator: () => {
      if (openaiMockState.generatorError) {
        throw openaiMockState.generatorError;
      }
      return {};
    },
  };
});

vi.mock('../qwen/qwenOAuth2.js', () => ({
  getQwenOAuthClient: async () => {
    if (qwenMockState.oauthError) {
      throw qwenMockState.oauthError;
    }
    return {};
  },
}));

vi.mock('../qwen/qwenContentGenerator.js', () => ({
  QwenContentGenerator: class {},
}));

const anthropicMockState = vi.hoisted(() => ({
  createAnthropicContentGenerator: vi.fn().mockReturnValue({}),
}));

vi.mock('./anthropicContentGenerator/index.js', () => ({
  createAnthropicContentGenerator: (...args: unknown[]) =>
    anthropicMockState.createAnthropicContentGenerator(...args),
}));

describe('createContentGenerator', () => {
  it('should create a Gemini content generator', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    const mockGenerator = {
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
        protocol: Protocol.GEMINI,
      },
      mockConfig,
    );
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
    // We expect it to be a LoggingContentGenerator wrapping a GeminiContentGenerator
    expect(generator).toBeInstanceOf(LoggingContentGenerator);
    const wrapped = (generator as LoggingContentGenerator).getWrapped();
    expect(wrapped).toBeDefined();
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
      models: {},
    } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
        protocol: Protocol.GEMINI,
      },
      mockConfig,
    );
    expect(GoogleGenAI).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      vertexai: undefined,
      httpOptions: {
        headers: {
          'User-Agent': expect.any(String),
        },
      },
    });
    expect(generator).toBeInstanceOf(LoggingContentGenerator);
  });

  it('should throw when protocol is missing', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    await expect(
      createContentGenerator(
        { model: 'test-model', apiKey: 'test-key' },
        mockConfig,
      ),
    ).rejects.toThrow('must have a protocol');
  });

  it('should throw for unknown protocol', async () => {
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
          protocol: 'bogus' as Protocol,
        },
        mockConfig,
      ),
    ).rejects.toThrow('Unknown protocol: bogus');
  });

  it('should create an Anthropic content generator', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        authType: AuthType.USE_ANTHROPIC,
        protocol: Protocol.ANTHROPIC,
        baseUrl: 'https://api.anthropic.com',
      },
      mockConfig,
    );

    expect(
      anthropicMockState.createAnthropicContentGenerator,
    ).toHaveBeenCalled();
    expect(generator).toBeInstanceOf(LoggingContentGenerator);
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
    openaiMockState.importError = null;
    openaiMockState.generatorError = null;
    qwenMockState.oauthError = null;
    vi.resetModules();
  });

  it('should throw friendly restart message with cause when dynamic import fails with ERR_MODULE_NOT_FOUND', async () => {
    const moduleError = new Error(
      "Cannot find module './openaiContentGenerator-STALE.js'",
    );
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    openaiMockState.importError = moduleError;

    try {
      await createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          authType: AuthType.USE_OPENAI,
          protocol: Protocol.OPENAI,
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
      expect(err.message).toMatch(/openai/);
      expect(err.cause).toBe(moduleError);
    }
  });

  it('should re-throw non-module errors unchanged', async () => {
    openaiMockState.generatorError = new Error('network timeout');

    await expect(
      createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          authType: AuthType.USE_OPENAI,
          protocol: Protocol.OPENAI,
        },
        mockConfig,
      ),
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
          protocol: Protocol.QWEN_OAUTH,
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
