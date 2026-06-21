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
});
