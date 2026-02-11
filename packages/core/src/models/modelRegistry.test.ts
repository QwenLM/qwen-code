/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRegistry, QWEN_OAUTH_MODELS } from './modelRegistry.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from './types.js';

describe('ModelRegistry', () => {
  describe('initialization', () => {
    it('should always include hard-coded qwen-oauth models', () => {
      const registry = new ModelRegistry();

      const qwenModels = registry.getModelsForAuthType(AuthType.QWEN_OAUTH);
      expect(qwenModels.length).toBe(QWEN_OAUTH_MODELS.length);
      expect(qwenModels[0].id).toBe('coder-model');
      expect(qwenModels[1].id).toBe('vision-model');
    });

    it('should initialize with empty config', () => {
      const registry = new ModelRegistry();
      expect(registry.getModelsForAuthType(AuthType.QWEN_OAUTH).length).toBe(
        QWEN_OAUTH_MODELS.length,
      );
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
    });

    it('should initialize with custom models config', () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: 'https://api.openai.com/v1',
          },
        ],
      };

      const registry = new ModelRegistry(modelProvidersConfig);

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
      expect(openaiModels[0].id).toBe('gpt-4-turbo');
    });

    it('should ignore qwen-oauth models in config (hard-coded)', () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        'qwen-oauth': [
          {
            id: 'custom-qwen',
            name: 'Custom Qwen',
          },
        ],
      };

      const registry = new ModelRegistry(modelProvidersConfig);

      // Should still use hard-coded qwen-oauth models
      const qwenModels = registry.getModelsForAuthType(AuthType.QWEN_OAUTH);
      expect(qwenModels.length).toBe(QWEN_OAUTH_MODELS.length);
      expect(qwenModels.find((m) => m.id === 'custom-qwen')).toBeUndefined();
    });
  });

  describe('getModelsForAuthType', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            description: 'Most capable GPT-4',
            baseUrl: 'https://api.openai.com/v1',
            capabilities: { vision: true },
          },
          {
            id: 'gpt-3.5-turbo',
            name: 'GPT-3.5 Turbo',
            capabilities: { vision: false },
          },
        ],
      };
      registry = new ModelRegistry(modelProvidersConfig);
    });

    it('should return models for existing authType', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
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
    });
  });

  describe('getModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: 'https://api.openai.com/v1',
            generationConfig: {
              samplingParams: {
                temperature: 0.8,
                max_tokens: 4096,
              },
            },
          },
        ],
      };
      registry = new ModelRegistry(modelProvidersConfig);
    });

    it('should return resolved model config', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4-turbo');
      expect(model?.name).toBe('GPT-4 Turbo');
      expect(model?.authType).toBe(AuthType.USE_OPENAI);
      expect(model?.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should preserve generationConfig without applying defaults', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model?.generationConfig.samplingParams?.temperature).toBe(0.8);
      expect(model?.generationConfig.samplingParams?.max_tokens).toBe(4096);
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
  });

  describe('hasModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });
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
    it('should return coder-model for qwen-oauth', () => {
      const registry = new ModelRegistry();
      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.QWEN_OAUTH,
      );
      expect(defaultModel?.id).toBe('coder-model');
    });

    it('should return first model for other authTypes', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
      });

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.USE_OPENAI,
      );
      expect(defaultModel?.id).toBe('gpt-4');
    });
  });

  describe('validation', () => {
    it('should throw error for model without id', () => {
      expect(
        () =>
          new ModelRegistry({
            openai: [{ id: '', name: 'No ID' }],
          }),
      ).toThrow('missing required field: id');
    });
  });

  describe('default base URLs', () => {
    it('should apply default dashscope URL for qwen-oauth', () => {
      const registry = new ModelRegistry();
      const model = registry.getModel(AuthType.QWEN_OAUTH, 'coder-model');
      expect(model?.baseUrl).toBe('DYNAMIC_QWEN_OAUTH_BASE_URL');
    });

    it('should apply default openai URL when not specified', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(model?.baseUrl).toBe('https://api.openai.com/v1');
    });

    it('should use custom baseUrl when specified', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            baseUrl: 'https://api.deepseek.com/v1',
          },
        ],
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
      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
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
      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);

      const geminiModels = registry.getModelsForAuthType(AuthType.USE_GEMINI);
      expect(geminiModels.length).toBe(1);
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
    it('should skip duplicate model ids and use first registered config', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 First', description: 'First config' },
          { id: 'gpt-4', name: 'GPT-4 Second', description: 'Second config' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);

      const gpt4 = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(gpt4).toBeDefined();
      expect(gpt4?.name).toBe('GPT-4 First');
      expect(gpt4?.description).toBe('First config');
    });

    it('should handle multiple duplicate ids in same authType', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'model-a', name: 'Model A First' },
          { id: 'model-a', name: 'Model A Second' },
          { id: 'model-b', name: 'Model B First' },
          { id: 'model-b', name: 'Model B Second' },
          { id: 'model-c', name: 'Model C' },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(3);

      expect(registry.getModel(AuthType.USE_OPENAI, 'model-a')?.name).toBe(
        'Model A First',
      );
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-b')?.name).toBe(
        'Model B First',
      );
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-c')?.name).toBe(
        'Model C',
      );
    });

    it('should treat same id in different authTypes as different models', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'shared-model', name: 'OpenAI Shared' }],
        gemini: [{ id: 'shared-model', name: 'Gemini Shared' }],
      });

      const openaiModel = registry.getModel(
        AuthType.USE_OPENAI,
        'shared-model',
      );
      const geminiModel = registry.getModel(
        AuthType.USE_GEMINI,
        'shared-model',
      );

      expect(openaiModel?.name).toBe('OpenAI Shared');
      expect(geminiModel?.name).toBe('Gemini Shared');
    });
  });

  describe('reloadModels', () => {
    it('should reload models from new config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeDefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeUndefined();

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
      });

      // After reload, only new models should exist
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeUndefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeDefined();
    });

    it('should preserve hard-coded qwen-oauth models after reload', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      expect(registry.getModelsForAuthType(AuthType.QWEN_OAUTH).length).toBe(
        QWEN_OAUTH_MODELS.length,
      );

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
      });

      // qwen-oauth models should still exist
      expect(registry.getModelsForAuthType(AuthType.QWEN_OAUTH).length).toBe(
        QWEN_OAUTH_MODELS.length,
      );
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
      expect(registry.getModelsForAuthType(AuthType.QWEN_OAUTH).length).toBe(
        QWEN_OAUTH_MODELS.length,
      );
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
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      registry.reloadModels({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Updated' },
          { id: 'gpt-3.5', name: 'GPT-3.5' },
        ],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(2);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')?.name).toBe(
        'GPT-4 Updated',
      );

      const geminiModels = registry.getModelsForAuthType(AuthType.USE_GEMINI);
      expect(geminiModels.length).toBe(1);
    });

    it('should skip invalid authType keys during reload', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
        'invalid-key': [{ id: 'invalid-model', name: 'Invalid Model' }],
      } as unknown as ModelProvidersConfig);

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeDefined();
    });

    it('should handle reload with undefined config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      registry.reloadModels(undefined);

      // All user-configured models should be cleared
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(0);
      // qwen-oauth models should still exist
      expect(registry.getModelsForAuthType(AuthType.QWEN_OAUTH).length).toBe(
        QWEN_OAUTH_MODELS.length,
      );
    });

    it('should apply duplicate model id handling during reload', () => {
      const registry = new ModelRegistry();

      registry.reloadModels({
        openai: [
          { id: 'model-a', name: 'Model A First' },
          { id: 'model-a', name: 'Model A Second' },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-a')?.name).toBe(
        'Model A First',
      );
    });
  });
});
