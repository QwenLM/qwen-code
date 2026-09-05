/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAgentContentGeneratorConfig,
  createRuntimeContentGeneratorView,
  resolveCredentialField,
} from './content-generator-config.js';
import { AuthType, createContentGenerator } from '../core/contentGenerator.js';
import { ModelRegistry } from './modelRegistry.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig } from './types.js';

vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  return {
    ...actual,
    createContentGenerator: vi.fn(),
  };
});

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
  const parentConfig = {
    model: 'parent-model',
    authType: 'openai' as ContentGeneratorConfig['authType'],
    apiKey: 'parent-key',
    apiKeyEnvKey: 'PARENT_KEY_ENV',
    baseUrl: 'https://parent.example.com',
    samplingParams: { temperature: 0.7, top_p: 0.9 },
    reasoning: { effort: 'high' as const },
    timeout: 30000,
    streamIdleTimeoutMs: 300000,
    maxRetries: 3,
    contextWindowSize: 128000,
    extra_body: { custom: 'value' },
  } satisfies ContentGeneratorConfig;

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
      expect(result.streamIdleTimeoutMs).toBe(300000);
      expect(result.maxRetries).toBe(3);
      expect(result.contextWindowSize).toBe(128000);
      expect(result.extra_body).toEqual({ custom: 'value' });
    });

    it('does not inherit mandatory thinking from another model', () => {
      const config = createMockConfig({
        ...parentConfig,
        thinkingMandatory: true,
      });

      const result = buildAgentContentGeneratorConfig(config, 'custom-model', {
        authType: 'openai',
      });

      expect(result.thinkingMandatory).toBeUndefined();
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
      expect(result.streamIdleTimeoutMs).toBeUndefined();
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
        streamIdleTimeoutMs: 600000,
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
      expect(result.streamIdleTimeoutMs).toBe(600000);
      expect(result.contextWindowSize).toBe(200000);
      expect(result.reasoning).toEqual({ effort: 'medium' });
      // Fields not in registry stay cleared (cross-provider)
      expect(result.extra_body).toBeUndefined();
    });

    it('should preserve a zero stream idle timeout from the registry', () => {
      const config = createMockConfig(parentConfig, {
        ...resolvedModel,
        generationConfig: {
          ...resolvedModel.generationConfig,
          streamIdleTimeoutMs: 0,
        },
      });

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        { authType: 'anthropic' },
      );

      expect(result.streamIdleTimeoutMs).toBe(0);
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

    it('should use explicit baseUrl when looking up a registry model', () => {
      const getResolvedModel = vi.fn().mockReturnValue(resolvedModel);
      const config = {
        getContentGeneratorConfig: () => parentConfig,
        getModelsConfig: () => ({ getResolvedModel }),
      } as unknown as Config;

      buildAgentContentGeneratorConfig(config, 'registry-model-id', {
        authType: 'anthropic',
        baseUrl: 'https://registry.example.com',
      });

      expect(getResolvedModel).toHaveBeenCalledWith(
        'anthropic',
        'registry-model-id',
        'https://registry.example.com',
      );
    });

    it('does not inherit mandatory thinking from another same-provider model', () => {
      const config = createMockConfig(
        { ...parentConfig, thinkingMandatory: true },
        {
          ...resolvedModel,
          authType: 'openai' as ResolvedModelConfig['authType'],
        },
      );

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        { authType: 'openai' },
      );

      expect(result.thinkingMandatory).toBeUndefined();
    });

    it('rejects image-only models for agent content generation', () => {
      const config = createMockConfig(parentConfig, {
        ...resolvedModel,
        imageOnly: true,
      });

      expect(() =>
        buildAgentContentGeneratorConfig(config, 'registry-model-id', {
          authType: 'anthropic',
        }),
      ).toThrow(
        "Image-only model 'registry-model-id' cannot be used for content generation",
      );
    });

    it('allows dual-role models for agent content generation', () => {
      const config = createMockConfig(parentConfig, {
        ...resolvedModel,
        supportsImageGeneration: true,
      });

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        { authType: 'anthropic' },
      );

      expect(result.model).toBe('registry-model-id');
      expect(result.authType).toBe('anthropic');
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

  describe('local worker credential isolation', () => {
    const localModel: ResolvedModelConfig = {
      id: 'local-worker',
      name: 'Local worker',
      authType: 'openai' as ResolvedModelConfig['authType'],
      baseUrl: 'http://127.0.0.1:11434/v1',
      registryBaseUrl: 'http://127.0.0.1:11434/v1',
      envKey: 'LOCAL_WORKER_KEY',
      generationConfig: {},
      capabilities: {},
    };

    beforeEach(() => {
      vi.stubEnv('LOCAL_WORKER_KEY', undefined);
      vi.stubEnv('OPENAI_API_KEY', 'global-cloud-key');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([undefined, ''])(
      'does not replace a missing worker key (%s)',
      (key) => {
        vi.stubEnv('LOCAL_WORKER_KEY', key);
        const result = buildAgentContentGeneratorConfig(
          createMockConfig(parentConfig, localModel),
          localModel.id,
          { authType: 'openai' },
        );

        expect(result.apiKey).toBe(key);
        expect(result.apiKeyEnvKey).toBe('LOCAL_WORKER_KEY');
        expect(result.baseUrl).toBe(localModel.baseUrl);
      },
    );

    it('honors a missing explicit envKey even on the leader endpoint', () => {
      const result = buildAgentContentGeneratorConfig(
        createMockConfig(parentConfig, {
          ...localModel,
          baseUrl: parentConfig.baseUrl,
        }),
        localModel.id,
        { authType: 'openai' },
      );

      expect(result.apiKey).toBeUndefined();
      expect(result.apiKeyEnvKey).toBe('LOCAL_WORKER_KEY');
    });

    it.each([true, false])(
      'does not use parent or global keys for another endpoint (registered=%s)',
      (registered) => {
        const result = buildAgentContentGeneratorConfig(
          createMockConfig(
            parentConfig,
            registered ? { ...localModel, envKey: undefined } : undefined,
          ),
          localModel.id,
          { authType: 'openai', baseUrl: localModel.baseUrl },
        );

        expect(result.apiKey).toBeUndefined();
        expect(result.apiKeyEnvKey).toBeUndefined();
        expect(result.baseUrl).toBe(localModel.baseUrl);
      },
    );

    it.each([true, false])(
      'accepts an explicit worker key (registered=%s)',
      (registered) => {
        const result = buildAgentContentGeneratorConfig(
          createMockConfig(parentConfig, registered ? localModel : undefined),
          localModel.id,
          {
            authType: 'openai',
            baseUrl: localModel.baseUrl,
            apiKey: 'explicit-worker-key',
          },
        );

        expect(result.apiKey).toBe('explicit-worker-key');
        expect(result.baseUrl).toBe(localModel.baseUrl);
      },
    );

    it('keeps the leader unchanged while applying only worker request options', () => {
      vi.stubEnv('LOCAL_WORKER_KEY', 'ollama');
      const leader = {
        ...parentConfig,
        customHeaders: { Authorization: 'Bearer leader-header' },
      };
      const before = structuredClone(leader);
      const result = buildAgentContentGeneratorConfig(
        createMockConfig(leader, {
          ...localModel,
          generationConfig: { contextWindowSize: 8192, timeout: 60000 },
        }),
        localModel.id,
        { authType: 'openai' },
      );

      expect(result.apiKey).toBe('ollama');
      expect(result.customHeaders).toBeUndefined();
      expect(result.reasoning).toBeUndefined();
      expect(result.samplingParams).toBeUndefined();
      expect(result.extra_body).toBeUndefined();
      expect(result.contextWindowSize).toBe(8192);
      expect(result.timeout).toBe(60000);
      expect(leader).toEqual(before);
    });

    it('does not inherit custom headers when the credential declaration changes', () => {
      vi.stubEnv('LOCAL_WORKER_KEY', 'worker-key');
      const result = buildAgentContentGeneratorConfig(
        createMockConfig(
          { ...parentConfig, customHeaders: { 'X-Api-Key': 'leader-header' } },
          { ...localModel, baseUrl: parentConfig.baseUrl },
        ),
        localModel.id,
        { authType: 'openai' },
      );

      expect(result.apiKey).toBe('worker-key');
      expect(result.customHeaders).toBeUndefined();
    });

    it('applies the local model own custom headers', () => {
      vi.stubEnv('LOCAL_WORKER_KEY', 'ollama');
      const headers = { 'X-Worker': 'local' };
      const result = buildAgentContentGeneratorConfig(
        createMockConfig(parentConfig, {
          ...localModel,
          generationConfig: { customHeaders: headers },
        }),
        localModel.id,
        { authType: 'openai' },
      );

      expect(result.customHeaders).toEqual(headers);
    });

    it.each([true, false])(
      'isolates a Gemini leader from a local worker (key=%s)',
      (hasKey) => {
        if (hasKey) vi.stubEnv('LOCAL_WORKER_KEY', 'ollama');
        const result = buildAgentContentGeneratorConfig(
          createMockConfig(
            {
              ...parentConfig,
              authType: 'gemini' as ContentGeneratorConfig['authType'],
            },
            { ...localModel, envKey: hasKey ? 'LOCAL_WORKER_KEY' : undefined },
          ),
          localModel.id,
          { authType: 'openai' },
        );

        expect(result.apiKey).toBe(hasKey ? 'ollama' : undefined);
        expect(result.baseUrl).toBe(localModel.baseUrl);
        expect(result.authType).toBe('openai');
      },
    );

    it('drops parent headers when an explicit key changes on the same endpoint', () => {
      const result = buildAgentContentGeneratorConfig(
        createMockConfig({
          ...parentConfig,
          customHeaders: { Authorization: 'Bearer parent-header' },
        }),
        'other-model',
        { authType: 'openai', apiKey: 'worker-key' },
      );

      expect(result.apiKey).toBe('worker-key');
      expect(result.customHeaders).toBeUndefined();
      expect(result.baseUrl).toBe(parentConfig.baseUrl);
    });

    it('preserves same-endpoint inheritance without a separate credential', () => {
      const result = buildAgentContentGeneratorConfig(
        createMockConfig(parentConfig, {
          ...localModel,
          baseUrl: parentConfig.baseUrl,
          envKey: undefined,
        }),
        localModel.id,
        { authType: 'openai' },
      );

      expect(result.apiKey).toBe(parentConfig.apiKey);
      expect(result.apiKeyEnvKey).toBe(parentConfig.apiKeyEnvKey);
      expect(result.reasoning).toEqual(parentConfig.reasoning);
    });

    it.each([
      [AuthType.USE_GEMINI, 'GEMINI_API_KEY'],
      [AuthType.USE_ANTHROPIC, 'ANTHROPIC_API_KEY'],
      [AuthType.USE_OPENAI, 'OPENAI_API_KEY'],
    ])(
      'preserves provider-default credentials for registered %s workers',
      (authType, key) => {
        vi.stubEnv(key, 'worker-default-key');
        const registry = new ModelRegistry({
          [authType]: [{ id: 'default-worker' }],
        });
        const resolved = registry.getModel(authType, 'default-worker');
        expect(resolved).toBeDefined();
        const config = createMockConfig(
          {
            ...parentConfig,
            authType:
              authType === AuthType.USE_OPENAI
                ? AuthType.USE_GEMINI
                : AuthType.USE_OPENAI,
          },
          resolved,
        );

        for (const baseUrl of [undefined, resolved!.baseUrl]) {
          const result = buildAgentContentGeneratorConfig(
            config,
            'default-worker',
            { authType, baseUrl },
          );
          expect(result.apiKey).toBe('worker-default-key');
        }
      },
    );

    it.each([AuthType.USE_GEMINI, AuthType.USE_OPENAI])(
      'requires a local credential in the real registry with a %s leader',
      (authType) => {
        const registry = new ModelRegistry({
          openai: [{ id: localModel.id, baseUrl: localModel.baseUrl }],
        });
        const resolved = registry.getModel(AuthType.USE_OPENAI, localModel.id);
        expect(resolved).toBeDefined();
        const result = buildAgentContentGeneratorConfig(
          createMockConfig({ ...parentConfig, authType }, resolved),
          localModel.id,
          { authType: AuthType.USE_OPENAI, baseUrl: localModel.baseUrl },
        );
        expect(result.apiKey).toBeUndefined();
        expect(result.baseUrl).toBe(localModel.baseUrl);
      },
    );
  });
});

describe('createRuntimeContentGeneratorView', () => {
  const parentConfig: ContentGeneratorConfig = {
    model: 'parent-model',
    authType: 'openai' as ContentGeneratorConfig['authType'],
    apiKey: 'parent-key',
    baseUrl: 'https://parent.example.com',
  };

  beforeEach(() => {
    vi.mocked(createContentGenerator).mockReset();
  });

  it('should bind the new ContentGenerator to contentGeneratorOwner, not base', async () => {
    const baseConfig = createMockConfig(parentConfig);
    // Distinct instance — represents the per-agent override Config.
    const ownerConfig = createMockConfig(parentConfig);
    const fakeGenerator = { generateContentStream: vi.fn() };
    vi.mocked(createContentGenerator).mockResolvedValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeGenerator as any,
    );

    const view = await createRuntimeContentGeneratorView(
      baseConfig,
      ownerConfig,
      'custom-model',
      { authType: 'openai' },
    );

    expect(createContentGenerator).toHaveBeenCalledTimes(1);
    const [, ownerArg] = vi.mocked(createContentGenerator).mock.calls[0];
    expect(ownerArg).toBe(ownerConfig);
    expect(ownerArg).not.toBe(baseConfig);
    expect(view.contentGenerator).toBe(fakeGenerator);
    expect(view.contentGeneratorConfig.model).toBe('custom-model');
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
