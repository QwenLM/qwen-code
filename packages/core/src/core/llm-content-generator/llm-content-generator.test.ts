/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LlmContentGenerator } from './llm-content-generator.js';
import { GoogleGenAI } from '@google/genai';
import type { Part } from '@google/genai';
import type { Config } from '../../config/config.js';

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

  it('adds the current session ID to Routify Gemini requests', async () => {
    const getSessionId = vi.fn().mockReturnValue('session-1');
    const cliConfig = {
      getSessionId,
      getOutboundAllowDynamicHeaderValues: () => true,
    } as unknown as Config;
    const sessionGenerator = new LlmContentGenerator(
      {
        apiKey: 'test-api-key',
        httpOptions: {
          baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
        },
      },
      {
        model: 'gemini-1.5-flash',
        baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
        customHeaders: { session_id: 'custom-${session_id}' },
      },
      cliConfig,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.generateContent.mockResolvedValue({});

    await sessionGenerator.generateContent(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-1',
    );
    getSessionId.mockReturnValue('session-2');
    await sessionGenerator.generateContent(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-2',
    );

    expect(
      googleGenAI.models.generateContent.mock.calls[0][0].config.httpOptions
        .headers,
    ).toEqual({ session_id: 'session-1' });
    expect(
      googleGenAI.models.generateContent.mock.calls[1][0].config.httpOptions
        .headers,
    ).toEqual({ session_id: 'session-2' });
  });

  it('warns when Gemini dynamic headers are disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      void new LlmContentGenerator(
        { apiKey: 'test-api-key' },
        {
          model: 'gemini-1.5-flash',
          customHeaders: { 'X-Gemini-Session': '${session_id}' },
        },
        {
          getOutboundAllowDynamicHeaderValues: () => false,
        } as unknown as Config,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('X-Gemini-Session'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('expands Gemini dynamic headers without a base URL', async () => {
    const sessionGenerator = new LlmContentGenerator(
      { apiKey: 'test-api-key' },
      {
        model: 'gemini-1.5-flash',
        customHeaders: { 'X-Gemini-Session': '${session_id}' },
      },
      {
        getSessionId: () => 'session-1',
        getOutboundAllowDynamicHeaderValues: () => true,
      } as unknown as Config,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.generateContent.mockResolvedValue({});

    await sessionGenerator.generateContent(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-1',
    );

    expect(
      googleGenAI.models.generateContent.mock.calls[0][0].config.httpOptions
        .headers,
    ).toEqual({ 'X-Gemini-Session': 'session-1' });
  });

  it('uses the constructor base URL for Gemini session ID injection', async () => {
    const cliConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
    } as unknown as Config;
    const sessionGenerator = new LlmContentGenerator(
      {
        apiKey: 'test-api-key',
        httpOptions: {
          baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
        },
      },
      undefined,
      cliConfig,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.generateContent.mockResolvedValue({});

    await sessionGenerator.generateContent(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-1',
    );

    expect(
      googleGenAI.models.generateContent.mock.calls[0][0].config.httpOptions
        .headers,
    ).toEqual({ session_id: 'session-1' });
  });

  it('does not use a fallback base URL over the constructor destination', async () => {
    const cliConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
    } as unknown as Config;
    const sessionGenerator = new LlmContentGenerator(
      {
        apiKey: 'test-api-key',
        httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com' },
      },
      {
        model: 'gemini-1.5-flash',
        baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
      },
      cliConfig,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.generateContent.mockResolvedValue({});

    await sessionGenerator.generateContent(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-1',
    );

    expect(
      googleGenAI.models.generateContent.mock.calls[0][0].config.httpOptions,
    ).toBeUndefined();
  });

  it('uses a non-Routify request destination over a Routify constructor destination', async () => {
    const cliConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
    } as unknown as Config;
    const sessionGenerator = new LlmContentGenerator(
      {
        apiKey: 'test-api-key',
        httpOptions: {
          baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
        },
      },
      undefined,
      cliConfig,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.generateContent.mockResolvedValue({});

    await sessionGenerator.generateContent(
      {
        model: 'gemini-1.5-flash',
        contents: [],
        config: {
          httpOptions: {
            baseUrl: 'https://generativelanguage.googleapis.com',
            headers: { 'X-Request': 'request-value' },
          },
        },
      },
      'prompt-1',
    );

    expect(
      googleGenAI.models.generateContent.mock.calls[0][0].config.httpOptions,
    ).toEqual({
      baseUrl: 'https://generativelanguage.googleapis.com',
      headers: { 'X-Request': 'request-value' },
    });
  });

  it('injects alongside request headers for a request-level Routify destination', async () => {
    const cliConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
    } as unknown as Config;
    const sessionGenerator = new LlmContentGenerator(
      {
        apiKey: 'test-api-key',
        httpOptions: { baseUrl: 'https://generativelanguage.googleapis.com' },
      },
      undefined,
      cliConfig,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.generateContent.mockResolvedValue({});

    await sessionGenerator.generateContent(
      {
        model: 'gemini-1.5-flash',
        contents: [],
        config: {
          httpOptions: {
            baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
            headers: { 'X-Request': 'request-value' },
          },
        },
      },
      'prompt-1',
    );

    expect(
      googleGenAI.models.generateContent.mock.calls[0][0].config.httpOptions,
    ).toEqual({
      baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
      headers: {
        'X-Request': 'request-value',
        session_id: 'session-1',
      },
    });
  });

  it('does not infer the SDK destination from content generator config', async () => {
    const cliConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
    } as unknown as Config;
    const sessionGenerator = new LlmContentGenerator(
      { apiKey: 'test-api-key' },
      {
        model: 'gemini-1.5-flash',
        baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
      },
      cliConfig,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.generateContent.mockResolvedValue({});

    await sessionGenerator.generateContent(
      { model: 'gemini-1.5-flash', contents: [] },
      'prompt-1',
    );

    expect(
      googleGenAI.models.generateContent.mock.calls[0][0].config.httpOptions,
    ).toBeUndefined();
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

  it('adds the current session ID to Routify embedding requests', async () => {
    const cliConfig = {
      getSessionId: vi.fn().mockReturnValue('session-1'),
    } as unknown as Config;
    const sessionGenerator = new LlmContentGenerator(
      {
        apiKey: 'test-api-key',
        httpOptions: {
          baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
        },
      },
      {
        model: 'embedding-model',
        baseUrl: 'https://routify-pub.alibaba-inc.com/protocol/vertex',
      },
      cliConfig,
    );
    const googleGenAI = vi.mocked(GoogleGenAI).mock.results.at(-1)?.value;
    googleGenAI.models.embedContent.mockResolvedValue({ embeddings: [] });

    await sessionGenerator.embedContent({
      model: 'embedding-model',
      contents: [],
    });

    expect(
      googleGenAI.models.embedContent.mock.calls[0][0].config.httpOptions
        .headers,
    ).toEqual({ session_id: 'session-1' });
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

  it.each([
    [1000000, 4096, 4096],
    [2048, 4096, 2048],
    [undefined, 4096, 4096],
    [2048, undefined, 2048],
  ])(
    'respects both configured and request output ceilings (%s, %s)',
    async (configured, requested, expected) => {
      const limited = new LlmContentGenerator(
        { apiKey: 'test' },
        { model: 'gemini-test', samplingParams: { max_tokens: configured } },
      );
      await limited.generateContent(
        {
          model: 'gemini-test',
          contents: [],
          config: { maxOutputTokens: requested },
        },
        'prompt-id',
      );
      expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ maxOutputTokens: expected }),
        }),
      );
    },
  );

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

  it('strips partMetadata from reattach parts before the Vertex request is built', async () => {
    // `vertexai: true` routes through the same `stripPartFields` path as the
    // Gemini Developer API route, but the Vertex request builder rejects
    // `partMetadata` unconditionally. The reattach boundary (issue #11627)
    // must not crash the Vertex route, so the marker is dropped before the
    // SDK builds the payload.
    const vertexGenerator = new LlmContentGenerator({
      apiKey: 'test-api-key',
      vertexai: true,
    });

    const request = {
      model: 'gemini-1.5-flash',
      contents: [
        {
          role: 'user' as const,
          parts: [
            {
              text: 'Recent images reattached',
              partMetadata: { 'qwen-code:reattach-boundary': true },
            },
            {
              inlineData: { mimeType: 'image/png', data: 'base64data' },
            },
          ],
        },
      ],
    };

    mockGoogleGenAI.models.generateContent.mockResolvedValue({});

    await vertexGenerator.generateContent(request, 'prompt-id');

    const calledWith = mockGoogleGenAI.models.generateContent.mock.calls[0][0];
    expect(calledWith.contents[0].parts[0].partMetadata).toBeUndefined();
    expect(calledWith.contents[0].parts[1].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'base64data',
    });
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

  // https://github.com/QwenLM/qwen-code/issues/9453
  //
  // The OpenAI Responses generator stashes an opaque reasoning-replay payload
  // in the shared `Part.thoughtSignature` field. That payload is only
  // meaningful to the Responses API, so after a provider switch it must not
  // travel on the Gemini wire as if it were a Gemini-native signature — while
  // the visible reasoning summary and `thought: true` marker are kept.
  describe('cross-provider reasoning replay metadata', () => {
    const responsesReplaySignature = JSON.stringify({
      id: 'rs_68c6c0c9ff5c8191a29b2e78c1a40c83',
      encrypted_content: 'gAAAAABvcmVhc29uaW5nLXJlcGxheS1wYXlsb2Fk',
    });

    // A Gemini-native thoughtSignature is an opaque token: it never starts
    // with '{' and never parses as the Responses replay payload shape.
    const geminiNativeSignature =
      'Ck0BShsIxKq3wOa2tgUQ5LK0BhjOqrfA5ra2BRABGAIiQB9Z7xKq3wOa2tgU';

    const buildRequest = (thoughtSignature: string) => ({
      model: 'gemini-2.5-pro',
      contents: [
        { role: 'user' as const, parts: [{ text: 'First' }] },
        {
          role: 'model' as const,
          parts: [
            { text: 'Reasoning summary', thought: true, thoughtSignature },
            { text: 'Visible answer' },
          ],
        },
        { role: 'user' as const, parts: [{ text: 'Second' }] },
      ],
    });

    it('preserves a native Gemini thoughtSignature', async () => {
      await generator.generateContent(
        buildRequest(geminiNativeSignature),
        'prompt-id',
      );

      const calledWith =
        mockGoogleGenAI.models.generateContent.mock.calls[0][0];
      const thoughtPart = calledWith.contents[1].parts[0];

      expect(thoughtPart.thoughtSignature).toBe(geminiNativeSignature);
      expect(thoughtPart.thought).toBe(true);
      expect(thoughtPart.text).toBe('Reasoning summary');
    });

    it('strips a Responses replay payload but keeps the visible reasoning text', async () => {
      await generator.generateContent(
        buildRequest(responsesReplaySignature),
        'prompt-id',
      );

      const calledWith =
        mockGoogleGenAI.models.generateContent.mock.calls[0][0];
      const thoughtPart = calledWith.contents[1].parts[0];

      expect(thoughtPart.thoughtSignature).toBeUndefined();
      expect(thoughtPart.thought).toBe(true);
      expect(thoughtPart.text).toBe('Reasoning summary');
      expect(calledWith.contents[1].parts[1].text).toBe('Visible answer');
    });

    it('does not mutate the caller-owned history part', async () => {
      // Hold the part by identity rather than re-deriving it from the request,
      // so this asserts the caller's own object was not touched.
      const historyPart: Part = {
        text: 'Reasoning summary',
        thought: true,
        thoughtSignature: responsesReplaySignature,
      };

      await generator.generateContent(
        {
          model: 'gemini-2.5-pro',
          contents: [
            { role: 'user', parts: [{ text: 'First' }] },
            { role: 'model', parts: [historyPart, { text: 'Visible answer' }] },
            { role: 'user', parts: [{ text: 'Second' }] },
          ],
        },
        'prompt-id',
      );

      // The strip is wire-only: persisted history keeps the payload so a
      // later switch back to the Responses API can still replay it.
      expect(historyPart.thoughtSignature).toBe(responsesReplaySignature);
    });

    it('forwards a non-string thoughtSignature without throwing', async () => {
      // The SDK types thoughtSignature as string, but the value crosses untyped
      // boundaries — persisted-history restore performs no Part shape validation —
      // so treat a non-string as a native opaque token rather than throwing.
      const nonStringSignature = 1 as unknown as string;

      await generator.generateContent(
        {
          model: 'gemini-2.5-pro',
          contents: [
            { role: 'user' as const, parts: [{ text: 'First' }] },
            {
              role: 'model' as const,
              parts: [
                {
                  text: 'Reasoning summary',
                  thought: true,
                  thoughtSignature: nonStringSignature,
                },
                { text: 'Visible answer' },
              ],
            },
            { role: 'user' as const, parts: [{ text: 'Second' }] },
          ],
        },
        'prompt-id',
      );

      const calledWith =
        mockGoogleGenAI.models.generateContent.mock.calls[0][0];
      const thoughtPart = calledWith.contents[1].parts[0];

      // The garbage is forwarded unchanged (base behavior): the recognizer
      // only drops the Responses replay payload shape, never crashes.
      expect(thoughtPart.thoughtSignature).toBe(nonStringSignature);
      expect(thoughtPart.thought).toBe(true);
      expect(thoughtPart.text).toBe('Reasoning summary');
    });
  });
});
