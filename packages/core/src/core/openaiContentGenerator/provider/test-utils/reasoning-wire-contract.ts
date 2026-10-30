/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, vi } from 'vitest';
import type OpenAI from 'openai';
import type { Config } from '../../../../config/config.js';
import type { ContentGeneratorConfig } from '../../../contentGenerator.js';
import { content, userText } from '../../../../test-utils/model-fixtures.js';
import { determineProvider } from '../../index.js';
import { OpenAIContentGenerator } from '../../openaiContentGenerator.js';
import type { OpenAICompatibleProvider } from '../types.js';

type Assistant = OpenAI.Chat.ChatCompletionAssistantMessageParam & {
  reasoning_content?: string;
  reasoning?: string;
};

export function createCliConfig(): Config {
  return {
    getCliVersion: vi.fn().mockReturnValue('1.0.0'),
    getProxy: vi.fn().mockReturnValue(undefined),
  } as unknown as Config;
}

export function createReasoningRequest(
  model: string,
  assistant: Assistant = {
    role: 'assistant',
    content: 'Hey! How can I help?',
    reasoning_content: 'The user said test.',
  },
  user = 'test',
  followUp = 'follow-up question',
): OpenAI.Chat.ChatCompletionCreateParams {
  return {
    model,
    messages: [
      { role: 'user', content: user },
      { ...assistant },
      { role: 'user', content: followUp },
    ],
    max_tokens: 1000,
  };
}

export function expectOutboundRequest(
  config: ContentGeneratorConfig,
  request: OpenAI.Chat.ChatCompletionCreateParams,
  expectedAssistant: Assistant,
  cliConfig = createCliConfig(),
  userPromptId = 'prompt-123',
) {
  const original = structuredClone(request);
  const result = determineProvider(config, cliConfig).buildRequest(
    request,
    userPromptId,
  );
  expect(result.messages).toEqual([
    original.messages[0],
    expectedAssistant,
    original.messages[2],
  ]);
  expect(request).toEqual(original);
}

export async function expectReasoningReplay(
  Provider: new (
    config: ContentGeneratorConfig,
    cliConfig: Config,
  ) => OpenAICompatibleProvider,
  config: ContentGeneratorConfig,
  rejectedField: 'reasoning' | 'reasoning_content',
  expectedAssistant: Assistant,
) {
  // The generator constructs fetch options synchronously; production preloads undici.
  const { preloadRuntimeFetchModule } = await import(
    '../../../../utils/runtimeFetchOptions.js'
  );
  await preloadRuntimeFetchModule();
  const receivedBodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      receivedBodies.push(body);
      const rejected =
        rejectedField === 'reasoning_content'
          ? raw.includes(rejectedField)
          : (
              body['messages'] as Array<Record<string, unknown>> | undefined
            )?.some(
              (message) =>
                message['role'] === 'assistant' && rejectedField in message,
            );
      const rejection =
        rejectedField === 'reasoning_content'
          ? {
              message:
                "messages.1.assistant.reasoning_content: property 'messages.1.assistant.reasoning_content' is unsupported",
              type: 'invalid_request_error',
              param: 'validation_error',
              code: 'wrong_api_format',
            }
          : {
              detail: [
                {
                  type: 'extra_forbidden',
                  loc: ['body', 'messages', 2, 'reasoning'],
                  msg: 'Extra inputs are not permitted',
                  input: 'The user said test.',
                },
              ],
            };
      res.writeHead(rejected ? 400 : 200, {
        'Content-Type': 'application/json',
      });
      res.end(
        JSON.stringify(
          rejected
            ? rejection
            : {
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
              },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const providerConfig = {
      ...config,
      baseUrl: `http://127.0.0.1:${port}${new URL(config.baseUrl!).pathname}`,
    };
    const cliConfig = createCliConfig();
    // Hostname routing is checked locally; exercise history -> converter -> provider -> wire.
    const generator = new OpenAIContentGenerator(
      providerConfig,
      cliConfig,
      new Provider(providerConfig, cliConfig),
    );
    const turns = [
      [userText('test')],
      [
        userText('test'),
        content(
          'model',
          { text: 'The user said test.', thought: true },
          { text: 'Hey! How can I help?' },
        ),
        userText('follow-up question'),
      ],
    ];
    for (const [index, contents] of turns.entries()) {
      const response = await generator.generateContent(
        { model: config.model!, contents },
        `prompt-${index + 1}`,
      );
      expect(response.candidates?.[0]?.content?.parts?.[0]).toMatchObject({
        text: 'Sure, go ahead.',
      });
    }
    const firstUser = {
      role: 'user',
      content: [{ type: 'text', text: 'test' }],
    };
    expect(receivedBodies.map((body) => body['messages'])).toEqual([
      [firstUser],
      [
        firstUser,
        expectedAssistant,
        {
          role: 'user',
          content: [{ type: 'text', text: 'follow-up question' }],
        },
      ],
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
