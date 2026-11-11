/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseCustomProviderSettings } from './parser.js';

describe('parseCustomProviderSettings', () => {
  it('uses an estimated budget only when capacity is undeclared', () => {
    const result = parseCustomProviderSettings({ gateway: {
      baseUrl: 'https://gateway.example/v1', apiKey: '',
      models: [{ model: 'unknown' }, { model: 'declared', contextWindow: 256000 }],
    } });
    expect(result.issues).toEqual([]);
    expect(result.providers[0].models.get('unknown')).toMatchObject({ contextWindow: 128000, contextWindowEstimated: true });
    expect(result.providers[0].models.get('declared')?.contextWindow).toBe(256000);
    expect(result.providers[0].models.get('declared')?.contextWindowEstimated).toBeUndefined();
  });

  it('accepts an explicit empty API key for an unauthenticated endpoint', () => {
    const result = parseCustomProviderSettings({
      local: {
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'local-model',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      providerId: 'local',
      apiKey: '',
      defaultModel: 'local-model',
    });
  });

  it('reserves the Qwen account provider id', () => {
    const result = parseCustomProviderSettings({
      'qwen-subscription': {
        baseUrl: 'https://api.qwen.ai/compatible-mode/v1',
        apiKey: 'placeholder',
        models: [{ model: 'qwen3.8-max' }],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues[0]?.message).toContain(
      'must not be qoder or qwen-subscription',
    );
  });

  it('continues to require an API key for Alibaba providers', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: '',
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual({
      providerId: 'alibaba',
      field: 'apiKey',
      message: 'apiKey is required and must resolve from the environment',
    });
  });

  it('uses the built-in Alibaba models without implicit size routing', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers).toHaveLength(1);
    const provider = result.providers[0];
    expect(provider.defaultModel).toBe('qwen3.8-max');
    expect(provider.routing).toEqual({});
    expect([...provider.models.keys()]).toEqual(['qwen3.8-max']);
    expect(provider.models.get('qwen3.8-max')).toMatchObject({
      capabilities: {
        vision: true,
        thinking: {
          modes: ['enabled'],
          requiresBudgetForEnabled: false,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      },
    });
    expect(provider.models.get('qwen3.8-max')).not.toHaveProperty(
      'generationDefaults',
    );
    expect(provider.timeouts.firstPayloadTimeoutMs).toBe(180_000);
    expect(provider).not.toHaveProperty('image');
  });

  it('accepts an Alibaba default model without a models metadata entry', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
        model: 'qwen-plus',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]?.defaultModel).toBe('qwen-plus');
    expect(result.providers[0]?.models.get('qwen-plus')).toMatchObject({
      modelId: 'qwen-plus',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      implicit: true,
      capabilities: {
        tools: true,
        vision: false,
        thinking: {
          modes: ['enabled'],
          requiresBudgetForEnabled: false,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        },
      },
      maxTokensField: 'max_tokens',
    });
    // Built-in metadata remains available and is not replaced by the fallback.
    const builtin = result.providers[0]?.models.get('qwen3.8-max');
    expect(builtin).toMatchObject({
      capabilities: { vision: true },
    });
    expect(builtin).not.toHaveProperty('implicit');
  });

  it.each([
    {},
    null,
    {
      type: 'alibaba',
      baseUrl: 'https://dashscope.aliyuncs.com',
      apiKey: 'image-secret-value',
    },
  ])('rejects removed provider image configuration %j', (image) => {
    const result = parseCustomProviderSettings({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'chat-secret-value',
        image,
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toEqual([
      {
        providerId: 'alibaba',
        field: 'image',
        message:
          'providers[provider].image has been removed; use tools.imageGen',
      },
    ]);
  });

  it('selects Alibaba behavior by type independently of provider id', () => {
    const result = parseCustomProviderSettings({
      'alibaba-prod': {
        type: 'alibaba',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    const provider = result.providers[0];
    expect(provider.providerId).toBe('alibaba-prod');
    expect(provider.type).toBe('alibaba');
    expect(provider.adapter).toBe('alibaba');
    expect(provider.defaultModel).toBe('qwen3.8-max');
    expect([...provider.models.keys()]).toEqual(['qwen3.8-max']);
    expect(provider.models.get('qwen3.8-max')).not.toHaveProperty(
      'generationDefaults',
    );
    expect(provider.timeouts.firstPayloadTimeoutMs).toBe(180_000);
  });

  it('normalizes the aliyun-bailian compatibility type to Alibaba', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        type: 'aliyun-bailian',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      providerId: 'gateway',
      type: 'alibaba',
      adapter: 'alibaba',
      defaultModel: 'qwen3.8-max',
    });
  });

  it('infers Alibaba behavior for the legacy aliyun-bailian provider id', () => {
    const result = parseCustomProviderSettings({
      'aliyun-bailian': {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      providerId: 'aliyun-bailian',
      type: 'alibaba',
      adapter: 'alibaba',
      defaultModel: 'qwen3.8-max',
    });
  });

  it('defaults to bearer authentication for Alibaba providers', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        type: 'alibaba',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]?.authType).toBe('bearer');
  });

  it('honors explicit api-key authentication for Alibaba providers', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        type: 'alibaba',
        authType: 'api-key',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]?.authType).toBe('api-key');
  });

  it('rejects unsupported provider types', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        type: 'unsupported',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'main-model',
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        providerId: 'gateway',
        field: 'type',
      }),
    );
  });

  it('selects the Anthropic adapter with bearer auth by default', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/compatible/v1',
        apiKey: 'secret-value',
        model: 'code-model',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      type: 'openai-compatible',
      adapter: 'anthropic-compatible',
      authType: 'bearer',
      anthropic: {
        version: '2023-06-01',
        betas: [],
        queryParams: {},
        cache: { mode: 'auto', ttl: '5m' },
      },
    });
  });

  it('selects the OpenAI Responses adapter explicitly', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'openai-responses',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'code-model',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      type: 'openai-compatible',
      adapter: 'openai-responses',
      authType: 'bearer',
    });
  });

  it('parses explicit Anthropic protocol options', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/compatible/v1',
        apiKey: 'secret-value',
        model: 'code-model',
        anthropic: {
          version: false,
          betas: ['custom-beta', 'custom-beta'],
          queryParams: { preview: 'true' },
          cache: { mode: 'auto', ttl: '1h' },
        },
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]?.anthropic).toEqual({
      version: false,
      betas: ['custom-beta'],
      queryParams: { preview: 'true' },
      cache: { mode: 'auto', ttl: '1h' },
    });
  });

  it('rejects unsafe or misplaced Anthropic protocol options', () => {
    const result = parseCustomProviderSettings({
      openai: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'code-model',
        anthropic: {},
      },
      anthropic: {
        protocol: 'anthropic',
        baseUrl: 'https://messages.example.com/v1',
        apiKey: 'secret-value',
        model: 'code-model',
        anthropic: {
          version: 'bad\nvalue',
          betas: ['bad,beta'],
          queryParams: { preview: 1 },
          cache: { mode: 'sometimes', ttl: '1d' },
        },
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        'anthropic',
        'anthropic.version',
        'anthropic.betas[0]',
        'anthropic.queryParams.preview',
        'anthropic.cache.mode',
        'anthropic.cache.ttl',
      ]),
    );
  });

  it('accepts an explicit api-key override for the Anthropic adapter', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        authType: 'api-key',
        baseUrl: 'https://models.example.com/compatible/v1',
        apiKey: 'secret-value',
        model: 'code-model',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]?.authType).toBe('api-key');
  });

  it('rejects unknown protocols and authentication types', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'other',
        authType: 'cookie',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'code-model',
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'protocol' }),
        expect.objectContaining({ field: 'authType' }),
      ]),
    );
  });

  it('selects the Anthropic adapter while preserving Alibaba behavior', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        type: 'alibaba',
        protocol: 'anthropic',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      type: 'alibaba',
      adapter: 'anthropic-compatible',
      authType: 'bearer',
      defaultModel: 'qwen3.8-max',
      timeouts: { firstPayloadTimeoutMs: 180_000 },
    });
    expect(
      result.providers[0]?.models.get('qwen3.8-max')?.capabilities.thinking,
    ).toMatchObject({
      modes: ['enabled'],
      requiresBudgetForEnabled: false,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('does not couple the Alibaba Anthropic protocol to a base URL path', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        protocol: 'anthropic',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      adapter: 'anthropic-compatible',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    });
  });

  it('does not couple the Alibaba OpenAI protocol to a base URL path', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiKey: 'secret-value',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers[0]).toMatchObject({
      adapter: 'alibaba',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    });
  });

  it('rejects generation parameters at the provider level', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
        preserve_thinking: false,
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual({
      providerId: 'alibaba',
      field: 'preserve_thinking',
      message:
        'Generation parameters must be configured under model.preferences[provider/model].',
    });
  });

  it('rejects generation parameters in model declarations', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'main-model',
        models: [{ model: 'main-model', top_k: 40 }],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        providerId: 'gateway',
        field: 'models[0].top_k',
      }),
    );
  });

  it('distinguishes request maxTokens from the model output capacity', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'main-model',
        models: [{ model: 'main-model', maxTokens: 8192 }],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual({
      providerId: 'gateway',
      field: 'models[0].maxTokens',
      message:
        '`maxTokens` is a generation preference and must be configured under model.preferences[provider/model]. To declare the model output capacity here, use `maxOutputTokens`.',
    });
  });

  it('preserves built-in capabilities when an Alibaba model is partially overridden', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: 'secret-value',
        models: [{ model: 'qwen3.8-max', maxOutputTokens: 16_000 }],
      },
    });

    expect(result.issues).toEqual([]);
    const model = result.providers[0]?.models.get('qwen3.8-max');
    expect(model).toMatchObject({
      maxOutputTokens: 16_000,
      capabilities: {
        tools: true,
        vision: true,
        cacheControl: true,
        thinking: {
          modes: ['enabled'],
          requiresBudgetForEnabled: false,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          requiredBetasForEffort: [],
        },
      },
      maxTokensField: 'max_completion_tokens',
    });
    expect(model).not.toHaveProperty('generationDefaults');
  });

  it('inherits the built-in Alibaba budget policy in a partial thinking override', () => {
    const result = parseCustomProviderSettings({
      alibaba: {
        protocol: 'anthropic',
        baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
        apiKey: 'secret-value',
        models: [
          {
            model: 'qwen3.8-max',
            capabilities: {
              thinking: {
                modes: ['enabled'],
                supportsEffort: true,
              },
            },
          },
        ],
      },
    });

    expect(result.issues).toEqual([]);
    expect(
      result.providers[0]?.models.get('qwen3.8-max')?.capabilities.thinking,
    ).toEqual({
      modes: ['enabled'],
      requiresBudgetForEnabled: false,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      requiredBetasForEffort: [],
    });
  });

  it('normalizes structured thinking capabilities', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'enabled-model',
        models: [
          {
            model: 'enabled-model',
            capabilities: { thinking: { modes: ['enabled'] } },
          },
          {
            model: 'adaptive-model',
            capabilities: {
              thinking: {
                modes: ['adaptive'],
                supportsEffort: true,
                requiredBetasForEffort: ['legacy-effort-beta'],
              },
            },
          },
          {
            model: 'dual-mode-model',
            capabilities: {
              thinking: {
                modes: ['enabled', 'adaptive'],
                preferredMode: 'adaptive',
                requiresBudgetForEnabled: false,
                supportsEffort: true,
                supportedEffortLevels: [
                  'low',
                  'medium',
                  'high',
                  'xhigh',
                  'max',
                ],
              },
            },
          },
          {
            model: 'no-thinking-model',
            capabilities: {
              thinking: {
                modes: [],
              },
            },
          },
        ],
      },
    });

    expect(result.issues).toEqual([]);
    expect(
      result.providers[0]?.models.get('enabled-model')?.capabilities.thinking,
    ).toEqual({
      modes: ['enabled'],
      requiresBudgetForEnabled: true,
      supportedEffortLevels: [],
      requiredBetasForEffort: [],
    });
    expect(
      result.providers[0]?.models.get('adaptive-model')?.capabilities.thinking,
    ).toEqual({
      modes: ['adaptive'],
      // `supportsEffort: true` without an explicit list resolves to every level.
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      requiredBetasForEffort: ['legacy-effort-beta'],
    });
    expect(
      result.providers[0]?.models.get('dual-mode-model')?.capabilities.thinking,
    ).toEqual({
      modes: ['enabled', 'adaptive'],
      preferredMode: 'adaptive',
      requiresBudgetForEnabled: false,
      supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      requiredBetasForEffort: [],
    });
    expect(
      result.providers[0]?.models.get('no-thinking-model')?.capabilities
        .thinking,
    ).toEqual({
      modes: [],
      supportedEffortLevels: [],
      requiredBetasForEffort: [],
    });
  });

  it('rejects boolean thinking capabilities', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'legacy-model',
        models: [
          {
            model: 'legacy-model',
            capabilities: { thinking: true },
          },
        ],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual({
      providerId: 'gateway',
      field: 'models[0].capabilities.thinking',
      message: 'thinking capability must be an object',
    });
  });

  it('rejects the removed scalar thinking mode', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'conflicting-model',
        models: [
          {
            model: 'conflicting-model',
            capabilities: {
              thinking: {
                mode: 'enabled',
                modes: ['adaptive'],
              },
            },
          },
        ],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        field: 'models[0].capabilities.thinking.mode',
        message: 'thinking.mode has been removed; use thinking.modes',
      }),
    );
  });

  it('rejects the removed supportsBudget capability', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'budget-model',
        models: [
          {
            model: 'budget-model',
            capabilities: {
              thinking: {
                modes: ['enabled'],
                supportsBudget: true,
              },
            },
          },
        ],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        field: 'models[0].capabilities.thinking.supportsBudget',
        message:
          'thinking.supportsBudget has been removed; budget support is derived from thinking.modes',
      }),
    );
  });

  it('rejects an enabled-budget policy without the enabled mode', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'adaptive-model',
        models: [
          {
            model: 'adaptive-model',
            capabilities: {
              thinking: {
                modes: ['adaptive'],
                requiresBudgetForEnabled: false,
              },
            },
          },
        ],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        field:
          'models[0].capabilities.thinking.requiresBudgetForEnabled',
        message:
          'thinking.requiresBudgetForEnabled requires thinking.modes to include enabled',
      }),
    );
  });

  it('rejects invalid thinking effort capability levels', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        protocol: 'anthropic',
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'invalid-model',
        models: [
          {
            model: 'invalid-model',
            capabilities: {
              thinking: {
                modes: ['adaptive'],
                supportsEffort: true,
                supportedEffortLevels: ['high', 'turbo'],
              },
            },
          },
        ],
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        field: 'models[0].capabilities.thinking.supportedEffortLevels[1]',
      }),
    );
  });

  it('supports a concise one-model compatible provider', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        baseUrl: 'https://models.example.com/v1/',
        apiKey: 'secret-value',
        model: 'code-model',
      },
    });

    expect(result.issues).toEqual([]);
    const provider = result.providers[0];
    expect(provider.baseUrl).toBe('https://models.example.com/v1');
    expect(provider.defaultModel).toBe('code-model');
    expect([...provider.models.keys()]).toEqual(['code-model']);
  });

  it('preserves provider model ids containing slashes', () => {
    const result = parseCustomProviderSettings({
      openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'secret-value',
        model: 'openrouter/auto',
        models: [
          { model: 'openrouter/auto' },
          { model: 'z-ai/glm-5.3-flash' },
        ],
        routing: { utility: 'z-ai/glm-5.3-flash' },
      },
    });

    expect(result.issues).toEqual([]);
    const provider = result.providers[0];
    expect(provider.defaultModel).toBe('openrouter/auto');
    expect([...provider.models.keys()]).toEqual([
      'openrouter/auto',
      'z-ai/glm-5.3-flash',
    ]);
    expect(provider.routing).toEqual({ utility: 'z-ai/glm-5.3-flash' });
  });

  it('accepts explicit purpose routing with or without model metadata', () => {
    const valid = parseCustomProviderSettings({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'main-model',
        models: [{ model: 'main-model' }, { model: 'fast-model' }],
        routing: {
          utility: 'fast-model',
          summary: 'fast-model',
        },
      },
    });
    expect(valid.issues).toEqual([]);
    expect(valid.providers[0]?.routing).toEqual({
      utility: 'fast-model',
      summary: 'fast-model',
    });

    const implicit = parseCustomProviderSettings({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'main-model',
        routing: { utility: 'missing-model' },
      },
    });
    expect(implicit.issues).toEqual([]);
    expect(implicit.providers[0]?.routing).toEqual({
      utility: 'missing-model',
    });
    expect(implicit.providers[0]?.models.get('missing-model')).toMatchObject({
      modelId: 'missing-model',
      implicit: true,
      contextWindow: 128_000,
    });
  });

  it('ignores legacy model tier fields without activating their routing', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'secret-value',
        model: 'main-model',
        defaultSmallModel: 'small-model',
        defaultMediumModel: 'medium-model',
        defaultLargeModel: 'large-model',
        subagentModel: 'subagent-model',
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]?.defaultModel).toBe('main-model');
    expect(result.providers[0]?.routing).toEqual({});
    expect([...result.providers[0].models.keys()]).toEqual(['main-model']);
  });

  it('rejects unresolved keys and unsafe URLs without exposing the key', () => {
    const result = parseCustomProviderSettings({
      gateway: {
        baseUrl: 'https://user:password@models.example.com/v1?token=value',
        apiKey: '${MODEL_API_KEY}',
        model: 'code-model',
      },
    });

    expect(result.providers).toEqual([]);
    expect(result.issues.map((issue) => issue.field)).toEqual([
      'baseUrl',
      'apiKey',
    ]);
    expect(JSON.stringify(result.issues)).not.toContain('MODEL_API_KEY');
    expect(JSON.stringify(result.issues)).not.toContain('password');
  });

  it('isolates an invalid provider from valid providers', () => {
    const result = parseCustomProviderSettings({
      valid: {
        baseUrl: 'https://models.example.com/v1',
        apiKey: 'valid-secret',
        model: 'model-a',
      },
      invalid: {
        baseUrl: 'not-a-url',
        apiKey: 'invalid-secret',
        model: 'model-b',
      },
    });

    expect(result.providers.map((provider) => provider.providerId)).toEqual([
      'valid',
    ]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ providerId: 'invalid', field: 'baseUrl' }),
    );
  });
});
