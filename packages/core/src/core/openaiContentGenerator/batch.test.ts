/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import {
  completionAsChunk,
  runBatchCompletion,
  singleChunkStream,
} from './batch.js';

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
    files: {
      create: vi.fn().mockResolvedValue({ id: 'file-in' }),
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
  beforeEach(() => {
    client = mockClient();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

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
    const upload = client.files.create.mock.calls[0][0];
    expect(upload.purpose).toBe('batch');
    const line = JSON.parse((await upload.file.text()).trim());
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

  it('rejects a batch that settled without completing', async () => {
    client.batches.create.mockResolvedValue({ id: 'b3', status: 'expired' });
    await expect(
      runBatchCompletion(client as unknown as OpenAI, request, undefined, 0),
    ).rejects.toThrow('Batch b3 expired');
    expect(client.batches.cancel).not.toHaveBeenCalled();
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
    expect(client.batches.cancel).toHaveBeenCalledWith('b4');
    expect(client.batches.retrieve).not.toHaveBeenCalled();
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
