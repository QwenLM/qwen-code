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
import { FireworksOpenAICompatibleProvider } from './fireworks.js';

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
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/qwen3p8-max',
    ...overrides,
  } as ContentGeneratorConfig;
}

function createReasoningRequest(): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model: 'accounts/fireworks/models/qwen3p8-max',
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

describe('Fireworks provider reasoning-mirror suppression (issue #11657)', () => {
  it('drops the mirrored reasoning field for api.fireworks.ai while preserving reasoning_content, without mutating the source history', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.fireworks.ai/inference/v1',
        model: 'accounts/fireworks/models/qwen3p8-max',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(result.messages?.[1]).toEqual({
      role: 'assistant',
      content: 'Hey! How can I help?',
      reasoning_content: 'The user said test.',
    });
    expect(
      (originalRequest.messages[1] as { reasoning?: string }).reasoning,
    ).toBeUndefined();
  });

  it('drops the mirrored reasoning field for Fireworks subdomains', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://inference.api.fireworks.ai/v1',
        model: 'accounts/fireworks/models/qwen3p8-max',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect(
      (result.messages?.[1] as { reasoning?: string }).reasoning,
    ).toBeUndefined();
    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('The user said test.');
  });

  it('does not treat hostile hostnames containing api.fireworks.ai as Fireworks', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.fireworks.ai.evil.example/v1',
        model: 'accounts/fireworks/models/qwen3p8-max',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    // Falls through to the default provider, which mirrors reasoning_content
    // into reasoning for qwen3 model names.
    expect((result.messages?.[1] as { reasoning?: string }).reasoning).toBe(
      'The user said test.',
    );
  });

  it('keeps an explicit reasoning field that differs from reasoning_content', () => {
    const request = createReasoningRequest();
    (request.messages[1] as { reasoning?: string }).reasoning =
      'Canonical reasoning field';
    const provider = determineProvider(
      createProviderConfig({}),
      createCliConfig(),
    );

    const result = provider.buildRequest(request, 'prompt-123');

    expect((result.messages?.[1] as { reasoning?: string }).reasoning).toBe(
      'Canonical reasoning field',
    );
    expect(
      (result.messages?.[1] as { reasoning_content?: string })
        .reasoning_content,
    ).toBe('The user said test.');
  });

  it('leaves non-Fireworks qwen3 endpoints mirroring as before', () => {
    const originalRequest = createReasoningRequest();
    const provider = determineProvider(
      createProviderConfig({
        baseUrl: 'https://api.openai.com/v1',
        model: 'accounts/other-vendor/models/qwen3-something',
      }),
      createCliConfig(),
    );

    const result = provider.buildRequest(originalRequest, 'prompt-123');

    expect((result.messages?.[1] as { reasoning?: string }).reasoning).toBe(
      'The user said test.',
    );
  });
});

describe('tool-call continuation against a Fireworks-like strict endpoint (issue #11657)', () => {
  /**
   * Local stand-in for Fireworks: accepts OpenAI-compatible chat
   * completions with `reasoning_content` (which Fireworks documents for
   * reasoning replay) but rejects the mirrored `reasoning` field with the
   * same validation payload api.fireworks.ai returns.
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
        const carriesMirroredReasoning = (
          body['messages'] as Array<Record<string, unknown>> | undefined
        )?.some(
          (message) =>
            message['role'] === 'assistant' && 'reasoning' in message,
        );
        if (carriesMirroredReasoning) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              detail: [
                {
                  type: 'extra_forbidden',
                  loc: ['body', 'messages', 2, 'reasoning'],
                  msg: 'Extra inputs are not permitted',
                  input: 'The user said test.',
                },
              ],
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
    baseUrl = `http://127.0.0.1:${port}/inference/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('continues a qwen3 tool-call conversation without shipping the mirrored reasoning field', async () => {
    // The stand-in runs on 127.0.0.1, not api.fireworks.ai, so hostname
    // detection (covered above) cannot wire the provider here; construct it
    // directly. The generator runs the real path: session history ->
    // converter -> provider boundary -> wire.
    const providerConfig = createProviderConfig({ baseUrl });
    const cliConfig = createCliConfig();
    const generator = new OpenAIContentGenerator(
      providerConfig,
      cliConfig,
      new FireworksOpenAICompatibleProvider(providerConfig, cliConfig),
    );

    // Turn 1 — a thinking turn that returns a tool call.
    const turn1: GenerateContentParameters = {
      model: 'accounts/fireworks/models/qwen3p8-max',
      contents: [{ role: 'user', parts: [{ text: 'test' }] }],
    };
    const response1 = await generator.generateContent(turn1, 'prompt-1');
    expect(response1.candidates?.[0]?.content?.parts?.[0]).toMatchObject({
      text: 'Sure, go ahead.',
    });

    // Turn 2 — history carries the model's prior thinking as a thought
    // part, exactly what the session history holds after a thinking turn;
    // on main this turn fails with `400 Extra inputs are not permitted,
    // field: 'messages[2].reasoning'`.
    const turn2: GenerateContentParameters = {
      model: 'accounts/fireworks/models/qwen3p8-max',
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

    // The strict endpoint accepted both turns, reasoning_content was
    // preserved on the wire, and the mirrored reasoning field never left.
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
      reasoning_content: 'The user said test.',
    });
    expect(assistantOnWire).not.toHaveProperty('reasoning');
  });
});
