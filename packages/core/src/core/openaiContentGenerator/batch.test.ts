/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import type OpenAI from 'openai';
import {
  BatchNotRetryableError,
  completionAsChunk,
  isNonRetryableBatchError,
  runBatchCompletion,
  singleChunkStream,
} from './batch.js';
import { isRetryableUpstreamError } from '../../utils/retryErrorClassification.js';
import { getErrorStatus } from '../../utils/errors.js';

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: 'qwen-plus',
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        reasoning_content: 'thinking',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'ls', arguments: '{}' },
          },
        ],
      },
    },
  ],
} as unknown as OpenAI.Chat.ChatCompletion;

const outputLine = (body: unknown, status_code = 200) =>
  new Response(
    JSON.stringify({ custom_id: 'turn', response: { status_code, body } }) +
      '\n',
  );

function mockClient() {
  return {
    baseURL: 'https://dashscope.test/compatible-mode/v1',
    apiKey: 'sk-test',
    files: {
      content: vi.fn(),
      delete: vi.fn().mockResolvedValue({}),
    },
    batches: {
      create: vi.fn(),
      retrieve: vi.fn(),
      cancel: vi.fn().mockResolvedValue({}),
    },
  };
}

const request = {
  model: 'qwen-plus',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  stream_options: { include_usage: true },
} as OpenAI.Chat.ChatCompletionCreateParams;

describe('runBatchCompletion', () => {
  let client: ReturnType<typeof mockClient>;
  // The input file goes up through the global fetch, not the SDK: the SDK
  // refuses multipart for a client carrying a custom fetch (see batch.ts).
  let uploadFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    client = mockClient();
    // A fresh Response per call: a Response body can only be read once, and
    // the multi-call tests below must not die on an already-consumed body.
    uploadFetch = vi
      .fn()
      .mockImplementation(async () =>
        Promise.resolve(new Response(JSON.stringify({ id: 'file-in' }))),
      );
    vi.stubGlobal('fetch', uploadFetch);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uploads the request without stream fields, polls, and returns the body', async () => {
    client.batches.create.mockResolvedValue({ id: 'b1', status: 'validating' });
    client.batches.retrieve
      .mockResolvedValueOnce({ id: 'b1', status: 'in_progress' })
      .mockResolvedValueOnce({
        id: 'b1',
        status: 'completed',
        output_file_id: 'file-out',
      });
    client.files.content.mockResolvedValue(outputLine(completion));

    const result = await runBatchCompletion(
      client as unknown as OpenAI,
      request,
      undefined,
      0,
    );

    expect(result).toEqual(completion);
    const [uploadUrl, uploadInit] = uploadFetch.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(uploadUrl).toBe('https://dashscope.test/compatible-mode/v1/files');
    expect(
      (uploadInit.headers as Record<string, string>)['Authorization'],
    ).toBe('Bearer sk-test');
    const form = uploadInit.body as FormData;
    expect(form.get('purpose')).toBe('batch');
    const line = JSON.parse((await (form.get('file') as File).text()).trim());
    expect(line).toEqual({
      custom_id: 'turn',
      method: 'POST',
      url: '/v1/chat/completions',
      body: { model: 'qwen-plus', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(client.batches.create.mock.calls[0][0]).toEqual({
      input_file_id: 'file-in',
      endpoint: '/v1/chat/completions',
      completion_window: '24h',
    });
    expect(client.batches.retrieve).toHaveBeenCalledTimes(2);
    expect(client.files.delete.mock.calls.map((c) => c[0])).toEqual([
      'file-in',
      'file-out',
    ]);
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('[batch] submitted b1'),
    );
  });

  it('surfaces a per-request failure from the error file', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b2',
      status: 'completed',
      output_file_id: null,
      error_file_id: 'file-err',
    });
    client.files.content.mockResolvedValue(
      new Response(
        JSON.stringify({
          custom_id: 'turn',
          error: { message: 'tools not supported' },
        }) + '\n',
      ),
    );
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('Batch b2 request failed: tools not supported');
    expect(client.files.delete).toHaveBeenCalledWith('file-err');
  });

  it('surfaces a per-request failure reported inside the output file', async () => {
    // A failed line comes back as a non-200 output line, not only in the
    // error file; its reason lives in the line's response body.
    client.batches.create.mockResolvedValue({
      id: 'b2s',
      status: 'completed',
      output_file_id: 'file-out',
    });
    client.files.content.mockResolvedValue(
      outputLine({ error: { message: 'input too long' } }, 400),
    );
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('Batch b2s request failed: input too long');
  });

  it('rejects a batch that settled without completing, with the reason from the error file', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b3',
      status: 'failed',
      error_file_id: 'file-err',
    });
    client.files.content.mockResolvedValue(
      new Response(
        JSON.stringify({
          custom_id: 'turn',
          error: { message: 'model unavailable in batch' },
        }) + '\n',
      ),
    );
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('Batch b3 failed: model unavailable in batch');
    expect(client.batches.cancel).not.toHaveBeenCalled();
    // Read before the cleanup that deletes it.
    expect(client.files.delete).toHaveBeenCalledWith('file-err');
  });

  it('reports a settled batch with no error file by status alone', async () => {
    client.batches.create.mockResolvedValue({ id: 'b3b', status: 'expired' });
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('Batch b3b expired');
  });

  it('keeps a settled-but-failed job’s paid output instead of deleting it', async () => {
    // `expired` (or `failed` after partial progress) can still hold lines the
    // user already paid for. Deleting them destroys a purchased result and
    // leaves no recovery path, so the files stay and stderr names one.
    client.batches.create.mockResolvedValue({
      id: 'b3c',
      status: 'expired',
      output_file_id: 'file-out',
      error_file_id: 'file-err',
    });
    client.files.content.mockResolvedValue(
      new Response(
        JSON.stringify({
          custom_id: 'turn',
          error: { message: 'window closed' },
        }) + '\n',
      ),
    );
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('Batch b3c expired: window closed');
    expect(client.files.delete).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('qwen batch fetch b3c'),
    );
  });

  it('surfaces an upload failure with the server response', async () => {
    uploadFetch.mockResolvedValue(
      new Response('{"error":{"message":"bad purpose"}}', { status: 400 }),
    );
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow(
      'POST /files -> HTTP 400: {"error":{"message":"bad purpose"}}',
    );
    expect(client.batches.create).not.toHaveBeenCalled();
  });

  it('deletes the uploaded input file when `batches.create` fails', async () => {
    // The file is already uploaded — and billed — by the time create runs, so
    // a create failure must not orphan it. The error must be typed: an
    // untyped 5xx/transport failure would be retried by the caller, and
    // POST /batches is not idempotent — a retry can create a second paid job.
    client.batches.create.mockRejectedValue(new Error('quota exceeded'));
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow(BatchNotRetryableError);
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('quota exceeded');
    expect(client.files.delete).toHaveBeenCalledWith('file-in');
    expect(client.batches.cancel).not.toHaveBeenCalled();
  });

  it('passes maxRetries: 0 to the non-idempotent batches.create', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b0',
      status: 'completed',
      output_file_id: 'file-out',
    });
    client.files.content.mockResolvedValue(outputLine(completion));
    await runBatchCompletion(
      client as unknown as OpenAI,
      request,
      undefined,
      0,
    );
    expect(client.batches.create).toHaveBeenCalledWith(
      expect.objectContaining({ input_file_id: 'file-in' }),
      expect.objectContaining({ maxRetries: 0 }),
    );
  });

  it('keeps the files and names the fetch command when reading a settled output fails', async () => {
    // The job completed and was paid for; an untyped read failure would let
    // the caller retry into a second job while `finally` deletes the answer.
    client.batches.create.mockResolvedValue({
      id: 'b7r',
      status: 'completed',
      output_file_id: 'file-out',
    });
    client.files.content.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('qwen batch fetch b7r');
    expect(client.files.delete).not.toHaveBeenCalled();
  });

  it('gives up shortly after the batch passes its own deadline', async () => {
    // A job whose status never flips must not hold the turn open forever.
    client.batches.create.mockResolvedValue({
      id: 'b7e',
      status: 'validating',
      expires_at: Math.floor(Date.now() / 1000) - 86400,
    });
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('qwen batch fetch b7e');
    // Abandoned, not cleaned up: the job may still settle server-side.
    expect(client.files.delete).not.toHaveBeenCalled();
  });

  it('bounds the wait when the job reports no expires_at', async () => {
    // `expires_at` is optional in practice (observed null on a token-plan
    // endpoint). Without a fallback bound a job whose status never flips
    // holds the turn open forever, so the documented minimum window applies.
    const startedAt = Date.now();
    const dateNow = vi.spyOn(Date, 'now');
    client.batches.create.mockResolvedValue({
      id: 'b7n',
      status: 'validating',
    });
    client.batches.retrieve.mockImplementation(async () => {
      // Past 24h + the grace, measured from the start of the wait.
      dateNow.mockReturnValue(startedAt + (24 * 60 * 60 + 601) * 1000);
      return { id: 'b7n', status: 'validating' };
    });
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('qwen batch fetch b7n');
    expect(client.files.delete).not.toHaveBeenCalled();
    dateNow.mockRestore();
  });

  it('stamps the HTTP status on an upload failure for the caller classifier', async () => {
    uploadFetch.mockImplementation(async () =>
      Promise.resolve(new Response('busy', { status: 503 })),
    );
    const error = await runBatchCompletion(
      client as unknown as OpenAI,
      request,
      undefined,
      0,
    ).then(
      () => {
        throw new Error('expected a rejection');
      },
      (e) => e,
    );
    expect(getErrorStatus(error)).toBe(503);
  });

  it('sends the configured customHeaders on the upload', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b0h',
      status: 'completed',
      output_file_id: 'file-out',
    });
    client.files.content.mockResolvedValue(outputLine(completion));
    await runBatchCompletion(
      client as unknown as OpenAI,
      request,
      undefined,
      0,
      { 'x-audit': 'tenant-7' },
    );
    const [, uploadInit] = uploadFetch.mock.calls[0] as [string, RequestInit];
    expect((uploadInit.headers as Record<string, string>)['x-audit']).toBe(
      'tenant-7',
    );
  });

  it('polls with a per-poll child signal, not the turn-long signal', async () => {
    // The SDK adds a never-removed abort listener per request attempt;
    // handing it the turn signal would grow its listener list without bound
    // over a 24h wait.
    client.batches.create.mockResolvedValue({
      id: 'b0p',
      status: 'in_progress',
    });
    client.batches.retrieve.mockResolvedValue({
      id: 'b0p',
      status: 'completed',
      output_file_id: 'file-out',
    });
    client.files.content.mockResolvedValue(outputLine(completion));
    const ac = new AbortController();
    await runBatchCompletion(
      client as unknown as OpenAI,
      request,
      ac.signal,
      0,
    );
    const pollSignal = client.batches.retrieve.mock.calls[0][1]
      ?.signal as AbortSignal;
    expect(pollSignal).toBeInstanceOf(AbortSignal);
    expect(pollSignal).not.toBe(ac.signal);
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('reports the abort and cleans up when aborted during create', async () => {
    const ac = new AbortController();
    client.batches.create.mockImplementation(async () => {
      ac.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, ac.signal, 0),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.files.delete).toHaveBeenCalledWith('file-in');
    // No batch exists to cancel.
    expect(client.batches.cancel).not.toHaveBeenCalled();
  });

  it('absorbs a transient poll failure and keeps waiting on the same batch', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b5',
      status: 'in_progress',
    });
    client.batches.retrieve
      .mockRejectedValueOnce(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      )
      .mockResolvedValueOnce({
        id: 'b5',
        status: 'completed',
        output_file_id: 'file-out',
      });
    client.files.content.mockResolvedValue(outputLine(completion));

    const result = await runBatchCompletion(
      client as unknown as OpenAI,
      request,
      undefined,
      0,
    );

    expect(result).toEqual(completion);
    // One batch, not two: a retry of this function would create a second job.
    expect(client.batches.create).toHaveBeenCalledTimes(1);
    expect(uploadFetch).toHaveBeenCalledTimes(1);
  });

  it('abandons the job after repeated poll failures, leaving it recoverable', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b6',
      status: 'in_progress',
    });
    client.batches.retrieve.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );

    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('qwen batch fetch b6');

    expect(client.batches.retrieve).toHaveBeenCalledTimes(6);
    // The job is still running: do not cancel it and do not delete its input,
    // and surface an error the caller's retry will not turn into a second job.
    expect(client.batches.cancel).not.toHaveBeenCalled();
    expect(client.files.delete).not.toHaveBeenCalled();
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.not.toMatchObject({ code: 'ECONNRESET' });
  });

  it('cancels the batch and throws an AbortError when aborted while waiting', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b4',
      status: 'in_progress',
    });
    const ac = new AbortController();
    const pending = runBatchCompletion(
      client as unknown as OpenAI,
      request,
      ac.signal,
      60_000,
    );
    await vi.waitFor(() => expect(client.batches.create).toHaveBeenCalled());
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // No SDK retries on the cancel: the user is waiting on the interrupt.
    expect(client.batches.cancel).toHaveBeenCalledWith(
      'b4',
      expect.objectContaining({ maxRetries: 0 }),
    );
    expect(client.batches.retrieve).not.toHaveBeenCalled();
  });

  it('keeps the files and says so when the cancel itself fails', async () => {
    client.batches.create.mockResolvedValue({
      id: 'b4c',
      status: 'in_progress',
      input_file_id: 'file-in',
    });
    client.batches.cancel.mockRejectedValue(new Error('cancel failed'));
    const ac = new AbortController();
    const pending = runBatchCompletion(
      client as unknown as OpenAI,
      request,
      ac.signal,
      60_000,
    );
    await vi.waitFor(() => expect(client.batches.create).toHaveBeenCalled());
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    // A failed cancel leaves the job running and billing; the input file
    // must survive and the stderr hint must name the recovery commands.
    expect(client.files.delete).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('qwen batch cancel b4c'),
    );
  });
});

describe("the give-up error and the caller's retry classifier", () => {
  // The invariant fix #4 rests on: a retry re-enters runBatchCompletion from
  // the top and creates a SECOND paid job while the first may still be
  // running and unreachable.
  const withThrottleBody =
    'Batch b7 is still running, but polling it failed 6 times in a row ' +
    '({"error":{"type":"rate_limit_error","message":"Too many requests, please try again later"}}). ' +
    'Recover the result with `qwen batch fetch b7`.';
  const withHttpStatus =
    'Batch b7 is still running, but polling it failed 6 times in a row ' +
    '(HTTP_STATUS/503 upstream unavailable). Recover with `qwen batch fetch b7`.';

  it('would be retried if it were a plain Error — the guard is load-bearing', () => {
    // Not a hypothetical: the message interpolates provider-authored detail,
    // and the classifier reads provider payloads out of message text.
    expect(isRetryableUpstreamError(new Error(withThrottleBody))).toBe(true);
    expect(isRetryableUpstreamError(new Error(withHttpStatus))).toBe(true);
  });

  it('fails fast on identity, whatever the provider wrote into the message', () => {
    expect(
      isNonRetryableBatchError(new BatchNotRetryableError(withThrottleBody)),
    ).toBe(true);
    expect(
      isNonRetryableBatchError(new BatchNotRetryableError(withHttpStatus)),
    ).toBe(true);
    expect(isNonRetryableBatchError(new Error(withThrottleBody))).toBe(false);
  });

  it('sees through wrappers that keep the give-up as `cause`', () => {
    // The pipeline's error handler rethrows a timeout-shaped give-up as a
    // plain Error with the original as `cause` (stamped ETIMEDOUT); a
    // name-only check on the outer error would classify that retryable.
    const wrapped = Object.assign(
      new Error('Request timeout after 300s.', {
        cause: new BatchNotRetryableError(withThrottleBody),
      }),
      { code: 'ETIMEDOUT' },
    );
    expect(isNonRetryableBatchError(wrapped)).toBe(true);
    // The walk is bounded; a chain deeper than the cap fails open.
    let deep: Error = new BatchNotRetryableError(withThrottleBody);
    for (let i = 0; i < 6; i += 1) deep = new Error('wrap', { cause: deep });
    expect(isNonRetryableBatchError(deep)).toBe(false);
  });

  it('is the type every give-up path throws', async () => {
    const client = mockClient();
    // A fresh Response per call: a Response body can only be read once.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify({ id: 'file-in' })),
        ),
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    client.batches.create.mockResolvedValue({
      id: 'b8',
      status: 'in_progress',
    });
    client.batches.retrieve.mockRejectedValue(new Error('socket hang up'));

    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toBeInstanceOf(BatchNotRetryableError);

    client.batches.create.mockResolvedValue({ id: 'b9', status: 'expired' });
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toBeInstanceOf(BatchNotRetryableError);

    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
});

describe('completionAsChunk', () => {
  it('replays message, reasoning, tool calls, finish reason, and usage as one chunk', async () => {
    const chunk = completionAsChunk(completion);
    expect(chunk).toMatchObject({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      usage: completion.usage,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          delta: {
            role: 'assistant',
            content: null,
            reasoning_content: 'thinking',
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                function: { name: 'ls', arguments: '{}' },
              },
            ],
          },
        },
      ],
    });
    const chunks = [];
    for await (const c of singleChunkStream(chunk)) chunks.push(c);
    expect(chunks).toEqual([chunk]);
  });
});
