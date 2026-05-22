/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGeminiContentGenerator } from './index.js';
import { GeminiContentGenerator } from './geminiContentGenerator.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';

vi.mock('./geminiContentGenerator.js', () => ({
  GeminiContentGenerator: vi.fn().mockImplementation(() => ({})),
}));

describe('createGeminiContentGenerator', () => {
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

  it('should create a GeminiContentGenerator', () => {
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'test-key',
      authType: AuthType.USE_GEMINI,
    };

    const generator = createGeminiContentGenerator(config, mockConfig);

    expect(GeminiContentGenerator).toHaveBeenCalled();
    expect(generator).toBeDefined();
  });

  it('should pass baseUrl through httpOptions when provided', () => {
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'test-key',
      authType: AuthType.USE_GEMINI,
      baseUrl: 'https://proxy.example.com/gemini',
    };

    createGeminiContentGenerator(config, mockConfig);

    expect(GeminiContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.any(String),
          }),
          baseUrl: 'https://proxy.example.com/gemini',
        }),
      }),
      config,
    );
  });

  it('should keep httpOptions unchanged when baseUrl is missing', () => {
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'test-key',
      authType: AuthType.USE_GEMINI,
    };

    createGeminiContentGenerator(config, mockConfig);

    expect(GeminiContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.any(String),
          }),
        }),
      }),
      config,
    );
    expect(vi.mocked(GeminiContentGenerator).mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: expect.any(String),
        }),
      }),
    );
  });

  it('omits X-Qwen-Code-Session-Id from httpOptions.headers when telemetry is disabled', () => {
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'k',
      authType: AuthType.USE_GEMINI,
    };
    createGeminiContentGenerator(config, mockConfig);
    const callArgs = vi.mocked(GeminiContentGenerator).mock.calls[0]?.[0] as
      | { httpOptions?: { headers?: Record<string, string> } }
      | undefined;
    expect(callArgs?.httpOptions?.headers).toBeDefined();
    expect(callArgs?.httpOptions?.headers ?? {}).not.toHaveProperty(
      'X-Qwen-Code-Session-Id',
    );
  });

  it('omits X-Qwen-Code-Session-Id for vanilla Gemini endpoint even when telemetry is enabled (third-party scope)', () => {
    // PR #4390 review (LaZzyMan): the session id header is scoped to
    // first-party (Alibaba/DashScope) destinations by default. A vanilla
    // Gemini API call resolves to `generativelanguage.googleapis.com`,
    // which is NOT on the default allowlist, so no header.
    mockConfig = {
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getTelemetryEnabled: vi.fn().mockReturnValue(true),
      getSessionId: vi.fn().mockReturnValue('sess-gemini'),
      getTelemetrySessionIdHeaderHosts: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'k',
      authType: AuthType.USE_GEMINI,
    };
    createGeminiContentGenerator(config, mockConfig);
    const callArgs = vi.mocked(GeminiContentGenerator).mock.calls[0]?.[0] as {
      httpOptions: { headers: Record<string, string> };
    };
    expect(callArgs.httpOptions.headers).not.toHaveProperty(
      'X-Qwen-Code-Session-Id',
    );
  });

  it('includes X-Qwen-Code-Session-Id when baseUrl points at a trusted DashScope endpoint', () => {
    mockConfig = {
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getTelemetryEnabled: vi.fn().mockReturnValue(true),
      getSessionId: vi.fn().mockReturnValue('sess-gemini'),
      getTelemetrySessionIdHeaderHosts: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;
    const config = {
      model: 'qwen-vl-plus',
      apiKey: 'k',
      authType: AuthType.USE_GEMINI,
      // Operator has pointed the Gemini SDK at a DashScope-compatible
      // endpoint via baseUrl override. This IS on the default allowlist.
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    };
    createGeminiContentGenerator(config, mockConfig);
    const callArgs = vi.mocked(GeminiContentGenerator).mock.calls[0]?.[0] as {
      httpOptions: { headers: Record<string, string> };
    };
    expect(callArgs.httpOptions.headers['X-Qwen-Code-Session-Id']).toBe(
      'sess-gemini',
    );
  });

  it('includes X-Qwen-Code-Session-Id when allowlist override covers googleapis.com', () => {
    // Operator opts back in for Google's endpoint via settings override.
    mockConfig = {
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getTelemetryEnabled: vi.fn().mockReturnValue(true),
      getSessionId: vi.fn().mockReturnValue('sess-gemini'),
      getTelemetrySessionIdHeaderHosts: vi
        .fn()
        .mockReturnValue(['*.googleapis.com']),
    } as unknown as Config;
    const config = {
      model: 'gemini-1.5-flash',
      apiKey: 'k',
      authType: AuthType.USE_GEMINI,
    };
    createGeminiContentGenerator(config, mockConfig);
    const callArgs = vi.mocked(GeminiContentGenerator).mock.calls[0]?.[0] as {
      httpOptions: { headers: Record<string, string> };
    };
    expect(callArgs.httpOptions.headers['X-Qwen-Code-Session-Id']).toBe(
      'sess-gemini',
    );
  });
});
