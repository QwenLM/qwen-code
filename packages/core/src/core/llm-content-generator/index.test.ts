/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLlmContentGenerator } from './index.js';
import { LlmContentGenerator } from './llm-content-generator.js';
import type { Config } from '../../config/config.js';
import { AuthType } from '../contentGenerator.js';

vi.mock('./llm-content-generator.js', () => ({
  LlmContentGenerator: vi.fn().mockImplementation(() => ({})),
}));

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
