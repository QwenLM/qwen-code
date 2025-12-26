/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { createContentGenerator, AuthType } from './contentGenerator.js';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator/index.js';

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
