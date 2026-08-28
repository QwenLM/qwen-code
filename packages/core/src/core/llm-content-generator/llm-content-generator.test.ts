/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmContentGenerator } from './llm-content-generator.js';
import { GoogleGenAI } from '@google/genai';

const mockReportLlmRequest = vi.hoisted(() => vi.fn());
const mockReportLlmResponse = vi.hoisted(() => vi.fn());
const mockReportLlmChunk = vi.hoisted(() => vi.fn());

vi.mock('@google/genai', () => {
  const mockGenerateContent = vi.fn();
  const mockGenerateContentStream = vi.fn();
  const mockEmbedContent = vi.fn();

  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: mockGenerateContentStream,
        embedContent: mockEmbedContent,
      },
    })),
  };
});
vi.mock('../../telemetry/gen-ai-request.js', () => ({
  reportLlmRequest: mockReportLlmRequest,
  reportLlmResponse: mockReportLlmResponse,
  reportLlmChunk: mockReportLlmChunk,
}));

describe('LlmContentGenerator', () => {
  let generator: LlmContentGenerator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGoogleGenAI: any;

  beforeEach(() => {
    vi.clearAllMocks();
    generator = new LlmContentGenerator({
      apiKey: 'test-api-key',
    });
    mockGoogleGenAI = vi.mocked(GoogleGenAI).mock.results[0].value;
  });

  it('should merge customHeaders into existing httpOptions.headers', async () => {
    vi.mocked(GoogleGenAI).mockClear();

    void new LlmContentGenerator(
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
    const telemetryAttempt = {};
    mockReportLlmRequest.mockReturnValueOnce(telemetryAttempt);

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
    expect(mockReportLlmRequest).toHaveBeenCalledWith(
      mockGoogleGenAI.models.generateContent.mock.calls[0][0],
    );
    expect(mockReportLlmResponse).toHaveBeenCalledWith(
      telemetryAttempt,
      expectedResponse,
    );
    expect(response).toBe(expectedResponse);
  });

  it('passes ordered multi-part startup reminder content through unchanged', async () => {
    const request = {
      model: 'gemini-1.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { text: '<system-reminder>\ndeferred tools' },
            { text: '<system-reminder>\nstartup context' },
          ],
        },
      ],
    };
    mockGoogleGenAI.models.generateContent.mockResolvedValue({
      responseId: 'test-id',
    });

    await generator.generateContent(request, 'prompt-id');

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: request.contents,
      }),
    );
  });

  it('should call generateContentStream on the underlying model', async () => {
    const request = { model: 'gemini-1.5-flash', contents: [] };
    const mockStream = (async function* () {
      yield { responseId: '1' };
    })();
    mockGoogleGenAI.models.generateContentStream.mockResolvedValue(mockStream);
    const telemetryAttempt = {};
    mockReportLlmRequest.mockReturnValueOnce(telemetryAttempt);

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
    expect(mockReportLlmRequest).toHaveBeenCalledWith(
      mockGoogleGenAI.models.generateContentStream.mock.calls[0][0],
    );
    expect(await stream.next()).toEqual({
      done: false,
      value: { responseId: '1' },
    });
    expect(mockReportLlmChunk).toHaveBeenCalledWith(telemetryAttempt, {
      responseId: '1',
    });
  });

  it('forwards stream return without pre-consuming the SDK stream', async () => {
    const next = vi.fn();
    const close = vi.fn().mockResolvedValue({ done: true, value: undefined });
    const sdkStream = {
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    };
    mockGoogleGenAI.models.generateContentStream.mockResolvedValue(sdkStream);

    const stream = await generator.generateContentStream(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-id',
    );
    await stream.return(undefined);

    expect(next).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('propagates SDK stream errors without reporting a chunk', async () => {
    const failure = new Error('stream failed');
    const next = vi.fn().mockRejectedValue(failure);
    mockGoogleGenAI.models.generateContentStream.mockResolvedValue({
      [Symbol.asyncIterator]: () => ({ next }),
    });

    const stream = await generator.generateContentStream(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-id',
    );

    await expect(stream.next()).rejects.toBe(failure);
    expect(mockReportLlmChunk).not.toHaveBeenCalled();
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
    const generatorWithParams = new LlmContentGenerator({ apiKey: 'test' }, {
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
    const generatorWithReasoning = new LlmContentGenerator({ apiKey: 'test' }, {
      model: 'gemini-2.5-pro',
      reasoning: {
        effort: 'high',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

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

  it("maps reasoning effort 'max' to HIGH (Gemini has no higher tier)", async () => {
    // 'max' is a DeepSeek-specific extension. Gemini caps at HIGH, so the
    // converter must clamp instead of falling through to UNSPECIFIED.
    const generatorWithMax = new LlmContentGenerator({ apiKey: 'test' }, {
      model: 'gemini-2.5-pro',
      reasoning: { effort: 'max' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await generatorWithMax.generateContent(
      { model: 'gemini-2.5-pro', contents: [] },
      'prompt-id',
    );

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

  it("maps reasoning effort 'medium' to MEDIUM", async () => {
    const generatorWithMedium = new LlmContentGenerator({ apiKey: 'test' }, {
      model: 'gemini-2.5-pro',
      reasoning: { effort: 'medium' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await generatorWithMedium.generateContent(
      { model: 'gemini-2.5-pro', contents: [] },
      'prompt-id',
    );

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'MEDIUM',
          },
        }),
      }),
    );
  });

  it("clamps reasoning effort 'xhigh' to HIGH (Gemini has no xhigh tier)", async () => {
    const generatorWithXhigh = new LlmContentGenerator({ apiKey: 'test' }, {
      model: 'gemini-2.5-pro',
      reasoning: { effort: 'xhigh' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await generatorWithXhigh.generateContent(
      { model: 'gemini-2.5-pro', contents: [] },
      'prompt-id',
    );

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

  it("maps provider-specific reasoning effort 'minimal' to MINIMAL", async () => {
    const generatorWithMinimal = new LlmContentGenerator(
      { apiKey: 'test' },
      {
        model: 'gemini-2.5-pro',
        reasoning: { effort: 'minimal' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    await generatorWithMinimal.generateContent(
      { model: 'gemini-2.5-pro', contents: [] },
      'prompt-id',
    );

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'MINIMAL',
          },
        }),
      }),
    );
  });

  it('rejects an unsupported provider-specific reasoning effort', async () => {
    const generatorWithUnknown = new LlmContentGenerator(
      { apiKey: 'test' },
      {
        model: 'gemini-2.5-pro',
        reasoning: { effort: 'vendor.ultra' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    await expect(
      generatorWithUnknown.generateContent(
        { model: 'gemini-2.5-pro', contents: [] },
        'prompt-id',
      ),
    ).rejects.toThrow('Unsupported Gemini reasoning effort: "vendor.ultra"');
    expect(mockGoogleGenAI.models.generateContent).not.toHaveBeenCalled();
  });

  it('honors a request reasoning opt-out before validating the configured effort', async () => {
    const generatorWithUnknown = new LlmContentGenerator(
      { apiKey: 'test' },
      {
        model: 'gemini-2.5-pro',
        reasoning: { effort: 'vendor.ultra' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    await generatorWithUnknown.generateContent(
      {
        model: 'gemini-2.5-pro',
        contents: [],
        config: { thinkingConfig: { includeThoughts: false } },
      },
      'prompt-id',
    );

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledOnce();
    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          thinkingConfig: { includeThoughts: false },
        }),
      }),
    );
  });

  it('keeps validating configured effort when mandatory thinking overrides a request opt-out', async () => {
    const generatorWithUnknown = new LlmContentGenerator(
      { apiKey: 'test' },
      {
        model: 'gemini-2.5-pro',
        reasoning: { effort: 'vendor.ultra' },
        thinkingMandatory: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    await expect(
      generatorWithUnknown.generateContent(
        {
          model: 'gemini-2.5-pro',
          contents: [],
          config: { thinkingConfig: { includeThoughts: false } },
        },
        'prompt-id',
      ),
    ).rejects.toThrow('Unsupported Gemini reasoning effort: "vendor.ultra"');
    expect(mockGoogleGenAI.models.generateContent).not.toHaveBeenCalled();
  });

  it('keeps mandatory thinking enabled across request and config opt-outs', async () => {
    const generatorWithMandatoryThinking = new LlmContentGenerator(
      { apiKey: 'test' },
      {
        model: 'gemini-2.5-pro',
        reasoning: false,
        thinkingMandatory: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    await generatorWithMandatoryThinking.generateContent(
      {
        model: 'gemini-2.5-pro',
        contents: [],
        config: { thinkingConfig: { includeThoughts: false } },
      },
      'prompt-id',
    );

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          thinkingConfig: {
            includeThoughts: true,
            thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED',
          },
        }),
      }),
    );
  });

  it('does not inherit mandatory thinking through a request model override', async () => {
    const generatorWithMandatoryThinking = new LlmContentGenerator(
      { apiKey: 'test' },
      {
        model: 'gemini-2.5-pro',
        reasoning: { effort: 'vendor.ultra' },
        thinkingMandatory: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );

    await generatorWithMandatoryThinking.generateContent(
      {
        model: 'gemini-2.0-flash',
        contents: [],
        config: { thinkingConfig: { includeThoughts: false } },
      },
      'prompt-id',
    );

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-2.0-flash',
        config: expect.objectContaining({
          thinkingConfig: { includeThoughts: false },
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
