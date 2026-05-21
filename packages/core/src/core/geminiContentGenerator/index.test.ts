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

  it('includes X-Qwen-Code-Session-Id in httpOptions.headers when telemetry is enabled', () => {
    mockConfig = {
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getTelemetryEnabled: vi.fn().mockReturnValue(true),
      getSessionId: vi.fn().mockReturnValue('sess-gemini'),
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
