/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import type { Settings } from '../config/settings.js';
import { resolveEndpoint } from './batch.js';

const provider = {
  id: 'batch-model',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  envKey: 'BATCH_KEY',
  generationConfig: { samplingParams: { temperature: 0.2, max_tokens: 1024 } },
};
const settings: Settings = {
  model: {
    name: 'chat-model',
    baseUrl: 'https://chat.example/v1',
    reasoningEffort: 'high',
  },
  security: {
    auth: {
      selectedType: AuthType.USE_ANTHROPIC,
      apiKey: 'chat-secret',
      baseUrl: 'https://chat.example/v1',
    },
  },
  modelProviders: { openai: [provider] },
  batch: { model: provider.id },
};
const env = {
  BATCH_KEY: 'batch-secret',
  OPENAI_API_KEY: 'other-secret',
  OPENAI_BASE_URL: 'https://other.example/v1',
  OPENAI_MODEL: 'other-model',
};

describe('independent Batch model', () => {
  it('resolves the registered route without chat or environment defaults leaking in', () => {
    const before = structuredClone(settings);
    const endpoint = resolveEndpoint(env, { settings });
    expect(endpoint).toMatchObject({
      apiKey: 'batch-secret',
      baseUrl: provider.baseUrl,
      model: provider.id,
      generationConfig: provider.generationConfig,
    });
    expect(endpoint.generationConfig).not.toHaveProperty('reasoning');
    expect(settings).toEqual(before);
    expect(
      resolveEndpoint(env, {
        settings: { ...settings, model: { name: 'another-chat-model' } },
      }),
    ).toEqual(endpoint);
  });

  it('supports custom provider IDs through providerProtocol', () => {
    expect(
      resolveEndpoint(env, {
        settings: {
          ...settings,
          modelProviders: { bailian: [provider] },
          providerProtocol: { bailian: AuthType.USE_OPENAI },
        },
      }).apiKey,
    ).toBe('batch-secret');
  });

  it('rejects missing or ambiguous routes and permits an exact baseUrl selection', () => {
    expect(() =>
      resolveEndpoint(env, {
        settings: {
          ...settings,
          batch: { model: 'missing' },
        },
      }),
    ).toThrow(/exactly one/);
    const duplicates = {
      ...settings,
      modelProviders: {
        openai: [
          provider,
          {
            ...provider,
            baseUrl: 'https://second.example/v1',
            envKey: 'SECOND_KEY',
          },
        ],
      },
    };
    expect(() => resolveEndpoint(env, { settings: duplicates })).toThrow(
      /exactly one/,
    );
    expect(
      resolveEndpoint(
        { ...env, SECOND_KEY: 'second-secret' },
        {
          settings: {
            ...duplicates,
            batch: { model: provider.id, baseUrl: 'https://second.example/v1' },
          },
        },
      ),
    ).toMatchObject({
      baseUrl: 'https://second.example/v1',
      apiKey: 'second-secret',
    });
  });

  it('does not fall back to ordinary credentials when the selected key is missing', () => {
    expect(() =>
      resolveEndpoint({ ...env, BATCH_KEY: undefined }, { settings }),
    ).toThrow(/envKey/);
  });

  it('rejects unsupported protocols and incomplete explicit selections', () => {
    expect(() =>
      resolveEndpoint(env, {
        settings: {
          ...settings,
          batch: { authType: 'anthropic', model: provider.id },
        },
      }),
    ).toThrow(/authType/);
    expect(() =>
      resolveEndpoint(env, {
        settings: {
          ...settings,
          batch: { authType: 'openai' },
        },
      }),
    ).toThrow(/batch.model/);
    expect(() =>
      resolveEndpoint(env, {
        settings: {
          ...settings,
          modelProviders: { openai: [{ ...provider, wireApi: 'responses' }] },
        },
      }),
    ).toThrow(/chat-completions/);
  });
});
