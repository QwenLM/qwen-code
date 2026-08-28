/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  userMessageContains,
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

describe('userMessageContains', () => {
  it('matches plain string user content', () => {
    const body = {
      messages: [{ role: 'user', content: 'Read test.txt.' }],
    };
    expect(userMessageContains(body, 'Read test.txt.')).toBe(true);
  });

  it('matches text blocks sent by the CLI stream-json format', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<system-reminder>context</system-reminder>',
            },
            { type: 'text', text: 'Create hello.txt.' },
          ],
        },
      ],
    };
    expect(userMessageContains(body, 'Create hello.txt.')).toBe(true);
  });

  it('matches prompts containing quotes against raw text', () => {
    // JSON.stringify would escape the quotes, so matching on a serialized
    // form would miss every prompt containing `"` — the exact prompts the
    // tool-control suite triggers on.
    const body = {
      messages: [
        { role: 'user', content: 'Run "echo hello" and "ls -la" commands.' },
      ],
    };
    expect(
      userMessageContains(body, 'Run "echo hello" and "ls -la" commands.'),
    ).toBe(true);
  });

  it('ignores non-user messages and absent content', () => {
    const body = {
      messages: [
        { role: 'system', content: 'Read test.txt.' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Read test.txt.' }],
        },
      ],
    };
    expect(userMessageContains(body, 'Read test.txt.')).toBe(false);
    expect(userMessageContains({}, 'Read test.txt.')).toBe(false);
  });
});
