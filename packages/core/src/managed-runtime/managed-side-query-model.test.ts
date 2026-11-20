/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { FinishReason, GenerateContentResponse } from '@google/genai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import {
  classifyManagedSideQueryResponse,
  generateManagedSideQuery,
} from './managed-side-query-model.js';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  client: vi.fn(),
  responses: vi.fn(),
  anthropic: vi.fn(),
  anthropicClient: vi.fn(),
  gemini: vi.fn(),
  geminiClient: vi.fn(),
}));
vi.mock('@google/genai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google/genai')>()),
  GoogleGenAI: class {
    models = { generateContentStream: mocks.gemini };
    constructor(options: unknown) {
      mocks.geminiClient(options);
    }
  },
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: mocks.anthropic };
    constructor(options: unknown) {
      mocks.anthropicClient(options);
    }
  },
}));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
    responses = { create: mocks.responses };
    constructor(options: unknown) {
      mocks.client(options);
    }
  },
}));
beforeEach(() => vi.clearAllMocks());

describe('isolated Managed model attempt', () => {
  it('disables Gemini SDK retries and host Vertex mode while preserving partial completion', async () => {
    mocks.gemini.mockResolvedValueOnce(
      (async function* () {
        const response = new GenerateContentResponse();
        response.candidates = [
          {
            finishReason: FinishReason.MAX_TOKENS,
            content: { parts: [{ text: 'partial' }] },
          },
        ];
        yield response;
      })(),
    );
    const result = await generateManagedSideQuery(
      {
        model: 'gemini',
        authType: AuthType.USE_GEMINI,
        apiKey: 'explicit-key',
        baseUrl: 'https://gemini.example',
      },
      { model: 'gemini', contents: [] },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ text: 'partial', outcome: 'truncated' });
    expect(mocks.geminiClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'explicit-key',
        vertexai: false,
        httpOptions: expect.objectContaining({ retryOptions: { attempts: 1 } }),
      }),
    );
    expect(mocks.gemini).toHaveBeenCalledTimes(1);
    expect(
      mocks.gemini.mock.calls[0]?.[0].config.httpOptions.retryOptions,
    ).toEqual({ attempts: 1 });
  });

  it('streams Anthropic once with explicit proxy authentication and no inherited key', async () => {
    const stream = (async function* () {
      yield {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'answer' },
      };
    })();
    mocks.anthropic.mockReturnValueOnce(
      Object.assign(stream, {
        finalMessage: async () => ({
          id: 'r',
          type: 'message',
          role: 'assistant',
          model: 'claude',
          content: [{ type: 'text', text: 'answer' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      }),
    );
    const progress = vi.fn();
    expect(
      await generateManagedSideQuery(
        {
          model: 'claude',
          authType: AuthType.USE_ANTHROPIC,
          apiKey: 'literal-key',
          baseUrl: 'https://proxy.example',
        },
        {
          model: 'claude',
          contents: [{ role: 'user', parts: [{ text: 'q' }] }],
          config: { maxOutputTokens: 300 },
        },
        new AbortController().signal,
        progress,
      ),
    ).toMatchObject({ outcome: 'success', text: 'answer' });
    expect(progress).toHaveBeenCalledWith('answer');
    expect(mocks.anthropicClient).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: null,
        authToken: 'literal-key',
        maxRetries: 0,
      }),
    );
    expect(mocks.anthropic.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 0 });
    expect(mocks.anthropic.mock.calls[0]?.[0]).not.toHaveProperty('tools');
  });

  it('preserves Responses filtering after visible partial output with one call', async () => {
    mocks.responses.mockResolvedValueOnce(
      (async function* () {
        yield {
          type: 'response.output_text.delta',
          delta: 'partial',
          output_index: 0,
          content_index: 0,
        };
        yield {
          type: 'response.incomplete',
          response: {
            id: 'r',
            incomplete_details: { reason: 'content_filter' },
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          },
        };
      })(),
    );
    const result = await generateManagedSideQuery(
      {
        model: 'responses',
        authType: AuthType.USE_OPENAI_RESPONSES,
        apiKey: 'literal-key',
        baseUrl: 'https://responses.example',
      },
      { model: 'responses', contents: [] },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ outcome: 'filtered', text: 'partial' });
    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://responses.example/v1',
        organization: null,
        project: null,
        maxRetries: 0,
      }),
    );
    expect(mocks.responses).toHaveBeenCalledTimes(1);
    expect(mocks.responses.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      store: false,
    });
  });

  it.each([
    [
      'response.incomplete',
      { incomplete_details: { reason: 'unknown' } },
      'unknown_completion',
    ],
    [
      'response.completed',
      {
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'denied' }],
          },
        ],
      },
      'filtered',
    ],
  ])(
    'preserves raw Responses %s semantics instead of converter defaults',
    async (type, response, outcome) => {
      mocks.responses.mockResolvedValueOnce(
        (async function* () {
          yield { type: 'response.output_text.delta', delta: 'partial' };
          yield { type, response };
        })(),
      );
      expect(
        await generateManagedSideQuery(
          {
            model: 'responses',
            authType: AuthType.USE_OPENAI_RESPONSES,
            apiKey: 'literal-key',
            baseUrl: 'https://responses.example',
          },
          { model: 'responses', contents: [] },
          new AbortController().signal,
        ),
      ).toMatchObject({ text: 'partial', outcome });
    },
  );

  it('keeps streamed Chat refusal text without accepting a normal stop as success', async () => {
    mocks.create.mockResolvedValueOnce(
      (async function* () {
        yield {
          id: 'r',
          object: 'chat.completion.chunk',
          model: 'explicit',
          created: 1,
          choices: [
            { index: 0, delta: { refusal: 'declined' }, finish_reason: null },
          ],
        };
        yield {
          id: 'r',
          object: 'chat.completion.chunk',
          model: 'explicit',
          created: 1,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
      })(),
    );
    expect(
      await generateManagedSideQuery(
        {
          model: 'explicit',
          authType: AuthType.USE_OPENAI,
          apiKey: 'literal-key',
          baseUrl: 'https://model.example/v1',
        },
        { model: 'explicit', contents: [] },
        new AbortController().signal,
      ),
    ).toMatchObject({ text: 'declined', outcome: 'filtered' });
  });
  it('streams visible partial text and retains a truncated finish reason', async () => {
    mocks.create.mockResolvedValueOnce(
      (async function* () {
        yield {
          id: 'r',
          object: 'chat.completion.chunk',
          model: 'explicit',
          created: 1,
          choices: [
            {
              index: 0,
              delta: {
                content: 'partial answer',
                reasoning_content: 'hidden thought',
              },
              finish_reason: null,
            },
          ],
        };
        yield {
          id: 'r',
          object: 'chat.completion.chunk',
          model: 'explicit',
          created: 1,
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        };
      })(),
    );
    const progress = vi.fn();
    const result = await generateManagedSideQuery(
      {
        model: 'explicit',
        authType: AuthType.USE_OPENAI,
        apiKey: 'literal-key',
        baseUrl: 'https://model.example/v1',
      },
      {
        model: 'explicit',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      },
      new AbortController().signal,
      progress,
    );
    expect(result).toMatchObject({
      outcome: 'truncated',
      text: 'partial answer',
    });
    expect(progress).toHaveBeenCalledWith('partial answer');
    expect(JSON.stringify(progress.mock.calls)).not.toContain('hidden thought');
    expect(mocks.create.mock.calls[0]?.[0]).toMatchObject({ stream: true });
  });
  it('settles success when the terminal Chat chunk carries no delta', async () => {
    mocks.create.mockResolvedValueOnce(
      (async function* () {
        yield {
          id: 'r',
          object: 'chat.completion.chunk',
          model: 'explicit',
          created: 1,
          choices: [
            {
              index: 0,
              delta: { content: 'complete answer' },
              finish_reason: null,
            },
          ],
        };
        yield {
          id: 'r',
          object: 'chat.completion.chunk',
          model: 'explicit',
          created: 1,
          choices: [{ index: 0, finish_reason: 'stop' }],
        };
      })(),
    );
    const result = await generateManagedSideQuery(
      {
        model: 'explicit',
        authType: AuthType.USE_OPENAI,
        apiKey: 'literal-key',
        baseUrl: 'https://model.example/v1',
      },
      {
        model: 'explicit',
        contents: [{ role: 'user', parts: [{ text: 'q' }] }],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      outcome: 'success',
      text: 'complete answer',
    });
  });
  it.each([
    [FinishReason.STOP, 'success'],
    [FinishReason.MAX_TOKENS, 'truncated'],
    [FinishReason.SAFETY, 'filtered'],
    [undefined, 'unknown_completion'],
  ])(
    'preserves %s outcome even when text is present',
    (finishReason, outcome) => {
      const response = new GenerateContentResponse();
      response.candidates = [
        {
          finishReason,
          content: {
            role: 'model',
            parts: [
              { text: 'partial answer' },
              { text: 'private thought', thought: true },
            ],
          },
        },
      ];
      expect(classifyManagedSideQueryResponse(response)).toMatchObject({
        outcome,
        text: 'partial answer',
      });
    },
  );

  it('excludes tool requests from successful history', () => {
    const response = new GenerateContentResponse();
    response.candidates = [
      {
        finishReason: FinishReason.STOP,
        content: {
          parts: [{ text: 'partial' }, { functionCall: { name: 'read_file' } }],
        },
      },
    ];
    expect(classifyManagedSideQueryResponse(response).outcome).toBe(
      'tool_request',
    );
    response.candidates[0]!.finishReason = FinishReason.MAX_TOKENS;
    expect(classifyManagedSideQueryResponse(response).outcome).toBe(
      'truncated',
    );
    response.candidates[0]!.finishReason = FinishReason.SAFETY;
    expect(classifyManagedSideQueryResponse(response).outcome).toBe('filtered');
  });

  it('uses explicit credentials once and disables SDK retries', async () => {
    mocks.create.mockRejectedValueOnce(new Error('connection lost'));
    const request = {
      model: 'explicit',
      contents: [{ role: 'user', parts: [{ text: 'question' }] }],
    };
    await expect(
      generateManagedSideQuery(
        {
          model: 'explicit',
          authType: AuthType.USE_OPENAI,
          apiKey: 'literal-key',
          baseUrl: 'https://model.example/v1',
        },
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow('connection lost');
    expect(mocks.client).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'literal-key',
        baseURL: 'https://model.example/v1',
        maxRetries: 0,
      }),
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]?.[0]).not.toHaveProperty('tools');
    expect(mocks.create.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ maxRetries: 0 }),
    );
  });
});
