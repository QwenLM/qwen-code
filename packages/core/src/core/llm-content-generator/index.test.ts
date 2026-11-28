/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLlmContentGenerator, normalizeGeminiBaseUrl } from './index.js';
import { LlmContentGenerator } from './llm-content-generator.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';

vi.mock('./llm-content-generator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./llm-content-generator.js')>();
  return {
    ...actual,
    LlmContentGenerator: vi.fn().mockImplementation(() => ({})),
  };
});

describe('createLlmContentGenerator', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getTelemetryEnabled: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
    } as unknown as Config;
  });

  it('should create a LlmContentGenerator', () => {
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'test-key',
      authType: AuthType.USE_GEMINI,
    };

    const generator = createLlmContentGenerator(config, mockConfig);

    expect(LlmContentGenerator).toHaveBeenCalled();
    expect(generator).toBeDefined();
  });

  it.each([
    [AuthType.USE_GEMINI, undefined, false],
    [AuthType.USE_GEMINI, true, false],
    [AuthType.USE_VERTEX_AI, false, true],
  ])(
    'uses %s for an isolated route regardless of vertexai=%s',
    (authType, vertexai, expected) => {
      const config = {
        model: 'test-model',
        authType,
        vertexai,
        isolatedRoute: true,
      };
      createLlmContentGenerator(config, mockConfig);
      expect(LlmContentGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ vertexai: expected }),
        config,
        mockConfig,
      );
    },
  );

  it('should pass baseUrl through httpOptions when provided', () => {
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'test-key',
      authType: AuthType.USE_GEMINI,
      baseUrl: 'https://proxy.example.com/gemini',
    };

    createLlmContentGenerator(config, mockConfig);

    expect(LlmContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.any(String),
          }),
          baseUrl: 'https://proxy.example.com/gemini',
        }),
      }),
      config,
      mockConfig,
    );
  });

  it('strips trailing /v1beta (Gemini) or /v1beta1 (Vertex) from baseUrl and omits SDK httpOptions.timeout', () => {
    expect(
      normalizeGeminiBaseUrl('  https://proxy.example.com/gateway/V1BETA///  '),
    ).toBe('https://proxy.example.com/gateway');
    expect(
      normalizeGeminiBaseUrl(
        'https://proxy.example.com/gateway/v1beta/V1BETA///',
      ),
    ).toBe('https://proxy.example.com/gateway');
    expect(
      normalizeGeminiBaseUrl('https://proxy.example.com/gateway/v1beta1/'),
    ).toBe('https://proxy.example.com/gateway/v1beta1');
    expect(
      normalizeGeminiBaseUrl(
        'https://proxy.example.com/vertex/v1beta1/V1BETA1///',
        true,
      ),
    ).toBe('https://proxy.example.com/vertex');
    expect(
      normalizeGeminiBaseUrl('https://proxy.example.com/vertex/v1beta/', true),
    ).toBe('https://proxy.example.com/vertex/v1beta');

    const config = {
      model: 'gemini-2.5-flash',
      apiKey: 'test-key',
      authType: AuthType.USE_GEMINI,
      baseUrl: 'https://proxy.example.com/gateway/v1beta',
      timeout: 600_000,
    };
    createLlmContentGenerator(config, mockConfig);

    const passedHttpOptions =
      vi.mocked(LlmContentGenerator).mock.calls[0]?.[0]?.httpOptions;
    expect(passedHttpOptions?.baseUrl).toBe(
      'https://proxy.example.com/gateway',
    );
    expect(passedHttpOptions).not.toHaveProperty('timeout');

    createLlmContentGenerator(
      {
        model: 'gemini-2.5-flash',
        apiKey: 'test-key',
        authType: AuthType.USE_VERTEX_AI,
        baseUrl: 'https://proxy.example.com/vertex/v1beta1/',
      },
      mockConfig,
    );
    const vertexHttpOptions =
      vi.mocked(LlmContentGenerator).mock.calls[1]?.[0]?.httpOptions;
    expect(vertexHttpOptions?.baseUrl).toBe('https://proxy.example.com/vertex');
  });

  it('should keep httpOptions unchanged when baseUrl is missing', () => {
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'test-key',
      authType: AuthType.USE_GEMINI,
    };

    createLlmContentGenerator(config, mockConfig);

    expect(LlmContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.any(String),
          }),
        }),
      }),
      config,
      mockConfig,
    );
    expect(vi.mocked(LlmContentGenerator).mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: expect.any(String),
        }),
      }),
    );
  });
});
