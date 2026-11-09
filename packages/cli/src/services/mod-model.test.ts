/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { completeModModel, resolveModModel } from './mod-model.js';

const usage = {
  promptTokenCount: 10,
  cachedContentTokenCount: 4,
  candidatesTokenCount: 5,
  totalTokenCount: 15,
};

function fakeConfig(
  options: {
    fastModel?: string;
    generateText?: (request: Record<string, unknown>) => Promise<unknown>;
  } = {},
) {
  const generateText = vi.fn(
    options.generateText ?? (async () => ({ text: 'answer', usage })),
  );
  const models = [
    { id: 'qwen-max', authType: 'openai' },
    { id: 'qwen-flash', authType: 'openai' },
    { id: 'deepseek-chat', authType: 'openai' },
    { id: 'claude-x', authType: 'anthropic' },
  ];
  const config = {
    getModel: () => 'qwen-max',
    getContentGeneratorConfig: () => ({ authType: 'openai' }),
    getFastModel: () => options.fastModel,
    getAllConfiguredModels: (authTypes?: string[]) =>
      models.filter(
        (model) => !authTypes || authTypes.includes(model.authType),
      ),
    getBaseLlmClient: () => ({ generateText }),
  } as unknown as Config;
  return { config, generateText };
}

const zero = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

describe('resolveModModel', () => {
  it("reads Claude Code's aliases as the fast and session models", () => {
    const { config } = fakeConfig({ fastModel: 'qwen-flash' });
    expect(resolveModModel(config, 'haiku').modelId).toBe('qwen-flash');
    expect(resolveModModel(config, 'sonnet').modelId).toBe('qwen-max');
    expect(resolveModModel(config, 'opus').modelId).toBe('qwen-max');
    // Without a fast model the small alias falls back to the session's.
    expect(resolveModModel(fakeConfig().config, 'haiku').modelId).toBe(
      'qwen-max',
    );
  });

  it('keeps the endpoint the fast model is pinned to', () => {
    const pinned = 'openai:qwen-flash\0https://workspace.example/v1';
    const { config } = fakeConfig({ fastModel: pinned });
    expect(resolveModModel(config, 'haiku')).toEqual({
      selector: pinned,
      modelId: 'qwen-flash',
      authType: 'openai',
    });
  });

  it('takes configured ids and refuses any other', () => {
    const { config } = fakeConfig();
    expect(resolveModModel(config, 'deepseek-chat').modelId).toBe(
      'deepseek-chat',
    );
    expect(resolveModModel(config, 'anthropic:claude-x')).toEqual({
      selector: 'anthropic:claude-x',
      modelId: 'claude-x',
      authType: 'anthropic',
    });
    expect(() => resolveModModel(config, 'gpt-unknown')).toThrow(
      'model "gpt-unknown" is not configured',
    );
  });
});

describe('completeModModel', () => {
  it('sends the prompt alone, its own system prompt and a 1024-token cap', async () => {
    const { config, generateText } = fakeConfig({ fastModel: 'qwen-flash' });
    const result = await completeModModel(
      config,
      { model: 'haiku', prompt: 'Translate', system: 'Be brief' },
      new AbortController().signal,
    );
    expect(result).toEqual({
      isAnswered: true,
      text: 'answer',
      usage: {
        input_tokens: 6,
        output_tokens: 5,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: [{ role: 'user', parts: [{ text: 'Translate' }] }],
        model: 'qwen-flash',
        systemInstruction: 'Be brief',
        promptId: 'side-query:mod-model-complete',
        config: {
          maxOutputTokens: 1024,
          thinkingConfig: { includeThoughts: false },
        },
        maxAttempts: 1,
        failClosed: true,
      }),
    );
  });

  it('keeps reasoning on when the Mod asks for an effort', async () => {
    const { config, generateText } = fakeConfig();
    await completeModModel(
      config,
      { model: 'qwen-max', prompt: 'p', effort: 'high', maxTokens: 50 },
      new AbortController().signal,
    );
    expect(generateText.mock.calls[0][0]).toMatchObject({
      config: {
        maxOutputTokens: 50,
        thinkingConfig: { includeThoughts: true },
      },
    });
    expect(generateText.mock.calls[0][0]).not.toHaveProperty(
      'systemInstruction',
    );
  });

  it("refuses a cap over the model's own output limit", async () => {
    const { config, generateText } = fakeConfig();
    await expect(
      completeModModel(
        config,
        { model: 'deepseek-chat', prompt: 'p', maxTokens: 9000 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("over deepseek-chat's output limit");
    expect(generateText).not.toHaveBeenCalled();
  });

  it('answers an empty reply, an API error and a timeout as results', async () => {
    const empty = fakeConfig({
      generateText: async () => ({ text: '', usage }),
    });
    expect(
      await completeModModel(
        empty.config,
        { model: 'qwen-max', prompt: 'p' },
        new AbortController().signal,
      ),
    ).toMatchObject({ isAnswered: false, reason: 'empty-reply' });

    const limited = fakeConfig({
      generateText: async () => {
        throw new Error('Failed to generate text content: 429', {
          cause: Object.assign(new Error('Too many requests'), { status: 429 }),
        });
      },
    });
    expect(
      await completeModModel(
        limited.config,
        { model: 'qwen-max', prompt: 'p' },
        new AbortController().signal,
      ),
    ).toEqual({
      isAnswered: false,
      reason: 'api-error',
      status: 429,
      error: 'rate_limit',
      usage: zero,
    });

    const slow = fakeConfig({
      generateText: (request) =>
        new Promise((_, reject) => {
          const signal = request['abortSignal'] as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    });
    expect(
      await completeModModel(
        slow.config,
        { model: 'qwen-max', prompt: 'p', timeoutMs: 20 },
        new AbortController().signal,
      ),
    ).toEqual({ isAnswered: false, reason: 'aborted', usage: zero });
  });
});
