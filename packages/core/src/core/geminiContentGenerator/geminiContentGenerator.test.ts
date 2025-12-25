/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GeminiContentGenerator } from './geminiContentGenerator.js';
import { GoogleGenAI } from '@google/genai';

vi.mock('@google/genai', () => {
  const mockGenerateContent = vi.fn();
  const mockGenerateContentStream = vi.fn();
  const mockCountTokens = vi.fn();
  const mockEmbedContent = vi.fn();

  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: mockGenerateContentStream,
        countTokens: mockCountTokens,
        embedContent: mockEmbedContent,
      },
    })),
  };
});

describe('GeminiContentGenerator', () => {
  let generator: GeminiContentGenerator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGoogleGenAI: any;

  beforeEach(() => {
    vi.clearAllMocks();
    generator = new GeminiContentGenerator({
      apiKey: 'test-api-key',
    });
    mockGoogleGenAI = vi.mocked(GoogleGenAI).mock.results[0].value;
  });

  it('should call generateContent on the underlying model', async () => {
    const request = { model: 'gemini-1.5-flash', contents: [] };
    const expectedResponse = { responseId: 'test-id' };
    mockGoogleGenAI.models.generateContent.mockResolvedValue(expectedResponse);

    const response = await generator.generateContent(request, 'prompt-id');

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        ...request,
        config: expect.objectContaining({
          temperature: 1,
          topP: 0.95,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED',
          },
        }),
      }),
    );
    expect(response).toBe(expectedResponse);
  });

  it('should call generateContentStream on the underlying model', async () => {
    const request = { model: 'gemini-1.5-flash', contents: [] };
    const mockStream = (async function* () {
      yield { responseId: '1' };
    })();
    mockGoogleGenAI.models.generateContentStream.mockResolvedValue(mockStream);

    const stream = await generator.generateContentStream(request, 'prompt-id');

    expect(mockGoogleGenAI.models.generateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        ...request,
        config: expect.objectContaining({
          temperature: 1,
          topP: 0.95,
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED',
          },
        }),
      }),
    );
    expect(stream).toBe(mockStream);
  });

  it('should call countTokens on the underlying model', async () => {
    const request = { model: 'gemini-1.5-flash', contents: [] };
    const expectedResponse = { totalTokens: 10 };
    mockGoogleGenAI.models.countTokens.mockResolvedValue(expectedResponse);

    const response = await generator.countTokens(request);

    expect(mockGoogleGenAI.models.countTokens).toHaveBeenCalledWith(request);
    expect(response).toBe(expectedResponse);
  });

  it('should call embedContent on the underlying model', async () => {
    const request = { model: 'embedding-model', contents: [] };
    const expectedResponse = { embeddings: [] };
    mockGoogleGenAI.models.embedContent.mockResolvedValue(expectedResponse);

    const response = await generator.embedContent(request);

    expect(mockGoogleGenAI.models.embedContent).toHaveBeenCalledWith(request);
    expect(response).toBe(expectedResponse);
  });

  it('should prioritize contentGeneratorConfig samplingParams over request config', async () => {
    const generatorWithParams = new GeminiContentGenerator({ apiKey: 'test' }, {
      model: 'gemini-1.5-flash',
      samplingParams: {
        temperature: 0.1,
        top_p: 0.2,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const request = {
      model: 'gemini-1.5-flash',
      contents: [],
      config: {
        temperature: 0.9,
        topP: 0.9,
      },
    };

    await generatorWithParams.generateContent(request, 'prompt-id');

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          temperature: 0.1,
          topP: 0.2,
        }),
      }),
    );
  });

  it('should map reasoning effort to thinkingConfig', async () => {
    const generatorWithReasoning = new GeminiContentGenerator(
      { apiKey: 'test' },
      {
        model: 'gemini-2.5-pro',
        reasoning: {
          effort: 'high',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    const request = {
      model: 'gemini-2.5-pro',
      contents: [],
    };

    await generatorWithReasoning.generateContent(request, 'prompt-id');

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'HIGH',
          },
        }),
      }),
    );
  });
});
