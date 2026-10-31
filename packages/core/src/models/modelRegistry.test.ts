/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ModelRegistry,
  QWEN_OAUTH_MODELS,
  isBaseUrlAllowed,
  modelRegistryKey,
  resolveProviderProtocol,
  scrubBaseUrlForMessage,
} from './modelRegistry.js';
import { AuthType } from '../core/contentGenerator.js';
import { DEFAULT_OPENAI_BASE_URL } from '../core/openaiContentGenerator/constants.js';
import { getDefaultBaseUrlForProtocol } from '../providers/provider-config.js';
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

describe('ModelRegistry managed allowlist (model.allowedBaseUrls)', () => {
  const CORP = 'https://corp.example';
  const externalCustom = () =>
    ({
      custom: [
        {
          id: 'ext',
          baseUrl: 'https://external-llm.example/v1',
          envKey: 'EXT_KEY',
        },
      ],
    }) as ModelProvidersConfig;

  it('rejects a custom provider with an external baseUrl when an allowlist is set', () => {
    const registry = new ModelRegistry(externalCustom(), { custom: 'openai' }, [
      CORP,
    ]);
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    expect(
      debugLoggerWarnSpy.mock.calls.some((call) =>
        String(call[0]).includes('not in the model.allowedBaseUrls'),
      ),
    ).toBe(true);
  });

  it('registers the same custom provider when its baseUrl is on the allowlist', () => {
    const registry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}/v1`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [CORP],
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ext']);
  });

  it('keeps today behavior when no allowlist is provided', () => {
    const registry = new ModelRegistry(externalCustom(), { custom: 'openai' });
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ext']);
  });

  it('does not treat a sibling domain as a path prefix of an allowlist entry', () => {
    const registry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: 'https://corp.example.evil.com/v1' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [CORP],
    );
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('matches hosts case-insensitively and ignores trailing slashes', () => {
    const registry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: 'https://CORP.Example/V1/' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      ['https://corp.example/'],
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ext']);
  });

  it('ignores a trailing slash on the ENTRY side and keeps path boundaries', () => {
    // The strip is symmetric — an entry written `…/v1/` covers the same
    // path without the slash (the earlier direction, target `…/V1/` against
    // entry `…/`, is covered by the case-insensitivity test above).
    const trailingEntry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}/v1`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [`${CORP}/v1/`],
    );
    expect(idsOf(trailingEntry, AuthType.USE_OPENAI)).toEqual(['ext']);

    // A path prefix that is not a path boundary still must not match:
    // entry `/v1` covers `/v1/…` but not `/v1beta`.
    const boundary = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}/v1beta`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [`${CORP}/v1`],
    );
    expect(boundary.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('matches allowlist paths case-sensitively while hosts stay case-insensitive', () => {
    // Hosts compare case-insensitively, but the path is case-sensitive:
    // /V1 is a different endpoint path than /v1.
    const mismatch = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: 'https://corp.example/V1' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      ['https://corp.example/v1'],
    );
    expect(mismatch.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);

    // A byte-identical URL still matches.
    const match = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: 'https://corp.example/v1' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      ['https://corp.example/v1'],
    );
    expect(idsOf(match, AuthType.USE_OPENAI)).toEqual(['ext']);
  });

  it('never matches across a scheme mismatch in either direction', () => {
    // The matcher compares protocol first, so an http:// entry can never
    // cover an https:// endpoint (and vice versa) — scheme sensitivity must
    // survive a refactor that weakens the origin/host comparison.
    const httpEntry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: 'https://corp.example/v1' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      ['http://corp.example/v1'],
    );
    expect(httpEntry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);

    const httpsEntry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: 'http://corp.example/v1' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      ['https://corp.example/v1'],
    );
    expect(httpsEntry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('an empty allowlist registers no models, including the qwen-oauth built-ins', () => {
    const registry = new ModelRegistry(
      { openai: [{ id: 'llm', baseUrl: CORP }] },
      undefined,
      [],
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual([]);
    expect(idsOf(registry, AuthType.QWEN_OAUTH)).toEqual([]);
  });

  it('does not register the qwen-oauth built-ins when an allowlist is set', () => {
    // Documented managed semantics, not a sentinel artifact: the built-in
    // qwen-oauth models resolve their baseUrl to the dynamic
    // 'DYNAMIC_QWEN_OAUTH_BASE_URL' placeholder, so no allowlist entry can
    // ever match them. Setting model.allowedBaseUrls intentionally disables
    // the personal Qwen login provider (its endpoint is discovered at login
    // and cannot be listed); a deployment that needs it leaves the key unset.
    const registry = new ModelRegistry(undefined, undefined, [CORP]);
    expect(idsOf(registry, AuthType.QWEN_OAUTH)).toEqual([]);
  });

  it('exempts the built-ins when the allowlist is workspace-scoped only', () => {
    // A workspace list still narrows configured provider endpoints, but the
    // built-in qwen-oauth models register without the filter — their login
    // endpoint cannot be listed, and disabling personal Qwen login is an
    // operator decision (issue #12805).
    const registry = new ModelRegistry(
      undefined,
      undefined,
      [CORP],
      false,
      true,
    );
    expectHardCodedQwenCount(registry);
    // Exempt models are not recorded as drops.
    expect(registry.getAllowlistDroppedModels()).toEqual([]);

    // The exemption is qwen-oauth-only: an external endpoint is still judged
    // against the same workspace list.
    const narrowed = new ModelRegistry(
      externalCustom(),
      { custom: 'openai' },
      [CORP],
      false,
      true,
    );
    expect(narrowed.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    expectHardCodedQwenCount(narrowed);
    expect(narrowed.getAllowlistDroppedModels()).toEqual([
      {
        id: 'ext',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://external-llm.example/v1',
      },
    ]);
  });

  it('fails closed for a model whose protocol default endpoint is not listed', () => {
    // openai protocol default baseUrl is the external DashScope endpoint.
    const registry = new ModelRegistry({ openai: [{ id: 'llm' }] }, undefined, [
      CORP,
    ]);
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('keeps the qwen-oauth built-ins for an explicit empty list (retired pin)', () => {
    // `[]` under qwen-oauth is an empty provider list, not a switch: only
    // the operator-scoped model.qwenOAuthBuiltinsDisabled disables the
    // built-ins (issue #12805, the migration and the provider-removal
    // route synthesize `[]` without operator intent).
    const registry = new ModelRegistry({ 'qwen-oauth': [] });
    expect(idsOf(registry, AuthType.QWEN_OAUTH)).toEqual(['coder-model']);
  });

  it('keeps the qwen-oauth built-ins when the key is missing', () => {
    const registry = new ModelRegistry();
    expectHardCodedQwenCount(registry);
  });

  it('keeps the qwen-oauth built-ins for a non-empty list (hard-coded wins)', () => {
    const registry = new ModelRegistry({
      'qwen-oauth': [{ id: 'custom-qwen' }],
    });
    expect(idsOf(registry, AuthType.QWEN_OAUTH)).toEqual(['coder-model']);
  });

  it('reloadModels preserves the boot-time allowlist on a providers-only reload', () => {
    const registry = new ModelRegistry(externalCustom(), { custom: 'openai' }, [
      CORP,
    ]);
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);

    // A providers-only reload must not drop the policy: an allowed model
    // still registers after the reload.
    registry.reloadModels(
      { custom: [{ id: 'ok', baseUrl: `${CORP}/v1` }] } as ModelProvidersConfig,
      { custom: 'openai' },
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ok']);
  });

  it('reloadModels keeps the boot-time allowlist — reloading providers cannot widen it', () => {
    const registry = new ModelRegistry(externalCustom(), { custom: 'openai' }, [
      CORP,
    ]);
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);

    // The policy is boot-frozen (like providerProtocol): re-registering the
    // external endpoint through a providers-only reload must not escape the
    // boot-time allowlist.
    registry.reloadModels(externalCustom(), { custom: 'openai' });
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('reloadModels keeps the boot-time builtins decision (no pin via [] anymore)', () => {
    // The disable decision is boot-frozen (like the allowlist): a
    // providers-only reload cannot re-enable the built-ins, and `[]` under
    // qwen-oauth no longer means anything (retired pin, issue #12805).
    const disabled = new ModelRegistry(undefined, undefined, undefined, true);
    expect(idsOf(disabled, AuthType.QWEN_OAUTH)).toEqual([]);
    disabled.reloadModels({ 'qwen-oauth': [] });
    expect(idsOf(disabled, AuthType.QWEN_OAUTH)).toEqual([]);

    // Not disabled: `[]` is just an empty provider list, so the hard-coded
    // built-ins survive a reload that carries only it.
    const enabled = new ModelRegistry();
    enabled.reloadModels({ 'qwen-oauth': [] });
    expectHardCodedQwenCount(enabled);
  });

  it('reloadModels refreshes the dropped-models record', () => {
    // The drop record must follow the reloaded registration, or user-visible
    // channels (advisor errors, warnings) keep naming boot-time drops for a
    // config that no longer produced them (issue #12805).
    const registry = new ModelRegistry(
      { custom: [{ id: 'on', baseUrl: CORP, envKey: 'CORP_KEY' }] },
      { custom: 'openai' },
      [CORP],
    );
    expect(registry.getAllowlistDroppedModels()).toEqual([
      {
        id: 'coder-model',
        authType: AuthType.QWEN_OAUTH,
        baseUrl: 'DYNAMIC_QWEN_OAUTH_BASE_URL',
      },
    ]);
    registry.reloadModels(
      {
        custom: [
          {
            id: 'off',
            baseUrl: 'https://external-llm.example/v1',
            envKey: 'CORP_KEY',
          },
        ],
      },
      { custom: 'openai' },
    );
    expect(registry.getAllowlistDroppedModels()).toEqual([
      {
        id: 'coder-model',
        authType: AuthType.QWEN_OAUTH,
        baseUrl: 'DYNAMIC_QWEN_OAUTH_BASE_URL',
      },
      {
        id: 'off',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://external-llm.example/v1',
      },
    ]);
  });

  it('matches an explicit default port as absent (URL origin semantics)', () => {
    // new URL() elides explicit default ports from the origin, so
    // https://corp.example:443/v1 is the same endpoint as https://corp.example.
    const registry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}:443/v1`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [CORP],
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ext']);

    // A non-default port is a different endpoint and must not match.
    const offPort = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}:8443/v1`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [CORP],
    );
    expect(offPort.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('fails closed (no models, no throw) for a non-array allowlist value', () => {
    // A hand-edited settings value that is not an array must not crash the
    // constructor with a raw TypeError; it blocks every model instead.
    let registry!: ModelRegistry;
    expect(
      () =>
        (registry = new ModelRegistry(
          { openai: [{ id: 'llm', baseUrl: CORP }] },
          undefined,
          'https://corp.example' as unknown as readonly string[],
        )),
    ).not.toThrow();
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    expect(
      debugLoggerWarnSpy.mock.calls.some((call) =>
        String(call[0]).includes('model.allowedBaseUrls is not an array'),
      ),
    ).toBe(true);
  });

  it('warns and skips degenerate entries instead of matching everything', () => {
    // 'https://' has no host — the old string fallback let it match every
    // https URL (silent fail-open). It must be skipped with a warning.
    const registry = new ModelRegistry(
      {
        custom: [
          {
            id: 'ext',
            baseUrl: 'https://external-llm.example/v1',
            envKey: 'EXT_KEY',
          },
          { id: 'ok', baseUrl: `${CORP}/v1`, envKey: 'CORP_KEY' },
        ],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [CORP, 'https://', 'mailto:', '', 'not a url', 42 as unknown as string],
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ok']);
    expect(
      debugLoggerWarnSpy.mock.calls.some((call) =>
        String(call[0]).includes('is not a URL with a host'),
      ),
    ).toBe(true);
    // 'mailto:' parses with an empty hostname — the parse-ok branch of
    // parseUrlForMatch must reject it too, not only the throw branch
    // that 'https://' hits (issue #12805).
    expect(
      debugLoggerWarnSpy.mock.calls.some((call) =>
        String(call[0]).includes('entry "mailto:" is not a URL with a host'),
      ),
    ).toBe(true);
    expect(
      debugLoggerWarnSpy.mock.calls.some((call) =>
        String(call[0]).includes('is not a non-empty string'),
      ),
    ).toBe(true);
  });

  it('keeps query/fragment entries but warns they match the whole prefix', () => {
    // Matching is URL-semantic and ignores query/fragment on both sides, so
    // an entry that carries one allows every endpoint under the same
    // origin+path — warn, but keep the entry (it still confines by
    // host+path; rejecting it would also break an all-invalid list's
    // fail-closed shape).
    const registry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}/v1`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [`${CORP}/v1?q=1`],
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ext']);
    expect(
      debugLoggerWarnSpy.mock.calls.some((call) =>
        String(call[0]).includes('carries a query/fragment'),
      ),
    ).toBe(true);

    // A fragment-only entry behaves the same way. Both constructions
    // validate their list (the spy is cleared per test, not per
    // construction), so two entries carrying a query/fragment warn twice.
    const fragment = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}/v1`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [`${CORP}/v1#f`],
    );
    expect(idsOf(fragment, AuthType.USE_OPENAI)).toEqual(['ext']);
    expect(
      debugLoggerWarnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('carries a query/fragment'),
      ).length,
    ).toBe(2);
  });

  it('matches a whitespace-padded allowlist entry against the exact baseUrl', () => {
    const registry = new ModelRegistry(
      {
        custom: [{ id: 'ext', baseUrl: `${CORP}/v1`, envKey: 'CORP_KEY' }],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [`  ${CORP}  `],
    );
    expect(idsOf(registry, AuthType.USE_OPENAI)).toEqual(['ext']);
  });

  it('isBaseUrlAllowed fails closed for empty, non-string, and non-array inputs', () => {
    expect(isBaseUrlAllowed(undefined, [CORP])).toBe(false);
    expect(isBaseUrlAllowed('', [CORP])).toBe(false);
    expect(isBaseUrlAllowed(`${CORP}/v1`, undefined)).toBe(false);
    expect(
      isBaseUrlAllowed(`${CORP}/v1`, null as unknown as readonly string[]),
    ).toBe(false);
    expect(isBaseUrlAllowed(`${CORP}/v1`, [`${CORP}/`])).toBe(true);
    expect(isBaseUrlAllowed(`${CORP}/v1`, ['https://other.example'])).toBe(
      false,
    );
    // A degenerate entry must match nothing even when a raw-list consumer
    // receives it unvalidated — the matcher itself is the chokepoint
    // (issue #12805: the previous string-normalized fallback turned
    // `https://` into a match-everything wildcard).
    expect(isBaseUrlAllowed('https://anything.example/v1', ['https://'])).toBe(
      false,
    );
    expect(isBaseUrlAllowed('https://anything.example/v1', ['not a url'])).toBe(
      false,
    );
    // Trailing slash on the entry side is ignored (symmetric with the
    // target side covered above).
    expect(isBaseUrlAllowed(`${CORP}`, [`${CORP}/`])).toBe(true);
  });

  it('keeps the built-ins when the disabled flag is an explicit false', () => {
    // The operator key is a plain boolean (issue #12805): false means
    // "not disabled", so the built-ins register even alongside an empty
    // qwen-oauth provider list.
    const registry = new ModelRegistry(
      { 'qwen-oauth': [] },
      undefined,
      undefined,
      false,
    );
    expectHardCodedQwenCount(registry);
  });

  it('suppresses the built-ins on an explicit true even without a merged pin', () => {
    const registry = new ModelRegistry(undefined, undefined, undefined, true);
    expect(idsOf(registry, AuthType.QWEN_OAUTH)).toEqual([]);
  });

  it('records each allowlist drop with the judged baseUrl', () => {
    const registry = new ModelRegistry(externalCustom(), { custom: 'openai' }, [
      CORP,
    ]);
    // The off-list provider entry plus the built-in qwen-oauth model, whose
    // dynamic endpoint can never match an allowlist entry.
    expect(registry.getAllowlistDroppedModels()).toEqual([
      {
        id: 'coder-model',
        authType: AuthType.QWEN_OAUTH,
        baseUrl: 'DYNAMIC_QWEN_OAUTH_BASE_URL',
      },
      {
        id: 'ext',
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://external-llm.example/v1',
      },
    ]);
  });

  it('stamps the judged baseUrl on resolved models (protocol default)', () => {
    // Pair assertion: a model without an explicit baseUrl is judged against
    // its protocol default endpoint, and the resolved model carries exactly
    // that baseUrl — the same value the allowlist saw.
    const registry = new ModelRegistry(
      { openai: [{ id: 'llm', name: 'llm' }] },
      undefined,
      [OPENAI_URL],
    );
    const model = registry.getModel(AuthType.USE_OPENAI, 'llm');
    expect(model?.baseUrl).toBe(OPENAI_URL);
  });
  it('stamps no baseUrl on baseUrl-less anthropic/gemini/responses models (R1-3)', () => {
    // The allowlist judges the protocol-table endpoint, but the registered
    // model keeps the pre-allowlist stamp: the table's Anthropic value
    // (`https://api.anthropic.com/v1`) would make the SDK dial
    // `/v1/v1/messages`, and any stamp shadows MissingBaseUrlError and the
    // SDK/env fallbacks (issue #12805).
    const registry = new ModelRegistry(
      {
        anthropic: [{ id: 'claude' }],
        gemini: [{ id: 'gem' }],
        openai: [{ id: 'resp-model', wireApi: 'responses' }],
      } as ModelProvidersConfig,
      undefined,
      [
        getDefaultBaseUrlForProtocol(AuthType.USE_ANTHROPIC),
        getDefaultBaseUrlForProtocol(AuthType.USE_GEMINI),
        getDefaultBaseUrlForProtocol(AuthType.USE_OPENAI_RESPONSES),
      ],
    );
    // Registered: the allowlist judged (and admitted) the table endpoints.
    expect(registry.getModel(AuthType.USE_ANTHROPIC, 'claude')?.baseUrl).toBe(
      '',
    );
    expect(registry.getModel(AuthType.USE_GEMINI, 'gem')?.baseUrl).toBe('');
    expect(
      registry.getModel(AuthType.USE_OPENAI_RESPONSES, 'resp-model')?.baseUrl,
    ).toBe('');
    // Same stamp without any policy.
    const unmanaged = new ModelRegistry({ anthropic: [{ id: 'claude' }] });
    expect(unmanaged.getModel(AuthType.USE_ANTHROPIC, 'claude')?.baseUrl).toBe(
      '',
    );
  });

  it('pins the OpenAI protocol-table default to the SDK default (R5-25)', () => {
    // The registry stamps DEFAULT_OPENAI_BASE_URL while both gates judge the
    // protocol table; the two literals must stay byte-equal.
    expect(getDefaultBaseUrlForProtocol(AuthType.USE_OPENAI)).toBe(
      DEFAULT_OPENAI_BASE_URL,
    );
  });

  it('scrubs userinfo credentials from the drop record and warning (R5-27)', () => {
    const registry = new ModelRegistry(
      {
        custom: [
          {
            id: 'gw',
            baseUrl: 'https://team:sk-live-abc123@gw-legacy.corp.example/v1',
          },
        ],
      } as ModelProvidersConfig,
      { custom: 'openai' },
      [CORP],
    );
    const dropped = registry
      .getAllowlistDroppedModels()
      .find((entry) => entry.id === 'gw');
    expect(dropped?.baseUrl).toContain('gw-legacy.corp.example/v1');
    expect(dropped?.baseUrl).not.toContain('sk-live-abc123');
    const warned = debugLoggerWarnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('"gw"'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('gw-legacy.corp.example/v1');
    expect(warned[0]).not.toContain('sk-live-abc123');
    // The Qwen OAuth sentinel is recorded verbatim — the built-in remedy
    // branch compares against it.
    expect(
      registry
        .getAllowlistDroppedModels()
        .find((entry) => entry.id === 'coder-model')?.baseUrl,
    ).toBe('DYNAMIC_QWEN_OAUTH_BASE_URL');
  });

  it('reloadModels preserves the workspace-only built-ins exemption (R5-24)', () => {
    const registry = new ModelRegistry(
      externalCustom(),
      { custom: 'openai' },
      [CORP],
      false,
      true,
    );
    expectHardCodedQwenCount(registry);
    registry.reloadModels(externalCustom(), { custom: 'openai' });
    // The exemption survives the reload, and the external endpoint is still
    // judged against the boot list.
    expectHardCodedQwenCount(registry);
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
  });

  it('fails startup on a malformed off-list entry instead of dropping it (R5-26)', () => {
    // Validation runs before the policy decision: an id-less entry the
    // allowlist would also drop must still refuse startup with its own error.
    expect(
      () =>
        new ModelRegistry(
          {
            openai: [{ id: '', baseUrl: 'https://external-llm.example/v1' }],
          },
          undefined,
          [CORP],
        ),
    ).toThrow('missing required field: id');
  });
});

describe('scrubBaseUrlForMessage (R2-18)', () => {
  it.each([
    ['user:pass@corp.example/v1', '***@corp.example/v1'],
    ['//user:pass@corp.example', '//***@corp.example'],
    ['sk-abc123:tok@gw.corp.example/v1', '***@gw.corp.example/v1'],
    ['https://user:sk@', 'https://***@'],
    ['ftp://user:pass@host/v1', 'ftp://***@host/v1'],
  ])('masks the userinfo of a non-http(s) shape %j', (input, expected) => {
    expect(scrubBaseUrlForMessage(input)).toBe(expected);
  });

  it('echoes clean http(s) URLs verbatim and strips userinfo from parseable ones', () => {
    expect(scrubBaseUrlForMessage('https://corp.example/v1?x=a@b')).toBe(
      'https://corp.example/v1?x=a@b',
    );
    expect(scrubBaseUrlForMessage('https://user:pass@corp.example/v1')).toBe(
      'https://corp.example/v1',
    );
  });

  it('keeps values that carry no userinfo, including the Qwen OAuth sentinel', () => {
    expect(scrubBaseUrlForMessage('DYNAMIC_QWEN_OAUTH_BASE_URL')).toBe(
      'DYNAMIC_QWEN_OAUTH_BASE_URL',
    );
    expect(scrubBaseUrlForMessage('corp.example/v1')).toBe('corp.example/v1');
  });
});
