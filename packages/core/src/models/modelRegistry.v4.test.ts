/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ModelRegistry } from './modelRegistry.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from './types.js';

describe('ModelRegistry provider-keyed support', () => {
  describe('provider-keyed format loading', () => {
    it('loads providers and registers models by providerId and authType', () => {
      const providerConfig: ModelProvidersConfig = {
        'my-openai': {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.openai.com/v1',
          models: [
            { id: 'gpt-4', name: 'GPT-4' },
            { id: 'gpt-3.5', name: 'GPT-3.5' },
          ],
        },
      };

      const registry = new ModelRegistry(providerConfig);

      expect(registry.getModelByProviderId('my-openai', 'gpt-4')).toBeDefined();
      expect(
        registry.getModelByProviderId('my-openai', 'gpt-4')?.providerId,
      ).toBe('my-openai');
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeDefined();
      expect(registry.getProviderAuthType('my-openai')).toBe(
        AuthType.USE_OPENAI,
      );
    });

    it('sets provider-level baseUrl/envKey on resolved models', () => {
      const providerConfig: ModelProvidersConfig = {
        cp: {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://custom-api.com/v1',
          envKey: 'CUSTOM_KEY',
          managed: true,
          models: [{ id: 'model-1' }],
        },
      };

      const registry = new ModelRegistry(providerConfig);

      const model = registry.getModelByProviderId('cp', 'model-1');
      expect(model?.baseUrl).toBe('https://custom-api.com/v1');
      expect(model?.envKey).toBe('CUSTOM_KEY');
    });
  });

  describe('resolveModelWithFallback', () => {
    const providerConfig: ModelProvidersConfig = {
      'provider-a': {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://a.com/v1',
        models: [{ id: 'shared-model', name: 'From A' }, { id: 'unique-a' }],
      },
      'provider-b': {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://b.com/v1',
        models: [{ id: 'shared-model', name: 'From B' }, { id: 'unique-b' }],
      },
    };

    it('resolves exact providerId + modelId', () => {
      const registry = new ModelRegistry(providerConfig);
      const result = registry.resolveModelWithFallback(
        'provider-b',
        'shared-model',
      );
      expect(result).toBeDefined();
      expect(result!.model.name).toBe('From B');
      expect(result!.authType).toBe(AuthType.USE_OPENAI);
    });

    it('falls back to authType match with lexicographic tie-breaking', () => {
      const registry = new ModelRegistry(providerConfig);
      const result = registry.resolveModelWithFallback(
        undefined,
        'shared-model',
        AuthType.USE_OPENAI,
      );
      expect(result).toBeDefined();
      // provider-a comes before provider-b lexicographically
      expect(result!.model.name).toBe('From A');
    });

    it('returns undefined when no match found', () => {
      const registry = new ModelRegistry(providerConfig);
      const result = registry.resolveModelWithFallback(
        'nonexistent',
        'nonexistent-model',
        AuthType.USE_OPENAI,
      );
      expect(result).toBeUndefined();
    });

    it('falls back to authType when providerId model mismatch', () => {
      const registry = new ModelRegistry(providerConfig);
      const result = registry.resolveModelWithFallback(
        'provider-a',
        'unique-b',
        AuthType.USE_OPENAI,
      );
      expect(result).toBeDefined();
      expect(result!.model.id).toBe('unique-b');
    });
  });

  describe('reloadModels with provider-keyed format', () => {
    it('clears previous provider state and reloads', () => {
      const registry = new ModelRegistry();

      const providerConfig: ModelProvidersConfig = {
        p1: {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'model-1' }],
        },
      };

      registry.reloadModels(providerConfig);
      expect(registry.getModelByProviderId('p1', 'model-1')).toBeDefined();

      registry.reloadModels(undefined);
      expect(registry.getModelByProviderId('p1', 'model-1')).toBeUndefined();
    });
  });

  describe('same authType + modelId across different providers', () => {
    const providerConfig: ModelProvidersConfig = {
      'proxy-a': {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://proxy-a.com/v1',
        envKey: 'KEY_A',
        models: [{ id: 'gpt-4', name: 'GPT-4 via A' }, { id: 'only-in-a' }],
      },
      'proxy-b': {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://proxy-b.com/v1',
        envKey: 'KEY_B',
        models: [{ id: 'gpt-4', name: 'GPT-4 via B' }, { id: 'only-in-b' }],
      },
    };

    it('getModelsForAuthType returns models from ALL providers', () => {
      const registry = new ModelRegistry(providerConfig);
      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);

      expect(models.length).toBe(4);
      const gpt4Models = models.filter((m) => m.id === 'gpt-4');
      expect(gpt4Models).toHaveLength(2);

      const providerIds = gpt4Models.map((m) => m.providerId).sort();
      expect(providerIds).toEqual(['proxy-a', 'proxy-b']);

      expect(gpt4Models.find((m) => m.providerId === 'proxy-a')?.baseUrl).toBe(
        'https://proxy-a.com/v1',
      );
      expect(gpt4Models.find((m) => m.providerId === 'proxy-b')?.baseUrl).toBe(
        'https://proxy-b.com/v1',
      );
    });

    it('getModelByProviderId resolves the correct provider variant', () => {
      const registry = new ModelRegistry(providerConfig);
      const fromA = registry.getModelByProviderId('proxy-a', 'gpt-4');
      const fromB = registry.getModelByProviderId('proxy-b', 'gpt-4');

      expect(fromA?.baseUrl).toBe('https://proxy-a.com/v1');
      expect(fromA?.envKey).toBe('KEY_A');
      expect(fromB?.baseUrl).toBe('https://proxy-b.com/v1');
      expect(fromB?.envKey).toBe('KEY_B');
    });

    it('getModel returns first-registered variant (backward compat)', () => {
      const registry = new ModelRegistry(providerConfig);
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(model).toBeDefined();
      expect(model?.providerId).toBe('proxy-a');
    });

    it('hasModel returns true even when modelId exists in multiple providers', () => {
      const registry = new ModelRegistry(providerConfig);
      expect(registry.hasModel(AuthType.USE_OPENAI, 'gpt-4')).toBe(true);
      expect(registry.hasModel(AuthType.USE_OPENAI, 'only-in-a')).toBe(true);
      expect(registry.hasModel(AuthType.USE_OPENAI, 'only-in-b')).toBe(true);
    });
  });
});
