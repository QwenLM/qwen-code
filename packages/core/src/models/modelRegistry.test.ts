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
      expect(registry.hasAuthType(AuthType.QWEN_OAUTH)).toBe(true);
      expect(registry.hasAuthType(AuthType.USE_OPENAI)).toBe(false);
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

      expect(registry.hasAuthType(AuthType.USE_OPENAI)).toBe(true);
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
              temperature: 0.8,
              max_tokens: 4096,
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

    it('should merge generationConfig with defaults', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model?.generationConfig.temperature).toBe(0.8);
      expect(model?.generationConfig.max_tokens).toBe(4096);
      // Default values should be applied
      expect(model?.generationConfig.top_p).toBe(0.9);
      expect(model?.generationConfig.timeout).toBe(60000);
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

  describe('getFirstModelForAuthType', () => {
    it('should return first model for authType', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'first', name: 'First' },
          { id: 'second', name: 'Second' },
        ],
      });

      const firstModel = registry.getFirstModelForAuthType(AuthType.USE_OPENAI);
      expect(firstModel?.id).toBe('first');
    });

    it('should return undefined for empty authType', () => {
      const registry = new ModelRegistry();
      const firstModel = registry.getFirstModelForAuthType(AuthType.USE_OPENAI);
      expect(firstModel).toBeUndefined();
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

  describe('getAvailableAuthTypes', () => {
    it('should return all configured authTypes', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      const authTypes = registry.getAvailableAuthTypes();
      expect(authTypes).toContain(AuthType.QWEN_OAUTH);
      expect(authTypes).toContain(AuthType.USE_OPENAI);
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
      expect(model?.baseUrl).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      );
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

  describe('findAuthTypesForModel', () => {
    it('should return empty array for non-existent model', () => {
      const registry = new ModelRegistry();
      const authTypes = registry.findAuthTypesForModel('non-existent');
      expect(authTypes).toEqual([]);
    });

    it('should return authTypes that have the model', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4' }],
      });

      const authTypes = registry.findAuthTypesForModel('gpt-4');
      expect(authTypes).toContain(AuthType.USE_OPENAI);
      expect(authTypes.length).toBe(1);
    });

    it('should return multiple authTypes if model exists in multiple', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'shared-model', name: 'Shared' }],
        'gemini-api-key': [{ id: 'shared-model', name: 'Shared Gemini' }],
      });

      const authTypes = registry.findAuthTypesForModel('shared-model');
      expect(authTypes.length).toBe(2);
      expect(authTypes).toContain(AuthType.USE_OPENAI);
      expect(authTypes).toContain(AuthType.USE_GEMINI);
    });

    it('should prioritize preferred authType in results', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'shared-model', name: 'Shared' }],
        'gemini-api-key': [{ id: 'shared-model', name: 'Shared Gemini' }],
      });

      const authTypes = registry.findAuthTypesForModel(
        'shared-model',
        AuthType.USE_GEMINI,
      );
      expect(authTypes[0]).toBe(AuthType.USE_GEMINI);
    });

    it('should handle qwen-oauth models', () => {
      const registry = new ModelRegistry();
      const authTypes = registry.findAuthTypesForModel('coder-model');
      expect(authTypes).toContain(AuthType.QWEN_OAUTH);
    });
  });
});
