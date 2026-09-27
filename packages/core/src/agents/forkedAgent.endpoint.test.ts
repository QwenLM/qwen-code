/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { AuthType, createContentGenerator } from '../core/contentGenerator.js';
import { getRuntimeContentGenerator } from './runtime/agent-context.js';
import { runForkedAgent, runWithForkedChatModel } from './forkedAgent.js';

vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  return { ...actual, createContentGenerator: vi.fn() };
});

function fastConfig(selector: string) {
  const config = new Config({
    sessionId: 'fast-endpoint-regression',
    cwd: '/tmp',
    targetDir: '/tmp',
    debugMode: false,
    usageStatisticsEnabled: false,
    model: 'shared',
    authType: AuthType.USE_OPENAI,
    fastModel: selector,
    modelProvidersConfig: {
      openai: [
        {
          id: 'shared',
          baseUrl: 'https://parent.example/v1',
          envKey: 'PARENT_KEY',
        },
        { id: 'shared', envKey: 'DEFAULT_KEY' },
        {
          id: 'shared',
          baseUrl: 'https://second.example/v1',
          envKey: 'SECOND_KEY',
        },
      ],
    },
  });
  vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
    model: 'shared',
    authType: AuthType.USE_OPENAI,
    baseUrl: 'https://parent.example/v1',
    apiKey: 'parent-key',
    apiKeyEnvKey: 'PARENT_KEY',
    customHeaders: { Authorization: 'parent-secret' },
  });
  return config;
}

describe('fast endpoint selectors at the fork boundary', () => {
  beforeEach(() => {
    vi.mocked(createContentGenerator).mockReset();
    vi.stubEnv('DEFAULT_KEY', 'default-key');
    vi.stubEnv('SECOND_KEY', 'second-key');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    [
      'openai:shared\0https://api.openai.com/v1',
      AuthType.USE_OPENAI,
      'shared',
      'https://api.openai.com/v1',
      'default-key',
    ],
    [
      'qwen-oauth:coder-model\0DYNAMIC_QWEN_OAUTH_BASE_URL',
      AuthType.QWEN_OAUTH,
      'coder-model',
      'DYNAMIC_QWEN_OAUTH_BASE_URL',
      undefined,
    ],
    [
      'openai:shared\0https://second.example/v1',
      AuthType.USE_OPENAI,
      'shared',
      'https://second.example/v1',
      'second-key',
    ],
  ] as const)(
    'routes %s through the selected runtime',
    async (selector, authType, model, baseUrl, apiKey) => {
      const config = fastConfig(selector);
      expect(config.getFastModel()).toBe(selector);
      const result = await runWithForkedChatModel(
        config,
        config.getFastModel()!,
        async (modelId) => ({
          modelId,
          runtime: getRuntimeContentGenerator()?.contentGeneratorConfig,
        }),
      );
      expect(result.modelId).toBe(model);
      expect(result.runtime).toMatchObject({
        model,
        authType,
        baseUrl,
        apiKey,
      });
      expect(result.runtime?.customHeaders).toBeUndefined();
      expect(createContentGenerator).toHaveBeenCalledOnce();
    },
  );

  it('keeps a removed Advisor registry endpoint fail-closed', async () => {
    const config = fastConfig('openai:shared\0https://api.openai.com/v1');
    await expect(
      runForkedAgent({
        config,
        model: 'openai:shared\0https://api.openai.com/v1',
        modelEndpointType: 'registry',
        userMessage: 'Review this task.',
        cacheSafeParams: {
          model: 'shared',
          generationConfig: {},
          history: [],
          version: 0,
        },
      }),
    ).rejects.toThrow('no longer configured at the selected endpoint');
    expect(createContentGenerator).not.toHaveBeenCalled();
  });
});
