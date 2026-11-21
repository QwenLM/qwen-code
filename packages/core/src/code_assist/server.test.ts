/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthClient } from 'google-auth-library';
import { Readable } from 'node:stream';
import { CodeAssistServer } from './server.js';
import { markRequestDispatched } from '../core/loggingContentGenerator/request-dispatch.js';
import { CODE_ASSIST_ENDPOINT } from './constants.js';

const telemetry = vi.hoisted(() => ({
  request: vi.fn(),
  response: vi.fn(),
  chunk: vi.fn(),
}));
vi.mock('../telemetry/gen-ai-request.js', () => ({
  reportLlmRequest: telemetry.request,
  reportLlmResponse: telemetry.response,
  reportLlmChunk: telemetry.chunk,
}));
vi.mock('../core/loggingContentGenerator/request-dispatch.js', () => ({
  markRequestDispatched: vi.fn(),
}));

function serverWithRequest(request: ReturnType<typeof vi.fn>) {
  return new CodeAssistServer(
    { request } as unknown as AuthClient,
    'project-1',
    {},
    { getSessionId: () => 'session-1' } as never,
  );
}

function idleStream() {
  return new Readable({ read() {} });
}

describe('CodeAssistServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('CODE_ASSIST_ENDPOINT', 'https://code-assist.test');
    vi.stubEnv('CODE_ASSIST_API_VERSION', 'v1internal');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('maps non-streaming requests and responses', async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        traceId: 'trace-1',
        response: {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'answer' }] } },
          ],
          usageMetadata: { totalTokenCount: 5 },
        },
      },
    });
    const response = await serverWithRequest(request).generateContent(
      { model: 'gemini-2.5-pro', contents: 'hello' },
      'prompt-1',
    );

    expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('answer');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://code-assist.test/v1internal:generateContent',
        method: 'POST',
        retry: false,
      }),
    );
    expect(JSON.parse(request.mock.calls[0][0].body)).toMatchObject({
      project: 'project-1',
      user_prompt_id: 'prompt-1',
      request: { session_id: 'session-1' },
    });
  });

  it('parses multi-line SSE across transport chunks', async () => {
    const first = JSON.stringify({
      traceId: 'trace-1',
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'first' }] } },
        ],
      },
    });
    const second = JSON.stringify({
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'second' }] } },
        ],
        usageMetadata: { totalTokenCount: 8 },
      },
    });
    const request = vi.fn().mockResolvedValue({
      data: Readable.from([
        Buffer.from(`data: ${first.slice(0, 20)}`),
        Buffer.from(`${first.slice(20)}\n\nda`),
        Buffer.from(`ta: ${second}\n\n`),
      ]),
    });

    const responses = [];
    for await (const response of await serverWithRequest(
      request,
    ).generateContentStream(
      { model: 'gemini-2.5-pro', contents: 'hello' },
      'prompt-1',
    )) {
      responses.push(response);
    }

    expect(
      responses.map(
        (response) => response.candidates?.[0]?.content?.parts?.[0]?.text,
      ),
    ).toEqual(['first', 'second']);
    expect(responses[1]?.usageMetadata?.totalTokenCount).toBe(8);
    expect(request.mock.calls[0][0].params).toEqual({ alt: 'sse' });
  });

  it('rejects malformed SSE JSON instead of yielding a false success', async () => {
    const request = vi.fn().mockResolvedValue({
      data: Readable.from(['data: {not-json}\n\n']),
    });
    const stream = await serverWithRequest(request).generateContentStream(
      { model: 'gemini-2.5-pro', contents: 'hello' },
      'prompt-1',
    );
    await expect(stream.next()).rejects.toThrow(
      'Malformed JSON in Code Assist stream.',
    );
  });

  it('fails embedding explicitly', async () => {
    await expect(
      serverWithRequest(vi.fn()).embedContent({
        model: 'embedding',
        contents: 'hello',
      }),
    ).rejects.toThrow('Code Assist does not support embedContent.');
  });

  it('forwards caller timeouts and marks dispatch after serialization', async () => {
    const events: string[] = [];
    const serializablePart = {
      text: 'hello',
      toJSON() {
        events.push('serialize');
        return { text: 'hello' };
      },
    };
    vi.mocked(markRequestDispatched).mockImplementation(() => {
      events.push('dispatch');
    });
    const request = vi.fn().mockImplementation(() => {
      events.push('request');
      return Promise.resolve({ data: Readable.from([]) });
    });
    const stream = await serverWithRequest(request).generateContentStream(
      {
        model: 'gemini-4-argon',
        contents: [serializablePart],
        config: { httpOptions: { timeout: 25 } },
      },
      'prompt-1',
    );
    for await (const _ of stream) void _;
    expect(events).toEqual(['serialize', 'dispatch', 'request']);
    expect(request.mock.calls[0][0].timeout).toBe(25);

    await serverWithRequest(request).generateContent(
      {
        model: 'gemini-4-argon',
        contents: 'test',
        config: { httpOptions: { timeout: 30 } },
      },
      'prompt-2',
    );
    expect(request.mock.calls[1][0].timeout).toBe(30);
  });

  it('rejects a non-loopback HTTP endpoint before sending a bearer request', async () => {
    const request = vi.fn();
    vi.stubEnv('CODE_ASSIST_ENDPOINT', 'http://code-assist.example');
    await expect(
      serverWithRequest(request).generateContent(
        {
          model: 'gemini-4-argon',
          contents: 'secret-user-prompt',
        },
        'prompt-1',
      ),
    ).rejects.toThrow('Plain HTTP Code Assist endpoints must be loopback');
    expect(request).not.toHaveBeenCalled();

    vi.stubEnv('CODE_ASSIST_ENDPOINT', '');
    const body = Readable.from([]);
    request.mockResolvedValue({ data: body });
    const stream = await serverWithRequest(request).generateContentStream(
      {
        model: 'gemini-4-argon',
        contents: 'test',
      },
      'prompt-1',
    );
    for await (const _ of stream) void _;
    expect(request.mock.calls[0][0].url).toBe(
      `${CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent`,
    );
  });

  it('keeps the first SSE event when the stream starts with a BOM', async () => {
    const request = vi.fn().mockResolvedValue({
      data: Readable.from([
        '\uFEFFdata: {"response":{"candidates":[{"content":{"parts":[{"text":"first"}]}}]}}\n\n',
      ]),
    });
    const stream = await serverWithRequest(request).generateContentStream(
      {
        model: 'gemini-4-argon',
        contents: 'hello',
      },
      'prompt-1',
    );
    const first = await stream.next();
    expect(first.value.candidates?.[0]?.content?.parts?.[0]?.text).toBe(
      'first',
    );
  });

  it('destroys an uniterated stream and rejects an abort before its first next', async () => {
    const firstBody = idleStream();
    const first = await serverWithRequest(
      vi.fn().mockResolvedValue({
        data: firstBody,
      }),
    ).generateContentStream(
      {
        model: 'gemini-4-argon',
        contents: 'hello',
      },
      'prompt-1',
    );
    await first.return(undefined);
    expect(firstBody.destroyed).toBe(true);

    const secondBody = idleStream();
    const controller = new AbortController();
    const second = await serverWithRequest(
      vi.fn().mockResolvedValue({
        data: secondBody,
      }),
    ).generateContentStream(
      {
        model: 'gemini-4-argon',
        contents: 'hello',
        config: { abortSignal: controller.signal },
      },
      'prompt-1',
    );
    controller.abort(new Error('cancel-before-read'));
    await expect(second.next()).rejects.toThrow('cancel-before-read');
    expect(secondBody.destroyed).toBe(true);
  });

  it('propagates the abort reason instead of flushing after cancellation', async () => {
    const body = new Readable({ read() {} });
    body.push(
      'data: {"response":{"candidates":[{"content":{"parts":[{"text":"first"}]}}]}}\n',
    );
    const controller = new AbortController();
    const stream = await serverWithRequest(
      vi.fn().mockResolvedValue({
        data: body,
      }),
    ).generateContentStream(
      {
        model: 'gemini-4-argon',
        contents: 'hello',
        config: { abortSignal: controller.signal },
      },
      'prompt-1',
    );
    const next = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort(new Error('stop-incomplete-event'));
    await expect(next).rejects.toThrow('stop-incomplete-event');
    expect(body.destroyed).toBe(true);
  });

  it('passes errors from otherwise successful transport envelopes to the caller', async () => {
    const stream = await serverWithRequest(
      vi.fn().mockResolvedValue({
        data: Readable.from([
          'data: {"error":{"code":500,"message":"backend failed"}}\n\n',
        ]),
      }),
    ).generateContentStream(
      {
        model: 'gemini-4-argon',
        contents: 'hello',
      },
      'prompt-1',
    );
    await expect(stream.next()).rejects.toThrow('backend failed');
  });
});
