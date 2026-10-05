/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ModelRegistry,
  QWEN_OAUTH_MODELS,
  modelRegistryKey,
  resolveProviderProtocol,
} from './modelRegistry.js';
import { AuthType } from '../core/contentGenerator.js';
import type {
  ModelConfig,
  ModelProvidersConfig,
  ProviderProtocolConfig,
} from './types.js';

const debugLoggerWarnSpy = vi.hoisted(() => vi.fn());

vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: debugLoggerWarnSpy,
      error: vi.fn(),
      isEnabled: () => false,
    }),
  };
});

beforeEach(() => {
  debugLoggerWarnSpy.mockClear();
});

const OPENAI_URL = 'https://api.openai.com/v1';
const PROXY_URL = 'https://proxy.example.com/v1';

/** The `{ openai: [...] }` provider map most cases build. */
const openaiOnly = (...models: ModelConfig[]) => ({ openai: models });
const openaiRegistry = (...models: ModelConfig[]) =>
  new ModelRegistry(openaiOnly(...models));
const openaiListed = (...models: ModelConfig[]) =>
  openaiRegistry(...models).getModelsForAuthType(AuthType.USE_OPENAI);

/** `{ id: 'gpt-4-turbo', name: 'GPT-4 Turbo', ...fields }`. */
const gpt4Turbo = (fields: Partial<ModelConfig>): ModelConfig => ({
  id: 'gpt-4-turbo',
  name: 'GPT-4 Turbo',
  ...fields,
});
/** A `gpt-4` entry: `{ id: 'gpt-4', name, baseUrl }`. */
const gpt4Entry = (fields: { name: string; baseUrl: string }): ModelConfig => ({
  id: 'gpt-4',
  ...fields,
});
/** Two `gpt-4` entries told apart only by baseUrl. */
const directAndProxy = () => [
  gpt4Entry({ name: 'GPT-4 Direct', baseUrl: OPENAI_URL }),
  gpt4Entry({ name: 'GPT-4 Proxy', baseUrl: PROXY_URL }),
];

const openaiName = (registry: ModelRegistry, id: string, baseUrl?: string) =>
  registry.getModel(AuthType.USE_OPENAI, id, baseUrl)?.name;
const idsOf = (registry: ModelRegistry, authType: AuthType) =>
  registry.getModelsForAuthType(authType).map((m) => m.id);
const expectHardCodedQwenCount = (registry: ModelRegistry) =>
  expect(registry.getModelsForAuthType(AuthType.QWEN_OAUTH).length).toBe(
    QWEN_OAUTH_MODELS.length,
  );

describe('ModelRegistry', () => {
  describe('initialization', () => {
    it('should always include hard-coded qwen-oauth models', () => {
      const qwenIds = idsOf(new ModelRegistry(), AuthType.QWEN_OAUTH);
      expect(qwenIds.length).toBe(QWEN_OAUTH_MODELS.length);
      expect(qwenIds[0]).toBe('coder-model');
    });

    it('should initialize with empty config', () => {
      const registry = new ModelRegistry();
      expectHardCodedQwenCount(registry);
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
    });

    it('should initialize with custom models config', () => {
      const openaiModels = openaiListed(gpt4Turbo({ baseUrl: OPENAI_URL }));
      expect(openaiModels.length).toBe(1);
      expect(openaiModels[0].id).toBe('gpt-4-turbo');
    });

    it('should ignore qwen-oauth models in config (hard-coded)', () => {
      const registry = new ModelRegistry({
        'qwen-oauth': [
          {
            id: 'custom-qwen',
            name: 'Custom Qwen',
          },
        ],
      });

      // Should still use hard-coded qwen-oauth models
      const qwenModels = registry.getModelsForAuthType(AuthType.QWEN_OAUTH);
      expect(qwenModels.length).toBe(QWEN_OAUTH_MODELS.length);
      expect(qwenModels.find((m) => m.id === 'custom-qwen')).toBeUndefined();
    });
  });

  describe('getModelsForAuthType', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = openaiRegistry(
        gpt4Turbo({
          description: 'Most capable GPT-4',
          baseUrl: OPENAI_URL,
          capabilities: { vision: true },
        }),
        {
          id: 'gpt-3.5-turbo',
          name: 'GPT-3.5 Turbo',
          capabilities: { vision: false },
        },
      );
    });

    it('should return models for existing authType', () => {
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);
    });

    it('should return empty array for non-existent authType', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_VERTEX_AI);
      expect(models.length).toBe(0);
    });

    it('should return AvailableModel format with correct fields', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      const gpt4 = models.find((m) => m.id === 'gpt-4-turbo');

      expect(gpt4).toBeDefined();
      expect(gpt4?.label).toBe('GPT-4 Turbo');
      expect(gpt4?.description).toBe('Most capable GPT-4');
      expect(gpt4?.isVision).toBe(true);
      expect(gpt4?.authType).toBe(AuthType.USE_OPENAI);
      expect(gpt4?.registryBaseUrl).toBe(OPENAI_URL);
      expect(
        models.find((m) => m.id === 'gpt-3.5-turbo')?.registryBaseUrl,
      ).toBeUndefined();
    });
  });

  describe('getModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = openaiRegistry(
        gpt4Turbo({
          baseUrl: OPENAI_URL,
          generationConfig: {
            streamIdleTimeoutMs: 600000,
            samplingParams: {
              temperature: 0.8,
              max_tokens: 4096,
            },
          },
        }),
      );
    });

    it('should return resolved model config', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4-turbo');
      expect(model?.name).toBe('GPT-4 Turbo');
      expect(model?.authType).toBe(AuthType.USE_OPENAI);
      expect(model?.baseUrl).toBe(OPENAI_URL);
    });

    it('should preserve generationConfig without applying defaults', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model?.generationConfig.samplingParams?.temperature).toBe(0.8);
      expect(model?.generationConfig.samplingParams?.max_tokens).toBe(4096);
      expect(model?.generationConfig.streamIdleTimeoutMs).toBe(600000);
      // No defaults are applied - only the configured values are present
      expect(model?.generationConfig.samplingParams?.top_p).toBeUndefined();
      expect(model?.generationConfig.timeout).toBeUndefined();
    });

    it('should return undefined for non-existent model', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'non-existent');
      expect(model).toBeUndefined();
    });

    it('should return undefined for non-existent authType', () => {
      const model = registry.getModel(AuthType.USE_VERTEX_AI, 'some-model');
      expect(model).toBeUndefined();
    });

    it('matches a plain registry key by its resolved default baseUrl', () => {
      const id = 'default-endpoint-model';
      const registry = openaiRegistry({ id });
      const get = (baseUrl?: string) =>
        registry.getModel(AuthType.USE_OPENAI, id, baseUrl);
      const unkeyed = get();

      expect(unkeyed?.baseUrl).toBeTruthy();
      expect(get(unkeyed?.baseUrl)).toBe(unkeyed);
      expect(get('https://wrong.example.com')).toBeUndefined();
    });
  });

  describe('modalities auto-fill', () => {
    // Sub-agents that read straight from the registry (e.g. via
    // getResolvedModel) need the registry to populate modalities for them;
    // otherwise they inherit the parent session's modalities and fail the
    // image/pdf/video gates set on tools like ReadFile.
    const modalitiesOf = (model: ModelConfig) =>
      openaiRegistry(model).getModel(AuthType.USE_OPENAI, model.id)
        ?.generationConfig.modalities;

    it('populates modalities from the model name when not provided', () => {
      const modalities = modalitiesOf(
        gpt4Turbo({ baseUrl: OPENAI_URL, generationConfig: {} }),
      );
      expect(modalities).toEqual({ image: true });
    });

    it('preserves caller-provided modalities verbatim', () => {
      const explicitModalities = { image: true, pdf: true };
      const generationConfig = { modalities: explicitModalities };
      const modalities = modalitiesOf(
        gpt4Turbo({ baseUrl: OPENAI_URL, generationConfig }),
      );
      expect(modalities).toEqual(explicitModalities);
    });

    it('returns text-only ({}) for models with no multimodal default', () => {
      const modalities = modalitiesOf({
        id: 'qwen3-coder-plus',
        name: 'Qwen3 Coder Plus',
        baseUrl: 'https://example.invalid',
        generationConfig: {},
      });
      expect(modalities).toEqual({});
    });

    it('populates MiniMax-M3 metadata when provider entries omit generationConfig', () => {
      const registry = openaiRegistry({
        id: 'MiniMax-M3',
        name: '[MiniMax] MiniMax-M3',
        baseUrl: 'https://api.minimaxi.com/v1',
        envKey: 'MINIMAX_API_KEY',
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'MiniMax-M3');
      expect(model?.generationConfig.modalities).toEqual({
        image: true,
        video: true,
      });

      const available = registry
        .getModelsForAuthType(AuthType.USE_OPENAI)
        .find((m) => m.id === 'MiniMax-M3');
      expect(available?.contextWindowSize).toBe(1000000);
      expect(available?.modalities).toEqual({
        image: true,
        video: true,
      });
    });

    it('normalizes stale MiniMax-M3 provider modalities to image + video', () => {
      const modalities = modalitiesOf({
        id: 'MiniMax-M3',
        name: '[MiniMax] MiniMax-M3',
        baseUrl: 'https://api.minimaxi.com/v1',
        envKey: 'MINIMAX_API_KEY',
        generationConfig: {
          modalities: { image: true },
        },
      });
      expect(modalities).toEqual({
        image: true,
        video: true,
      });
    });
  });

  describe('hasModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = openaiRegistry({ id: 'gpt-4', name: 'GPT-4' });
    });

    it('should return true for existing model', () => {
      expect(registry.hasModel(AuthType.USE_OPENAI, 'gpt-4')).toBe(true);
    });

    it('should return false for non-existent model', () => {
      expect(registry.hasModel(AuthType.USE_OPENAI, 'non-existent')).toBe(
        false,
      );
    });

    it('should return false for non-existent authType', () => {
      expect(registry.hasModel(AuthType.USE_VERTEX_AI, 'gpt-4')).toBe(false);
    });
  });

  describe('getDefaultModelForAuthType', () => {
    it('does not use service-only entries when no conversation default exists', () => {
      const registry = openaiRegistry(
        { id: 'asr', voiceOnly: true },
        { id: 'image', imageOnly: true },
      );
      expect(
        registry.getDefaultModelForAuthType(AuthType.USE_OPENAI),
      ).toBeUndefined();
    });

    it('should return coder-model for qwen-oauth', () => {
      const defaultModel = new ModelRegistry().getDefaultModelForAuthType(
        AuthType.QWEN_OAUTH,
      );
      expect(defaultModel?.id).toBe('coder-model');
    });

    it('should return first model for other authTypes', () => {
      const registry = openaiRegistry(
        { id: 'gpt-4', name: 'GPT-4' },
        { id: 'gpt-3.5', name: 'GPT-3.5' },
      );

      expect(registry.getDefaultModelForAuthType(AuthType.USE_OPENAI)?.id).toBe(
        'gpt-4',
      );
    });
  });

  describe('validation', () => {
    it('should throw error for model without id', () => {
      expect(() => openaiRegistry({ id: '', name: 'No ID' })).toThrow(
        'missing required field: id',
      );
    });
  });

  describe('default base URLs', () => {
    it('should apply default dashscope URL for qwen-oauth', () => {
      const registry = new ModelRegistry();
      const model = registry.getModel(AuthType.QWEN_OAUTH, 'coder-model');
      expect(model?.baseUrl).toBe('DYNAMIC_QWEN_OAUTH_BASE_URL');
    });

    it('should apply default openai URL when not specified', () => {
      const registry = openaiRegistry({ id: 'gpt-4', name: 'GPT-4' });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(model?.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should use custom baseUrl when specified', () => {
      const registry = openaiRegistry({
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'deepseek');
      expect(model?.baseUrl).toBe('https://api.deepseek.com/v1');
    });
  });

  describe('authType key validation', () => {
    it('should accept valid authType keys', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
      expect(openaiModels[0].id).toBe('gpt-4');

      const geminiModels = registry.getModelsForAuthType(AuthType.USE_GEMINI);
      expect(geminiModels.length).toBe(1);
      expect(geminiModels[0].id).toBe('gemini-pro');
    });

    it('should skip invalid authType keys', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        'invalid-key': [{ id: 'some-model', name: 'Some Model' }],
      } as unknown as ModelProvidersConfig);

      // Valid key should be registered
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);

      // Invalid key should be skipped (no crash)
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
    });

    it('should handle mixed valid and invalid keys', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        'bad-key-1': [{ id: 'model-1', name: 'Model 1' }],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
        'bad-key-2': [{ id: 'model-2', name: 'Model 2' }],
      } as unknown as ModelProvidersConfig);

      // Valid keys should be registered
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(1);

      // Invalid keys should be skipped
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(1);
    });

    it('should work correctly with getModelsForAuthType after validation', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
        'invalid-key': [{ id: 'invalid-model', name: 'Invalid Model' }],
      } as unknown as ModelProvidersConfig);

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(models.find((m) => m.id === 'gpt-4')).toBeDefined();
      expect(models.find((m) => m.id === 'gpt-3.5')).toBeDefined();
      expect(models.find((m) => m.id === 'invalid-model')).toBeUndefined();
    });
  });

  describe('duplicate model id handling', () => {
    it('should skip duplicate model ids (same id, no baseUrl) and use first registered config', () => {
      const registry = openaiRegistry(
        { id: 'gpt-4', name: 'GPT-4 First', description: 'First config' },
        { id: 'gpt-4', name: 'GPT-4 Second', description: 'Second config' },
        { id: 'gpt-3.5', name: 'GPT-3.5' },
      );

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);

      const gpt4 = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(gpt4).toBeDefined();
      expect(gpt4?.name).toBe('GPT-4 First');
      expect(gpt4?.description).toBe('First config');
    });

    it('should skip duplicate when both id and baseUrl match', () => {
      const models = openaiListed(
        gpt4Entry({ name: 'First', baseUrl: OPENAI_URL }),
        gpt4Entry({ name: 'Second', baseUrl: OPENAI_URL }),
      );
      expect(models.length).toBe(1);
      expect(models[0].label).toBe('First');
    });

    it('should allow same id with different baseUrls as distinct models', () => {
      const models = openaiListed(...directAndProxy());
      expect(models.length).toBe(2);
      expect(models[0].label).toBe('GPT-4 Direct');
      expect(models[1].label).toBe('GPT-4 Proxy');
      expect(models.map((model) => model.registryBaseUrl)).toEqual([
        OPENAI_URL,
        PROXY_URL,
      ]);
    });

    it('should retrieve model by id and baseUrl precisely', () => {
      const registry = openaiRegistry(...directAndProxy());

      expect(openaiName(registry, 'gpt-4', OPENAI_URL)).toBe('GPT-4 Direct');
      expect(openaiName(registry, 'gpt-4', PROXY_URL)).toBe('GPT-4 Proxy');
    });

    it('should return first match when getModel is called without baseUrl', () => {
      const registry = openaiRegistry(...directAndProxy());

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(model).toBeDefined();
      expect(model?.name).toBe('GPT-4 Direct');
    });

    it('should handle hasModel with and without baseUrl', () => {
      const registry = openaiRegistry(...directAndProxy());
      const has = (baseUrl?: string) =>
        registry.hasModel(AuthType.USE_OPENAI, 'gpt-4', baseUrl);

      expect(has()).toBe(true);
      expect(has(OPENAI_URL)).toBe(true);
      expect(has(PROXY_URL)).toBe(true);
      expect(has('https://unknown.example.com/v1')).toBe(false);
    });

    it('should handle multiple duplicate ids in same authType', () => {
      const registry = openaiRegistry(
        { id: 'model-a', name: 'Model A First' },
        { id: 'model-a', name: 'Model A Second' },
        { id: 'model-b', name: 'Model B First' },
        { id: 'model-b', name: 'Model B Second' },
        { id: 'model-c', name: 'Model C' },
      );

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(3);

      expect(openaiName(registry, 'model-a')).toBe('Model A First');
      expect(openaiName(registry, 'model-b')).toBe('Model B First');
      expect(openaiName(registry, 'model-c')).toBe('Model C');
    });

    it('should treat same id in different authTypes as different models', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'shared-model', name: 'OpenAI Shared' }],
        gemini: [{ id: 'shared-model', name: 'Gemini Shared' }],
      });

      expect(openaiName(registry, 'shared-model')).toBe('OpenAI Shared');
      expect(registry.getModel(AuthType.USE_GEMINI, 'shared-model')?.name).toBe(
        'Gemini Shared',
      );
    });
  });

  describe('reloadModels', () => {
    it('should reload models from new config', () => {
      const registry = openaiRegistry({ id: 'gpt-4', name: 'GPT-4' });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeDefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeUndefined();

      registry.reloadModels(openaiOnly({ id: 'gpt-3.5', name: 'GPT-3.5' }));

      // After reload, only new models should exist
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeUndefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeDefined();
    });

    it('should preserve hard-coded qwen-oauth models after reload', () => {
      const registry = openaiRegistry({ id: 'gpt-4', name: 'GPT-4' });

      expectHardCodedQwenCount(registry);

      registry.reloadModels(openaiOnly({ id: 'gpt-3.5', name: 'GPT-3.5' }));

      // qwen-oauth models should still exist
      expectHardCodedQwenCount(registry);
      expect(
        registry.getModel(AuthType.QWEN_OAUTH, 'coder-model'),
      ).toBeDefined();
    });

    it('should clear user-configured models when reload with empty config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(1);

      registry.reloadModels({});

      // All user-configured models should be cleared
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(0);

      // qwen-oauth models should still exist
      expectHardCodedQwenCount(registry);
    });

    it('should ignore qwen-oauth models in reload config', () => {
      const registry = new ModelRegistry();

      registry.reloadModels({
        'qwen-oauth': [{ id: 'custom-qwen', name: 'Custom Qwen' }],
      });

      // qwen-oauth should still use hard-coded models
      const qwenModels = registry.getModelsForAuthType(AuthType.QWEN_OAUTH);
      expect(qwenModels.length).toBe(QWEN_OAUTH_MODELS.length);
      expect(qwenModels.find((m) => m.id === 'custom-qwen')).toBeUndefined();
    });

    it('should handle reload with multiple authTypes', () => {
      const registry = openaiRegistry({ id: 'gpt-4', name: 'GPT-4' });

      registry.reloadModels({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Updated' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);
      expect(openaiName(registry, 'gpt-4')).toBe('GPT-4 Updated');

      expect(registry.getModelsForAuthType(AuthType.USE_GEMINI).length).toBe(1);
    });

    it('should skip invalid authType keys during reload', () => {
      const registry = openaiRegistry({ id: 'gpt-4', name: 'GPT-4' });

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
        'invalid-key': [{ id: 'invalid-model', name: 'Invalid Model' }],
      } as unknown as ModelProvidersConfig);

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeDefined();
    });

    it('keeps the previous registry when a replacement model is invalid', () => {
      const registry = new ModelRegistry(
        { idealab: [{ id: 'old-model' }] } as ModelProvidersConfig,
        { idealab: 'openai' },
      );

      expect(() =>
        registry.reloadModels(
          {
            idealab: [{ id: 'new-model' }, { id: '' }],
          } as ModelProvidersConfig,
          { idealab: 'gemini' },
        ),
      ).toThrow('missing required field: id');

      expect(registry.getModel(AuthType.USE_OPENAI, 'old-model')).toBeDefined();
      expect(
        registry.getModel(AuthType.USE_GEMINI, 'new-model'),
      ).toBeUndefined();
    });

    it('should correctly reload same-id different-baseUrl models', () => {
      const registry = openaiRegistry(
        gpt4Entry({ name: 'Old Direct', baseUrl: OPENAI_URL }),
      );

      registry.reloadModels(
        openaiOnly(
          gpt4Entry({ name: 'New Direct', baseUrl: OPENAI_URL }),
          gpt4Entry({ name: 'New Proxy', baseUrl: PROXY_URL }),
        ),
      );

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);
      expect(openaiName(registry, 'gpt-4', OPENAI_URL)).toBe('New Direct');
      expect(openaiName(registry, 'gpt-4', PROXY_URL)).toBe('New Proxy');
    });

    it('should handle reload with undefined config', () => {
      const registry = openaiRegistry({ id: 'gpt-4', name: 'GPT-4' });

      registry.reloadModels(undefined);

      // All user-configured models should be cleared
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
      // qwen-oauth models should still exist
      expectHardCodedQwenCount(registry);
    });

    it('exposes the applied providers config so hot-reload can diff against registry state', () => {
      const boot = openaiOnly({ id: 'gpt-4', name: 'GPT-4' });
      const registry = new ModelRegistry(boot);
      expect(registry.getModelProvidersConfig()).toBe(boot);

      const next = openaiOnly({ id: 'gpt-5', name: 'GPT-5' });
      registry.reloadModels(next);
      // The copy in reloadModels is load-bearing: without it the hot-reload
      // gate in registerModelProvidersHotReload would diff against a stale
      // value and rebuild the registry on every settings event.
      expect(registry.getModelProvidersConfig()).toBe(next);

      registry.reloadModels(undefined);
      expect(registry.getModelProvidersConfig()).toBeUndefined();
    });

    it('should handle reload replacing same-id entries when baseUrls change', () => {
      const oldProxy = 'https://old-proxy.example.com/v1';
      const newProxy = 'https://new-proxy.example.com/v1';
      const registry = openaiRegistry(
        gpt4Entry({ name: 'GPT-4 v1', baseUrl: OPENAI_URL }),
        gpt4Entry({ name: 'GPT-4 Proxy', baseUrl: oldProxy }),
      );

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);

      registry.reloadModels(
        openaiOnly(
          gpt4Entry({ name: 'GPT-4 v1 updated', baseUrl: OPENAI_URL }),
          gpt4Entry({ name: 'GPT-4 New Proxy', baseUrl: newProxy }),
        ),
      );

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4', oldProxy),
      ).toBeUndefined();
      expect(openaiName(registry, 'gpt-4', newProxy)).toBe('GPT-4 New Proxy');
    });

    it('should apply duplicate model id handling during reload', () => {
      const registry = new ModelRegistry();

      registry.reloadModels({
        openai: [
          { id: 'model-a', name: 'Model A First' },
          { id: 'model-a', name: 'Model A Second' },
        ],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(openaiName(registry, 'model-a')).toBe('Model A First');
    });

    it('should preserve models with same id but different baseUrls during reload', () => {
      const registry = new ModelRegistry();

      registry.reloadModels(openaiOnly(...directAndProxy()));

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);

      expect(openaiName(registry, 'gpt-4', OPENAI_URL)).toBe('GPT-4 Direct');
      expect(openaiName(registry, 'gpt-4', PROXY_URL)).toBe('GPT-4 Proxy');
    });
  });
});

describe('modelRegistryKey', () => {
  it('should return id when no baseUrl is provided', () => {
    expect(modelRegistryKey('gpt-4')).toBe('gpt-4');
    expect(modelRegistryKey('gpt-4', undefined)).toBe('gpt-4');
    expect(modelRegistryKey('gpt-4', '')).toBe('gpt-4');
  });

  it('should return composite key when baseUrl is provided', () => {
    const key = modelRegistryKey('gpt-4', OPENAI_URL);
    expect(key).toBe('gpt-4\0https://api.openai.com/v1');
    expect(key).not.toBe('gpt-4');
  });

  it('should produce different keys for same id with different baseUrls', () => {
    const key1 = modelRegistryKey('gpt-4', OPENAI_URL);
    expect(modelRegistryKey('gpt-4', PROXY_URL)).not.toBe(key1);
  });

  it('should produce same key for identical id and baseUrl', () => {
    const key1 = modelRegistryKey('gpt-4', OPENAI_URL);
    expect(modelRegistryKey('gpt-4', OPENAI_URL)).toBe(key1);
  });
});

describe('fastOnly and voiceOnly flags', () => {
  it.each([
    [
      'should propagate fastOnly flag to AvailableModel',
      'fastOnly',
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', fastOnly: true },
    ],
    [
      'should propagate voiceOnly flag to AvailableModel',
      'voiceOnly',
      { id: 'whisper-1', name: 'Whisper', voiceOnly: true },
    ],
    [
      'should propagate visionOnly flag to AvailableModel',
      'visionOnly',
      { id: 'vision-bridge', name: 'Vision Bridge', visionOnly: true },
    ],
  ] as const)('%s', (_title, flag, flagged) => {
    const models = openaiListed({ id: 'gpt-4o', name: 'GPT-4o' }, flagged);
    expect(models.find((m) => m.id === 'gpt-4o')?.[flag]).toBeUndefined();
    expect(models.find((m) => m.id === flagged.id)?.[flag]).toBe(true);
  });

  it('keeps realtimeOnly routes out of the selectable list but resolvable by id', () => {
    const registry = openaiRegistry(
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'omni-realtime', name: 'Omni Realtime', realtimeOnly: true },
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['gpt-4o']);
    // Still resolvable, so naming it as a chat model fails with a clear error
    // instead of "not found".
    expect(
      registry.getModel(AuthType.USE_OPENAI, 'omni-realtime')?.realtimeOnly,
    ).toBe(true);
  });

  it('never picks a realtimeOnly route as the default model', () => {
    const registry = openaiRegistry({
      id: 'omni-realtime',
      realtimeOnly: true,
    });
    expect(
      registry.getDefaultModelForAuthType(AuthType.USE_OPENAI),
    ).toBeUndefined();
  });

  it('should propagate imageOnly flag to AvailableModel', () => {
    const [model] = openaiListed({
      id: 'qwen-image-2.0',
      imageOnly: true,
    });
    expect(model?.imageOnly).toBe(true);
  });

  it('should propagate image generation capability without excluding the default model', () => {
    const registry = openaiRegistry({
      id: 'dual-role-model',
      supportsImageGeneration: true,
    });

    const available = registry.getModelsForAuthType(AuthType.USE_OPENAI)[0];
    expect(available?.supportsImageGeneration).toBe(true);
    expect(registry.getDefaultModelForAuthType(AuthType.USE_OPENAI)?.id).toBe(
      'dual-role-model',
    );
  });

  it('should warn when both fastOnly and voiceOnly are set', () => {
    const models = openaiListed({
      id: 'unreachable-model',
      fastOnly: true,
      voiceOnly: true,
    });
    expect(models).toHaveLength(1);
    expect(models[0].fastOnly).toBe(true);
    expect(models[0].voiceOnly).toBe(true);
  });

  it('should warn when visionOnly conflicts with another selector-only flag', () => {
    const models = openaiListed({
      id: 'unreachable-vision',
      visionOnly: true,
      voiceOnly: true,
    });
    expect(models).toHaveLength(1);
    expect(models[0].visionOnly).toBe(true);
    expect(models[0].voiceOnly).toBe(true);
  });
});

describe('malformed modelProviders tolerance', () => {
  it('skips a non-array provider value instead of throwing (legacy V5 { protocol, models })', () => {
    // A settings file still in the reverted #5089 V5 shape can deliver a
    // { protocol, models } object here instead of a ModelConfig[].
    const registry = new ModelRegistry({
      openai: {
        protocol: 'openai',
        models: [{ id: 'gpt-4o' }],
      },
    } as unknown as ModelProvidersConfig);

    // Must not throw "models is not iterable"; the malformed entry is skipped.
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('skips a non-array value for a custom-mapped provider id without throwing', () => {
    const registry = new ModelRegistry(
      {
        idealab: { protocol: 'openai', models: [{ id: 'qwen3.7-max' }] },
      } as unknown as ModelProvidersConfig,
      { idealab: 'openai' },
    );

    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });
});

describe('resolveProviderProtocol', () => {
  it('returns the built-in protocol when the provider id is itself one', () => {
    expect(resolveProviderProtocol('openai')).toBe(AuthType.USE_OPENAI);
    expect(resolveProviderProtocol('gemini')).toBe(AuthType.USE_GEMINI);
    expect(resolveProviderProtocol('anthropic')).toBe(AuthType.USE_ANTHROPIC);
  });

  it('honors an explicit providerProtocol mapping for a custom id', () => {
    const map: ProviderProtocolConfig = { idealab: 'openai' };
    expect(resolveProviderProtocol('idealab', map)).toBe(AuthType.USE_OPENAI);
  });

  it('ignores inherited providerProtocol mappings', () => {
    const map = Object.create({ idealab: 'openai' }) as ProviderProtocolConfig;
    expect(resolveProviderProtocol('idealab', map)).toBeUndefined();
  });

  it('lets an explicit mapping override an id that looks built-in', () => {
    // "openai" as a key, but the operator routes it to the gemini protocol.
    const map: ProviderProtocolConfig = { openai: 'gemini' };
    expect(resolveProviderProtocol('openai', map)).toBe(AuthType.USE_GEMINI);
  });

  it('returns undefined for an unknown id with no mapping (typo guard)', () => {
    expect(resolveProviderProtocol('idealab')).toBeUndefined();
    expect(resolveProviderProtocol('typo-key', { other: 'openai' })).toBe(
      undefined,
    );
  });

  it('ignores an explicit mapping to an unknown protocol', () => {
    const map: ProviderProtocolConfig = { idealab: 'not-a-protocol' };
    expect(resolveProviderProtocol('idealab', map)).toBeUndefined();
  });
});

describe('providerProtocol mapping (custom provider ids)', () => {
  const IDEALAB_URL = 'https://idealab.example/v1';
  /** `{ idealab: [{ id: 'qwen3.7-max' }] }`: a custom id needing a mapping. */
  const idealabMax = () =>
    ({ idealab: [{ id: 'qwen3.7-max' }] }) as unknown as ModelProvidersConfig;

  it('registers a custom provider under its mapped protocol', () => {
    const registry = new ModelRegistry(
      {
        idealab: [{ id: 'qwen3.7-max', baseUrl: IDEALAB_URL }],
      } as unknown as ModelProvidersConfig,
      { idealab: 'openai' },
    );

    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['qwen3.7-max']);
    // The model is reachable via the resolved protocol + baseUrl.
    expect(
      registry.getModel(AuthType.USE_OPENAI, 'qwen3.7-max', IDEALAB_URL),
    ).toBeDefined();
  });

  it('merges a built-in provider and a custom provider sharing one protocol', () => {
    const registry = new ModelRegistry(
      {
        openai: [{ id: 'gpt-4o', baseUrl: OPENAI_URL }],
        idealab: [{ id: 'qwen3.7-max', baseUrl: IDEALAB_URL }],
      } as unknown as ModelProvidersConfig,
      { idealab: 'openai' },
    );

    expect(idsOf(registry, AuthType.USE_OPENAI).sort()).toEqual([
      'gpt-4o',
      'qwen3.7-max',
    ]);
  });

  it('still skips a custom provider id with no mapping (backward compatible)', () => {
    const registry = new ModelRegistry({
      openai: [{ id: 'gpt-4o' }],
      idealab: [{ id: 'qwen3.7-max' }],
    } as unknown as ModelProvidersConfig);

    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['gpt-4o']);
    // idealab had no providerProtocol entry, so its models are not registered.
    expect(
      registry.getModel(AuthType.USE_OPENAI, 'qwen3.7-max'),
    ).toBeUndefined();
  });

  it('warns clearly when providerProtocol maps to an unknown protocol', () => {
    const registry = new ModelRegistry(idealabMax(), {
      idealab: 'opneai',
    } as unknown as ProviderProtocolConfig);

    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Provider "idealab" maps to "opneai" via providerProtocol',
      ),
    );
    expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
      expect.not.stringContaining('has no providerProtocol mapping'),
    );
  });

  it('routes a custom provider to a non-openai protocol when mapped', () => {
    const registry = new ModelRegistry(
      {
        'my-vertex': [{ id: 'gemini-2.5-pro' }],
      } as unknown as ModelProvidersConfig,
      { 'my-vertex': 'gemini' },
    );

    expect(idsOf(registry, AuthType.USE_GEMINI)).toEqual(['gemini-2.5-pro']);
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('persists the mapping across reloadModels when none is supplied', () => {
    const registry = new ModelRegistry(idealabMax(), { idealab: 'openai' });

    expect(registry.getProviderProtocolConfig()).toEqual({ idealab: 'openai' });

    // Hot reload carrying only modelProviders (the existing reload callers).
    registry.reloadModels({
      idealab: [{ id: 'qwen3.7-max' }, { id: 'qwen3.7-coder' }],
    } as unknown as ModelProvidersConfig);

    expect(registry.getProviderProtocolConfig()).toEqual({ idealab: 'openai' });
    expect(idsOf(registry, AuthType.USE_OPENAI).sort()).toEqual([
      'qwen3.7-coder',
      'qwen3.7-max',
    ]);
  });

  it('updates the mapping when reloadModels supplies a new one', () => {
    const registry = new ModelRegistry(idealabMax(), { idealab: 'openai' });

    registry.reloadModels(idealabMax(), { idealab: 'gemini' });

    expect(registry.getProviderProtocolConfig()).toEqual({ idealab: 'gemini' });
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    expect(idsOf(registry, AuthType.USE_GEMINI)).toEqual(['qwen3.7-max']);
  });

  it('clears the protocol bucket when a previously-mapped provider is dropped', () => {
    const registry = new ModelRegistry(idealabMax(), { idealab: 'openai' });
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toHaveLength(1);

    // Reload with idealab entirely absent; the openai bucket must empty out.
    registry.reloadModels({} as ModelProvidersConfig);

    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('passing an empty providerProtocol to reloadModels REPLACES (clears) the map', () => {
    const registry = new ModelRegistry(idealabMax(), { idealab: 'openai' });
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toHaveLength(1);

    // `{}` is a value, not "no argument": it replaces the map, so idealab no
    // longer resolves and its models are dropped (documented footgun guard).
    registry.reloadModels(idealabMax(), {});

    expect(registry.getProviderProtocolConfig()).toEqual({});
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('silently ignores a custom provider explicitly mapped to qwen-oauth', () => {
    const registry = new ModelRegistry(
      {
        'my-alias': [{ id: 'secret-model' }],
      } as unknown as ModelProvidersConfig,
      { 'my-alias': 'qwen-oauth' },
    );

    // Hard-coded QWEN_OAUTH bucket untouched; the aliased model is not added.
    expectHardCodedQwenCount(registry);
    expect(
      registry.getModel(AuthType.QWEN_OAUTH, 'secret-model'),
    ).toBeUndefined();
  });

  it('first-wins when two custom providers contribute the same id+baseUrl to one protocol', () => {
    const registry = new ModelRegistry(
      {
        providerA: [
          {
            id: 'shared',
            name: 'From A',
            baseUrl: 'https://api.example.com/v1',
          },
        ],
        providerB: [
          {
            id: 'shared',
            name: 'From B',
            baseUrl: 'https://api.example.com/v1',
          },
        ],
      } as unknown as ModelProvidersConfig,
      { providerA: 'openai', providerB: 'openai' },
    );

    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models).toHaveLength(1);
    expect(models[0].label).toBe('From A');
  });
});
