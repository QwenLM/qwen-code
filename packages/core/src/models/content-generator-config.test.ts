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
import { createContentGenerator } from '../core/contentGenerator.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig } from './types.js';
import { ModelsConfig } from './modelsConfig.js';

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
  const parentConfig: ContentGeneratorConfig = {
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
  };

  describe('endpoint-qualified advisor models', () => {
    afterEach(() => vi.unstubAllEnvs());

    function endpointConfig() {
      const models = new ModelsConfig({
        modelProvidersConfig: {
          openai: [
            { id: 'shared', envKey: 'IMPLICIT_KEY' },
            {
              id: 'shared',
              baseUrl: 'https://parent.example.com',
              envKey: 'PARENT_KEY_ENV',
            },
            {
              id: 'shared',
              baseUrl: 'https://second.example/v1',
              envKey: 'SECOND_KEY',
            },
          ],
        },
      });
      return {
        getContentGeneratorConfig: () => ({
          ...parentConfig,
          model: 'shared',
          customHeaders: { Authorization: 'parent-secret' },
        }),
        getModelsConfig: () => models,
      } as unknown as Config;
    }

    it('uses the selected endpoint and its own credential with a bare model ID', () => {
      vi.stubEnv('SECOND_KEY', 'second-key');
      const result = buildAgentContentGeneratorConfig(
        endpointConfig(),
        'shared',
        {
          authType: 'openai',
          registryBaseUrl: 'https://second.example/v1',
        },
      );
      expect(result).toMatchObject({
        model: 'shared',
        baseUrl: 'https://second.example/v1',
        apiKey: 'second-key',
        apiKeyEnvKey: 'SECOND_KEY',
      });
      expect(result.customHeaders).toBeUndefined();
    });

    it('does not send parent credentials to an endpoint with a missing key', () => {
      vi.stubEnv('SECOND_KEY', undefined);
      const result = buildAgentContentGeneratorConfig(
        endpointConfig(),
        'shared',
        {
          authType: 'openai',
          registryBaseUrl: 'https://second.example/v1',
        },
      );
      expect(result.apiKey).toBeUndefined();
      expect(result.customHeaders).toBeUndefined();
    });

    it('retains credentials and headers when the selected route matches the parent', () => {
      vi.stubEnv('PARENT_KEY_ENV', undefined);
      const result = buildAgentContentGeneratorConfig(
        endpointConfig(),
        'shared',
        {
          authType: 'openai',
          registryBaseUrl: 'https://parent.example.com',
        },
      );
      expect(result.apiKey).toBe('parent-key');
      expect(result.customHeaders).toEqual({ Authorization: 'parent-secret' });
    });

    it('selects an implicit endpoint exactly and rejects a removed explicit endpoint', () => {
      vi.stubEnv('IMPLICIT_KEY', 'implicit-key');
      const config = endpointConfig();
      expect(
        buildAgentContentGeneratorConfig(config, 'shared', {
          authType: 'openai',
          registryBaseUrl: null,
        }),
      ).toMatchObject({ apiKey: 'implicit-key' });
      expect(() =>
        buildAgentContentGeneratorConfig(config, 'shared', {
          authType: 'openai',
          registryBaseUrl: 'https://api.openai.com/v1',
        }),
      ).toThrow('no longer configured');
    });
  });

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

    it('does not inherit enableRequestMetadata from another same-provider model', () => {
      // A per-model decision: an inherited true would ship the DashScope
      // tracing object to a vendor-forwarded side model and get the 400 the
      // gate exists to avoid, so an unset side model falls back to the gate.
      const config = createMockConfig(
        { ...parentConfig, enableRequestMetadata: true },
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

      expect(result.enableRequestMetadata).toBeUndefined();
    });

    it.each(['image', 'voice'] as const)(
      'rejects %s-only models for agent content generation',
      (purpose) => {
        const config = createMockConfig(parentConfig, {
          ...resolvedModel,
          ...(purpose === 'image' ? { imageOnly: true } : { voiceOnly: true }),
        });

        expect(() =>
          buildAgentContentGeneratorConfig(config, 'registry-model-id', {
            authType: 'anthropic',
          }),
        ).toThrow(
          `${purpose === 'image' ? 'Image' : 'Voice'}-only model 'registry-model-id' cannot be used for content generation`,
        );
      },
    );

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

  // A workflow `agent({ effort })` gets its tier through this builder. It has
  // to land on the agent's copy by the rule `/effort` uses, and never on the
  // session config that copy was spread from.
  describe('per-agent reasoning effort', () => {
    // An explicit tier is authoritative on the copy: an inherited budget would
    // outrank it on the wire, so the copy drops it. The parent keeps both.
    it('writes the tier onto an inherited copy, drops the inherited budget, and leaves the parent alone', () => {
      const parent: ContentGeneratorConfig = {
        ...parentConfig,
        reasoning: { effort: 'high', budget_tokens: 4096 },
      };
      const config = createMockConfig(parent);

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(result.model).toBe('parent-model');
      expect(result.apiKey).toBe('parent-key');
      expect(result.reasoning).toEqual({ effort: 'low' });
      expect(parent.reasoning).toEqual({ effort: 'high', budget_tokens: 4096 });
    });

    it('leaves thinking off when the parent turned it off', () => {
      const config = createMockConfig({ ...parentConfig, reasoning: false });

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toBe(false);
    });

    it('applies after a cross-provider switch cleared the generation config', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(
        config,
        'claude-sonnet',
        { authType: 'anthropic' },
        { reasoningEffort: 'xhigh' },
      );

      expect(result.samplingParams).toBeUndefined();
      expect(result.reasoning).toEqual({ effort: 'xhigh' });
    });

    it('changes nothing when no effort is requested', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        {},
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    // Limited to what `/effort` offers the agent's model: an unoffered tier
    // becomes the next stronger offered one (else the strongest), and a model
    // that offers none keeps the tier the agent inherited.
    it('clamps to the tiers the model declares', () => {
      const config = createMockConfig(parentConfig, {
        capabilities: {
          reasoning: {
            thinking: true,
            disableField: 'reasoning_effort',
            efforts: ['low', 'medium', 'high'],
          },
        },
      } as unknown as ResolvedModelConfig);

      const above = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );
      const offered = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(above.reasoning).toEqual({ effort: 'high' });
      expect(offered.reasoning).toEqual({ effort: 'low' });
    });

    it('keeps the inherited tier for a model that offers none', () => {
      const config = createMockConfig(parentConfig, {
        capabilities: {
          reasoning: {
            thinking: true,
            disableField: 'enable_thinking',
            toggleOnly: true,
          },
        },
      } as unknown as ResolvedModelConfig);

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it('drops a thinking budget the agent model registry provides', () => {
      const registryModel = {
        id: 'registry-model',
        authType: 'openai',
        name: 'registry-model',
        baseUrl: 'https://registry.example.com',
        generationConfig: { reasoning: { budget_tokens: 32000 } },
        capabilities: {},
      } as unknown as ResolvedModelConfig;
      const config = createMockConfig(parentConfig, registryModel);

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model',
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(result.model).toBe('registry-model');
      expect(result.reasoning).toEqual({ effort: 'low' });
    });

    // A provider switch clears the session's `reasoning: false` from the copy;
    // the tier must still not switch thinking back on.
    it('never re-enables thinking the session turned off, even across providers', () => {
      const config = createMockConfig({ ...parentConfig, reasoning: false });

      const result = buildAgentContentGeneratorConfig(
        config,
        'claude-sonnet',
        { authType: 'anthropic' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toBeUndefined();
    });

    // Registry stubs that answer only for the arguments they are given, so a
    // lookup keyed on the wrong model or an exact-only base URL shows up.
    const DECLARED_TIERS = {
      thinking: true,
      disableField: 'reasoning_effort',
      efforts: ['low', 'medium', 'high'],
    };
    function configWithRegistry(
      parent: ContentGeneratorConfig,
      entry: { authType: string; model: string; baseUrl: string },
    ): Config {
      const getResolvedModel = vi.fn(
        (authType: string, model: string, baseUrl?: string) =>
          authType === entry.authType &&
          model === entry.model &&
          (baseUrl === undefined || baseUrl === entry.baseUrl)
            ? ({
                id: entry.model,
                authType: entry.authType,
                name: entry.model,
                baseUrl: entry.baseUrl,
                generationConfig: {},
                capabilities: { reasoning: DECLARED_TIERS },
              } as unknown as ResolvedModelConfig)
            : undefined,
      );
      return {
        getContentGeneratorConfig: () => parent,
        getModelsConfig: () => ({ getResolvedModel }),
      } as unknown as Config;
    }

    it("clamps against the agent's own model, not the session's", () => {
      const config = configWithRegistry(parentConfig, {
        authType: 'openai',
        model: 'agent-model',
        baseUrl: 'https://agent.example.com',
      });

      const result = buildAgentContentGeneratorConfig(
        config,
        'agent-model',
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.model).toBe('agent-model');
      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it('finds the declared tiers behind a gateway base URL', () => {
      const config = configWithRegistry(
        { ...parentConfig, baseUrl: 'https://gw.internal/v1' },
        {
          authType: 'openai',
          model: 'parent-model',
          baseUrl: 'https://api.openai.com/v1',
        },
      );

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it("falls back to the provider's built-in tiers when the registry declares none", () => {
      const config = createMockConfig({ ...parentConfig, model: 'gpt-5' });

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it('refuses an interactive login when asked to', async () => {
      const config = createMockConfig(parentConfig);
      vi.mocked(createContentGenerator).mockResolvedValue(
        {} as Awaited<ReturnType<typeof createContentGenerator>>,
      );

      await createRuntimeContentGeneratorView(
        config,
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'low', requireCachedCredentials: true },
      );

      expect(createContentGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: 'low' } }),
        config,
        true,
      );
    });

    it('carries the effort through createRuntimeContentGeneratorView', async () => {
      const config = createMockConfig(parentConfig);
      vi.mocked(createContentGenerator).mockResolvedValue(
        {} as Awaited<ReturnType<typeof createContentGenerator>>,
      );

      const view = await createRuntimeContentGeneratorView(
        config,
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'medium' },
      );

      expect(view.contentGeneratorConfig.reasoning).toEqual({
        effort: 'medium',
      });
      expect(createContentGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: 'medium' } }),
        config,
      );
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
