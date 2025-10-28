/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { ContentGenerator } from './contentGenerator.js';
import { createContentGenerator, AuthType } from './contentGenerator.js';
import { createCodeAssistContentGenerator } from '../code_assist/codeAssist.js';
import { GoogleGenAI } from '@google/genai';
import type { Config } from '../config/config.js';
import { LoggingContentGenerator } from './loggingContentGenerator.js';

vi.mock('../code_assist/codeAssist.js');
vi.mock('@google/genai');

const mockConfig = {
  getCliVersion: vi.fn().mockReturnValue('1.0.0'),
} as unknown as Config;

describe('createContentGenerator', () => {
  it('should create a CodeAssistContentGenerator', async () => {
    const mockGenerator = {} as unknown as ContentGenerator;
    vi.mocked(createCodeAssistContentGenerator).mockResolvedValue(
      mockGenerator as never,
    );
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        authType: AuthType.LOGIN_WITH_GOOGLE,
      },
      mockConfig,
    );
    expect(createCodeAssistContentGenerator).toHaveBeenCalled();
    expect(generator).toEqual(
      new LoggingContentGenerator(mockGenerator, mockConfig),
    );
  });

  it('should create a GoogleGenAI content generator', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => true,
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
    expect(generator).toEqual(
      new LoggingContentGenerator(
        (mockGenerator as GoogleGenAI).models,
        mockConfig,
      ),
    );
  });

  it('should create a GoogleGenAI content generator with client install id logging disabled', async () => {
    const mockConfig = {
      getUsageStatisticsEnabled: () => false,
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
    expect(generator).toEqual(
      new LoggingContentGenerator(
        (mockGenerator as GoogleGenAI).models,
        mockConfig,
      ),
    );
  });
});
