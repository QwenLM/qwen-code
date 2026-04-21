/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAgentContentGeneratorConfig,
  resolveCredentialField,
} from './content-generator-config.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig } from './types.js';

function createMockConfig(
  parentConfig: ContentGeneratorConfig,
  resolvedModel?: ResolvedModelConfig,
) {
  return {
    getContentGeneratorConfig: () => parentConfig,
    getModelsConfig: () => ({
      getResolvedModel: vi.fn().mockReturnValue(resolvedModel),
    }),
  } as unknown as Config;
}

describe('buildAgentContentGeneratorConfig', () => {
  const parentConfig: ContentGeneratorConfig = {
    model: 'parent-model',
    authType: 'openai' as ContentGeneratorConfig['authType'],
    apiKey: 'parent-key',
    apiKeyEnvKey: 'PARENT_KEY_ENV',
    baseUrl: 'https://parent.example.com',
    samplingParams: { temperature: 0.7, top_p: 0.9 },
    reasoning: { effort: 'high' as const },
    timeout: 30000,
    maxRetries: 3,
    contextWindowSize: 128000,
    extra_body: { custom: 'value' },
  };

  describe('same-provider, bare model ID, no registry match', () => {
    it('should override the model but keep parent generation config', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, 'custom-model', {
        authType: 'openai',
      });

      expect(result.model).toBe('custom-model');
      expect(result.authType).toBe('openai');
      expect(result.apiKey).toBe('parent-key');
      expect(result.baseUrl).toBe('https://parent.example.com');
      expect(result.apiKeyEnvKey).toBe('PARENT_KEY_ENV');
      // Generation config inherited from parent
      expect(result.samplingParams).toEqual({ temperature: 0.7, top_p: 0.9 });
      expect(result.reasoning).toEqual({ effort: 'high' });
      expect(result.timeout).toBe(30000);
      expect(result.maxRetries).toBe(3);
      expect(result.contextWindowSize).toBe(128000);
      expect(result.extra_body).toEqual({ custom: 'value' });
    });
  });

  describe('cross-provider, no registry match', () => {
    it('should clear generation config fields to prevent leaking', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, 'claude-sonnet', {
        authType: 'anthropic',
      });

      expect(result.model).toBe('claude-sonnet');
      expect(result.authType).toBe('anthropic');
      // Generation config cleared
      expect(result.samplingParams).toBeUndefined();
      expect(result.reasoning).toBeUndefined();
      expect(result.timeout).toBeUndefined();
      expect(result.maxRetries).toBeUndefined();
      expect(result.contextWindowSize).toBeUndefined();
      expect(result.extra_body).toBeUndefined();
      // Parent credentials NOT inherited (different provider)
      expect(result.apiKeyEnvKey).toBeUndefined();
    });

    it('should use explicit auth overrides', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, 'claude-sonnet', {
        authType: 'anthropic',
        apiKey: 'explicit-key',
        baseUrl: 'https://explicit.example.com',
      });

      expect(result.apiKey).toBe('explicit-key');
      expect(result.baseUrl).toBe('https://explicit.example.com');
    });
  });

  describe('cross-provider with env var fallback', () => {
    beforeEach(() => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic-key');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://env-anthropic.example.com');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should resolve credentials from provider env vars', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, 'claude-sonnet', {
        authType: 'anthropic',
      });

      expect(result.apiKey).toBe('env-anthropic-key');
    });
  });

  describe('with registry-resolved model', () => {
    const resolvedModel: ResolvedModelConfig = {
      id: 'registry-model-id',
      name: 'Registry Model',
      authType: 'anthropic' as ResolvedModelConfig['authType'],
      baseUrl: 'https://registry.example.com',
      envKey: 'REGISTRY_API_KEY',
      generationConfig: {
        samplingParams: { temperature: 0.5 },
        contextWindowSize: 200000,
        reasoning: { effort: 'medium' as const },
      },
      capabilities: {},
    };

    beforeEach(() => {
      vi.stubEnv('REGISTRY_API_KEY', 'registry-key-from-env');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should apply registry generation config over cleared parent config', () => {
      const config = createMockConfig(parentConfig, resolvedModel);

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        { authType: 'anthropic' },
      );

      expect(result.model).toBe('registry-model-id');
      expect(result.authType).toBe('anthropic');
      expect(result.baseUrl).toBe('https://registry.example.com');
      expect(result.apiKey).toBe('registry-key-from-env');
      expect(result.apiKeyEnvKey).toBe('REGISTRY_API_KEY');
      // Registry generation config applied
      expect(result.samplingParams).toEqual({ temperature: 0.5 });
      expect(result.contextWindowSize).toBe(200000);
      expect(result.reasoning).toEqual({ effort: 'medium' });
      // Fields not in registry stay cleared (cross-provider)
      expect(result.extra_body).toBeUndefined();
    });

    it('should prefer explicit auth overrides over registry values', () => {
      const config = createMockConfig(parentConfig, resolvedModel);

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        {
          authType: 'anthropic',
          apiKey: 'explicit-key',
          baseUrl: 'https://explicit.example.com',
        },
      );

      expect(result.apiKey).toBe('explicit-key');
      expect(result.baseUrl).toBe('https://explicit.example.com');
    });
  });

  describe('edge cases', () => {
    it('should fall back to parent model when modelId is undefined', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, undefined, {
        authType: 'openai',
      });

      expect(result.model).toBe('parent-model');
    });

    it('should keep proxy and userAgent from parent regardless of provider', () => {
      const configWithProxy: ContentGeneratorConfig = {
        ...parentConfig,
        proxy: 'http://proxy.example.com',
        userAgent: 'custom-agent/1.0',
      };
      const config = createMockConfig(configWithProxy);

      const result = buildAgentContentGeneratorConfig(config, 'claude-sonnet', {
        authType: 'anthropic',
      });

      expect(result.proxy).toBe('http://proxy.example.com');
      expect(result.userAgent).toBe('custom-agent/1.0');
    });
  });
});

describe('resolveCredentialField', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should prefer explicit value', () => {
    expect(
      resolveCredentialField('explicit', 'inherited', 'openai', 'apiKey'),
    ).toBe('explicit');
  });

  it('should fall back to inherited value', () => {
    expect(
      resolveCredentialField(undefined, 'inherited', 'openai', 'apiKey'),
    ).toBe('inherited');
  });

  it('should fall back to env var', () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    expect(
      resolveCredentialField(undefined, undefined, 'openai', 'apiKey'),
    ).toBe('env-key');
  });

  it('should return undefined when nothing matches', () => {
    expect(
      resolveCredentialField(undefined, undefined, 'unknown', 'apiKey'),
    ).toBeUndefined();
  });
});
