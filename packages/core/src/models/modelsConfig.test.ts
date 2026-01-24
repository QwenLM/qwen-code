/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ModelsConfig } from './modelsConfig.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from './types.js';

describe('ModelsConfig', () => {
  function deepClone<T>(value: T): T {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((v) => deepClone(v)) as T;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = deepClone((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }

  function snapshotGenerationConfig(
    modelsConfig: ModelsConfig,
  ): ContentGeneratorConfig {
    return deepClone<ContentGeneratorConfig>(
      modelsConfig.getGenerationConfig() as ContentGeneratorConfig,
    );
  }

  function currentGenerationConfig(
    modelsConfig: ModelsConfig,
  ): ContentGeneratorConfig {
    return modelsConfig.getGenerationConfig() as ContentGeneratorConfig;
  }

  it('should fully rollback state when switchModel fails after applying defaults (authType change)', async () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'openai-a',
          name: 'OpenAI A',
          baseUrl: 'https://api.openai.example.com/v1',
          envKey: 'OPENAI_API_KEY',
          generationConfig: {
            samplingParams: { temperature: 0.2, max_tokens: 123 },
            timeout: 111,
            maxRetries: 1,
          },
        },
      ],
      anthropic: [
        {
          id: 'anthropic-b',
          name: 'Anthropic B',
          baseUrl: 'https://api.anthropic.example.com/v1',
          envKey: 'ANTHROPIC_API_KEY',
          generationConfig: {
            samplingParams: { temperature: 0.7, max_tokens: 456 },
            timeout: 222,
            maxRetries: 2,
          },
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
    });

    // Establish a known baseline state via a successful switch.
    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'openai-a');
    const baselineAuthType = modelsConfig.getCurrentAuthType();
    const baselineModel = modelsConfig.getModel();
    const baselineStrict = modelsConfig.isStrictModelProviderSelection();
    const baselineGc = snapshotGenerationConfig(modelsConfig);
    const baselineSources = deepClone(
      modelsConfig.getGenerationConfigSources(),
    );

    modelsConfig.setOnModelChange(async () => {
      throw new Error('refresh failed');
    });

    await expect(
      modelsConfig.switchModel(AuthType.USE_ANTHROPIC, 'anthropic-b'),
    ).rejects.toThrow('refresh failed');

    // Ensure state is fully rolled back (selection + generation config + flags).
    expect(modelsConfig.getCurrentAuthType()).toBe(baselineAuthType);
    expect(modelsConfig.getModel()).toBe(baselineModel);
    expect(modelsConfig.isStrictModelProviderSelection()).toBe(baselineStrict);

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc).toMatchObject({
      model: baselineGc.model,
      baseUrl: baselineGc.baseUrl,
      apiKeyEnvKey: baselineGc.apiKeyEnvKey,
      samplingParams: baselineGc.samplingParams,
      timeout: baselineGc.timeout,
      maxRetries: baselineGc.maxRetries,
    });

    const sources = modelsConfig.getGenerationConfigSources();
    expect(sources).toEqual(baselineSources);
  });

  it('should fully rollback state when switchModel fails after applying defaults', async () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'model-a',
          name: 'Model A',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_A',
        },
        {
          id: 'model-b',
          name: 'Model B',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_B',
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
    });

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'model-a');
    const baselineModel = modelsConfig.getModel();
    const baselineGc = snapshotGenerationConfig(modelsConfig);
    const baselineSources = deepClone(
      modelsConfig.getGenerationConfigSources(),
    );

    modelsConfig.setOnModelChange(async () => {
      throw new Error('hot-update failed');
    });

    await expect(
      modelsConfig.switchModel(AuthType.USE_OPENAI, 'model-b'),
    ).rejects.toThrow('hot-update failed');

    expect(modelsConfig.getModel()).toBe(baselineModel);
    expect(modelsConfig.getGenerationConfig()).toMatchObject({
      model: baselineGc.model,
      baseUrl: baselineGc.baseUrl,
      apiKeyEnvKey: baselineGc.apiKeyEnvKey,
    });
    expect(modelsConfig.getGenerationConfigSources()).toEqual(baselineSources);
  });

  it('should require provider-sourced apiKey when switching models even if envKey is missing', async () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'model-a',
          name: 'Model A',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_SHARED',
        },
        {
          id: 'model-b',
          name: 'Model B',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_SHARED',
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {
        model: 'model-a',
      },
    });

    // Simulate key prompt flow / explicit key provided via CLI/settings.
    modelsConfig.updateCredentials({ apiKey: 'manual-key', model: 'model-a' });

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'model-b');

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('model-b');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.apiKeyEnvKey).toBe('API_KEY_SHARED');
  });

  it('should use provider config when modelId exists in registry even after updateCredentials', () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'model-a',
          name: 'Model A',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_A',
          generationConfig: {
            samplingParams: { temperature: 0.1, max_tokens: 123 },
            timeout: 111,
            maxRetries: 1,
          },
        },
      ],
    };

    // Simulate settings.model.generationConfig being resolved into ModelsConfig.generationConfig
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {
        model: 'custom-model',
        samplingParams: { temperature: 0.9, max_tokens: 999 },
        timeout: 9999,
        maxRetries: 9,
      },
      generationConfigSources: {
        model: { kind: 'settings', detail: 'settings.model.name' },
        samplingParams: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.samplingParams',
        },
        timeout: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.timeout',
        },
        maxRetries: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.maxRetries',
        },
      },
    });

    // User manually updates credentials via updateCredentials.
    // Note: In practice, handleAuthSelect prevents using a modelId that matches a provider model,
    // but if syncAfterAuthRefresh is called with a modelId that exists in registry,
    // we should use provider config.
    modelsConfig.updateCredentials({ apiKey: 'manual-key' });

    // syncAfterAuthRefresh with a modelId that exists in registry should use provider config
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'model-a');

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('model-a');
    // Provider config should be applied
    expect(gc.samplingParams?.temperature).toBe(0.1);
    expect(gc.samplingParams?.max_tokens).toBe(123);
    expect(gc.timeout).toBe(111);
    expect(gc.maxRetries).toBe(1);
  });

  it('should preserve settings generationConfig when modelId does not exist in registry', () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'provider-model',
          name: 'Provider Model',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_A',
          generationConfig: {
            samplingParams: { temperature: 0.1, max_tokens: 123 },
            timeout: 111,
            maxRetries: 1,
          },
        },
      ],
    };

    // Simulate settings with a custom model (not in registry)
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {
        model: 'custom-model',
        samplingParams: { temperature: 0.9, max_tokens: 999 },
        timeout: 9999,
        maxRetries: 9,
      },
      generationConfigSources: {
        model: { kind: 'settings', detail: 'settings.model.name' },
        samplingParams: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.samplingParams',
        },
        timeout: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.timeout',
        },
        maxRetries: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.maxRetries',
        },
      },
    });

    // User manually sets credentials for a custom model (not in registry)
    modelsConfig.updateCredentials({
      apiKey: 'manual-key',
      baseUrl: 'https://manual.example.com/v1',
      model: 'custom-model',
    });

    // First auth refresh - modelId doesn't exist in registry, so credentials should be preserved
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'custom-model');
    // Second auth refresh should still preserve settings generationConfig
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'custom-model');

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('custom-model');
    // Settings-sourced generation config should be preserved since modelId doesn't exist in registry
    expect(gc.samplingParams?.temperature).toBe(0.9);
    expect(gc.samplingParams?.max_tokens).toBe(999);
    expect(gc.timeout).toBe(9999);
    expect(gc.maxRetries).toBe(9);
  });

  it('should clear provider-sourced config when updateCredentials is called after switchModel', async () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'provider-model',
          name: 'Provider Model',
          baseUrl: 'https://provider.example.com/v1',
          envKey: 'PROVIDER_API_KEY',
          generationConfig: {
            samplingParams: { temperature: 0.1, max_tokens: 100 },
            timeout: 1000,
            maxRetries: 2,
          },
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
    });

    // Step 1: Switch to a provider model - this applies provider config
    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'provider-model');

    // Verify provider config is applied
    let gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('provider-model');
    expect(gc.baseUrl).toBe('https://provider.example.com/v1');
    expect(gc.samplingParams?.temperature).toBe(0.1);
    expect(gc.samplingParams?.max_tokens).toBe(100);
    expect(gc.timeout).toBe(1000);
    expect(gc.maxRetries).toBe(2);

    // Verify sources are from modelProviders
    let sources = modelsConfig.getGenerationConfigSources();
    expect(sources['model']?.kind).toBe('modelProviders');
    expect(sources['baseUrl']?.kind).toBe('modelProviders');
    expect(sources['samplingParams']?.kind).toBe('modelProviders');
    expect(sources['timeout']?.kind).toBe('modelProviders');
    expect(sources['maxRetries']?.kind).toBe('modelProviders');

    // Step 2: User manually sets credentials via updateCredentials
    // This should clear all provider-sourced config
    modelsConfig.updateCredentials({
      apiKey: 'manual-api-key',
      model: 'custom-model',
    });

    // Verify provider-sourced config is cleared
    gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('custom-model'); // Set by updateCredentials
    expect(gc.apiKey).toBe('manual-api-key'); // Set by updateCredentials
    expect(gc.baseUrl).toBeUndefined(); // Cleared (was from provider)
    expect(gc.samplingParams).toBeUndefined(); // Cleared (was from provider)
    expect(gc.timeout).toBeUndefined(); // Cleared (was from provider)
    expect(gc.maxRetries).toBeUndefined(); // Cleared (was from provider)

    // Verify sources are updated
    sources = modelsConfig.getGenerationConfigSources();
    expect(sources['model']?.kind).toBe('programmatic');
    expect(sources['apiKey']?.kind).toBe('programmatic');
    expect(sources['baseUrl']).toBeUndefined(); // Source cleared
    expect(sources['samplingParams']).toBeUndefined(); // Source cleared
    expect(sources['timeout']).toBeUndefined(); // Source cleared
    expect(sources['maxRetries']).toBeUndefined(); // Source cleared
  });

  it('should preserve non-provider config when updateCredentials clears provider config', async () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'provider-model',
          name: 'Provider Model',
          baseUrl: 'https://provider.example.com/v1',
          envKey: 'PROVIDER_API_KEY',
          generationConfig: {
            samplingParams: { temperature: 0.1, max_tokens: 100 },
            timeout: 1000,
            maxRetries: 2,
          },
        },
      ],
    };

    // Initialize with settings-sourced config
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {
        samplingParams: { temperature: 0.8, max_tokens: 500 },
        timeout: 5000,
      },
      generationConfigSources: {
        samplingParams: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.samplingParams',
        },
        timeout: {
          kind: 'settings',
          detail: 'settings.model.generationConfig.timeout',
        },
      },
    });

    // Switch to provider model - this overwrites with provider config
    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'provider-model');

    // Verify provider config is applied (overwriting settings)
    let gc = currentGenerationConfig(modelsConfig);
    expect(gc.samplingParams?.temperature).toBe(0.1);
    expect(gc.timeout).toBe(1000);

    // User manually sets credentials - clears provider-sourced config
    modelsConfig.updateCredentials({
      apiKey: 'manual-key',
    });

    // Provider-sourced config should be cleared
    gc = currentGenerationConfig(modelsConfig);
    expect(gc.samplingParams).toBeUndefined();
    expect(gc.timeout).toBeUndefined();
    // The original settings-sourced config is NOT restored automatically;
    // it should be re-resolved by other layers in refreshAuth
  });

  it('should always force Qwen OAuth apiKey placeholder when applying model defaults', async () => {
    // Simulate a stale/explicit apiKey existing before switching models.
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.QWEN_OAUTH,
      generationConfig: {
        apiKey: 'manual-key-should-not-leak',
      },
    });

    // Switching within qwen-oauth triggers applyResolvedModelDefaults().
    await modelsConfig.switchModel(AuthType.QWEN_OAUTH, 'vision-model');

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
    expect(gc.apiKeyEnvKey).toBeUndefined();
  });

  it('should apply Qwen OAuth apiKey placeholder during syncAfterAuthRefresh for fresh users', () => {
    // Fresh user: authType not selected yet (currentAuthType undefined).
    const modelsConfig = new ModelsConfig();

    // Config.refreshAuth passes modelId from modelsConfig.getModel(), which falls back to DEFAULT_QWEN_MODEL.
    modelsConfig.syncAfterAuthRefresh(
      AuthType.QWEN_OAUTH,
      modelsConfig.getModel(),
    );

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('coder-model');
    expect(gc.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
    expect(gc.apiKeyEnvKey).toBeUndefined();
  });

  it('should use default model for new authType when switching from different authType with env vars', () => {
    // Simulate cold start with OPENAI env vars (OPENAI_MODEL and OPENAI_API_KEY)
    // This sets the model in generationConfig but no authType is selected yet
    const modelsConfig = new ModelsConfig({
      generationConfig: {
        model: 'gpt-4o', // From OPENAI_MODEL env var
        apiKey: 'openai-key-from-env',
      },
    });

    // User switches to qwen-oauth via AuthDialog
    // refreshAuth calls syncAfterAuthRefresh with the current model (gpt-4o)
    // which doesn't exist in qwen-oauth registry, so it should use default
    modelsConfig.syncAfterAuthRefresh(AuthType.QWEN_OAUTH, 'gpt-4o');

    const gc = currentGenerationConfig(modelsConfig);
    // Should use default qwen-oauth model (coder-model), not the OPENAI model
    expect(gc.model).toBe('coder-model');
    expect(gc.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
    expect(gc.apiKeyEnvKey).toBeUndefined();
  });

  it('should clear manual credentials when switching from USE_OPENAI to QWEN_OAUTH', () => {
    // User manually set credentials for OpenAI
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'gpt-4o',
        apiKey: 'manual-openai-key',
        baseUrl: 'https://manual.example.com/v1',
      },
    });

    // Manually set credentials via updateCredentials
    modelsConfig.updateCredentials({
      apiKey: 'manual-openai-key',
      baseUrl: 'https://manual.example.com/v1',
      model: 'gpt-4o',
    });

    // User switches to qwen-oauth
    // Since authType is not USE_OPENAI, manual credentials should be cleared
    // and default qwen-oauth model should be applied
    modelsConfig.syncAfterAuthRefresh(AuthType.QWEN_OAUTH, 'gpt-4o');

    const gc = currentGenerationConfig(modelsConfig);
    // Should use default qwen-oauth model, not preserve manual OpenAI credentials
    expect(gc.model).toBe('coder-model');
    expect(gc.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
    // baseUrl should be set to qwen-oauth default, not preserved from manual OpenAI config
    expect(gc.baseUrl).toBe('DYNAMIC_QWEN_OAUTH_BASE_URL');
    expect(gc.apiKeyEnvKey).toBeUndefined();
  });

  it('should preserve manual credentials when switching to USE_OPENAI', () => {
    // User manually set credentials
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'gpt-4o',
        apiKey: 'manual-openai-key',
        baseUrl: 'https://manual.example.com/v1',
        samplingParams: { temperature: 0.9 },
      },
    });

    // Manually set credentials via updateCredentials
    modelsConfig.updateCredentials({
      apiKey: 'manual-openai-key',
      baseUrl: 'https://manual.example.com/v1',
      model: 'gpt-4o',
    });

    // User switches to USE_OPENAI (same or different model)
    // Since authType is USE_OPENAI, manual credentials should be preserved
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'gpt-4o');

    const gc = currentGenerationConfig(modelsConfig);
    // Should preserve manual credentials
    expect(gc.model).toBe('gpt-4o');
    expect(gc.apiKey).toBe('manual-openai-key');
    expect(gc.baseUrl).toBe('https://manual.example.com/v1');
    expect(gc.samplingParams?.temperature).toBe(0.9); // Preserved from initial config
  });

  it('should maintain consistency between currentModelId and _generationConfig.model after initialization', () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'test-model',
          name: 'Test Model',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'TEST_API_KEY',
        },
      ],
    };

    // Test case 1: generationConfig.model provided with other config
    const config1 = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {
        model: 'test-model',
        samplingParams: { temperature: 0.5 },
      },
    });
    expect(config1.getModel()).toBe('test-model');
    expect(config1.getGenerationConfig().model).toBe('test-model');

    // Test case 2: generationConfig.model provided
    const config2 = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {
        model: 'test-model',
      },
    });
    expect(config2.getModel()).toBe('test-model');
    expect(config2.getGenerationConfig().model).toBe('test-model');

    // Test case 3: no model provided (empty string fallback)
    const config3 = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {},
    });
    expect(config3.getModel()).toBe('coder-model'); // Falls back to DEFAULT_QWEN_MODEL
    expect(config3.getGenerationConfig().model).toBeUndefined();
  });

  it('should maintain consistency between currentModelId and _generationConfig.model during syncAfterAuthRefresh', () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'model-a',
          name: 'Model A',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_A',
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
      generationConfig: {
        model: 'model-a',
      },
    });

    // Manually set credentials to trigger preserveManualCredentials path
    modelsConfig.updateCredentials({ apiKey: 'manual-key' });

    // syncAfterAuthRefresh with a different modelId
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'model-a');

    // Both should be consistent
    expect(modelsConfig.getModel()).toBe('model-a');
    expect(modelsConfig.getGenerationConfig().model).toBe('model-a');
  });

  it('should maintain consistency between currentModelId and _generationConfig.model during setModel', async () => {
    const modelProvidersConfig: ModelProvidersConfig = {
      openai: [
        {
          id: 'model-a',
          name: 'Model A',
          baseUrl: 'https://api.example.com/v1',
          envKey: 'API_KEY_A',
        },
      ],
    };

    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig,
    });

    // setModel with a raw model ID
    await modelsConfig.setModel('custom-model');

    // Both should be consistent
    expect(modelsConfig.getModel()).toBe('custom-model');
    expect(modelsConfig.getGenerationConfig().model).toBe('custom-model');
  });

  it('should maintain consistency between currentModelId and _generationConfig.model during updateCredentials', () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
    });

    // updateCredentials with model
    modelsConfig.updateCredentials({
      apiKey: 'test-key',
      model: 'updated-model',
    });

    // Both should be consistent
    expect(modelsConfig.getModel()).toBe('updated-model');
    expect(modelsConfig.getGenerationConfig().model).toBe('updated-model');
  });

  describe('getAllAvailableModels', () => {
    it('should return all models across all authTypes', () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'openai-model-1',
            name: 'OpenAI Model 1',
            baseUrl: 'https://api.openai.com/v1',
            envKey: 'OPENAI_API_KEY',
          },
          {
            id: 'openai-model-2',
            name: 'OpenAI Model 2',
            baseUrl: 'https://api.openai.com/v1',
            envKey: 'OPENAI_API_KEY',
          },
        ],
        anthropic: [
          {
            id: 'anthropic-model-1',
            name: 'Anthropic Model 1',
            baseUrl: 'https://api.anthropic.com/v1',
            envKey: 'ANTHROPIC_API_KEY',
          },
        ],
        gemini: [
          {
            id: 'gemini-model-1',
            name: 'Gemini Model 1',
            baseUrl: 'https://generativelanguage.googleapis.com/v1',
            envKey: 'GEMINI_API_KEY',
          },
        ],
      };

      const modelsConfig = new ModelsConfig({
        modelProvidersConfig,
      });

      const allModels = modelsConfig.getAllAvailableModels();

      // Should include qwen-oauth models (hard-coded)
      const qwenModels = allModels.filter(
        (m) => m.authType === AuthType.QWEN_OAUTH,
      );
      expect(qwenModels.length).toBeGreaterThan(0);

      // Should include openai models
      const openaiModels = allModels.filter(
        (m) => m.authType === AuthType.USE_OPENAI,
      );
      expect(openaiModels.length).toBe(2);
      expect(openaiModels.map((m) => m.id)).toContain('openai-model-1');
      expect(openaiModels.map((m) => m.id)).toContain('openai-model-2');

      // Should include anthropic models
      const anthropicModels = allModels.filter(
        (m) => m.authType === AuthType.USE_ANTHROPIC,
      );
      expect(anthropicModels.length).toBe(1);
      expect(anthropicModels[0].id).toBe('anthropic-model-1');

      // Should include gemini models
      const geminiModels = allModels.filter(
        (m) => m.authType === AuthType.USE_GEMINI,
      );
      expect(geminiModels.length).toBe(1);
      expect(geminiModels[0].id).toBe('gemini-model-1');
    });

    it('should return empty array when no models are registered', () => {
      const modelsConfig = new ModelsConfig();

      const allModels = modelsConfig.getAllAvailableModels();

      // Should still include qwen-oauth models (hard-coded)
      expect(allModels.length).toBeGreaterThan(0);
      const qwenModels = allModels.filter(
        (m) => m.authType === AuthType.QWEN_OAUTH,
      );
      expect(qwenModels.length).toBeGreaterThan(0);
    });

    it('should return models with correct structure', () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'test-model',
            name: 'Test Model',
            description: 'A test model',
            baseUrl: 'https://api.example.com/v1',
            envKey: 'TEST_API_KEY',
            capabilities: {
              vision: true,
            },
          },
        ],
      };

      const modelsConfig = new ModelsConfig({
        modelProvidersConfig,
      });

      const allModels = modelsConfig.getAllAvailableModels();
      const testModel = allModels.find((m) => m.id === 'test-model');

      expect(testModel).toBeDefined();
      expect(testModel?.id).toBe('test-model');
      expect(testModel?.label).toBe('Test Model');
      expect(testModel?.description).toBe('A test model');
      expect(testModel?.authType).toBe(AuthType.USE_OPENAI);
      expect(testModel?.isVision).toBe(true);
      expect(testModel?.capabilities?.vision).toBe(true);
    });
  });
});
