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

  it('should merge customHeaders into existing httpOptions.headers', async () => {
    vi.mocked(GoogleGenAI).mockClear();

    void new GeminiContentGenerator(
      {
        apiKey: 'test-api-key',
        httpOptions: {
          headers: {
            'X-Base': 'base',
            'X-Override': 'base',
          },
        },
      },
      {
        customHeaders: {
          'X-Custom': 'custom',
          'X-Override': 'custom',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    expect(vi.mocked(GoogleGenAI)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(GoogleGenAI)).toHaveBeenCalledWith({
      apiKey: 'test-api-key',
      httpOptions: {
        headers: {
          'X-Base': 'base',
          'X-Custom': 'custom',
          'X-Override': 'custom',
        },
      },
    });
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

  it('should strip displayName from inlineData and fileData before sending to API', async () => {
    const request = {
      model: 'gemini-1.5-flash',
      contents: [
        {
          role: 'user' as const,
          parts: [
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'base64data',
                displayName: 'image.png',
              },
            },
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: 'base64pdfdata',
                displayName: 'document.pdf',
              },
            },
            {
              fileData: {
                mimeType: 'application/pdf',
                fileUri: 'gs://bucket/file.pdf',
                displayName: 'document.pdf',
              },
            },
          ],
        },
      ],
    };

    await generator.generateContent(request, 'prompt-id');

    const calledWith = mockGoogleGenAI.models.generateContent.mock.calls[0][0];

    // Verify displayName is stripped from inlineData
    expect(calledWith.contents[0].parts[0].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'base64data',
    });
    expect(
      calledWith.contents[0].parts[0].inlineData.displayName,
    ).toBeUndefined();

    expect(calledWith.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'application/pdf',
      data: 'base64pdfdata',
    });
    expect(
      calledWith.contents[0].parts[1].inlineData.displayName,
    ).toBeUndefined();

    // Verify displayName is stripped from fileData
    expect(calledWith.contents[0].parts[2].fileData).toEqual({
      mimeType: 'application/pdf',
      fileUri: 'gs://bucket/file.pdf',
    });
    expect(
      calledWith.contents[0].parts[2].fileData.displayName,
    ).toBeUndefined();
  });

  it('should strip displayName from functionResponse parts', async () => {
    const request = {
      model: 'gemini-1.5-flash',
      contents: [
        {
          role: 'user' as const,
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'Read',
                response: { output: 'content' },
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: 'base64data',
                      displayName: 'screenshot.png',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await generator.generateContent(request, 'prompt-id');

    const calledWith = mockGoogleGenAI.models.generateContent.mock.calls[0][0];
    const functionResponseParts =
      calledWith.contents[0].parts[0].functionResponse.parts;

    // Verify displayName is stripped from nested inlineData
    expect(functionResponseParts[0].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'base64data',
    });
    expect(functionResponseParts[0].inlineData.displayName).toBeUndefined();
  });

  it('should convert audio and video to text in functionResponse parts', async () => {
    const request = {
      model: 'gemini-1.5-flash',
      contents: [
        {
          role: 'user' as const,
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'Read',
                response: { output: 'content' },
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: 'imagedata',
                    },
                  },
                  {
                    inlineData: {
                      mimeType: 'audio/wav',
                      data: 'audiodata',
                      displayName: 'recording.wav',
                    },
                  },
                  {
                    inlineData: {
                      mimeType: 'video/mp4',
                      data: 'videodata',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await generator.generateContent(request, 'prompt-id');

    const calledWith = mockGoogleGenAI.models.generateContent.mock.calls[0][0];
    const functionResponseParts =
      calledWith.contents[0].parts[0].functionResponse.parts;

    // All parts should remain, but audio/video converted to text
    expect(functionResponseParts).toHaveLength(3);
    expect(functionResponseParts[0].inlineData.mimeType).toBe('image/png');
    expect(functionResponseParts[1].text).toBe(
      'Unsupported media type for Gemini: audio/wav (recording.wav).',
    );
    expect(functionResponseParts[2].text).toBe(
      'Unsupported media type for Gemini: video/mp4.',
    );
  });
});
