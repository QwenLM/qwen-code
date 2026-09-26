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
      getRuntimeEnvironment: () => ({}),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getTelemetryEnabled: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session'),
    } as unknown as Config;
  });

  it('uses Gemini mode and only the supplied environment endpoint', () => {
    mockConfig.getRuntimeEnvironment = () => ({
      GOOGLE_GENAI_USE_VERTEXAI: 'true',
      GOOGLE_GEMINI_BASE_URL: 'https://workspace.example/gemini',
      GOOGLE_CLOUD_PROJECT: 'unrelated-project',
    });
    createLlmContentGenerator(
      {
        model: 'gemini-test',
        apiKey: 'workspace-key',
        authType: AuthType.USE_GEMINI,
      },
      mockConfig,
    );
    expect(LlmContentGenerator).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'workspace-key',
        vertexai: false,
        project: '',
        location: '',
        httpOptions: expect.objectContaining({
          baseUrl: 'https://workspace.example/gemini',
        }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it.each(['global', 'us', 'eu', 'us-central1'])(
    'binds the Vertex ADC project and %s location',
    (location) => {
      mockConfig.getRuntimeEnvironment = () => ({
        GOOGLE_CLOUD_PROJECT: 'workspace-project',
        GOOGLE_CLOUD_LOCATION: location,
        GOOGLE_APPLICATION_CREDENTIALS: '/workspace/credentials.json',
      });
      createLlmContentGenerator(
        { model: 'gemini-test', authType: AuthType.USE_VERTEX_AI },
        mockConfig,
      );
      const baseUrl =
        location === 'global'
          ? 'https://aiplatform.googleapis.com/'
          : location === 'us' || location === 'eu'
            ? `https://aiplatform.${location}.rep.googleapis.com/`
            : `https://${location}-aiplatform.googleapis.com/`;
      expect(LlmContentGenerator).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: undefined,
          vertexai: true,
          project: 'workspace-project',
          location,
          googleAuthOptions: {
            projectId: 'workspace-project',
            keyFilename: '/workspace/credentials.json',
          },
          httpOptions: expect.objectContaining({ baseUrl }),
        }),
        expect.anything(),
        expect.anything(),
      );
    },
  );

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

  it('should use the standard Gemini endpoint when baseUrl is missing', () => {
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
    expect(vi.mocked(LlmContentGenerator).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        httpOptions: expect.objectContaining({
          baseUrl: 'https://generativelanguage.googleapis.com/',
        }),
      }),
    );
  });
});
