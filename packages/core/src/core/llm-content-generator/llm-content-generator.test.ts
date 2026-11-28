/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getEventListeners } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import {
  LlmContentGenerator,
  supportsGeminiFunctionResponseAudioVideo,
} from './llm-content-generator.js';
import {
  StreamInactivityTimeoutError,
  StreamLifetimeExceededError,
} from '../stream-guards.js';
import { observeRequestDispatch } from '../loggingContentGenerator/request-dispatch.js';
import { GoogleGenAI } from '@google/genai';
import type { GenerateContentConfig, Part } from '@google/genai';
import type { Config } from '../../config/config.js';
import type { AuthType, ContentGeneratorConfig } from '../contentGenerator.js';
import {
  content,
  streamOf,
  userText,
} from '../../test-utils/model-fixtures.js';

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

const ROUTIFY = 'https://routify-pub.alibaba-inc.com/protocol/vertex';
const GOOGLE_API = 'https://generativelanguage.googleapis.com';
const DEFAULT_SENT_CONFIG = {
  temperature: 1,
  topP: 0.95,
  thinkingConfig: {
    includeThoughts: true,
    thinkingLevel: 'THINKING_LEVEL_UNSPECIFIED',
  },
};

const flashReq = (config?: GenerateContentConfig) => ({
  model: 'gemini-1.5-flash',
  contents: [],
  ...(config && { config }),
});
const userReq = (...parts: Part[]) => ({
  model: 'gemini-1.5-flash',
  contents: [content('user', ...parts)],
});
const session1 = () =>
  ({ getSessionId: vi.fn().mockReturnValue('session-1') }) as unknown as Config;
const withCg = (cg: object) =>
  new LlmContentGenerator({ apiKey: 'test' }, cg as ContentGeneratorConfig);

// Builds a generator on a fresh SDK instance and returns that instance's models.
function build(sdk: object, cg?: ContentGeneratorConfig, cli?: Config) {
  const gen = new LlmContentGenerator(
    { apiKey: 'test-api-key', ...sdk },
    cg,
    cli,
  );
  return {
    gen,
    models: vi.mocked(GoogleGenAI).mock.results.at(-1)?.value.models,
  };
}

// Sends one flash request through a fresh generator whose SDK resolves to {}
// and returns the httpOptions the SDK received.
async function sentHttpOptions(
  sdk: object,
  cg: ContentGeneratorConfig | undefined,
  cli: Config,
  requestConfig?: GenerateContentConfig,
) {
  const { gen, models } = build(sdk, cg, cli);
  models.generateContent.mockResolvedValue({});
  await gen.generateContent(flashReq(requestConfig), 'prompt-1');
  return models.generateContent.mock.calls[0][0].config.httpOptions;
}

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

  const sent = () => mockGoogleGenAI.models.generateContent.mock.calls[0][0];
  const expectSentConfig = (config: object) =>
    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ config: expect.objectContaining(config) }),
    );
  // The SDK method got the request plus default sampling/thinking config, and
  // that exact payload was reported as the telemetry request.
  function expectDefaultsSent(method: Mock, request: object) {
    expect(method).toHaveBeenCalledWith(
      expect.objectContaining({
        ...request,
        config: expect.objectContaining(DEFAULT_SENT_CONFIG),
      }),
    );
    expect(mockReportLlmRequest).toHaveBeenCalledWith(method.mock.calls[0][0]);
  }

  it.each([false, true])(
    'uses the declared Gemini default while respecting request opt-out=%s',
    async (off) => {
      const config = {
        getResolvedModelConfig: vi.fn().mockReturnValue({
          capabilities: {
            reasoning: {
              profile: 'gemini',
              efforts: ['low', 'medium', 'high'],
              defaultEffort: 'medium',
            },
          },
        }),
      } as unknown as Config;
      const configured = new LlmContentGenerator(
        { apiKey: 'dummy' },
        { model: 'company-alias', authType: 'gemini' as AuthType },
        config,
      );
      const optOut = () => ({ includeThoughts: false, thinkingBudget: 0 });
      await configured.generateContent(
        {
          model: 'company-alias',
          contents: [],
          ...(off ? { config: { thinkingConfig: optOut() } } : {}),
        },
        'prompt',
      );
      expectSentConfig({
        thinkingConfig: off
          ? optOut()
          : { includeThoughts: true, thinkingLevel: 'MEDIUM' },
      });
    },
  );

  it.each([
    [
      'uses the built-in Gemini 4 Neon default',
      'gemini-4-neon',
      undefined,
      'HIGH',
    ],
    [
      'honors an explicit Gemini 4 Neon low tier',
      'gemini-4-neon',
      { effort: 'low' } as const,
      'LOW',
    ],
    [
      'honors an explicit Gemini 4 Neon medium tier',
      'gemini-4-neon',
      { effort: 'medium' } as const,
      'MEDIUM',
    ],
    [
      'honors an explicit Gemini 4 Neon xhigh tier',
      'gemini-4-neon',
      { effort: 'xhigh' } as const,
      'XHIGH',
    ],
    [
      'clamps a persisted legacy Gemini 4 Neon max tier to xhigh',
      'gemini-4-neon',
      { effort: 'max' } as const,
      'XHIGH',
    ],
    [
      'honors an explicit Gemini 4 Hydrogen xhigh tier',
      'gemini-4-hydrogen-xhigh',
      { effort: 'xhigh' } as const,
      'XHIGH',
    ],
    [
      'clamps Gemini 4 Argon xhigh to HIGH',
      'gemini-4-argon-high',
      { effort: 'xhigh' } as const,
      'HIGH',
    ],
    [
      'clamps Gemini 4 Argon max to HIGH',
      'gemini-4-argon-high',
      { effort: 'max' } as const,
      'HIGH',
    ],
  ])('%s', async (_title, model, reasoning, thinkingLevel) => {
    const config = {
      getResolvedModelConfig: vi.fn().mockReturnValue({}),
    } as unknown as Config;
    const builtIn = new LlmContentGenerator(
      { apiKey: 'dummy' },
      { model, authType: 'gemini' as AuthType, reasoning },
      config,
    );
    await builtIn.generateContent({ model, contents: [] }, 'prompt');
    expectSentConfig({
      thinkingConfig: { includeThoughts: true, thinkingLevel },
    });
  });

  it('honors explicit capabilities.reasoning xhigh on a custom alias and narrower overrides on Neon', async () => {
    const xhighAliasConfig = {
      getResolvedModelConfig: vi.fn().mockReturnValue({
        capabilities: {
          reasoning: {
            profile: 'gemini',
            efforts: ['low', 'medium', 'high', 'xhigh'],
            defaultEffort: 'high',
          },
        },
      }),
    } as unknown as Config;
    const aliasGen = new LlmContentGenerator(
      { apiKey: 'dummy' },
      {
        model: 'company-alias',
        authType: 'gemini' as AuthType,
        reasoning: { effort: 'xhigh' },
      },
      xhighAliasConfig,
    );
    await aliasGen.generateContent(
      { model: 'company-alias', contents: [] },
      'prompt',
    );
    expectSentConfig({
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'XHIGH' },
    });

    const narrowNeonConfig = {
      getResolvedModelConfig: vi.fn().mockReturnValue({
        capabilities: {
          reasoning: {
            profile: 'gemini',
            efforts: ['low', 'medium', 'high'],
            defaultEffort: 'high',
          },
        },
      }),
    } as unknown as Config;
    const narrowGen = new LlmContentGenerator(
      { apiKey: 'dummy' },
      {
        model: 'gemini-4-neon',
        authType: 'gemini' as AuthType,
        reasoning: { effort: 'xhigh' },
      },
      narrowNeonConfig,
    );
    await narrowGen.generateContent(
      { model: 'gemini-4-neon', contents: [] },
      'prompt',
    );
    expectSentConfig({
      thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
    });
  });

  it('does not override thinking off on a built-in Gemini 4 route', async () => {
    const config = {
      getResolvedModelConfig: vi.fn().mockReturnValue({}),
    } as unknown as Config;
    const builtIn = new LlmContentGenerator(
      { apiKey: 'dummy' },
      {
        model: 'gemini-4-neon',
        authType: 'gemini' as AuthType,
        reasoning: false,
      },
      config,
    );
    const requestOptOut = () => ({ includeThoughts: false, thinkingBudget: 0 });
    await builtIn.generateContent(
      { model: 'gemini-4-neon', contents: [] },
      'prompt',
    );
    expectSentConfig({ thinkingConfig: { includeThoughts: false } });
    await builtIn.generateContent(
      {
        model: 'gemini-4-neon',
        contents: [],
        config: { thinkingConfig: requestOptOut() },
      },
      'prompt',
    );
    expectSentConfig({ thinkingConfig: requestOptOut() });
  });

  it('should merge customHeaders into existing httpOptions.headers', async () => {
    vi.mocked(GoogleGenAI).mockClear();
    const headers = { 'X-Base': 'base', 'X-Override': 'base' };
    const customHeaders = { 'X-Custom': 'custom', 'X-Override': 'custom' };
    build({ httpOptions: { headers } }, {
      customHeaders,
    } as unknown as ContentGeneratorConfig);

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
    const request = flashReq();
    const expectedResponse = { responseId: 'test-id' };
    mockGoogleGenAI.models.generateContent.mockResolvedValue(expectedResponse);
    const telemetryAttempt = {};
    mockReportLlmRequest.mockReturnValueOnce(telemetryAttempt);

    const response = await generator.generateContent(request, 'prompt-id');

    expectDefaultsSent(mockGoogleGenAI.models.generateContent, request);
    expect(mockReportLlmResponse).toHaveBeenCalledWith(
      telemetryAttempt,
      expectedResponse,
    );
    expect(response).toBe(expectedResponse);
  });

  it('adds the current session ID to Routify Gemini requests', async () => {
    const getSessionId = vi.fn().mockReturnValue('session-1');
    const { gen, models } = build(
      { httpOptions: { baseUrl: ROUTIFY } },
      {
        model: 'gemini-1.5-flash',
        baseUrl: ROUTIFY,
        customHeaders: { session_id: 'custom-${session_id}' },
      },
      {
        getSessionId,
        getOutboundAllowDynamicHeaderValues: () => true,
      } as unknown as Config,
    );
    models.generateContent.mockResolvedValue({});

    await gen.generateContent(flashReq(), 'prompt-1');
    getSessionId.mockReturnValue('session-2');
    await gen.generateContent(flashReq(), 'prompt-2');

    const headers = (i: number) =>
      models.generateContent.mock.calls[i][0].config.httpOptions.headers;
    expect(headers(0)).toEqual({ session_id: 'session-1' });
    expect(headers(1)).toEqual({ session_id: 'session-2' });
  });

  it('warns when Gemini dynamic headers are disabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      build(
        {},
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
    const httpOptions = await sentHttpOptions(
      {},
      {
        model: 'gemini-1.5-flash',
        customHeaders: { 'X-Gemini-Session': '${session_id}' },
      },
      {
        getSessionId: () => 'session-1',
        getOutboundAllowDynamicHeaderValues: () => true,
      } as unknown as Config,
    );
    expect(httpOptions.headers).toEqual({ 'X-Gemini-Session': 'session-1' });
  });

  it('uses the constructor base URL for Gemini session ID injection', async () => {
    const httpOptions = await sentHttpOptions(
      { httpOptions: { baseUrl: ROUTIFY } },
      undefined,
      session1(),
    );
    expect(httpOptions.headers).toEqual({ session_id: 'session-1' });
  });

  it('does not use a fallback base URL over the constructor destination', async () => {
    const httpOptions = await sentHttpOptions(
      { httpOptions: { baseUrl: GOOGLE_API } },
      { model: 'gemini-1.5-flash', baseUrl: ROUTIFY },
      session1(),
    );
    expect(httpOptions).toBeUndefined();
  });

  it('uses a non-Routify request destination over a Routify constructor destination', async () => {
    const httpOptions = await sentHttpOptions(
      { httpOptions: { baseUrl: ROUTIFY } },
      undefined,
      session1(),
      {
        httpOptions: {
          baseUrl: GOOGLE_API,
          headers: { 'X-Request': 'request-value' },
        },
      },
    );
    expect(httpOptions).toEqual({
      baseUrl: GOOGLE_API,
      headers: { 'X-Request': 'request-value' },
    });
  });

  it('injects alongside request headers for a request-level Routify destination', async () => {
    const httpOptions = await sentHttpOptions(
      { httpOptions: { baseUrl: GOOGLE_API } },
      undefined,
      session1(),
      {
        httpOptions: {
          baseUrl: ROUTIFY,
          headers: { 'X-Request': 'request-value' },
        },
      },
    );
    expect(httpOptions).toEqual({
      baseUrl: ROUTIFY,
      headers: { 'X-Request': 'request-value', session_id: 'session-1' },
    });
  });

  it('does not infer the SDK destination from content generator config', async () => {
    const httpOptions = await sentHttpOptions(
      {},
      { model: 'gemini-1.5-flash', baseUrl: ROUTIFY },
      session1(),
    );
    expect(httpOptions).toBeUndefined();
  });

  it('passes ordered multi-part startup reminder content through unchanged', async () => {
    const request = userReq(
      { text: '<system-reminder>\ndeferred tools' },
      { text: '<system-reminder>\nstartup context' },
    );
    mockGoogleGenAI.models.generateContent.mockResolvedValue({
      responseId: 'test-id',
    });

    await generator.generateContent(request, 'prompt-id');

    expect(mockGoogleGenAI.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({ contents: request.contents }),
    );
  });

  it('should call generateContentStream on the underlying model', async () => {
    const request = flashReq();
    const mockStream = streamOf({ responseId: '1' });
    mockGoogleGenAI.models.generateContentStream.mockResolvedValue(mockStream);
    const telemetryAttempt = {};
    mockReportLlmRequest.mockReturnValueOnce(telemetryAttempt);

    const stream = await generator.generateContentStream(request, 'prompt-id');

    expectDefaultsSent(mockGoogleGenAI.models.generateContentStream, request);
    expect(await stream.next()).toEqual({
      done: false,
      value: { responseId: '1' },
    });
    expect(mockReportLlmChunk).toHaveBeenCalledWith(telemetryAttempt, {
      responseId: '1',
    });
  });

  it('reports the request dispatch before the SDK call', async () => {
    mockGoogleGenAI.models.generateContentStream.mockResolvedValue(
      streamOf({ responseId: '1' }),
    );
    const onDispatch = vi.fn();

    await observeRequestDispatch(onDispatch, () =>
      generator.generateContentStream(flashReq(), 'prompt-id'),
    );

    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(onDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      mockGoogleGenAI.models.generateContentStream.mock.invocationCallOrder[0],
    );
  });

  it('forwards stream return without pre-consuming the SDK stream', async () => {
    const next = vi.fn();
    const close = vi.fn().mockResolvedValue({ done: true, value: undefined });
    mockGoogleGenAI.models.generateContentStream.mockResolvedValue({
      [Symbol.asyncIterator]: () => ({ next, return: close }),
    });

    const stream = await generator.generateContentStream(
      flashReq(),
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
      flashReq(),
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
    const { gen, models } = build(
      { httpOptions: { baseUrl: ROUTIFY } },
      { model: 'embedding-model', baseUrl: ROUTIFY },
      session1(),
    );
    models.embedContent.mockResolvedValue({ embeddings: [] });

    await gen.embedContent({ model: 'embedding-model', contents: [] });

    expect(
      models.embedContent.mock.calls[0][0].config.httpOptions.headers,
    ).toEqual({ session_id: 'session-1' });
  });

  it('should prioritize contentGeneratorConfig samplingParams over request config', async () => {
    await withCg({
      model: 'gemini-1.5-flash',
      samplingParams: { temperature: 0.1, top_p: 0.2, seed: 42 },
    }).generateContent(
      flashReq({ temperature: 0.9, topP: 0.9, seed: 1 }),
      'prompt-id',
    );

    expectSentConfig({ temperature: 0.1, topP: 0.2, seed: 42 });
  });

  it.each([
    [1000000, 4096, 4096],
    [2048, 4096, 2048],
    [undefined, 4096, 4096],
    [2048, undefined, 2048],
  ])(
    'respects both configured and request output ceilings (%s, %s)',
    async (configured, requested, expected) => {
      await withCg({
        model: 'gemini-test',
        samplingParams: { max_tokens: configured },
      }).generateContent(
        {
          model: 'gemini-test',
          contents: [],
          config: { maxOutputTokens: requested },
        },
        'prompt-id',
      );
      expectSentConfig({ maxOutputTokens: expected });
    },
  );

  it.each([
    ['should map reasoning effort to thinkingConfig', 'high', 'HIGH'],
    // 'max' is a DeepSeek-specific extension. Gemini caps at HIGH, so the
    // converter must clamp instead of falling through to UNSPECIFIED.
    [
      "maps reasoning effort 'max' to HIGH (Gemini has no higher tier)",
      'max',
      'HIGH',
    ],
    ["maps reasoning effort 'medium' to MEDIUM", 'medium', 'MEDIUM'],
    [
      "clamps reasoning effort 'xhigh' to HIGH (Gemini has no xhigh tier)",
      'xhigh',
      'HIGH',
    ],
  ])('%s', async (_title, effort, thinkingLevel) => {
    await withCg({
      model: 'gemini-2.5-pro',
      reasoning: { effort },
    }).generateContent({ model: 'gemini-2.5-pro', contents: [] }, 'prompt-id');

    expectSentConfig({
      thinkingConfig: { includeThoughts: true, thinkingLevel },
    });
  });

  it.each([
    ['gemini-4-neon', 'xhigh', 'XHIGH'],
    ['gemini-4-neon-xhigh', 'max', 'XHIGH'],
    ['gemini-4-hydrogen', 'xhigh', 'XHIGH'],
    ['gemini-4-hydrogen-xhigh', 'max', 'XHIGH'],
    ['gemini-4-argon-high', 'xhigh', 'HIGH'],
    ['gemini-4-argon-high', 'max', 'HIGH'],
  ] as const)(
    'maps %s effort %s to %s without cliConfig',
    async (model, effort, thinkingLevel) => {
      await withCg({
        model,
        reasoning: { effort },
      }).generateContent({ model, contents: [] }, 'prompt-id');

      expectSentConfig({
        thinkingConfig: { includeThoughts: true, thinkingLevel },
      });
    },
  );

  it('should strip displayName from inlineData and fileData before sending to API', async () => {
    await generator.generateContent(
      userReq(
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
      ),
      'prompt-id',
    );

    // displayName is stripped from both inlineData parts and from fileData.
    const parts = sent().contents[0].parts;
    expect(parts[0].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'base64data',
    });
    expect(parts[0].inlineData.displayName).toBeUndefined();
    expect(parts[1].inlineData).toEqual({
      mimeType: 'application/pdf',
      data: 'base64pdfdata',
    });
    expect(parts[1].inlineData.displayName).toBeUndefined();
    expect(parts[2].fileData).toEqual({
      mimeType: 'application/pdf',
      fileUri: 'gs://bucket/file.pdf',
    });
    expect(parts[2].fileData.displayName).toBeUndefined();
  });

  it('strips partMetadata from reattach parts before the Vertex request is built', async () => {
    // `vertexai: true` shares the Gemini Developer API's `stripPartFields`
    // path, but the Vertex request builder rejects `partMetadata`
    // unconditionally; the reattach boundary (issue #11627) must not crash
    // the Vertex route, so the marker is dropped before the SDK builds it.
    const vertexGenerator = new LlmContentGenerator({
      apiKey: 'test-api-key',
      vertexai: true,
    });
    mockGoogleGenAI.models.generateContent.mockResolvedValue({});

    await vertexGenerator.generateContent(
      userReq(
        {
          text: 'Recent images reattached',
          partMetadata: { 'qwen-code:reattach-boundary': true },
        },
        { inlineData: { mimeType: 'image/png', data: 'base64data' } },
      ),
      'prompt-id',
    );

    const parts = sent().contents[0].parts;
    expect(parts[0].partMetadata).toBeUndefined();
    expect(parts[1].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'base64data',
    });
  });

  // Sends one user turn holding a Read functionResponse with these nested
  // parts; returns the functionResponse object the SDK received.
  async function sentFunctionResponse(
    parts: Part[],
    response: Record<string, unknown> = { output: 'content' },
  ) {
    await generator.generateContent(
      userReq({
        functionResponse: {
          id: 'call-1',
          name: 'Read',
          response,
          parts: parts as NonNullable<
            NonNullable<Part['functionResponse']>['parts']
          >,
        },
      }),
      'prompt-id',
    );
    return sent().contents[0].parts[0].functionResponse;
  }

  it('should strip displayName from functionResponse parts', async () => {
    const functionResponse = await sentFunctionResponse([
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'base64data',
          displayName: 'screenshot.png',
        },
      },
    ]);

    // displayName is stripped from nested inlineData
    expect(functionResponse.parts).toEqual([
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'base64data',
        },
      },
    ]);
    expect(functionResponse.parts[0].inlineData.displayName).toBeUndefined();
  });

  it('promotes tool-returned audio and video to a follow-up user turn on Gemini 2.5 and earlier', async () => {
    const functionResponse = await sentFunctionResponse([
      { inlineData: { mimeType: 'image/png', data: 'imagedata' } },
      {
        inlineData: {
          mimeType: 'audio/x-wav',
          data: 'audiodata',
          displayName: 'recording.wav',
        },
      },
      { inlineData: { mimeType: 'video/mp4', data: 'videodata' } },
    ]);

    // Gemini 2.5 and earlier reject binary audio/video inside
    // functionResponse.parts (400 INVALID_ARGUMENT), so image stays nested
    // while audio/video are promoted into a follow-up user turn.
    expect(functionResponse.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'imagedata' } },
    ]);
    expect(functionResponse.response).toEqual({
      output:
        'content\nAttached audio/wav (recording.wav) in following user message.\nAttached video/mp4 in following user message.',
    });
    expect(sent().contents).toHaveLength(2);
    expect(sent().contents[1]).toEqual({
      role: 'user',
      parts: [
        { text: 'Attached media from tool output:' },
        { inlineData: { mimeType: 'audio/wav', data: 'audiodata' } },
        { inlineData: { mimeType: 'video/mp4', data: 'videodata' } },
      ],
    });
  });

  const inline = (
    mimeType: string,
    data: string,
    displayName?: string,
  ): Part => ({
    inlineData: displayName
      ? { mimeType, data, displayName }
      : { mimeType, data },
  });
  const filePart = (
    mimeType: string,
    fileUri: string,
    displayName?: string,
  ): Part => ({
    fileData: displayName
      ? { mimeType, fileUri, displayName }
      : { mimeType, fileUri },
  });
  const fnRespPart = (
    parts: Part[],
    response: Record<string, unknown> = { output: 'ok' },
    id = 'call-1',
  ): Part => ({
    functionResponse: {
      id,
      name: 'read_file',
      response,
      parts: parts as NonNullable<
        NonNullable<Part['functionResponse']>['parts']
      >,
    },
  });

  it('retains tool-returned audio and video natively in functionResponse.parts on Gemini 3+ models', async () => {
    for (const [m, ok] of [
      ['gemini-3-flash', true],
      ['publishers/google/models/gemini-4-pro', true],
      ['gemini-2.5-flash', false],
      ['gemini-1.5-pro', false],
    ] as const) {
      expect(supportsGeminiFunctionResponseAudioVideo(m)).toBe(ok);
    }

    await generator.generateContent(
      {
        model: 'gemini-3.0-pro',
        contents: [
          content(
            'user',
            fnRespPart([
              inline('image/png', 'imagedata'),
              inline('audio/x-wav', 'audiodata', 'recording.wav'),
              filePart('VIDEO/MP4', 'gs://bucket/clip.mp4', 'clip.mp4'),
            ]),
          ),
        ],
      },
      'prompt-id',
    );

    expect(sent().contents).toHaveLength(1);
    expect(sent().contents[0].parts[0].functionResponse).toMatchObject({
      response: { output: 'ok' },
      parts: [
        inline('image/png', 'imagedata'),
        inline('audio/wav', 'audiodata'),
        filePart('video/mp4', 'gs://bucket/clip.mp4'),
      ],
    });
  });

  it('enforces presence-as-true InputModalities on both user turns and functionResponse parts', async () => {
    const { gen, models } = build(
      {},
      { model: 'gemini-3.0-pro', modalities: { image: true } },
    );
    models.generateContent.mockResolvedValue({});

    await gen.generateContent(
      {
        model: 'gemini-3.0-pro',
        contents: [
          content(
            'user',
            inline('image/png', 'img'),
            inline('audio/wav', 'aud', 'clip.wav'),
            inline('application/pdf; charset=binary', 'pdfdata', 'doc.pdf'),
          ),
          content(
            'user',
            fnRespPart(
              [
                inline('image/png', 'img2'),
                inline('video/webm', 'vid', 'v.webm'),
              ],
              { output: '' },
              'call-vision-only',
            ),
          ),
        ],
      },
      'prompt-id',
    );

    const called = models.generateContent.mock.calls[0][0];
    expect(called.contents).toHaveLength(2);
    expect(called.contents[0].parts).toEqual([
      inline('image/png', 'img'),
      { text: 'Unsupported media type for Gemini: audio/wav (clip.wav).' },
      { text: 'Unsupported media type for Gemini: application/pdf (doc.pdf).' },
    ]);
    expect(called.contents[1].parts[0].functionResponse).toMatchObject({
      parts: [inline('image/png', 'img2')],
      response: {
        output: 'Unsupported media type for Gemini: video/webm (v.webm).',
      },
    });
  });

  it('drops functionResponse.parts when all nested parts are promoted video and preserves caller input', async () => {
    const originalResponse = { output: '' };
    const originalParts: Part[] = [
      {
        inlineData: {
          mimeType: 'video/webm',
          data: 'webmdata',
          displayName: 'video.webm',
        },
      },
    ];
    const request = userReq({
      functionResponse: {
        id: 'call-video',
        name: 'read_file',
        response: originalResponse,
        parts: originalParts as NonNullable<
          NonNullable<Part['functionResponse']>['parts']
        >,
      },
    });

    mockGoogleGenAI.models.generateContentStream.mockResolvedValue(
      streamOf({ responseId: '1' }),
    );
    await generator.generateContentStream(request, 'prompt-id');

    const sentContents =
      mockGoogleGenAI.models.generateContentStream.mock.calls[0][0].contents;
    const sentFnResponse = sentContents[0].parts[0].functionResponse;
    expect(sentFnResponse.parts).toBeUndefined();
    expect(sentFnResponse.response).toEqual({
      output: 'Attached video/webm (video.webm) in following user message.',
    });
    expect(sentContents[1]).toEqual({
      role: 'user',
      parts: [
        { text: 'Attached media from tool output:' },
        { inlineData: { mimeType: 'video/webm', data: 'webmdata' } },
      ],
    });
    // Caller history must remain untouched for subsequent switches back to a
    // provider that supports video.
    expect(originalResponse).toEqual({ output: '' });
    expect(originalParts).toHaveLength(1);
    expect(originalParts[0].inlineData?.mimeType).toBe('video/webm');
  });

  it('moves upstream text entries and promotes fileData video out of functionResponse.parts on Gemini 2.5 and earlier', async () => {
    const functionResponse = await sentFunctionResponse(
      [
        { text: '[Image omitted during compaction]' },
        {
          fileData: {
            mimeType: 'video/mp4',
            fileUri: 'gs://bucket/clip.mp4',
            displayName: 'clip.mp4',
          },
        },
        {
          fileData: {
            mimeType: 'application/pdf',
            fileUri: 'gs://bucket/doc.pdf',
            displayName: 'doc.pdf',
          },
        },
      ],
      { error: 'partial failure' },
    );

    expect(functionResponse.parts).toEqual([
      {
        fileData: {
          mimeType: 'application/pdf',
          fileUri: 'gs://bucket/doc.pdf',
        },
      },
    ]);
    expect(functionResponse.response).toEqual({
      error: 'partial failure',
      output:
        '[Image omitted during compaction]\nAttached video/mp4 (clip.mp4) in following user message.',
    });
    expect(sent().contents[1]).toEqual({
      role: 'user',
      parts: [
        { text: 'Attached media from tool output:' },
        {
          fileData: { mimeType: 'video/mp4', fileUri: 'gs://bucket/clip.mp4' },
        },
      ],
    });
  });

  it('preserves non-string response.output by recording extracted notes under response.notes', async () => {
    const functionResponse = await sentFunctionResponse(
      [{ text: '[Image omitted during compaction]' }],
      { output: { ok: true } },
    );

    expect(functionResponse.parts).toBeUndefined();
    expect(functionResponse.response).toEqual({
      output: { ok: true },
      notes: '[Image omitted during compaction]',
    });
  });

  it('handles case-insensitive audio/video MIME types, raw string entries, unknown nested fields, and non-string response.notes', async () => {
    const functionResponse = await sentFunctionResponse(
      [
        {
          inlineData: {
            mimeType: ' VIDEO/WEBM ',
            data: 'webmdata',
            displayName: 'clip.webm',
          },
        },
        {
          fileData: {
            mimeType: 'Audio/MP3',
            fileUri: 'gs://bucket/a.mp3',
          },
        },
        'legacy string note' as unknown as Part,
        {
          inlineData: {
            mimeType: 'image/png',
            data: 'pngdata',
            displayName: 'shot.png',
            extraKey: 'must-not-leak',
          } as Part['inlineData'],
          fileData: {
            mimeType: 'application/pdf',
            fileUri: 'gs://bucket/doc.pdf',
            displayName: 'doc.pdf',
            extraKey: 'must-not-leak',
          } as Part['fileData'],
        },
      ],
      { output: { ok: true }, notes: ['existing-note'] },
    );

    expect(functionResponse.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'pngdata' } },
      {
        fileData: {
          fileUri: 'gs://bucket/doc.pdf',
          mimeType: 'application/pdf',
        },
      },
    ]);
    expect(functionResponse.response).toEqual({
      output: { ok: true },
      notes: ['existing-note'],
      _notes:
        'Attached video/webm (clip.webm) in following user message.\nAttached audio/mp3 in following user message.\nlegacy string note',
    });
    expect(sent().contents[1]).toEqual({
      role: 'user',
      parts: [
        { text: 'Attached media from tool output:' },
        { inlineData: { mimeType: 'video/webm', data: 'webmdata' } },
        { fileData: { fileUri: 'gs://bucket/a.mp3', mimeType: 'audio/mp3' } },
      ],
    });
  });

  it('splits reattach-boundary bundles off functionResponse turns with hardcoded role=user and drops unsigned empty text', async () => {
    const fr = {
      functionResponse: {
        id: 'call-1',
        name: 'read_file',
        response: { output: 'done' },
      },
    };
    await generator.generateContent(
      {
        model: 'gemini-3.0-pro',
        contents: [
          {
            role: 'function',
            parts: [
              { text: '' },
              fr,
              {
                text: 'Reattached image summary',
                partMetadata: { 'qwen-code:reattach-boundary': true },
              },
              { inlineData: { mimeType: 'image/png', data: 'imgdata' } },
            ],
          },
          {
            role: 'model',
            parts: [
              { text: '', thoughtSignature: 'sig-keep' },
              { text: '' },
              { text: 'reply' },
            ],
          },
        ],
      },
      'prompt-id',
    );

    expect(sent().contents).toEqual([
      { role: 'function', parts: [fr] },
      {
        role: 'user',
        parts: [
          { text: 'Reattached image summary' },
          { inlineData: { mimeType: 'image/png', data: 'imgdata' } },
        ],
      },
      {
        role: 'model',
        parts: [{ text: '', thoughtSignature: 'sig-keep' }, { text: 'reply' }],
      },
    ]);
  });

  it('prepends Gemini 2.5 promoted tool media ahead of split reattach-boundary bundles on user turns', async () => {
    await generator.generateContent(
      {
        model: 'gemini-2.5-flash',
        contents: [
          {
            role: 'user',
            parts: [
              fnRespPart(
                [inline('VIDEO/WEBM', 'webmdata', 'clip.webm')],
                { output: 'done' },
                'call-split-promote',
              ),
              {
                text: 'Reattached image summary',
                partMetadata: { 'qwen-code:reattach-boundary': true },
              },
              { inlineData: { mimeType: 'image/png', data: 'imgdata' } },
            ],
          },
        ],
      },
      'prompt-id',
    );

    expect(sent().contents).toEqual([
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-split-promote',
              name: 'read_file',
              response: {
                output:
                  'done\nAttached video/webm (clip.webm) in following user message.',
              },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'video/webm', data: 'webmdata' } },
          { text: 'Reattached image summary' },
          { inlineData: { mimeType: 'image/png', data: 'imgdata' } },
        ],
      },
    ]);
  });

  // https://github.com/QwenLM/qwen-code/issues/9453
  //
  // The OpenAI Responses generator stashes an opaque reasoning-replay payload
  // in the shared `Part.thoughtSignature` field. It only means something to
  // the Responses API, so after a provider switch it must not travel on the
  // Gemini wire as a Gemini-native signature, while the visible reasoning
  // summary and `thought: true` marker are kept.
  describe('cross-provider reasoning replay metadata', () => {
    const responsesReplaySignature = JSON.stringify({
      id: 'rs_68c6c0c9ff5c8191a29b2e78c1a40c83',
      encrypted_content: 'gAAAAABvcmVhc29uaW5nLXJlcGxheS1wYXlsb2Fk',
    });

    // A Gemini-native thoughtSignature is an opaque token: it never starts
    // with '{' and never parses as the Responses replay payload shape.
    const geminiNativeSignature =
      'Ck0BShsIxKq3wOa2tgUQ5LK0BhjOqrfA5ra2BRABGAIiQB9Z7xKq3wOa2tgU';

    const buildRequest = (thoughtPart: Part) => ({
      model: 'gemini-2.5-pro',
      contents: [
        userText('First'),
        content('model', thoughtPart, { text: 'Visible answer' }),
        userText('Second'),
      ],
    });
    const thoughtPart = (thoughtSignature: string): Part => ({
      text: 'Reasoning summary',
      thought: true,
      thoughtSignature,
    });

    // Sends a reasoning part carrying `signature`; checks the sent part has
    // `expected` as its signature and kept its visible fields.
    async function sendThought(signature: string, expected?: unknown) {
      await generator.generateContent(
        buildRequest(thoughtPart(signature)),
        'prompt-id',
      );
      const calledWith = sent();
      const sentPart = calledWith.contents[1].parts[0];
      expect(sentPart.thoughtSignature).toBe(expected);
      expect(sentPart.thought).toBe(true);
      expect(sentPart.text).toBe('Reasoning summary');
      return calledWith;
    }

    it('preserves a native Gemini thoughtSignature', async () => {
      await sendThought(geminiNativeSignature, geminiNativeSignature);
    });

    it('strips a Responses replay payload but keeps the visible reasoning text', async () => {
      const calledWith = await sendThought(responsesReplaySignature);
      expect(calledWith.contents[1].parts[1].text).toBe('Visible answer');
    });

    it('does not mutate the caller-owned history part', async () => {
      // Hold the part by identity rather than re-deriving it from the request,
      // so this asserts the caller's own object was not touched.
      const historyPart = thoughtPart(responsesReplaySignature);

      await generator.generateContent(buildRequest(historyPart), 'prompt-id');

      // The strip is wire-only: persisted history keeps the payload so a
      // later switch back to the Responses API can still replay it.
      expect(historyPart.thoughtSignature).toBe(responsesReplaySignature);
    });

    it('forwards a non-string thoughtSignature without throwing', async () => {
      // The SDK types thoughtSignature as string, but the value crosses untyped
      // boundaries (persisted-history restore does no Part shape validation),
      // so a non-string is treated as a native opaque token, not a throw.
      const nonStringSignature = 1 as unknown as string;

      // The garbage is forwarded unchanged (base behavior): the recognizer
      // only drops the Responses replay payload shape, never crashes.
      await sendThought(nonStringSignature, nonStringSignature);
    });
  });

  describe('stream-guards integration', () => {
    function setupHangingStream(
      cg: Record<string, unknown>,
      firstChunk?: { responseId: string },
    ) {
      const { gen, models } = build({}, { model: 'gemini-2.5-flash', ...cg });
      let signal: AbortSignal | undefined;
      const close = vi.fn().mockResolvedValue({ done: true, value: undefined });
      models.generateContentStream.mockImplementation(
        async (req: { config?: { abortSignal?: AbortSignal } }) => {
          signal = req.config?.abortSignal;
          let count = 0;
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () =>
                firstChunk && count++ === 0
                  ? { done: false, value: firstChunk }
                  : new Promise(() => {}),
              return: close,
            }),
          };
        },
      );
      return { gen, close, getSignal: () => signal };
    }

    it.each([
      [
        'streamIdleTimeoutMs',
        { streamIdleTimeoutMs: 500 },
        undefined,
        500,
        StreamInactivityTimeoutError,
      ],
      [
        'QWEN_STREAM_IDLE_TIMEOUT_MS',
        { streamMaxLifetimeMs: 0 },
        '200',
        200,
        StreamInactivityTimeoutError,
      ],
      [
        'streamMaxLifetimeMs',
        { streamIdleTimeoutMs: 0, streamMaxLifetimeMs: 250 },
        undefined,
        250,
        StreamLifetimeExceededError,
      ],
    ] as const)(
      'aborts stalled stream via %s and trips per-request signal',
      async (_label, cg, envIdle, advanceMs, ErrorClass) => {
        vi.useFakeTimers();
        if (envIdle) vi.stubEnv('QWEN_STREAM_IDLE_TIMEOUT_MS', envIdle);
        try {
          const { gen, getSignal } = setupHangingStream(cg);
          const stream = await gen.generateContentStream(
            flashReq(),
            'prompt-id',
          );
          const settled = stream.next().catch((err: unknown) => err);
          await vi.advanceTimersByTimeAsync(advanceMs);
          const caught = await settled;
          expect(caught).toBeInstanceOf(ErrorClass);
          expect((caught as { code?: string }).code).toBe('ETIMEDOUT');
          expect(getSignal()?.aborted).toBe(true);
        } finally {
          vi.unstubAllEnvs();
          vi.useRealTimers();
        }
      },
    );

    it('aborts request signal and cleans up caller abort listener on mid-stream error even when both guards are disabled', async () => {
      const caller = new AbortController();
      const { gen, models } = build(
        {},
        {
          model: 'gemini-2.5-flash',
          streamIdleTimeoutMs: 0,
          streamMaxLifetimeMs: 0,
        },
      );
      let capturedSignal: AbortSignal | undefined;
      models.generateContentStream.mockImplementation(
        async (req: { config?: { abortSignal?: AbortSignal } }) => {
          capturedSignal = req.config?.abortSignal;
          let count = 0;
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                if (count++ === 0) {
                  return { done: false, value: { responseId: '1' } };
                }
                throw new Error('mid-stream socket reset');
              },
            }),
          };
        },
      );

      const stream = await gen.generateContentStream(
        { ...flashReq(), config: { abortSignal: caller.signal } },
        'prompt-guards-off-err',
      );
      expect(await stream.next()).toEqual({
        done: false,
        value: { responseId: '1' },
      });
      expect(capturedSignal?.aborted).toBe(false);
      await expect(stream.next()).rejects.toThrow('mid-stream socket reset');
      expect(capturedSignal?.aborted).toBe(true);
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0);
    });

    it('aborts the per-request signal on early consumer return', async () => {
      const { gen, close, getSignal } = setupHangingStream(
        {},
        { responseId: '1' },
      );
      const stream = await gen.generateContentStream(flashReq(), 'prompt-id');
      expect(await stream.next()).toEqual({
        done: false,
        value: { responseId: '1' },
      });
      expect(getSignal()?.aborted).toBe(false);
      await stream.return(undefined);
      expect(getSignal()?.aborted).toBe(true);
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
