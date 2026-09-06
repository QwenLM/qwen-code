/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from './fake-openai-server.js';

type StreamToolCallDelta = {
  index: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type StreamChunk = {
  choices: Array<{
    delta: {
      tool_calls?: StreamToolCallDelta[];
    };
  }>;
};

let server: FakeOpenAIServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('fake OpenAI server', () => {
  it('serves non-streaming and streaming chat completions', async () => {
    server = await startFakeOpenAIServer(({ requestIndex }) =>
      requestIndex === 0
        ? { content: 'hello from fake model' }
        : {
            toolCalls: [
              fakeToolCall('write_file', {
                file_path: '/tmp/fake.txt',
                content: 'fake',
              }),
            ],
          },
    );

    const nonStreaming = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(nonStreaming.status).toBe(200);
    await expect(nonStreaming.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'hello from fake model',
          },
          finish_reason: 'stop',
        },
      ],
    });

    const streaming = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        stream: true,
        messages: [{ role: 'user', content: 'write' }],
      }),
    });
    expect(streaming.status).toBe(200);
    const streamText = await streaming.text();
    expect(streamText).toContain('"tool_calls"');
    expect(streamText).toContain('"write_file"');
    expect(streamText).toContain('data: [DONE]');
    expect(server.requests).toHaveLength(2);
  });

  it('streams errorContent as a single error_finish chunk', async () => {
    server = await startFakeOpenAIServer(() => ({
      errorContent: '{"error":{"message":"overloaded"}}',
    }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    const streamText = await response.text();
    expect(streamText).toContain('"finish_reason":"error_finish"');
    expect(streamText).toContain('overloaded');
    expect(streamText).toContain('data: [DONE]');
    // The error body and finish reason must ride the SAME chunk: the CLI
    // pipeline reads delta.content off the chunk that carries
    // finish_reason === 'error_finish'.
    const errorFrame = streamText
      .split('\n\n')
      .find((frame) => frame.includes('error_finish'));
    expect(errorFrame).toBeDefined();
    const payload = JSON.parse(
      errorFrame!.replace(/^data: /, ''),
    ) as unknown as {
      choices: Array<{ delta: { content?: string } }>;
    };
    expect(payload.choices[0]?.delta.content).toBe(
      '{"error":{"message":"overloaded"}}',
    );
  });

  it('holds a streamed response until the caller releases it', async () => {
    let release!: () => void;
    server = await startFakeOpenAIServer(() => ({
      contentChunks: ['HELD_FIRST_DELTA', 'HELD_SECOND_DELTA'],
      holdAfterChunks: 1,
      holdUntil: new Promise<void>((resolve) => {
        release = resolve;
      }),
    }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('HELD_FIRST_DELTA');
    // The unresolved read is the assertion — and it has to survive the timeout,
    // since a read the race abandons still consumes the chunk when it lands.
    const pending = reader.read();
    const arrived = await Promise.race([
      pending.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(
      arrived,
      'Nothing may reach the client while the stream is held',
    ).toBe(false);

    release();
    let rest = '';
    let result = await pending;
    while (!result.done) {
      rest += decoder.decode(result.value, { stream: true });
      result = await reader.read();
    }
    expect(rest).toContain('HELD_SECOND_DELTA');
    expect(rest).toContain('data: [DONE]');
  });

  it('closes while a held response stays unreleased', async () => {
    server = await startFakeOpenAIServer(() => ({
      contentChunks: ['UNRELEASED_DELTA'],
      holdAfterChunks: 1,
      holdUntil: new Promise<void>(() => {}),
    }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain(
      'UNRELEASED_DELTA',
    );

    // A case that forgets to release must not be able to keep the server (and
    // so the run) open: close() tears the held connection down under it.
    await expect(server.close()).resolves.toBeUndefined();
    server = undefined;
    const torn = await reader.read().catch(() => ({ done: true as const }));
    expect(torn.done).toBe(true);
  });

  it('can close response connections for isolated latency measurements', async () => {
    server = await startFakeOpenAIServer(
      () => ({ content: 'no connection reuse' }),
      { keepAlive: false },
    );

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('connection')).toBe('close');
    await response.text();
  });

  it('closes non-streaming response connections when keepAlive is disabled', async () => {
    server = await startFakeOpenAIServer(() => ({ content: 'no reuse' }), {
      keepAlive: false,
    });

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('connection')).toBe('close');
    await response.text();
  });

  it('preserves a caller-requested close for default non-streaming responses', async () => {
    server = await startFakeOpenAIServer(() => ({ content: 'closed' }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'fake-model',
        stream: false,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('connection')).toBe('close');
    await response.text();
  });

  it('closes idempotently', async () => {
    server = await startFakeOpenAIServer(() => ({ content: 'unused' }));

    const firstClose = server.close();
    const secondClose = server.close();

    expect(secondClose).toBe(firstClose);
    await Promise.all([firstClose, secondClose]);
  });

  it('serves non-streaming tool calls with null content', async () => {
    server = await startFakeOpenAIServer(() => ({
      toolCalls: [
        fakeToolCall('write_file', {
          file_path: '/tmp/fake.txt',
          content: 'fake',
        }),
      ],
    }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'use a tool' }],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ function: { name: 'write_file' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  });

  it('streams tool call arguments as deltas', async () => {
    server = await startFakeOpenAIServer(() => ({
      toolCalls: [
        fakeToolCall(
          'write_file',
          {
            file_path: '/tmp/fake.txt',
            content: 'fake',
          },
          'call_fixed',
        ),
      ],
    }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        stream: true,
        messages: [{ role: 'user', content: 'write' }],
      }),
    });

    expect(response.status).toBe(200);
    const toolCallDeltas = (await response.text())
      .split('\n\n')
      .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)) as StreamChunk)
      .flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    expect(toolCallDeltas).toEqual([
      {
        index: 0,
        id: 'call_fixed',
        type: 'function',
        function: { name: 'write_file', arguments: '' },
      },
      {
        index: 0,
        function: {
          arguments: '{"file_path":"/tmp/fake.txt","content":"fake"}',
        },
      },
    ]);
  });

  it('returns 404 for wrong methods or paths', async () => {
    server = await startFakeOpenAIServer(() => ({ content: 'unused' }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'GET',
    });

    expect(response.status).toBe(404);
  });

  it('returns 400 for malformed JSON bodies', async () => {
    server = await startFakeOpenAIServer(() => ({ content: 'unused' }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('rejects oversized request bodies', async () => {
    let handled = false;
    server = await startFakeOpenAIServer(() => {
      handled = true;
      return { content: 'unused' };
    });

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(10 * 1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    expect(handled).toBe(false);
  });

  it('returns 500 without exposing handler error details', async () => {
    server = await startFakeOpenAIServer(() => {
      throw new Error('secret stack detail');
    });

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: 'fake OpenAI server handler failed',
        type: 'server_error',
      },
    });
  });

  it('closes the response when streaming fails after headers are sent', async () => {
    server = await startFakeOpenAIServer(() => ({
      content: 1n as unknown as string,
    }));

    await expect(
      fetch(`${server.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'fake-model',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    ).rejects.toThrow();
  });
});
