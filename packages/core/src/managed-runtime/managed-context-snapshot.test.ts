/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { captureManagedContext } from './managed-context-snapshot.js';
import type { LlmPreparedRequest } from '../core/llm-chat.js';

describe('committed prepared context snapshot', () => {
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    'records an invalid context window as unknown (%s)',
    (contextWindowSize) => {
      const context = captureManagedContext({
        prepared: {
          request: { model: 'main', contents: [], config: {} },
          history: [],
          completedToolCallIds: [],
          routeSelector: 'main',
          providerPin: 'a'.repeat(64),
          promptTokensForClamp: 0,
        },
        turnId: 'turn',
        contextWindowSize,
        mcpToolNames: new Set(),
        origins: [],
      });
      expect(context.contextWindowSize).toBeNull();
      expect(context.thresholds).toBeNull();
    },
  );

  it('attributes actual request declarations and trusted injected origins without retaining content', () => {
    const prepared: LlmPreparedRequest = {
      request: {
        model: 'model-1',
        config: {
          systemInstruction:
            'Base instructions\nprivate workspace\nprivate memory\nprivate skill catalog',
          tools: [
            {
              functionDeclarations: [
                { name: 'read_file' },
                { name: 'mcp_remote' },
                { name: 'skill' },
              ],
            },
          ],
        },
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'hello' },
              {
                inlineData: {
                  mimeType: 'image/png',
                  data: 'secret-base64'.repeat(100_000),
                },
              },
            ],
          },
        ],
      },
      history: [],
      completedToolCallIds: [],
      routeSelector: 'main',
      providerPin: 'a'.repeat(64),
      promptTokensForClamp: 0,
    };
    const before = prepared.request.contents[0].parts;
    const context = captureManagedContext({
      prepared,
      turnId: 'turn-1',
      contextWindowSize: 100_000,
      mcpToolNames: new Set(['mcp_remote']),
      origins: [
        {
          category: 'instructionFiles',
          name: 'QWEN.md',
          text: 'private workspace',
        },
        { category: 'memoryFiles', name: 'Memory', text: 'private memory' },
        { category: 'skills', name: 'Skills', text: 'private skill catalog' },
        {
          category: 'instructionFiles',
          name: 'not-in-request',
          text: 'missing origin',
        },
      ],
    });
    expect(
      Object.values(context.breakdown).every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      ),
    ).toBe(true);
    for (const key of [
      'systemPrompt',
      'builtinTools',
      'mcpTools',
      'instructionFiles',
      'memoryFiles',
      'skills',
      'messages',
    ] as const)
      expect(context.breakdown[key]).toBeGreaterThan(0);
    expect(context.details.map((detail) => detail.name)).not.toContain(
      'not-in-request',
    );
    expect(context.inputTokens).toBeNull();
    expect(context.contextWindowSize).toBe(100_000);
    expect(context.thresholds!.hard).toBeLessThanOrEqual(1);
    expect(JSON.stringify(context)).not.toContain('private');
    expect(JSON.stringify(context)).not.toContain('secret-base64');
    expect(prepared.request.contents[0].parts).toBe(before);
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(8192);
  });
});
