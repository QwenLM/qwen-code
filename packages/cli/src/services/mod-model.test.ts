/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { BaseLlmClient } from '@qwen-code/qwen-code-core/core/baseLlmClient.js';
import type { ContentGenerator } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { ModelRegistry } from '@qwen-code/qwen-code-core/models/modelRegistry.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
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
    {
      id: 'qwen-flash',
      authType: 'openai',
      baseUrl: 'https://workspace.example/v1',
    },
    { id: 'deepseek-chat', authType: 'openai' },
    { id: 'claude-x', authType: 'anthropic' },
    { id: 'inherit', authType: 'openai' },
    { id: 'constructor', authType: 'openai' },
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

  it('requires the fast model endpoint to remain configured', () => {
    const { config } = fakeConfig();
    config.getFastModel = vi.fn<Config['getFastModel']>(
      ({ requirePinnedEndpoint } = {}) => {
        if (requirePinnedEndpoint) throw new Error('stale fast endpoint');
        return 'qwen-flash';
      },
    );
    expect(() => resolveModModel(config, 'haiku')).toThrow(
      'stale fast endpoint',
    );
    expect(resolveModModel(config, 'sonnet').modelId).toBe('qwen-max');
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

  it('keeps literal ids distinct from aliases and verifies explicit endpoint pins', () => {
    const { config } = fakeConfig();
    expect(resolveModModel(config, 'openai:inherit').selector).toBe(
      'openai:inherit',
    );
    expect(resolveModModel(config, 'constructor').selector).toBe(
      'openai:constructor',
    );
    const pin = 'openai:qwen-flash\0https://workspace.example/v1';
    expect(resolveModModel(config, pin).selector).toBe(pin);
    expect(() =>
      resolveModModel(config, 'openai:qwen-flash\0https://other.example/v1'),
    ).toThrow('is not configured');
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
        model: 'openai:qwen-flash',
        systemInstruction: 'Be brief',
        promptId: 'side-query:mod-model-complete',
        config: {
          maxOutputTokens: 1024,
          thinkingConfig: { includeThoughts: false },
        },
        isolatedRequest: true,
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
      generateText: () => new Promise(() => {}),
    });
    expect(
      await completeModModel(
        slow.config,
        { model: 'qwen-max', prompt: 'p', timeoutMs: 20 },
        new AbortController().signal,
      ),
    ).toEqual({ isAnswered: false, reason: 'aborted', usage: zero });
  });

  it('keeps a wrapped quota exhaustion status without treating it as transient', async () => {
    const { config } = fakeConfig({
      generateText: async () => {
        const quota = Object.assign(
          new Error('Quota exhausted. The quota will reset at 09:00 UTC.'),
          { status: 429 },
        );
        throw new Error('Failed to generate text content', {
          cause: new Error(
            'Quota exhausted: please retry after the reset time',
            {
              cause: quota,
            },
          ),
        });
      },
    });
    await expect(
      completeModModel(
        config,
        { model: 'sonnet', prompt: 'p' },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      isAnswered: false,
      reason: 'api-error',
      status: 429,
      error: 'billing_error',
    });
  });

  it('sends one HTTP attempt to the selected endpoint with only its credentials', async () => {
    const headers: Array<{ authorization?: string; primary?: string }> = [];
    const server = createServer((request, response) => {
      const authorization = request.headers.authorization;
      const repeated = headers.some(
        (entry) => entry.authorization === authorization,
      );
      headers.push({
        authorization,
        primary: request.headers['x-primary-only'] as string | undefined,
      });
      request.resume();
      response.writeHead(repeated ? 418 : 429, {
        'content-type': 'application/json',
        'retry-after-ms': '1',
      });
      response.end(JSON.stringify({ error: { message: 'Too many requests' } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('No server address');
      const targetUrl = `http://127.0.0.1:${address.port}/v1`;
      vi.stubEnv('QWEN_CODE_UNATTENDED_RETRY', '1');
      vi.stubEnv('OPENAI_API_KEY', 'sdk-default-key');
      vi.stubEnv('QWEN_TEST_MOD_TARGET_KEY', 'target-key');
      vi.stubEnv('QWEN_TEST_MOD_MISSING_KEY', undefined);
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'other',
            baseUrl: 'http://127.0.0.1:1/v1',
            envKey: 'QWEN_TEST_MOD_MISSING_KEY',
          },
          {
            id: 'other',
            baseUrl: targetUrl,
            envKey: 'QWEN_TEST_MOD_TARGET_KEY',
          },
          {
            id: 'missing-key',
            baseUrl: targetUrl,
            envKey: 'QWEN_TEST_MOD_MISSING_KEY',
          },
          { id: 'default-key', baseUrl: targetUrl },
          { id: 'default-primary-key', baseUrl: targetUrl },
        ],
      });
      const primary = {
        model: 'primary',
        authType: AuthType.USE_OPENAI,
        apiKey: 'primary-key',
        apiKeyEnvKey: 'QWEN_TEST_MOD_PRIMARY_KEY',
        baseUrl: 'http://127.0.0.1:2/v1',
        customHeaders: { 'x-primary-only': 'primary-secret' },
      };
      const primaryGenerate = vi.fn();
      const config = {
        getModel: () => primary.model,
        getContentGeneratorConfig: () => primary,
        getBaseLlmClient: () => client,
        getAllConfiguredModels: () =>
          registry.getModelsForAuthType(AuthType.USE_OPENAI),
        getModelsConfig: () => ({
          getResolvedModel: registry.getModel.bind(registry),
        }),
        getSessionId: () => 'mod-model-test',
        getCliVersion: () => 'test',
        getProxy: () => undefined,
        getTelemetryUserId: () => undefined,
        getTelemetryLogPromptsEnabled: () => false,
        getTelemetrySensitiveSpanAttributeMaxLength: () => undefined,
        getChatRecordingService: () => undefined,
      } as unknown as Config;
      const client = new BaseLlmClient(
        { generateContent: primaryGenerate } as unknown as ContentGenerator,
        config,
      );
      const pinned = `openai:other\0${targetUrl}`;
      // A normal side query may already have cached a non-isolated generator.
      await client.resolveForModel(pinned);
      await expect(
        completeModModel(
          config,
          { model: pinned, prompt: 'p' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ reason: 'api-error', status: 429 });
      await expect(
        completeModModel(
          config,
          { model: 'openai:missing-key', prompt: 'p' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ reason: 'api-error', status: null });
      await expect(
        completeModModel(
          config,
          { model: 'openai:default-key', prompt: 'p' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ reason: 'api-error', status: 429 });
      vi.stubEnv('OPENAI_API_KEY', primary.apiKey);
      await expect(
        completeModModel(
          config,
          { model: 'openai:default-primary-key', prompt: 'p' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ reason: 'api-error', status: null });
      expect(headers).toEqual([
        { authorization: 'Bearer target-key', primary: undefined },
        { authorization: 'Bearer sdk-default-key', primary: undefined },
      ]);
      expect(primaryGenerate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
