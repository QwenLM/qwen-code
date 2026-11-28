/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { SettingsService } from '@qwen-code/resource';
import { parseCustomProviderSettings } from './parser.js';
import { checkCustomProviderConnection } from './check.js';

type Protocol = 'openai' | 'openai-responses' | 'anthropic';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

describe.each<Protocol>(['openai', 'openai-responses', 'anthropic'])(
  '%s check thinking and output budget',
  (protocol) => {
    it.each(['declared thinking', 'no thinking'] as const)(
      'sends no thinking parameters and a fixed output budget: %s',
      async (capability) => {
        const h = await harness(protocol);
        if (capability === 'declared thinking') {
          // 配置无法表达上游是否接受关闭思考，声明了思考能力也不能发关闭参数。
          h.runtime.models.get('check-model')!.capabilities.thinking = {
            modes: ['enabled', 'adaptive'],
            preferredMode: 'adaptive',
            supportedEffortLevels: ['low', 'medium', 'high'],
            requiredBetasForEffort: [],
          };
        }
        await expect(
          checkCustomProviderConnection(h.runtime, new SettingsService()),
        ).resolves.toBeUndefined();
        expect(h.requests).toHaveLength(1);
        const body = h.requests[0];
        expect(
          body[
            protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'
          ],
        ).toBe(16);
        for (const field of [
          'reasoning_effort',
          'enable_thinking',
          'reasoning',
          'thinking',
          'output_config',
        ]) {
          expect(body).not.toHaveProperty(field);
        }
      },
    );

    it.each([true, false])(
      'accepts a complete budget-exhausted response without answer text (visible thinking=%s)',
      async (thinking) => {
        const h = await harness(protocol, { thinking });
        await expect(
          checkCustomProviderConnection(h.runtime, new SettingsService()),
        ).resolves.toBeUndefined();
        expect(h.requests).toHaveLength(1);
      },
    );

    it('rejects reasoning output without complete protocol termination', async () => {
      const h = await harness(protocol, { truncate: true });
      await expect(
        checkCustomProviderConnection(h.runtime, new SettingsService()),
      ).rejects.toThrow('Model stream ended before completion');
    });

    it('does not treat an upstream minimum-budget rejection as success', async () => {
      const h = await harness(protocol, { status: 400 });
      await expect(
        checkCustomProviderConnection(h.runtime, new SettingsService()),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_output_budget' });
      expect(h.requests).toHaveLength(1);
    });
  },
);

async function harness(
  protocol: Protocol,
  options: { thinking?: boolean; truncate?: boolean; status?: number } = {},
) {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    if (options.status) {
      res.writeHead(options.status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: {
            code: 'invalid_output_budget',
            message: 'Output budget must be at least 32',
          },
        }),
      );
      return;
    }
    const frames = budgetFrames(protocol, options.thinking !== false);
    if (options.truncate) frames.pop();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const parsed = parseCustomProviderSettings({
    gateway: {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      apiKey: 'test-key',
      protocol,
      model: 'check-model',
      models: [{ model: 'check-model', maxOutputTokens: 8192 }],
    },
  });
  expect(parsed.issues).toEqual([]);
  return { runtime: parsed.providers[0], requests };
}

function budgetFrames(protocol: Protocol, thinking: boolean): unknown[] {
  switch (protocol) {
    case 'openai':
      return [
        {
          id: 'reply',
          choices: [
            {
              index: 0,
              delta: thinking
                ? { reasoning_content: 'Thinking' }
                : { role: 'assistant' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'reply',
          choices: [{ index: 0, delta: {}, finish_reason: 'length' }],
          usage: { completion_tokens: 16 },
        },
      ];
    case 'openai-responses':
      return [
        {
          type: 'response.created',
          response: { id: 'reply', model: 'check-model' },
        },
        ...(thinking
          ? [
              {
                type: 'response.reasoning_summary_text.delta',
                output_index: 0,
                item_id: 'reasoning-1',
                delta: 'Thinking',
              },
            ]
          : []),
        {
          type: 'response.incomplete',
          response: {
            id: 'reply',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { output_tokens: 16 },
          },
        },
      ];
    case 'anthropic':
      return [
        {
          type: 'message_start',
          message: {
            id: 'reply',
            model: 'check-model',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        ...(thinking
          ? [
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Thinking' },
              },
              { type: 'content_block_stop', index: 0 },
            ]
          : []),
        {
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 16 },
        },
        { type: 'message_stop' },
      ];
    default:
      throw new Error(`Unsupported fixture protocol: ${protocol}`);
  }
}
