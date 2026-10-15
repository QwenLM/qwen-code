/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { LlmContentGenerator } from './llm-content-generator.js';
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
      samplingParams: { temperature: 0.1, top_p: 0.2 },
    }).generateContent(flashReq({ temperature: 0.9, topP: 0.9 }), 'prompt-id');

    expectSentConfig({ temperature: 0.1, topP: 0.2 });
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
  // parts; returns the nested parts the SDK received.
  async function sentFunctionResponseParts(parts: Part[]) {
    await generator.generateContent(
      userReq({
        functionResponse: {
          id: 'call-1',
          name: 'Read',
          response: { output: 'content' },
          parts,
        },
      }),
      'prompt-id',
    );
    return sent().contents[0].parts[0].functionResponse.parts;
  }

  it('should strip displayName from functionResponse parts', async () => {
    const functionResponseParts = await sentFunctionResponseParts([
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'base64data',
          displayName: 'screenshot.png',
        },
      },
    ]);

    // displayName is stripped from nested inlineData
    expect(functionResponseParts[0].inlineData).toEqual({
      mimeType: 'image/png',
      data: 'base64data',
    });
    expect(functionResponseParts[0].inlineData.displayName).toBeUndefined();
  });

  it('should convert audio and video to text in functionResponse parts', async () => {
    const functionResponseParts = await sentFunctionResponseParts([
      { inlineData: { mimeType: 'image/png', data: 'imagedata' } },
      {
        inlineData: {
          mimeType: 'audio/wav',
          data: 'audiodata',
          displayName: 'recording.wav',
        },
      },
      { inlineData: { mimeType: 'video/mp4', data: 'videodata' } },
    ]);

    // All parts remain, but audio/video are converted to text
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
});
