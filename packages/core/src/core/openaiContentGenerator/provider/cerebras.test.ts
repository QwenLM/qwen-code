/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { GenerateContentParameters } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { determineProvider } from '../index.js';
import { OpenAIContentGenerator } from '../openaiContentGenerator.js';
import { CerebrasOpenAICompatibleProvider } from './cerebras.js';

function createCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

function createProviderConfig(
  overrides: Partial<ContentGeneratorConfig>,
): ContentGeneratorConfig {
  return {
    apiKey: 'test-api-key',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'qwen-3.8-27b',
    ...overrides,
  } as ContentGeneratorConfig;
}

function createReasoningRequest(): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model: 'qwen-3.8-27b',
    messages: [
      { role: 'user', content: 'test' },
      {
        role: 'assistant',
        content: 'Hey! How can I help?',
        reasoning_content: 'The user said test.',
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam & {
        reasoning_content: string;
      },
      { role: 'user', content: 'follow-up question' },
    ],
    max_tokens: 1000,
  };
}

describe('Cerebras provider outbound compatibility filtering', () => {
  it('strips reasoning_content from outgoing requests for api.cerebras.ai without mutating the source history', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.cerebras.ai/v1',
        model: 'qwen-3.8-27b',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'Hey! How can I help?',
    });
    expect(
      (originalRequest.messages[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('The user said test.');
  });

  it('strips reasoning_content for Cerebras subdomains', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://proxy.api.cerebras.ai/v1',
        model: 'gpt-oss-120b',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'Hey! How can I help?',
    });
  });

  it('does not treat hostile hostnames containing api.cerebras.ai as Cerebras', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.cerebras.ai.evil.example/v1',
        model: 'gpt-4o',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('The user said test.');
  });

  it('preserves reasoning_content for non-Cerebras OpenAI-compatible providers', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('The user said test.');
  });
});

describe('multi-turn against a Cerebras-like strict endpoint (issue #11045)', () => {
  /**
   * Local stand-in for Cerebras: accepts OpenAI-compatible chat completions
   * but rejects any request whose body carries the `reasoning_content`
   * field, with the same payload api.cerebras.ai returns.
   */
  let server: http.Server;
  let baseUrl: string;
  let receivedBodies: Array<Record<string, unknown>>;

  beforeAll(async () => {
    // The generator's constructor builds undici-backed fetch options
    // synchronously; production preloads undici in createContentGenerator.
    const { preloadRuntimeFetchModule } = await import(
      '../../../utils/runtimeFetchOptions.js'
    );
    await preloadRuntimeFetchModule();

    receivedBodies = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        receivedBodies.push(body);
        if (raw.includes('reasoning_content')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              message:
                "messages.1.assistant.reasoning_content: property 'messages.1.assistant.reasoning_content' is unsupported",
              type: 'invalid_request_error',
              param: 'validation_error',
              code: 'wrong_api_format',
            }),
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1757000000,
            model: body['model'],
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Sure, go ahead.' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('replays reasoning history on follow-up turns without shipping reasoning_content', async () => {
    // Wire the Cerebras provider at the local stand-in endpoint; detection
    // by hostname is covered above. The generator runs the real path:
    // session history -> converter -> provider boundary -> wire.
    const providerConfig = createProviderConfig({
      baseUrl,
      model: 'qwen-3.8-27b',
    });
    const cliConfig = createCliConfig();
    const generator = new OpenAIContentGenerator(
      providerConfig,
      cliConfig,
      new CerebrasOpenAICompatibleProvider(providerConfig, cliConfig),
    );

    // Turn 1 — no history, succeeds.
    const turn1: GenerateContentParameters = {
      model: 'qwen-3.8-27b',
      contents: [{ role: 'user', parts: [{ text: 'test' }] }],
    };
    const response1 = await generator.generateContent(turn1, 'prompt-1');
    expect(response1.candidates?.[0]?.content?.parts?.[0]).toMatchObject({
      text: 'Sure, go ahead.',
    });

    // Turn 2 — history carries the model's prior thinking as a thought part,
    // exactly what the session history holds after a thinking turn.
    const turn2: GenerateContentParameters = {
      model: 'qwen-3.8-27b',
      contents: [
        { role: 'user', parts: [{ text: 'test' }] },
        {
          role: 'model',
          parts: [
            { text: 'The user said test.', thought: true },
            { text: 'Hey! How can I help?' },
          ],
        },
        { role: 'user', parts: [{ text: 'follow-up question' }] },
      ],
    };
    const response2 = await generator.generateContent(turn2, 'prompt-2');
    expect(response2.candidates?.[0]?.content?.parts?.[0]).toMatchObject({
      text: 'Sure, go ahead.',
    });

    // The strict endpoint accepted both turns, and the follow-up request
    // that reached the wire never carried reasoning_content.
    const followUp = receivedBodies[1] as {
      messages?: Array<Record<string, unknown>>;
    };
    expect(followUp.messages).toBeDefined();
    const assistantOnWire = followUp.messages?.find(
      (message) => message['role'] === 'assistant',
    );
    expect(assistantOnWire).toMatchObject({
      role: 'assistant',
      content: 'Hey! How can I help?',
    });
    expect(assistantOnWire).not.toHaveProperty('reasoning_content');
  });
});
