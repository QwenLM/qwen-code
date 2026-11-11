/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { withHttpServer } from '../test-utils/http-server.js';
import { JudgmentInputTooLongError } from './types.js';
import { TypeSafeJudge } from './typesafe.js';
import { customProviderRequest } from '../provider/custom/request.js';

const settings = {
  backend: 'typesafe',
  model: 'jev-latest',
  baseUrl: 'https://api.typesafe.ai/',
  apiKey: 'test-key',
} as const;
const request = {
  state: { message: 'hello' },
  questions: { ok: { type: 'noul', instructions: 'Is it a greeting?' } },
} as const;
const result = {
  model: 'jev-version',
  answers: { ok: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 },
};
const send = () => vi.fn<typeof customProviderRequest>();

describe('TypeSafe judgment', () => {
  it('uses the real HTTP contract without forwarding CLI identity headers', async () => {
    let body = '';
    let url: string | undefined;
    let headers: import('node:http').IncomingHttpHeaders = {};
    await withHttpServer(
      async (incoming, response) => {
        url = incoming.url;
        headers = incoming.headers;
        for await (const chunk of incoming) body += chunk;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      },
      async (baseUrl) => {
        const actual = await new TypeSafeJudge({ ...settings, baseUrl }, customProviderRequest).judge(
          request,
        );
        expect(actual.answers.ok.noul).toBe(0.9);
      },
    );
    expect(url).toBe('/v1/systemone');
    expect(JSON.parse(body)).toEqual({ ...request, model: 'jev-latest' });
    expect(headers['authorization']).toBe('Bearer test-key');
    expect(headers['cosy-clienttype']).toBeUndefined();
    expect(headers['cosy-version']).toBeUndefined();
    expect(headers['cosy-machineos']).toBeUndefined();
  });
  it('sends the native protocol through the shared request layer and maps usage', async () => {
    const transport = send().mockResolvedValue(Response.json(result));
    const signal = new AbortController().signal;
    const actual = await new TypeSafeJudge(settings, transport).judge(request, {
      signal,
    });
    expect(transport).toHaveBeenCalledWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({
        method: 'POST',
        signal,
        body: JSON.stringify({
          state: request.state,
          model: settings.model,
          questions: request.questions,
        }),
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' }),
      }),
      expect.objectContaining({ requestTimeoutMs: 10000 }),
    );
    expect(actual).toMatchObject({
      model: 'jev-version',
      answers: result.answers,
      requestId: expect.any(String),
      usage: { inputTokens: 10, outputTokens: 2 },
    });
  });
  it('recognizes the real TypeSafe token-limit error without retrying', async () => {
    const transport = send().mockResolvedValue(
      Response.json(
        { detail: { error_type: 'max_tokens_exceeded' } },
        { status: 400 },
      ),
    );
    await expect(
      new TypeSafeJudge(settings, transport).judge(request),
    ).rejects.toBeInstanceOf(JudgmentInputTooLongError);
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each([
    { status: 400, body: { detail: { error_type: 'invalid_request' } } },
    { status: 401, body: { detail: { error_type: 'max_tokens_exceeded' } } },
    { status: 400, body: { message: 'max_tokens_exceeded' } },
  ])(
    'does not confuse unrelated errors with context overflow: $status $body',
    async ({ status, body }) => {
      const transport = send().mockResolvedValue(
        Response.json(body, { status }),
      );
      const error = await new TypeSafeJudge(settings, transport)
        .judge(request)
        .catch((e) => e);
      expect(error).not.toBeInstanceOf(JudgmentInputTooLongError);
      expect(error.message).toBe(
        `TypeSafe judgment request failed (HTTP ${status})`,
      );
    },
  );
  it('retries transient HTTP failures within the bound', async () => {
    const transport = send().mockImplementation(
      async () =>
        new Response('', { status: 503, headers: { 'retry-after': '0' } }),
    );
    await expect(
      new TypeSafeJudge(settings, transport).judge(request),
    ).rejects.toThrow('503');
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('uses one request without endpoint observation in side-effect-free mode', async () => {
    const transport = send().mockResolvedValue(
      new Response('', { status: 503 }),
    );

    const error = await new TypeSafeJudge(settings, transport)
      .judge(request, { sideEffectFree: true })
      .catch((failure) => failure);

    expect(error).toMatchObject({
      message: 'TypeSafe judgment request failed (HTTP 503)',
      requestId: expect.any(String),
      httpStatus: 503,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][2]).toMatchObject({
      singleAttempt: true,
    });
  });
  it('does not retry authorization errors or disclose the response body', async () => {
    const transport = send().mockResolvedValue(
      new Response('sensitive upstream text', { status: 401 }),
    );
    const outcome = new TypeSafeJudge(settings, transport).judge(request);
    await expect(outcome).rejects.toThrow('HTTP 401');
    expect(transport).toHaveBeenCalledOnce();
  });
  it.each([
    { ...result, answers: {} },
    {
      ...result,
      answers: {
        ok: {
          type: 'choice',
          choice: 'x',
          probabilities: { x: 1 },
          confidence: 1,
        },
      },
    },
    { ...result, answers: { ok: { type: 'noul', noul: 2 } } },
  ])('rejects missing, mismatched and malformed answers', async (data) => {
    const transport = send().mockResolvedValue(Response.json(data));
    const error = await new TypeSafeJudge(settings, transport)
      .judge(request)
      .catch((failure) => failure);
    expect(error).toMatchObject({ requestId: expect.any(String) });
    expect(transport).toHaveBeenCalledOnce();
  });
  it('accepts a fractional native score', async () => {
    const transport = send().mockResolvedValue(
      Response.json({
        ...result,
        answers: {
          score: {
            type: 'score',
            score: 0.25,
            probabilities: { '0': 0.75, '1': 0.25 },
            confidence: 0.2,
          },
        },
      }),
    );
    const actual = await new TypeSafeJudge(settings, transport).judge({
      state: '',
      questions: {
        score: { type: 'score', instructions: '', criteria: ['low', 'high'] },
      },
    });
    expect(actual.answers.score.score).toBe(0.25);
  });
  it('propagates cancellation without another request', async () => {
    const transport = send();
    await expect(
      new TypeSafeJudge(settings, transport).judge(request, {
        signal: AbortSignal.abort(new Error('cancelled')),
      }),
    ).rejects.toThrow('cancelled');
    expect(transport).not.toHaveBeenCalled();
  });
});
