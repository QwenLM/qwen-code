/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { CustomProviderRegistry } from './registry.js';

describe('CustomProviderRegistry', () => {
  it('keeps secrets out of public projections', () => {
    const registry = new CustomProviderRegistry();
    registry.replace({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'top-secret-api-key',
        model: 'main-model',
      },
    });

    const publicJson = JSON.stringify(registry.getPublicProviders());
    expect(publicJson).not.toContain('top-secret-api-key');
    expect(publicJson).not.toContain('models.example.com');
    expect(registry.isCustomProviderModel('gateway/main-model')).toBe(true);
    expect(registry.getProviderForModel('gateway/main-model')).toMatchObject({
      providerId: 'gateway',
      apiKey: 'top-secret-api-key',
      baseUrl: 'https://models.example.com/v1',
    });
  });

  it('keeps provider model ids intact after the internal provider prefix', () => {
    const registry = new CustomProviderRegistry();
    const parsed = registry.replace({
      openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'secret-value',
        model: 'z-ai/glm-5.3-flash',
        models: [{ model: 'z-ai/glm-5.3-flash' }, { model: 'openrouter/auto' }],
      },
    });

    expect(parsed.issues).toEqual([]);
    expect(
      registry.getModelDescriptor('openrouter/z-ai/glm-5.3-flash'),
    ).toMatchObject({
      providerId: 'openrouter',
      modelId: 'z-ai/glm-5.3-flash',
    });
    expect(
      registry.getModelDescriptor('openrouter/openrouter/auto'),
    ).toMatchObject({
      providerId: 'openrouter',
      modelId: 'openrouter/auto',
    });
  });

  it('projects only the requested model while preserving its public descriptor', () => {
    const registry = new CustomProviderRegistry();
    registry.replace({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'main-model',
        models: [{ model: 'main-model' }, { model: 'org/other-model' }],
      },
    });
    const expected = registry
      .getPublicModels()
      .find((model) => model.key === 'gateway/org/other-model')!;
    const clone = vi.spyOn(globalThis, 'structuredClone');
    let descriptor;
    try {
      descriptor = registry.getModelDescriptor(expected.key)!;
      expect(clone).toHaveBeenCalledExactlyOnceWith(expected.capabilities);
      clone.mockClear();
      expect(registry.getModelDescriptor('platform-model')).toBeUndefined();
      expect(clone).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
    }
    expect(descriptor).toEqual(expected);
    (descriptor.capabilities.thinking.modes as string[]).push('changed');
    expect(registry.getModelDescriptor(expected.key)).toEqual(expected);
  });

  it('isolates nested public capabilities from registry state', () => {
    const registry = new CustomProviderRegistry();
    registry.replace({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    const publicThinking = registry.getPublicModels()[0]!.capabilities.thinking;
    (publicThinking.modes as unknown as string[]).push('adaptive');
    (publicThinking.supportedEffortLevels as unknown as string[]).push('low');
    (publicThinking.requiredBetasForEffort as unknown as string[]).push(
      'mutated-beta',
    );

    expect(
      registry.getModelDescriptor('alibaba/qwen3.8-max')?.capabilities.thinking,
    ).toEqual({
      modes: ['enabled'],
      requiresBudgetForEnabled: false,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      requiredBetasForEffort: [],
    });
    expect(registry.getPublicModels()[0]?.capabilities.thinking).toEqual({
      modes: ['enabled'],
      requiresBudgetForEnabled: false,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      requiredBetasForEffort: [],
    });
  });

  it('projects Anthropic protocol metadata without exposing credentials', () => {
    const registry = new CustomProviderRegistry();
    registry.replace({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'anthropic-secret',
        model: 'main-model',
        anthropic: {
          version: false,
          betas: ['custom-beta'],
          queryParams: { access_token: 'query-secret' },
        },
      },
    });

    expect(registry.getProviderForModel('gateway/main-model')).toMatchObject({
      adapter: 'anthropic-compatible',
      authType: 'bearer',
      anthropic: {
        version: false,
        betas: ['custom-beta'],
        queryParams: { access_token: 'query-secret' },
      },
    });
    expect(registry.getPublicModels()).toMatchObject([
      { key: 'gateway/main-model', format: 'anthropic' },
    ]);
    expect(JSON.stringify(registry.getPublicProviders())).not.toContain(
      'anthropic-secret',
    );
    expect(JSON.stringify(registry.getPublicProviders())).not.toContain(
      'query-secret',
    );
  });

  it('projects secret-free Responses adapter metadata with OpenAI format', () => {
    const registry = new CustomProviderRegistry();
    registry.replace({
      gateway: {
        protocol: 'openai-responses',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'responses-secret',
        model: 'main-model',
      },
    });

    expect(registry.getProviderForModel('gateway/main-model')).toMatchObject({
      adapter: 'openai-responses',
    });
    expect(registry.getPublicModels()).toMatchObject([
      {
        key: 'gateway/main-model',
        adapter: 'openai-responses',
        format: 'openai',
      },
    ]);
    expect(JSON.stringify(registry.getPublicProviders())).not.toContain(
      'responses-secret',
    );
  });

  it('materializes a referenced provider model without declared metadata', () => {
    const registry = new CustomProviderRegistry();
    const parsed = registry.replace(
      {
        alibaba: {
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: 'secret-value',
        },
      },
      ['alibaba/qwen-plus', 'qoder/ultimate', 'missing/model'],
    );

    expect(parsed.issues).toEqual([]);
    expect(registry.isCustomProviderModel('alibaba/qwen-plus')).toBe(true);
    expect(registry.isCustomProviderModel('qoder/ultimate')).toBe(false);
    expect(registry.isCustomProviderModel('missing/model')).toBe(false);
    expect(registry.getModelDescriptor('alibaba/qwen-plus')).toMatchObject({
      providerId: 'alibaba',
      modelId: 'qwen-plus',
      implicit: true,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      capabilities: {
        tools: true,
        vision: false,
        thinking: {
          modes: ['enabled'],
          requiresBudgetForEnabled: false,
        },
      },
    });
    expect(registry.getPublicModels()).toContainEqual(
      expect.objectContaining({
        key: 'alibaba/qwen-plus',
        implicit: true,
      }),
    );
  });

  it('does not register providers with the removed image configuration', () => {
    const registry = new CustomProviderRegistry();
    const parsed = registry.replace({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'chat-secret-key',
        model: 'main-model',
        image: {
          type: 'alibaba',
          baseUrl: 'https://dashscope.aliyuncs.com',
          apiKey: 'image-secret-key',
        },
      },
    });

    expect(parsed.providers).toEqual([]);
    expect(parsed.issues).toContainEqual(
      expect.objectContaining({
        field: 'image',
        message: expect.stringContaining('tools.imageGen'),
      }),
    );
    expect(registry.getModelDescriptor('gateway/main-model')).toBeUndefined();
  });

  it('keeps a model descriptor stable across credential rotation and unrelated provider updates', () => {
    const registry = new CustomProviderRegistry();
    const provider = {
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'old-secret',
      model: 'main-model',
    };
    registry.replace({ first: provider, second: provider });
    const descriptor = registry.getModelDescriptor('first/main-model')!;

    registry.replace({
      first: { ...provider, apiKey: 'new-secret' },
      second: { ...provider, baseUrl: 'https://changed.example/v1' },
    });

    expect(registry.getModelDescriptor('first/main-model')).toEqual(descriptor);
    expect(registry.getProviderForModel('first/main-model')?.apiKey).toBe(
      'new-secret',
    );
    expect(JSON.stringify(descriptor)).not.toContain('old-secret');
    expect(JSON.stringify(descriptor)).not.toContain('gateway.example');
  });

  it('retains model ownership when credentials are cleared and accepts rotated ones', () => {
    const registry = new CustomProviderRegistry();
    const provider = {
      protocol: 'anthropic',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'secret',
      model: 'main-model',
      anthropic: { queryParams: { access_token: 'query-secret' } },
    };
    registry.replace({ gateway: provider });
    const descriptor = registry.getModelDescriptor('gateway/main-model')!;
    registry.clearCredentials();
    expect(registry.isCustomProviderModel('gateway/main-model')).toBe(true);
    expect(registry.getModelDescriptor('gateway/main-model')).toEqual(
      descriptor,
    );
    expect(
      JSON.stringify(registry.getProviderForModel('gateway/main-model')),
    ).not.toContain('secret');
    registry.replace({ gateway: { ...provider, apiKey: 'rotated-secret' } });
    expect(registry.getProviderForModel('gateway/main-model')?.apiKey).toBe(
      'rotated-secret',
    );
  });

  it('ignores account-owned provider entries in settings', () => {
    const registry = new CustomProviderRegistry();

    const parsed = registry.replace({
      'qwen-subscription': {
        baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
        apiKey: 'placeholder',
        models: [{ model: 'qwen3.8-max' }],
      },
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'top-secret-api-key',
        model: 'main-model',
      },
    });

    expect(parsed.issues).toEqual([]);
    expect(parsed.providers.map((provider) => provider.providerId)).toEqual([
      'gateway',
    ]);
    expect(
      registry.isCustomProviderModel('qwen-subscription/qwen3.8-max'),
    ).toBe(false);
  });

  it('replaces state atomically and supports explicit clearing', () => {
    const registry = new CustomProviderRegistry();
    registry.replace({
      first: {
        baseUrl: 'https://first.example.com/v1',
        apiKey: 'secret-value',
        model: 'model-a',
      },
    });
    registry.replace({
      second: {
        baseUrl: 'https://second.example.com/v1',
        apiKey: 'secret-value',
        model: 'model-b',
      },
    });

    expect(registry.isCustomProviderModel('first/model-a')).toBe(false);
    expect(registry.isCustomProviderModel('second/model-b')).toBe(true);

    registry.clear();
    expect(registry.getPublicProviders()).toEqual([]);
    expect(registry.getPublicModels()).toEqual([]);
  });
});
