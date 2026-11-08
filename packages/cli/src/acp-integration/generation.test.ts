/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { GenerateContentParameters } from '@google/genai';
import { executeGeneration } from './generation.js';

function createConfig(fastModel: string | undefined) {
  const generateContentStream = vi.fn(async function* (
    _request: GenerateContentParameters,
    _promptId: string,
  ) {
    yield {
      candidates: [{ content: { parts: [{ thought: true }] } }],
    };
    yield {
      candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
    };
    yield {
      candidates: [{ content: { parts: [{ text: ' world' }] } }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    };
  });
  const resolveForModel = vi.fn(async (model: string) => ({
    contentGenerator: { generateContentStream },
    model,
  }));
  const config = {
    getFastModel: () => fastModel,
    getModel: () => 'main-model',
    getBaseLlmClient: () => ({ resolveForModel }),
  } as unknown as Config;
  return { config, generateContentStream, resolveForModel };
}

describe('executeGeneration', () => {
  it('streams a stateless, tool-free request through the fast model', async () => {
    const { config, generateContentStream, resolveForModel } =
      createConfig('fast-model');
    const events: unknown[] = [];

    const result = await executeGeneration(
      config,
      'request-1',
      'Translate this',
      new AbortController().signal,
      async (event) => {
        events.push(event);
      },
    );

    expect(resolveForModel).toHaveBeenCalledWith('fast-model', {
      failClosed: true,
    });
    expect(generateContentStream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'fast-model',
        contents: [{ role: 'user', parts: [{ text: 'Translate this' }] }],
        config: expect.objectContaining({
          tools: [],
          thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        }),
      }),
      'generation:request-1',
    );
    expect(generateContentStream.mock.calls[0]?.[0].config).not.toHaveProperty(
      'maxOutputTokens',
    );
    expect(events).toEqual([
      { type: 'started', model: 'fast-model', modelSource: 'fast' },
      { type: 'thinking' },
      { type: 'delta', seq: 0, text: 'Hello' },
      { type: 'delta', seq: 1, text: ' world' },
    ]);
    expect(result).toEqual({
      model: 'fast-model',
      modelSource: 'fast',
      inputTokens: 4,
      outputTokens: 2,
    });
  });

  it('uses the main model when no valid fast model is available', async () => {
    const { config, resolveForModel } = createConfig(undefined);

    const result = await executeGeneration(
      config,
      'request-2',
      'Summarize this',
      new AbortController().signal,
      async () => undefined,
    );

    expect(resolveForModel).toHaveBeenCalledWith('main-model', {
      failClosed: true,
    });
    expect(result.modelSource).toBe('main');
  });

  it('falls back to the main model when the fast model cannot be resolved', async () => {
    const { config, resolveForModel } = createConfig('invalid-fast-model');
    resolveForModel.mockRejectedValueOnce(new Error('Unknown model'));

    const result = await executeGeneration(
      config,
      'request-3',
      'Rewrite this',
      new AbortController().signal,
      async () => undefined,
    );

    expect(resolveForModel).toHaveBeenNthCalledWith(1, 'invalid-fast-model', {
      failClosed: true,
    });
    expect(resolveForModel).toHaveBeenNthCalledWith(2, 'main-model', {
      failClosed: true,
    });
    expect(result).toEqual(
      expect.objectContaining({ model: 'main-model', modelSource: 'main' }),
    );
  });
});
