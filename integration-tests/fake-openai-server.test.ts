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
              fakeToolCall(
                'write_file',
                {
                  file_path: '/tmp/fake.txt',
                  content: 'fake',
                },
                'call_write_file',
              ),
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
    expect(streamText).toContain('"id":"call_write_file"');
    expect(streamText).toContain('"function":{"name":"write_file"}');
    expect(streamText).toContain(
      '"function":{"arguments":"{\\"file_path\\":\\"/tmp/fake.txt\\",\\"content\\":\\"fake\\"}"}',
    );
    expect(streamText).not.toContain(
      '"function":{"name":"write_file","arguments":',
    );
    expect(streamText).toContain('data: [DONE]');
    expect(server.requests).toHaveLength(2);
  });

  it('serves non-streaming tool calls with null content', async () => {
    server = await startFakeOpenAIServer(() => ({
      toolCalls: [
        fakeToolCall(
          'write_file',
          {
            file_path: '/tmp/fake.txt',
            content: 'fake',
          },
          'call_write_file',
        ),
      ],
    }));

    const response = await fetch(`${server.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake-model',
        messages: [{ role: 'user', content: 'write' }],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_write_file',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    file_path: '/tmp/fake.txt',
                    content: 'fake',
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
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
