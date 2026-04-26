/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  AuthType,
} from './contentGenerator.js';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator/index.js';
import { RateLimitedContentGenerator } from './rateLimitedContentGenerator.js';

vi.mock('@google/genai');

describe('createContentGenerator', () => {
  it('should create a Gemini content generator', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
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
});

describe('createContentGenerator request concurrency wrapping (#3409)', () => {
  const baseMockConfig = {
    getUsageStatisticsEnabled: () => false,
    getContentGeneratorConfig: () => ({}),
    getCliVersion: () => '1.0.0',
  } as unknown as Config;

  const buildGoogleGenAIMock = () => {
    const mockGenerator = { models: {} } as unknown as GoogleGenAI;
    vi.mocked(GoogleGenAI).mockImplementation(() => mockGenerator as never);
  };

  const originalEnv = process.env['QWEN_REQUEST_CONCURRENCY'];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['QWEN_REQUEST_CONCURRENCY'];
    } else {
      process.env['QWEN_REQUEST_CONCURRENCY'] = originalEnv;
    }
  });

  it('does not wrap with rate-limiter when no concurrency is configured', async () => {
    buildGoogleGenAIMock();
    delete process.env['QWEN_REQUEST_CONCURRENCY'];
    const generator = (await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      baseMockConfig,
    )) as LoggingContentGenerator;
    expect(generator.getWrapped()).not.toBeInstanceOf(
      RateLimitedContentGenerator,
    );
  });

  it('wraps with RateLimitedContentGenerator when requestConcurrency is set', async () => {
    buildGoogleGenAIMock();
    delete process.env['QWEN_REQUEST_CONCURRENCY'];
    const generator = (await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
        requestConcurrency: 4,
      },
      baseMockConfig,
    )) as LoggingContentGenerator;
    const wrapped = generator.getWrapped();
    expect(wrapped).toBeInstanceOf(RateLimitedContentGenerator);
    const limiter = (wrapped as RateLimitedContentGenerator).getLimiter();
    expect(limiter.limit).toBe(4);
  });

  it('falls back to QWEN_REQUEST_CONCURRENCY env var when config is unset', async () => {
    buildGoogleGenAIMock();
    process.env['QWEN_REQUEST_CONCURRENCY'] = '6';
    const generator = (await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      baseMockConfig,
    )) as LoggingContentGenerator;
    const wrapped = generator.getWrapped();
    expect(wrapped).toBeInstanceOf(RateLimitedContentGenerator);
    expect((wrapped as RateLimitedContentGenerator).getLimiter().limit).toBe(6);
  });

  it('config value wins over the env var', async () => {
    buildGoogleGenAIMock();
    process.env['QWEN_REQUEST_CONCURRENCY'] = '6';
    const generator = (await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
        requestConcurrency: 2,
      },
      baseMockConfig,
    )) as LoggingContentGenerator;
    const wrapped = generator.getWrapped();
    expect(wrapped).toBeInstanceOf(RateLimitedContentGenerator);
    expect((wrapped as RateLimitedContentGenerator).getLimiter().limit).toBe(2);
  });

  it.each([
    ['0', 0],
    ['-1', 0],
    ['nope', 0],
    ['  ', 0],
  ])('treats env var %s as unlimited', async (envVal, _expected) => {
    buildGoogleGenAIMock();
    process.env['QWEN_REQUEST_CONCURRENCY'] = envVal;
    const generator = (await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
      },
      baseMockConfig,
    )) as LoggingContentGenerator;
    expect(generator.getWrapped()).not.toBeInstanceOf(
      RateLimitedContentGenerator,
    );
  });

  it('floors fractional config values', async () => {
    buildGoogleGenAIMock();
    delete process.env['QWEN_REQUEST_CONCURRENCY'];
    const generator = (await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-api-key',
        authType: AuthType.USE_GEMINI,
        requestConcurrency: 3.7,
      },
      baseMockConfig,
    )) as LoggingContentGenerator;
    const wrapped = generator.getWrapped() as RateLimitedContentGenerator;
    expect(wrapped.getLimiter().limit).toBe(3);
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
