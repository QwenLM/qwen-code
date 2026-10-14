/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { ModelsConfig } from './modelsConfig.js';
import type { ModelsConfigOptions } from './modelsConfig.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { ModelConfig, ModelProvidersConfig } from './types.js';
import type { ConfigSource, ConfigSources } from '../utils/configResolver.js';

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

  const API_URL = 'https://api.example.com/v1';
  const OPENAI_URL = 'https://api.openai.com/v1';
  // A registry entry; omitted arguments leave their keys out.
  const entry = (
    id: string,
    name: string,
    baseUrl?: string,
    envKey?: string,
    generationConfig?: ModelConfig['generationConfig'],
  ): ModelConfig => ({
    id,
    name,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(envKey === undefined ? {} : { envKey }),
    ...(generationConfig === undefined ? {} : { generationConfig }),
  });
  // A USE_OPENAI config whose registry holds these openai entries.
  const openaiConfig = (
    openai: ModelConfig[],
    generationConfig?: ModelsConfigOptions['generationConfig'],
    generationConfigSources?: ConfigSources,
  ) =>
    new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig: { openai },
      ...(generationConfig === undefined ? {} : { generationConfig }),
      ...(generationConfigSources === undefined
        ? {}
        : { generationConfigSources }),
    });
  const settingsSrc = (detail: string): ConfigSource => ({
    kind: 'settings',
    detail,
  });
  const providerSrc = (modelId: string, detail: string): ConfigSource => ({
    kind: 'modelProviders',
    authType: 'openai',
    modelId,
    detail,
  });
  // model from settings.model.name, apiKey (and baseUrl) from security.auth.
  const settingsAuthSources = (withBaseUrl = false): ConfigSources => ({
    model: settingsSrc('settings.model.name'),
    apiKey: settingsSrc('security.auth.apiKey'),
    ...(withBaseUrl ? { baseUrl: settingsSrc('security.auth.baseUrl') } : {}),
  });
  const cliSources = (): ConfigSources => ({
    model: { kind: 'cli', detail: '--model' },
    apiKey: { kind: 'cli', detail: '--openaiApiKey' },
  });
  const testSources = (): ConfigSources => ({
    model: { kind: 'programmatic', detail: 'test' },
    apiKey: { kind: 'programmatic', detail: 'test' },
    baseUrl: { kind: 'programmatic', detail: 'test' },
  });
  const unsetEnv = (key: string) => {
    delete process.env[key];
    return key;
  };
  // Refreshes USE_OPENAI auth onto `modelId`; returns the generation config.
  const refreshOpenAI = (modelsConfig: ModelsConfig, modelId: string) => {
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, modelId);
    return currentGenerationConfig(modelsConfig);
  };
  const switchOpenAI = async (modelsConfig: ModelsConfig, modelId: string) => {
    await modelsConfig.switchModel(AuthType.USE_OPENAI, modelId);
    return currentGenerationConfig(modelsConfig);
  };
  const failModelChange = (modelsConfig: ModelsConfig, message: string) =>
    modelsConfig.setOnModelChange(async () => {
      throw new Error(message);
    });
  const hasModel = (modelsConfig: ModelsConfig, id: string) =>
    modelsConfig.getAllConfiguredModels().some((m) => m.id === id);
  const ofAuthType = (
    models: ReturnType<ModelsConfig['getAllConfiguredModels']>,
    authType: string,
  ) => models.filter((m) => m.authType === authType);

  // `special` must be refused as primary and skipped by the auth fallback.
  const expectRefusedAsPrimary = async (
    special: ModelConfig,
    message: string,
  ) => {
    const models = new ModelsConfig({
      modelProvidersConfig: { openai: [special, { id: 'chat' }] },
    });
    models.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'missing');
    expect(models.getModel()).toBe('chat');
    await expect(
      models.switchModel(AuthType.USE_OPENAI, special.id),
    ).rejects.toThrow(message);
    expect(() =>
      models.syncAfterAuthRefresh(AuthType.USE_OPENAI, special.id),
    ).toThrow(message);
    expect(models.getModel()).toBe('chat');
  };

  it('rejects voice-only primary models and skips them during fallback', () =>
    expectRefusedAsPrimary(
      { id: 'asr', voiceOnly: true },
      "Voice-only model 'asr' cannot be used as the primary model",
    ));

  it('rejects realtime-only primary models and skips them during fallback', () =>
    expectRefusedAsPrimary(
      { id: 'omni-realtime', realtimeOnly: true },
      "Realtime-only model 'omni-realtime' cannot be used as the primary model",
    ));

  it('rejects image-only models as the primary model', async () => {
    const modelsConfig = openaiConfig([
      { id: 'chat-model' },
      { id: 'image-model', imageOnly: true },
    ]);
    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'chat-model');

    await expect(
      modelsConfig.switchModel(AuthType.USE_OPENAI, 'image-model'),
    ).rejects.toThrow(
      "Image-only model 'image-model' cannot be used as the primary model",
    );
    expect(modelsConfig.getModel()).toBe('chat-model');
  });

  it('allows an image-generation-capable model as the primary model', async () => {
    const modelsConfig = openaiConfig([
      { id: 'dual-role-model', supportsImageGeneration: true },
    ]);

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'dual-role-model');

    expect(modelsConfig.getModel()).toBe('dual-role-model');
  });

  it('rejects an image-only model during auth refresh without changing state', () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_ANTHROPIC,
      modelProvidersConfig: {
        openai: [{ id: 'image-model', imageOnly: true }],
      },
      generationConfig: { model: 'previous-model' },
    });

    expect(() =>
      modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'image-model'),
    ).toThrow(
      "Image-only model 'image-model' cannot be used as the primary model",
    );
    expect(modelsConfig.getCurrentAuthType()).toBe(AuthType.USE_ANTHROPIC);
    expect(modelsConfig.getModel()).toBe('previous-model');
  });

  it('allows a dual-role model during auth refresh', () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_ANTHROPIC,
      modelProvidersConfig: {
        openai: [{ id: 'dual-role-model', supportsImageGeneration: true }],
      },
      generationConfig: { model: 'previous-model' },
    });

    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'dual-role-model');

    expect(modelsConfig.getCurrentAuthType()).toBe(AuthType.USE_OPENAI);
    expect(modelsConfig.getModel()).toBe('dual-role-model');
  });

  it('does not choose an image-only model as the auth default', () => {
    const modelsConfig = new ModelsConfig({
      modelProvidersConfig: {
        openai: [{ id: 'image-model', imageOnly: true }, { id: 'chat-model' }],
      },
    });

    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'missing-model');

    expect(modelsConfig.getModel()).toBe('chat-model');
  });

  it('should fully rollback state when switchModel fails after applying defaults (authType change)', async () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      modelProvidersConfig: {
        openai: [
          entry(
            'openai-a',
            'OpenAI A',
            'https://api.openai.example.com/v1',
            'OPENAI_API_KEY',
            {
              samplingParams: { temperature: 0.2, max_tokens: 123 },
              timeout: 111,
              maxRetries: 1,
            },
          ),
        ],
        anthropic: [
          entry(
            'anthropic-b',
            'Anthropic B',
            'https://api.anthropic.example.com/v1',
            'ANTHROPIC_API_KEY',
            {
              samplingParams: { temperature: 0.7, max_tokens: 456 },
              timeout: 222,
              maxRetries: 2,
            },
          ),
        ],
      },
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

    failModelChange(modelsConfig, 'refresh failed');

    await expect(
      modelsConfig.switchModel(AuthType.USE_ANTHROPIC, 'anthropic-b'),
    ).rejects.toThrow('refresh failed');

    // Ensure state is fully rolled back (selection + generation config + flags).
    expect(modelsConfig.getCurrentAuthType()).toBe(baselineAuthType);
    expect(modelsConfig.getModel()).toBe(baselineModel);
    expect(modelsConfig.isStrictModelProviderSelection()).toBe(baselineStrict);
    expect(currentGenerationConfig(modelsConfig)).toMatchObject({
      model: baselineGc.model,
      baseUrl: baselineGc.baseUrl,
      apiKeyEnvKey: baselineGc.apiKeyEnvKey,
      samplingParams: baselineGc.samplingParams,
      timeout: baselineGc.timeout,
      maxRetries: baselineGc.maxRetries,
    });
    expect(modelsConfig.getGenerationConfigSources()).toEqual(baselineSources);
  });

  it('should fully rollback state when switchModel fails after applying defaults', async () => {
    const modelsConfig = openaiConfig([
      entry('model-a', 'Model A', API_URL, 'API_KEY_A'),
      entry('model-b', 'Model B', API_URL, 'API_KEY_B'),
    ]);

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'model-a');
    const baselineModel = modelsConfig.getModel();
    const baselineGc = snapshotGenerationConfig(modelsConfig);
    const baselineSources = deepClone(
      modelsConfig.getGenerationConfigSources(),
    );

    failModelChange(modelsConfig, 'hot-update failed');

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

  it('should preserve an existing apiKey when switching between models with the same provider credentials', async () => {
    const modelsConfig = openaiConfig(
      [
        entry('model-a', 'Model A', API_URL, 'API_KEY_SHARED'),
        entry('model-b', 'Model B', API_URL, 'API_KEY_SHARED'),
      ],
      { model: 'model-a' },
    );

    // Simulate key prompt flow / explicit key provided via CLI/settings.
    modelsConfig.updateCredentials({ apiKey: 'manual-key', model: 'model-a' });

    const gc = await switchOpenAI(modelsConfig, 'model-b');
    expect(gc.model).toBe('model-b');
    expect(gc.apiKey).toBe('manual-key');
    expect(gc.apiKeyEnvKey).toBe('API_KEY_SHARED');
    expect(modelsConfig.getGenerationConfigSources()['apiKey']?.kind).toBe(
      'programmatic',
    );
  });

  it('should not reuse an apiKey when switching to a model with different provider credentials', async () => {
    const modelsConfig = openaiConfig(
      [
        entry(
          'model-a',
          'Model A',
          'https://api-a.example.com/v1',
          'API_KEY_A',
        ),
        entry(
          'model-b',
          'Model B',
          'https://api-b.example.com/v1',
          'API_KEY_B',
        ),
      ],
      { model: 'model-a' },
    );

    modelsConfig.updateCredentials({ apiKey: 'manual-key', model: 'model-a' });

    const gc = await switchOpenAI(modelsConfig, 'model-b');
    expect(gc.model).toBe('model-b');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.apiKeyEnvKey).toBe('API_KEY_B');
  });

  // Provider defaults, and settings.model.generationConfig resolved onto a
  // custom model id, for the two registry-vs-settings cases below.
  const providerGenerationConfig = () => ({
    samplingParams: { temperature: 0.1, max_tokens: 123 },
    timeout: 111,
    maxRetries: 1,
  });
  const customModelGeneration = () => ({
    model: 'custom-model',
    samplingParams: { temperature: 0.9, max_tokens: 999 },
    timeout: 9999,
    maxRetries: 9,
  });
  const customModelSources = (): ConfigSources => ({
    model: settingsSrc('settings.model.name'),
    samplingParams: settingsSrc(
      'settings.model.generationConfig.samplingParams',
    ),
    timeout: settingsSrc('settings.model.generationConfig.timeout'),
    maxRetries: settingsSrc('settings.model.generationConfig.maxRetries'),
  });

  it('should use provider config when modelId exists in registry even after updateCredentials', () => {
    const modelsConfig = openaiConfig(
      [
        entry(
          'model-a',
          'Model A',
          API_URL,
          'API_KEY_A',
          providerGenerationConfig(),
        ),
      ],
      customModelGeneration(),
      customModelSources(),
    );

    // The /auth provider-setup flow prevents a manual modelId that matches a
    // provider model, but if syncAfterAuthRefresh gets a modelId that exists
    // in the registry, the provider config must win.
    modelsConfig.updateCredentials({ apiKey: 'manual-key' });

    const gc = refreshOpenAI(modelsConfig, 'model-a');
    expect(gc.model).toBe('model-a');
    expect(gc.samplingParams?.temperature).toBe(0.1);
    expect(gc.samplingParams?.max_tokens).toBe(123);
    expect(gc.timeout).toBe(111);
    expect(gc.maxRetries).toBe(1);
  });

  it.each([
    { kind: 'cli' as const, detail: '--base-url' },
    { kind: 'env' as const, envKey: 'OPENAI_BASE_URL' },
    { kind: 'settings' as const, settingsPath: 'model.baseUrl' },
  ])(
    'should preserve $kind baseUrl during same-model auth refresh',
    (baseUrlSource) => {
      const modelsConfig = openaiConfig(
        [
          entry(
            'shared-base-model',
            'Shared Base Model',
            'https://provider-default.example.com/v1',
            'SHARED_BASE_URL_KEY',
            { timeout: 111 },
          ),
        ],
        {
          model: 'shared-base-model',
          baseUrl: 'https://shared-proxy.example.com/v1',
          apiKey: 'resolved-key',
        },
        {
          model: { kind: 'settings', settingsPath: 'model.name' },
          baseUrl: baseUrlSource,
          apiKey: { kind: 'settings', settingsPath: 'model.apiKey' },
        },
      );

      const gc = refreshOpenAI(modelsConfig, 'shared-base-model');
      expect(gc.model).toBe('shared-base-model');
      expect(gc.baseUrl).toBe('https://shared-proxy.example.com/v1');
      expect(gc.apiKey).toBe('resolved-key');
      expect(gc.timeout).toBe(111);

      const sources = modelsConfig.getGenerationConfigSources();
      expect(sources['baseUrl']).toEqual(baseUrlSource);
      expect(sources['timeout']?.kind).toBe('modelProviders');
    },
  );

  it('should preserve settings generationConfig when modelId does not exist in registry', () => {
    const modelsConfig = openaiConfig(
      [
        entry(
          'provider-model',
          'Provider Model',
          API_URL,
          'API_KEY_A',
          providerGenerationConfig(),
        ),
      ],
      customModelGeneration(),
      customModelSources(),
    );

    // User manually sets credentials for a custom model (not in registry).
    modelsConfig.updateCredentials({
      apiKey: 'manual-key',
      baseUrl: 'https://manual.example.com/v1',
      model: 'custom-model',
    });

    // The modelId is not in the registry, so both refreshes keep the
    // settings-sourced generation config.
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'custom-model');
    const gc = refreshOpenAI(modelsConfig, 'custom-model');
    expect(gc.model).toBe('custom-model');
    expect(gc.samplingParams?.temperature).toBe(0.9);
    expect(gc.samplingParams?.max_tokens).toBe(999);
    expect(gc.timeout).toBe(9999);
    expect(gc.maxRetries).toBe(9);
  });

  const providerModel = () =>
    entry(
      'provider-model',
      'Provider Model',
      'https://provider.example.com/v1',
      'PROVIDER_API_KEY',
      {
        samplingParams: { temperature: 0.1, max_tokens: 100 },
        timeout: 1000,
        maxRetries: 2,
      },
    );

  it('should clear provider-sourced config when updateCredentials is called after switchModel', async () => {
    const modelsConfig = openaiConfig([providerModel()]);

    // Switching to a provider model applies its config, sourced from it.
    let gc = await switchOpenAI(modelsConfig, 'provider-model');
    expect(gc.model).toBe('provider-model');
    expect(gc.baseUrl).toBe('https://provider.example.com/v1');
    expect(gc.samplingParams?.temperature).toBe(0.1);
    expect(gc.samplingParams?.max_tokens).toBe(100);
    expect(gc.timeout).toBe(1000);
    expect(gc.maxRetries).toBe(2);
    let sources = modelsConfig.getGenerationConfigSources();
    for (const key of [
      'model',
      'baseUrl',
      'samplingParams',
      'timeout',
      'maxRetries',
    ]) {
      expect(sources[key]?.kind).toBe('modelProviders');
    }

    // Manual credentials clear every provider-sourced field and its source.
    modelsConfig.updateCredentials({
      apiKey: 'manual-api-key',
      model: 'custom-model',
    });

    gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('custom-model');
    expect(gc.apiKey).toBe('manual-api-key');
    expect(gc.baseUrl).toBeUndefined();
    expect(gc.samplingParams).toBeUndefined();
    expect(gc.timeout).toBeUndefined();
    expect(gc.maxRetries).toBeUndefined();
    sources = modelsConfig.getGenerationConfigSources();
    expect(sources['model']?.kind).toBe('programmatic');
    expect(sources['apiKey']?.kind).toBe('programmatic');
    for (const key of ['baseUrl', 'samplingParams', 'timeout', 'maxRetries']) {
      expect(sources[key]).toBeUndefined();
    }
  });

  it('should preserve non-provider config when updateCredentials clears provider config', async () => {
    const modelsConfig = openaiConfig(
      [providerModel()],
      {
        samplingParams: { temperature: 0.8, max_tokens: 500 },
        timeout: 5000,
      },
      {
        samplingParams: settingsSrc(
          'settings.model.generationConfig.samplingParams',
        ),
        timeout: settingsSrc('settings.model.generationConfig.timeout'),
      },
    );

    // The provider model's config overwrites the settings-sourced one...
    let gc = await switchOpenAI(modelsConfig, 'provider-model');
    expect(gc.samplingParams?.temperature).toBe(0.1);
    expect(gc.timeout).toBe(1000);

    // ...and manual credentials clear it.
    modelsConfig.updateCredentials({ apiKey: 'manual-key' });

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
      generationConfig: { apiKey: 'manual-key-should-not-leak' },
    });

    // Switching within qwen-oauth triggers applyResolvedModelDefaults().
    await modelsConfig.switchModel(AuthType.QWEN_OAUTH, 'coder-model');

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
    expect(gc.apiKeyEnvKey).toBeUndefined();
  });

  it('should apply extra_body and customHeaders from model provider config', async () => {
    const modelsConfig = openaiConfig([
      entry('model-with-extras', 'Model With Extras', API_URL, 'API_KEY', {
        extra_body: { custom_param: 'value', enable_thinking: true },
        customHeaders: { 'X-Custom-Header': 'header-value' },
      }),
    ]);

    const gc = await switchOpenAI(modelsConfig, 'model-with-extras');
    expect(gc.extra_body).toEqual({
      custom_param: 'value',
      enable_thinking: true,
    });
    expect(gc.customHeaders).toEqual({ 'X-Custom-Header': 'header-value' });

    const sources = modelsConfig.getGenerationConfigSources();
    expect(sources['extra_body']?.kind).toBe('modelProviders');
    expect(sources['customHeaders']?.kind).toBe('modelProviders');
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
    // Cold start with OPENAI_MODEL / OPENAI_API_KEY: the model is set but no
    // authType is selected yet.
    const modelsConfig = new ModelsConfig({
      generationConfig: { model: 'gpt-4o', apiKey: 'openai-key-from-env' },
    });

    // Switching to qwen-oauth via AuthDialog refreshes with gpt-4o, which is
    // not in the qwen-oauth registry, so the qwen-oauth default must win.
    modelsConfig.syncAfterAuthRefresh(AuthType.QWEN_OAUTH, 'gpt-4o');

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('coder-model');
    expect(gc.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
    expect(gc.apiKeyEnvKey).toBeUndefined();
  });

  const manualOpenAIConfig = (
    extra: ModelsConfigOptions['generationConfig'] = {},
  ) => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'gpt-4o',
        apiKey: 'manual-openai-key',
        baseUrl: 'https://manual.example.com/v1',
        ...extra,
      },
    });
    modelsConfig.updateCredentials({
      apiKey: 'manual-openai-key',
      baseUrl: 'https://manual.example.com/v1',
      model: 'gpt-4o',
    });
    return modelsConfig;
  };

  it('should clear manual credentials when switching from USE_OPENAI to QWEN_OAUTH', () => {
    const modelsConfig = manualOpenAIConfig();

    // Leaving USE_OPENAI clears the manual credentials (baseUrl included)
    // and applies the qwen-oauth default model.
    modelsConfig.syncAfterAuthRefresh(AuthType.QWEN_OAUTH, 'gpt-4o');

    const gc = currentGenerationConfig(modelsConfig);
    expect(gc.model).toBe('coder-model');
    expect(gc.apiKey).toBe('QWEN_OAUTH_DYNAMIC_TOKEN');
    expect(gc.baseUrl).toBe('DYNAMIC_QWEN_OAUTH_BASE_URL');
    expect(gc.apiKeyEnvKey).toBeUndefined();
  });

  it('should preserve manual credentials when switching to USE_OPENAI', () => {
    const modelsConfig = manualOpenAIConfig({
      samplingParams: { temperature: 0.9 },
    });

    // Staying on USE_OPENAI keeps the manual credentials.
    const gc = refreshOpenAI(modelsConfig, 'gpt-4o');
    expect(gc.model).toBe('gpt-4o');
    expect(gc.apiKey).toBe('manual-openai-key');
    expect(gc.baseUrl).toBe('https://manual.example.com/v1');
    expect(gc.samplingParams?.temperature).toBe(0.9); // Preserved from initial config
  });

  it('should fall back to settings-sourced apiKey when registry model envKey is not in process.env (restart scenario)', () => {
    // Restart scenario from issue #3417: settings.security.auth.apiKey is
    // 'settings-api-key', the openai provider model's envKey is unset in
    // process.env, and resolveCliGenerationConfig resolved the key from
    // settings (layer 4). syncAfterAuthRefresh must NOT discard that key.
    const envKey = unsetEnv('CODING_PLAN_KEY_TEST_3417');

    // Initialized with the settings-sourced apiKey, as at startup.
    const modelsConfig = openaiConfig(
      [
        entry('qwen3.5-plus', 'Test Model', API_URL, envKey, {
          samplingParams: { temperature: 0.3 },
        }),
      ],
      {
        model: 'qwen3.5-plus',
        apiKey: 'settings-api-key',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      settingsAuthSources(true),
    );
    expect(currentGenerationConfig(modelsConfig).apiKey).toBe(
      'settings-api-key',
    );

    // What refreshAuth does on startup: the settings key stays as fallback,
    // envKey metadata stays for diagnostics, provider config still applies.
    const gc = refreshOpenAI(modelsConfig, 'qwen3.5-plus');
    expect(gc.apiKey).toBe('settings-api-key');
    expect(gc.apiKeyEnvKey).toBe(envKey);
    expect(gc.model).toBe('qwen3.5-plus');
    expect(gc.samplingParams?.temperature).toBe(0.3);
    expect(modelsConfig.getGenerationConfigSources()['apiKey']?.kind).toBe(
      'settings',
    );
  });

  it('should prefer env var over settings apiKey when both exist (restart scenario)', () => {
    const envKey = 'CODING_PLAN_KEY_TEST_3417_PREFER';
    process.env[envKey] = 'env-api-key';

    try {
      const modelsConfig = openaiConfig(
        [entry('test-model', 'Test Model', API_URL, envKey)],
        { model: 'test-model', apiKey: 'settings-api-key' },
        settingsAuthSources(),
      );

      const gc = refreshOpenAI(modelsConfig, 'test-model');
      expect(gc.apiKey).toBe('env-api-key');
      expect(gc.apiKeyEnvKey).toBe(envKey);
      expect(modelsConfig.getGenerationConfigSources()['apiKey']?.kind).toBe(
        'env',
      );
    } finally {
      delete process.env[envKey];
    }
  });

  it('should preserve programmatic apiKey when authType and modelId unchanged (restart scenario)', () => {
    // An apiKey set via updateCredentials (programmatic source) survives a
    // refresh with the same authType+modelId: the short-circuit saves and
    // restores it around applyResolvedModelDefaults.
    const envKey = unsetEnv('CODING_PLAN_KEY_TEST_3417_PROG');
    const modelsConfig = openaiConfig(
      [entry('provider-model', 'Provider Model', API_URL, envKey)],
      {
        model: 'provider-model',
        apiKey: 'programmatic-key',
      },
      {
        model: { kind: 'programmatic', detail: 'updateCredentials' },
        apiKey: { kind: 'programmatic', detail: 'updateCredentials' },
      },
    );

    expect(refreshOpenAI(modelsConfig, 'provider-model').apiKey).toBe(
      'programmatic-key',
    );
  });

  it('should NOT preserve env apiKey with via.modelProviders during model switch', () => {
    // model-a's provider-specific envKey value must NOT be reused for
    // model-b: they may target different services with different credentials.
    const envKeyA = unsetEnv('PROVIDER_KEY_A_TEST_3417');
    const envKeyB = unsetEnv('PROVIDER_KEY_B_TEST_3417');
    const modelsConfig = openaiConfig(
      [
        entry('model-a', 'Model A', 'https://api-a.example.com/v1', envKeyA),
        entry('model-b', 'Model B', 'https://api-b.example.com/v1', envKeyB),
      ],
      { model: 'model-a', apiKey: 'key-for-model-a' },
      {
        model: providerSrc('model-a', 'model.id'),
        apiKey: {
          kind: 'env',
          envKey: envKeyA,
          via: providerSrc('model-a', 'envKey'),
        },
      },
    );

    // model-b's envKey is not set either.
    const gc = refreshOpenAI(modelsConfig, 'model-b');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.model).toBe('model-b');
  });

  it('should NOT preserve settings-sourced apiKey when switching to a different provider within same authType', () => {
    // Cross-provider switch within one authType: provider-a's settings key
    // must NOT leak to provider-b, which may have a different baseUrl.
    const envKeyA = unsetEnv('PROVIDER_KEY_A_SETTINGS_TEST');
    const envKeyB = unsetEnv('PROVIDER_KEY_B_SETTINGS_TEST');
    const modelsConfig = openaiConfig(
      [
        entry(
          'provider-a',
          'Provider A',
          'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKeyA,
        ),
        entry('provider-b', 'Provider B', OPENAI_URL, envKeyB),
      ],
      {
        model: 'provider-a',
        apiKey: 'settings-api-key',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
      settingsAuthSources(true),
    );

    const gc = refreshOpenAI(modelsConfig, 'provider-b');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.model).toBe('provider-b');
    expect(gc.baseUrl).toBe(OPENAI_URL);
  });

  it('should NOT preserve CLI-sourced apiKey when switching to a different provider within same authType', () => {
    // Cross-provider switch: provider-a's CLI key must NOT reach provider-b.
    const envKeyA = unsetEnv('PROVIDER_KEY_A_CLI_TEST');
    const envKeyB = unsetEnv('PROVIDER_KEY_B_CLI_TEST');
    const modelsConfig = openaiConfig(
      [
        entry(
          'cli-provider-a',
          'CLI Provider A',
          'https://api-a.example.com/v1',
          envKeyA,
        ),
        entry(
          'cli-provider-b',
          'CLI Provider B',
          'https://api-b.example.com/v1',
          envKeyB,
        ),
      ],
      {
        model: 'cli-provider-a',
        apiKey: 'cli-provided-key',
      },
      cliSources(),
    );

    const gc = refreshOpenAI(modelsConfig, 'cli-provider-b');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.model).toBe('cli-provider-b');
    expect(gc.baseUrl).toBe('https://api-b.example.com/v1');
  });

  it('should NOT preserve apiKey on first syncAfterAuthRefresh when previousAuthType is undefined (cold start)', () => {
    // Cold start: no initialAuthType, so on the first refresh
    // previousAuthType (undefined) !== USE_OPENAI, isUnchanged is false and
    // nothing is preserved.
    const envKey = unsetEnv('COLD_START_KEY_TEST_3417');
    const modelsConfig = new ModelsConfig({
      modelProvidersConfig: {
        openai: [
          entry('cold-start-model', 'Cold Start Model', API_URL, envKey),
        ],
      },
      generationConfig: {
        model: 'cold-start-model',
        apiKey: 'stale-key-from-previous-session',
      },
      generationConfigSources: settingsAuthSources(),
    });

    const gc = refreshOpenAI(modelsConfig, 'cold-start-model');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.model).toBe('cold-start-model');
  });

  // A registry-applied model whose settings apiKey predates a hot-reload.
  const hotReloadConfig = (
    id: string,
    name: string,
    baseUrl: string,
    envKey: string,
  ) =>
    openaiConfig(
      [entry(id, name, baseUrl, envKey)],
      {
        model: id,
        apiKey: 'old-api-key',
        baseUrl,
        apiKeyEnvKey: envKey,
      },
      {
        ...settingsAuthSources(),
        baseUrl: providerSrc(id, 'baseUrl'),
        apiKeyEnvKey: providerSrc(id, 'envKey'),
      },
    );

  it('should NOT preserve apiKey when same modelId but envKey changed (hot-reload)', () => {
    // Reloading the provider config changes the envKey of the same model id
    // (isUnchanged turns false), so the old apiKey must NOT be restored.
    const oldEnvKey = unsetEnv('OLD_ENV_KEY_HOT_RELOAD_TEST');
    const newEnvKey = unsetEnv('NEW_ENV_KEY_HOT_RELOAD_TEST');
    const modelsConfig = hotReloadConfig(
      'hot-reload-model',
      'Hot Reload Model',
      API_URL,
      oldEnvKey,
    );

    modelsConfig.reloadModelProvidersConfig({
      openai: [
        entry('hot-reload-model', 'Hot Reload Model', API_URL, newEnvKey),
      ],
    });

    const gc = refreshOpenAI(modelsConfig, 'hot-reload-model');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.apiKeyEnvKey).toBe(newEnvKey);
    expect(gc.model).toBe('hot-reload-model');
  });

  it('should NOT preserve apiKey when same modelId but baseUrl changed (hot-reload)', () => {
    // Reloading the provider config changes the baseUrl of the same model id
    // (isUnchanged turns false), so the old apiKey must NOT be restored.
    const envKey = unsetEnv('BASE_URL_HOT_RELOAD_TEST');
    const modelsConfig = hotReloadConfig(
      'url-reload-model',
      'URL Reload Model',
      'https://old-api.example.com/v1',
      envKey,
    );

    modelsConfig.reloadModelProvidersConfig({
      openai: [
        entry(
          'url-reload-model',
          'URL Reload Model',
          'https://new-api.example.com/v1',
          envKey,
        ),
      ],
    });

    const gc = refreshOpenAI(modelsConfig, 'url-reload-model');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.baseUrl).toBe('https://new-api.example.com/v1');
    expect(gc.model).toBe('url-reload-model');
  });

  it('should NOT preserve apiKey when no-envKey model has baseUrl changed (hot-reload)', () => {
    // A model without envKey: the baseUrl alone changing on hot-reload makes
    // isProviderChanged true, so the old apiKey must NOT be restored.
    const modelsConfig = openaiConfig(
      [
        entry(
          'no-envkey-model',
          'No EnvKey Model',
          'https://old-api.example.com/v1',
        ),
      ],
      {
        model: 'no-envkey-model',
        apiKey: 'old-settings-key',
        baseUrl: 'https://old-api.example.com/v1',
      },
      // Post-apply state: baseUrl source is modelProviders.
      {
        model: providerSrc('no-envkey-model', 'model.id'),
        apiKey: settingsSrc('security.auth.apiKey'),
        baseUrl: providerSrc('no-envkey-model', 'baseUrl'),
      },
    );

    modelsConfig.reloadModelProvidersConfig({
      openai: [
        entry(
          'no-envkey-model',
          'No EnvKey Model',
          'https://new-api.example.com/v1',
        ),
      ],
    });

    const gc = refreshOpenAI(modelsConfig, 'no-envkey-model');
    expect(gc.apiKey).toBeUndefined();
    expect(gc.baseUrl).toBe('https://new-api.example.com/v1');
    expect(gc.model).toBe('no-envkey-model');
  });

  it('should preserve general env var apiKey (e.g. OPENAI_API_KEY) when provider envKey is absent', () => {
    // With OPENAI_API_KEY set but not the provider-specific envKey, the
    // general env var key is kept as a fallback. resolveCliGenerationConfig
    // resolved it at layer 3: kind 'env' without 'via'.
    const providerEnvKey = unsetEnv('SPECIFIC_PROVIDER_KEY_TEST_3417');
    const modelsConfig = openaiConfig(
      [entry('test-model', 'Test Model', API_URL, providerEnvKey)],
      {
        model: 'test-model',
        apiKey: 'openai-api-key-value',
      },
      {
        model: settingsSrc('settings.model.name'),
        apiKey: { kind: 'env', envKey: 'OPENAI_API_KEY' },
      },
    );

    expect(refreshOpenAI(modelsConfig, 'test-model').apiKey).toBe(
      'openai-api-key-value',
    );
    const sources = modelsConfig.getGenerationConfigSources();
    expect(sources['apiKey']?.kind).toBe('env');
    expect(sources['apiKey']?.envKey).toBe('OPENAI_API_KEY');
  });

  it('should preserve CLI-sourced apiKey (--openaiApiKey) when registry model envKey is absent', () => {
    // Regression: CLI-passed keys (source kind 'cli') must not be discarded
    // during syncAfterAuthRefresh when the provider's envKey is unset.
    const envKey = unsetEnv('CODING_PLAN_KEY_TEST_3417_CLI');
    const modelsConfig = openaiConfig(
      [
        entry('cli-test-model', 'CLI Test Model', API_URL, envKey, {
          samplingParams: { temperature: 0.5 },
        }),
      ],
      {
        model: 'cli-test-model',
        apiKey: 'cli-provided-key',
      },
      cliSources(),
    );
    expect(currentGenerationConfig(modelsConfig).apiKey).toBe(
      'cli-provided-key',
    );

    const gc = refreshOpenAI(modelsConfig, 'cli-test-model');
    expect(gc.apiKey).toBe('cli-provided-key');
    expect(gc.apiKeyEnvKey).toBe(envKey);
    expect(gc.model).toBe('cli-test-model');
    expect(gc.samplingParams?.temperature).toBe(0.5);

    const sources = modelsConfig.getGenerationConfigSources();
    expect(sources['apiKey']?.kind).toBe('cli');
    expect(sources['apiKey']?.detail).toBe('--openaiApiKey');
  });

  it('should maintain consistency between currentModelId and _generationConfig.model after initialization', () => {
    const withGeneration = (
      generationConfig: ModelsConfigOptions['generationConfig'],
    ) =>
      openaiConfig(
        [entry('test-model', 'Test Model', API_URL, 'TEST_API_KEY')],
        generationConfig,
      );

    // generationConfig.model provided with other config
    const config1 = withGeneration({
      model: 'test-model',
      samplingParams: { temperature: 0.5 },
    });
    expect(config1.getModel()).toBe('test-model');
    expect(config1.getGenerationConfig().model).toBe('test-model');

    // generationConfig.model provided alone
    const config2 = withGeneration({ model: 'test-model' });
    expect(config2.getModel()).toBe('test-model');
    expect(config2.getGenerationConfig().model).toBe('test-model');

    // no model provided (empty string fallback)
    const config3 = withGeneration({});
    expect(config3.getModel()).toBe('coder-model'); // Falls back to DEFAULT_QWEN_MODEL
    expect(config3.getGenerationConfig().model).toBeUndefined();
  });

  it('should maintain consistency between currentModelId and _generationConfig.model during syncAfterAuthRefresh', () => {
    const modelsConfig = openaiConfig(
      [entry('model-a', 'Model A', API_URL, 'API_KEY_A')],
      { model: 'model-a' },
    );

    // Manual credentials take the preserveManualCredentials path.
    modelsConfig.updateCredentials({ apiKey: 'manual-key' });
    modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'model-a');

    expect(modelsConfig.getModel()).toBe('model-a');
    expect(modelsConfig.getGenerationConfig().model).toBe('model-a');
  });

  it('should use explicit provider baseUrl when syncing after provider install', () => {
    const modelsConfig = openaiConfig(
      [
        entry(
          'shared-model',
          'Shared Model (old)',
          'https://old.example.com/v1',
          'OLD_API_KEY',
        ),
        entry(
          'shared-model',
          'Shared Model (new)',
          'https://new.example.com/v1',
          'NEW_API_KEY',
        ),
      ],
      {
        model: 'shared-model',
        baseUrl: 'https://old.example.com/v1',
      },
    );

    modelsConfig.syncAfterAuthRefresh(
      AuthType.USE_OPENAI,
      'shared-model',
      'https://new.example.com/v1',
    );

    expect(modelsConfig.getModel()).toBe('shared-model');
    expect(modelsConfig.getGenerationConfig()).toMatchObject({
      model: 'shared-model',
      baseUrl: 'https://new.example.com/v1',
      apiKeyEnvKey: 'NEW_API_KEY',
    });
  });

  it('should maintain consistency between currentModelId and _generationConfig.model during setModel', async () => {
    const modelsConfig = openaiConfig([
      entry('model-a', 'Model A', API_URL, 'API_KEY_A'),
    ]);

    await modelsConfig.setModel('custom-model');

    expect(modelsConfig.getModel()).toBe('custom-model');
    expect(modelsConfig.getGenerationConfig().model).toBe('custom-model');
  });

  it('recomputes raw model modalities instead of carrying provider multimodal defaults', async () => {
    const modelsConfig = openaiConfig([
      entry(
        'qwen3.6-plus',
        'Qwen 3.6 Plus',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'DASHSCOPE_API_KEY',
        { contextWindowSize: 12345, modalities: { image: true, video: true } },
      ),
    ]);

    await modelsConfig.switchModel(AuthType.USE_OPENAI, 'qwen3.6-plus');
    expect(modelsConfig.getGenerationConfig().modalities).toEqual({
      image: true,
      video: true,
    });

    await modelsConfig.setModel('qwen3.7-max');

    const autoDetected = {
      kind: 'computed',
      detail: 'auto-detected from model',
    };
    expect(modelsConfig.getModel()).toBe('qwen3.7-max');
    expect(modelsConfig.getGenerationConfig().modalities).toEqual({});
    expect(modelsConfig.getGenerationConfigSources()['modalities']).toEqual(
      autoDetected,
    );
    expect(modelsConfig.getGenerationConfig().contextWindowSize).not.toBe(
      12345,
    );
    expect(
      modelsConfig.getGenerationConfigSources()['contextWindowSize'],
    ).toEqual(autoDetected);
  });

  it('notifies the owner to refresh after a raw model switch', async () => {
    const onModelChange = vi.fn();
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'qwen3.6-plus',
        modalities: { image: true, video: true },
      },
      onModelChange,
    });

    await modelsConfig.setModel('qwen3.7-max');

    expect(onModelChange).toHaveBeenCalledWith(AuthType.USE_OPENAI, true);
  });

  it('preserves explicitly configured modalities during raw model switches', async () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'custom-vision-model',
        modalities: { image: true },
      },
      generationConfigSources: {
        modalities: {
          kind: 'settings',
          settingsPath: 'model.generationConfig.modalities',
        },
      },
    });

    await modelsConfig.setModel('custom-vision-model-v2');

    expect(modelsConfig.getGenerationConfig().modalities).toEqual({
      image: true,
    });
    expect(modelsConfig.getGenerationConfigSources()['modalities']).toEqual({
      kind: 'settings',
      settingsPath: 'model.generationConfig.modalities',
    });
  });

  it('refreshes model-derived modalities when hot-switching to the default qwen-oauth model', async () => {
    // Start on qwen-oauth with a text-only model so modalities are empty.
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.QWEN_OAUTH,
      generationConfig: { model: 'qwen3-coder-flash', modalities: {} },
      generationConfigSources: {
        modalities: { kind: 'computed', detail: 'auto-detected from model' },
      },
    });

    // Hot-update to coder-model (DEFAULT_QWEN_MODEL), which accepts images.
    // Without refreshing model-derived defaults the previous model's empty
    // modalities would linger and the vision-bridge gate would misfire.
    await modelsConfig.setModel('coder-model');

    expect(modelsConfig.getModel()).toBe('coder-model');
    expect(modelsConfig.getGenerationConfig().modalities).toEqual({
      image: true,
      video: true,
    });
  });

  it('rolls back raw model state when owner refresh fails', async () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: {
        model: 'qwen3.6-plus',
        modalities: { image: true, video: true },
      },
      generationConfigSources: {
        modalities: { kind: 'computed', detail: 'auto-detected from model' },
      },
      onModelChange: async () => {
        throw new Error('refresh failed');
      },
    });

    await expect(modelsConfig.setModel('qwen3.7-max')).rejects.toThrow(
      'refresh failed',
    );

    expect(modelsConfig.getModel()).toBe('qwen3.6-plus');
    expect(modelsConfig.getGenerationConfig().modalities).toEqual({
      image: true,
      video: true,
    });
  });

  it('should maintain consistency between currentModelId and _generationConfig.model during updateCredentials', () => {
    const modelsConfig = new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
    });

    modelsConfig.updateCredentials({
      apiKey: 'test-key',
      model: 'updated-model',
    });

    expect(modelsConfig.getModel()).toBe('updated-model');
    expect(modelsConfig.getGenerationConfig().model).toBe('updated-model');
  });

  describe('getAllConfiguredModels', () => {
    // True when every model before the first non-qwen-oauth one is qwen-oauth.
    const qwenFirst = (
      models: ReturnType<ModelsConfig['getAllConfiguredModels']>,
      firstNonQwenIndex: number,
    ) =>
      models
        .slice(0, firstNonQwenIndex)
        .every((m) => m.authType === AuthType.QWEN_OAUTH);

    it('should return all models across all authTypes and put qwen-oauth first', () => {
      const modelsConfig = new ModelsConfig({
        modelProvidersConfig: {
          openai: [
            entry(
              'openai-model-1',
              'OpenAI Model 1',
              OPENAI_URL,
              'OPENAI_API_KEY',
            ),
            entry(
              'openai-model-2',
              'OpenAI Model 2',
              OPENAI_URL,
              'OPENAI_API_KEY',
            ),
          ],
          anthropic: [
            entry(
              'anthropic-model-1',
              'Anthropic Model 1',
              'https://api.anthropic.com/v1',
              'ANTHROPIC_API_KEY',
            ),
          ],
          gemini: [
            entry(
              'gemini-model-1',
              'Gemini Model 1',
              'https://generativelanguage.googleapis.com/v1',
              'GEMINI_API_KEY',
            ),
          ],
        },
      });

      const allModels = modelsConfig.getAllConfiguredModels();

      // qwen-oauth models (hard-coded) come first, then the registry ones.
      const firstNonQwenIndex = allModels.findIndex(
        (m) => m.authType !== AuthType.QWEN_OAUTH,
      );
      expect(firstNonQwenIndex).toBeGreaterThan(0);
      expect(qwenFirst(allModels, firstNonQwenIndex)).toBe(true);
      expect(
        allModels
          .slice(firstNonQwenIndex)
          .every((m) => m.authType !== AuthType.QWEN_OAUTH),
      ).toBe(true);
      expect(ofAuthType(allModels, AuthType.QWEN_OAUTH).length).toBeGreaterThan(
        0,
      );

      const openaiModels = ofAuthType(allModels, AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(2);
      expect(openaiModels.map((m) => m.id)).toContain('openai-model-1');
      expect(openaiModels.map((m) => m.id)).toContain('openai-model-2');

      const anthropicModels = ofAuthType(allModels, AuthType.USE_ANTHROPIC);
      expect(anthropicModels.length).toBe(1);
      expect(anthropicModels[0].id).toBe('anthropic-model-1');

      const geminiModels = ofAuthType(allModels, AuthType.USE_GEMINI);
      expect(geminiModels.length).toBe(1);
      expect(geminiModels[0].id).toBe('gemini-model-1');
    });

    it('should return empty array when no models are registered', () => {
      const allModels = new ModelsConfig().getAllConfiguredModels();

      // Should still include qwen-oauth models (hard-coded)
      expect(allModels.length).toBeGreaterThan(0);
      expect(ofAuthType(allModels, AuthType.QWEN_OAUTH).length).toBeGreaterThan(
        0,
      );
    });

    it('should return models with correct structure', () => {
      const modelsConfig = new ModelsConfig({
        modelProvidersConfig: {
          openai: [
            {
              id: 'test-model',
              name: 'Test Model',
              description: 'A test model',
              baseUrl: API_URL,
              envKey: 'TEST_API_KEY',
              capabilities: { vision: true },
            },
          ],
        },
      });

      const testModel = modelsConfig
        .getAllConfiguredModels()
        .find((m) => m.id === 'test-model');

      expect(testModel).toBeDefined();
      expect(testModel?.id).toBe('test-model');
      expect(testModel?.label).toBe('Test Model');
      expect(testModel?.description).toBe('A test model');
      expect(testModel?.authType).toBe(AuthType.USE_OPENAI);
      expect(testModel?.isVision).toBe(true);
      expect(testModel?.capabilities?.vision).toBe(true);
    });

    it('should support filtering by authTypes and still put qwen-oauth first when included', () => {
      const modelsConfig = new ModelsConfig({
        modelProvidersConfig: {
          openai: [
            entry(
              'openai-model-1',
              'OpenAI Model 1',
              OPENAI_URL,
              'OPENAI_API_KEY',
            ),
          ],
          anthropic: [
            entry(
              'anthropic-model-1',
              'Anthropic Model 1',
              'https://api.anthropic.com/v1',
              'ANTHROPIC_API_KEY',
            ),
          ],
        },
      });

      // OpenAI only: no qwen-oauth.
      const openaiOnly = modelsConfig.getAllConfiguredModels([
        AuthType.USE_OPENAI,
      ]);
      expect(openaiOnly.every((m) => m.authType === AuthType.USE_OPENAI)).toBe(
        true,
      );
      expect(openaiOnly.map((m) => m.id)).toContain('openai-model-1');

      // qwen-oauth requested later is still ordered first.
      const withQwen = modelsConfig.getAllConfiguredModels([
        AuthType.USE_OPENAI,
        AuthType.QWEN_OAUTH,
        AuthType.USE_ANTHROPIC,
      ]);
      expect(withQwen.length).toBeGreaterThan(0);
      const firstNonQwenIndex = withQwen.findIndex(
        (m) => m.authType !== AuthType.QWEN_OAUTH,
      );
      expect(firstNonQwenIndex).toBeGreaterThan(0);
      expect(qwenFirst(withQwen, firstNonQwenIndex)).toBe(true);
    });

    // An OPENAI_*-derived runtime model with no registry entry.
    const envRuntimeConfig = () =>
      new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        generationConfig: {
          model: 'my-openai-model',
          apiKey: 'sk-test-key',
          baseUrl: API_URL,
        },
        generationConfigSources: {
          model: { kind: 'env', envKey: 'OPENAI_MODEL' },
          apiKey: { kind: 'env', envKey: 'OPENAI_API_KEY' },
          baseUrl: { kind: 'env', envKey: 'OPENAI_BASE_URL' },
        },
      });

    it('should include an active runtime model whose authType has no registry models', () => {
      // Regression for #5089: such a runtime model dropped out of the default
      // listing because iteration was limited to
      // `modelRegistry.getAuthTypes()`, which only knows authTypes that have
      // registry models. It can be the *current* model, so it must still
      // appear in availableModels.
      const modelsConfig = envRuntimeConfig();

      const snapshotId = modelsConfig.detectAndCaptureRuntimeModel();
      expect(snapshotId).toBe('$runtime|openai|my-openai-model');

      // The default listing (no explicit authTypes) must include it.
      const allModels = modelsConfig.getAllConfiguredModels();
      const openaiModel = allModels.find(
        (m) => m.authType === AuthType.USE_OPENAI,
      );
      expect(openaiModel).toBeDefined();
      expect(openaiModel?.id).toBe('my-openai-model');
      expect(openaiModel?.isRuntimeModel).toBe(true);

      // qwen-oauth registry models still come first and are still listed.
      expect(allModels.some((m) => m.authType === AuthType.QWEN_OAUTH)).toBe(
        true,
      );
    });

    it('should not inject the runtime model when an explicit authType filter excludes it', () => {
      // The runtime-model injection is scoped to the default listing; an
      // explicit filter must return exactly the requested authType set.
      const modelsConfig = envRuntimeConfig();
      modelsConfig.detectAndCaptureRuntimeModel();

      const qwenOnly = modelsConfig.getAllConfiguredModels([
        AuthType.QWEN_OAUTH,
      ]);
      expect(qwenOnly.every((m) => m.authType === AuthType.QWEN_OAUTH)).toBe(
        true,
      );
    });
  });

  describe('Runtime Model Snapshot', () => {
    // USE_OPENAI with model/apiKey/baseUrl from `sources`.
    const runtimeConfig = (
      model: string,
      apiKey: string,
      baseUrl: string,
      generationConfigSources: ConfigSources = testSources(),
    ) =>
      new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        generationConfig: { model, apiKey, baseUrl },
        generationConfigSources,
      });
    const cliSourcesWithBaseUrl = (): ConfigSources => ({
      ...cliSources(),
      baseUrl: { kind: 'cli', detail: '--openaiBaseUrl' },
    });

    it('should detect and capture runtime model from CLI source', () => {
      const modelsConfig = runtimeConfig(
        'gpt-4-turbo',
        'sk-test-key',
        OPENAI_URL,
        cliSourcesWithBaseUrl(),
      );

      expect(modelsConfig.detectAndCaptureRuntimeModel()).toBe(
        '$runtime|openai|gpt-4-turbo',
      );

      const snapshot = modelsConfig.getActiveRuntimeModelSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot?.id).toBe('$runtime|openai|gpt-4-turbo');
      expect(snapshot?.authType).toBe(AuthType.USE_OPENAI);
      expect(snapshot?.modelId).toBe('gpt-4-turbo');
      expect(snapshot?.apiKey).toBe('sk-test-key');
      expect(snapshot?.baseUrl).toBe(OPENAI_URL);
    });

    it('should detect and capture runtime model from ENV source', () => {
      const modelsConfig = runtimeConfig('gpt-4o', 'sk-env-key', OPENAI_URL, {
        model: settingsSrc('settings.model.name'),
        apiKey: { kind: 'env', envKey: 'OPENAI_API_KEY' },
        baseUrl: settingsSrc('settings.openaiBaseUrl'),
      });

      expect(modelsConfig.detectAndCaptureRuntimeModel()).toBe(
        '$runtime|openai|gpt-4o',
      );

      const snapshot = modelsConfig.getActiveRuntimeModelSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot?.modelId).toBe('gpt-4o');
      expect(snapshot?.apiKey).toBe('sk-env-key');
    });

    it('should not capture registry models as runtime', () => {
      const modelsConfig = openaiConfig(
        [entry('gpt-4-turbo', 'GPT-4 Turbo', OPENAI_URL, 'OPENAI_API_KEY')],
        {
          model: 'gpt-4-turbo',
          apiKey: 'sk-test-key',
          baseUrl: OPENAI_URL,
        },
        cliSourcesWithBaseUrl(),
      );

      // The model exists in the registry, so no snapshot is created.
      expect(modelsConfig.detectAndCaptureRuntimeModel()).toBeUndefined();
      expect(modelsConfig.getActiveRuntimeModelSnapshot()).toBeUndefined();
    });

    it('should not capture runtime model without valid credentials', () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        generationConfig: { model: 'custom-model' }, // no apiKey or baseUrl
        generationConfigSources: { model: { kind: 'cli', detail: '--model' } },
      });

      expect(modelsConfig.detectAndCaptureRuntimeModel()).toBeUndefined();
    });

    it('should switch to runtime model and apply snapshot configuration', async () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        generationConfig: {
          model: 'runtime-model',
          apiKey: 'sk-runtime-key',
          baseUrl: 'https://runtime.example.com/v1',
          samplingParams: { temperature: 0.7, max_tokens: 2000 },
        },
        generationConfigSources: testSources(),
      });

      expect(modelsConfig.detectAndCaptureRuntimeModel()).toBeDefined();

      // Updating the model rewrites the existing snapshot, changing its ID.
      modelsConfig.updateCredentials({
        model: 'different-model',
        apiKey: 'different-key',
        baseUrl: 'https://different.example.com/v1',
      });
      expect(modelsConfig.getActiveRuntimeModelSnapshotId()).toBe(
        '$runtime|openai|different-model',
      );

      // A separate snapshot for the original runtime model (as if several
      // runtime models were available).
      modelsConfig['runtimeModelSnapshots'].set(
        '$runtime|openai|runtime-model',
        {
          id: '$runtime|openai|runtime-model',
          authType: AuthType.USE_OPENAI,
          modelId: 'runtime-model',
          apiKey: 'sk-runtime-key',
          baseUrl: 'https://runtime.example.com/v1',
          generationConfig: {
            samplingParams: { temperature: 0.7, max_tokens: 2000 },
          },
          sources: testSources(),
          createdAt: Date.now(),
        },
      );

      await modelsConfig.switchToRuntimeModel('$runtime|openai|runtime-model');

      const gc = currentGenerationConfig(modelsConfig);
      expect(gc.model).toBe('runtime-model');
      expect(gc.apiKey).toBe('sk-runtime-key');
      expect(gc.baseUrl).toBe('https://runtime.example.com/v1');
      expect(gc.samplingParams?.temperature).toBe(0.7);
      expect(gc.samplingParams?.max_tokens).toBe(2000);
    });

    it('should throw error when switching to non-existent runtime snapshot', async () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
      });

      await expect(
        modelsConfig.switchToRuntimeModel('$runtime|openai|nonexistent'),
      ).rejects.toThrow(
        "Runtime model snapshot '$runtime|openai|nonexistent' not found",
      );
    });

    it('should return runtime option first in getAllConfiguredModels', () => {
      const modelsConfig = openaiConfig(
        [
          entry(
            'registry-model',
            'Registry Model',
            OPENAI_URL,
            'OPENAI_API_KEY',
          ),
        ],
        {
          model: 'runtime-model',
          apiKey: 'sk-test-key',
          baseUrl: 'https://runtime.example.com/v1',
        },
        testSources(),
      );

      modelsConfig.detectAndCaptureRuntimeModel();

      const openaiModels = ofAuthType(
        modelsConfig.getAllConfiguredModels(),
        AuthType.USE_OPENAI,
      );
      expect(openaiModels.length).toBe(2);
      expect(openaiModels[0].isRuntimeModel).toBe(true);
      // AvailableModel.id should be modelId, runtimeSnapshotId should be snapshot.id
      expect(openaiModels[0].id).toBe('runtime-model');
      expect(openaiModels[0].runtimeSnapshotId).toBe(
        '$runtime|openai|runtime-model',
      );
      expect(openaiModels[0].label).toBe('runtime-model');
      expect(openaiModels[1].isRuntimeModel).toBeUndefined();
      expect(openaiModels[1].id).toBe('registry-model');
    });

    it('should create/update runtime snapshot via updateCredentials', () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
      });

      modelsConfig.updateCredentials({
        model: 'custom-model',
        apiKey: 'sk-custom-key',
        baseUrl: 'https://custom.example.com/v1',
      });

      const snapshot = modelsConfig.getActiveRuntimeModelSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot?.modelId).toBe('custom-model');
      expect(snapshot?.apiKey).toBe('sk-custom-key');
      expect(snapshot?.baseUrl).toBe('https://custom.example.com/v1');
    });

    it('should update existing runtime snapshot when credentials change', () => {
      const modelsConfig = runtimeConfig(
        'initial-model',
        'sk-initial-key',
        'https://initial.example.com/v1',
      );

      modelsConfig.detectAndCaptureRuntimeModel();
      modelsConfig.updateCredentials({
        model: 'updated-model',
        apiKey: 'sk-updated-key',
      });

      const snapshot = modelsConfig.getActiveRuntimeModelSnapshot();
      expect(snapshot).toBeDefined();
      expect(snapshot?.modelId).toBe('updated-model');
      expect(snapshot?.apiKey).toBe('sk-updated-key');
      // baseUrl should be preserved from initial
      expect(snapshot?.baseUrl).toBe('https://initial.example.com/v1');
    });

    it('should enforce per-authType snapshot limit', () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
      });

      modelsConfig.updateCredentials({
        model: 'model-a',
        apiKey: 'sk-key-a',
        baseUrl: 'https://a.example.com/v1',
      });
      expect(modelsConfig.getActiveRuntimeModelSnapshotId()).toBe(
        '$runtime|openai|model-a',
      );

      // A second USE_OPENAI snapshot (different model) replaces the first.
      modelsConfig.updateCredentials({
        model: 'model-b',
        apiKey: 'sk-key-b',
        baseUrl: 'https://b.example.com/v1',
      });
      const secondSnapshotId = modelsConfig.getActiveRuntimeModelSnapshotId();
      expect(secondSnapshotId).toBe('$runtime|openai|model-b');
      expect(modelsConfig.getActiveRuntimeModelSnapshot()?.id).toBe(
        secondSnapshotId,
      );
    });

    it('should support multiple authTypes with separate snapshots', async () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
      });

      modelsConfig.updateCredentials({
        model: 'openai-model',
        apiKey: 'sk-openai-key',
        baseUrl: 'https://openai.example.com/v1',
      });

      const openaiSnapshot = modelsConfig.getActiveRuntimeModelSnapshot();
      expect(openaiSnapshot?.authType).toBe(AuthType.USE_OPENAI);
      expect(openaiSnapshot?.modelId).toBe('openai-model');

      // Add an Anthropic snapshot manually and switch to it.
      modelsConfig['runtimeModelSnapshots'].set(
        '$runtime|anthropic|anthropic-model',
        {
          id: '$runtime|anthropic|anthropic-model',
          authType: AuthType.USE_ANTHROPIC,
          modelId: 'anthropic-model',
          apiKey: 'sk-anthropic-key',
          baseUrl: 'https://anthropic.example.com/v1',
          sources: testSources(),
          createdAt: Date.now(),
        },
      );
      await modelsConfig.switchToRuntimeModel(
        '$runtime|anthropic|anthropic-model',
      );

      const anthropicSnapshot = modelsConfig.getActiveRuntimeModelSnapshot();
      expect(anthropicSnapshot?.authType).toBe(AuthType.USE_ANTHROPIC);
      expect(anthropicSnapshot?.modelId).toBe('anthropic-model');
    });

    it('should rollback state when switchToRuntimeModel fails', async () => {
      const modelsConfig = runtimeConfig(
        'runtime-model',
        'sk-runtime-key',
        'https://runtime.example.com/v1',
      );

      const snapshotId = modelsConfig.detectAndCaptureRuntimeModel();
      expect(snapshotId).toBeDefined();

      failModelChange(modelsConfig, 'refresh failed');
      const baselineModel = modelsConfig.getModel();
      const baselineGc = snapshotGenerationConfig(modelsConfig);

      await expect(
        modelsConfig.switchToRuntimeModel(snapshotId!),
      ).rejects.toThrow('refresh failed');

      expect(modelsConfig.getModel()).toBe(baselineModel);
      expect(modelsConfig.getGenerationConfig()).toMatchObject({
        model: baselineGc.model,
        apiKey: baselineGc.apiKey,
        baseUrl: baselineGc.baseUrl,
      });
    });
  });

  describe('reloadModelProvidersConfig', () => {
    it('should reload model providers configuration', async () => {
      const modelsConfig = openaiConfig([{ id: 'gpt-4', name: 'GPT-4' }]);

      await modelsConfig.switchModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(modelsConfig.getModel()).toBe('gpt-4');

      modelsConfig.reloadModelProvidersConfig({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
      });

      // After reload, old model should not exist
      const find = (id: string) =>
        modelsConfig.getAllConfiguredModels().find((m) => m.id === id);
      expect(find('gpt-4')).toBeUndefined();
      expect(find('gpt-3.5')).toBeDefined();
    });

    it('should preserve current model selection if still available after reload', async () => {
      const modelsConfig = openaiConfig([
        { id: 'gpt-4', name: 'GPT-4' },
        { id: 'gpt-3.5', name: 'GPT-3.5' },
      ]);

      await modelsConfig.switchModel(AuthType.USE_OPENAI, 'gpt-4');
      expect(modelsConfig.getModel()).toBe('gpt-4');

      // The reloaded config still includes gpt-4.
      modelsConfig.reloadModelProvidersConfig({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Updated' },
          { id: 'new-model', name: 'New Model' },
        ],
      });

      const availableModels = modelsConfig.getAllConfiguredModels();
      expect(availableModels.find((m) => m.id === 'gpt-4')).toBeDefined();
      expect(availableModels.find((m) => m.id === 'new-model')).toBeDefined();
    });

    it('should update available models after reload', async () => {
      const modelsConfig = openaiConfig([{ id: 'gpt-4', name: 'GPT-4' }]);

      expect(hasModel(modelsConfig, 'gpt-4')).toBe(true);
      expect(hasModel(modelsConfig, 'gemini-pro')).toBe(false);

      modelsConfig.reloadModelProvidersConfig({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5' }],
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      expect(hasModel(modelsConfig, 'gpt-4')).toBe(false);
      expect(hasModel(modelsConfig, 'gpt-3.5')).toBe(true);
      expect(hasModel(modelsConfig, 'gemini-pro')).toBe(true);
    });

    it('should handle reload with empty config', async () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        modelProvidersConfig: {
          openai: [{ id: 'gpt-4', name: 'GPT-4' }],
          gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
        },
      });

      expect(
        modelsConfig
          .getAllConfiguredModels()
          .filter((m) => m.authType !== 'qwen-oauth').length,
      ).toBeGreaterThan(0);

      modelsConfig.reloadModelProvidersConfig({});

      // Only qwen-oauth models should remain
      const models = modelsConfig.getAllConfiguredModels();
      expect(models.every((m) => m.authType === 'qwen-oauth')).toBe(true);
    });

    it('should preserve qwen-oauth models after reload', () => {
      const modelsConfig = new ModelsConfig({
        modelProvidersConfig: { openai: [{ id: 'gpt-4', name: 'GPT-4' }] },
      });
      const qwenCount = () =>
        ofAuthType(modelsConfig.getAllConfiguredModels(), 'qwen-oauth').length;
      const initialQwenCount = qwenCount();

      modelsConfig.reloadModelProvidersConfig({
        gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
      });

      expect(qwenCount()).toBe(initialQwenCount);
    });

    it('should handle reload with undefined config', () => {
      const modelsConfig = new ModelsConfig({
        modelProvidersConfig: { openai: [{ id: 'gpt-4', name: 'GPT-4' }] },
      });
      const openaiCount = () =>
        ofAuthType(modelsConfig.getAllConfiguredModels(), 'openai').length;

      expect(openaiCount()).toBeGreaterThan(0);

      modelsConfig.reloadModelProvidersConfig(undefined);

      // User-configured models should be cleared
      expect(openaiCount()).toBe(0);
    });

    it('should support multiple reloads', () => {
      const modelsConfig = new ModelsConfig();

      modelsConfig.reloadModelProvidersConfig({
        openai: [{ id: 'model-v1', name: 'Model V1' }],
      });
      expect(hasModel(modelsConfig, 'model-v1')).toBe(true);

      modelsConfig.reloadModelProvidersConfig({
        openai: [{ id: 'model-v2', name: 'Model V2' }],
      });
      expect(hasModel(modelsConfig, 'model-v1')).toBe(false);
      expect(hasModel(modelsConfig, 'model-v2')).toBe(true);

      modelsConfig.reloadModelProvidersConfig({});
      expect(hasModel(modelsConfig, 'model-v2')).toBe(false);
    });

    it('should handle complex multi-authType reload', async () => {
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        modelProvidersConfig: {
          openai: [
            { id: 'gpt-4', name: 'GPT-4' },
            { id: 'gpt-3.5', name: 'GPT-3.5' },
          ],
          gemini: [{ id: 'gemini-pro', name: 'Gemini Pro' }],
        },
      });

      modelsConfig.reloadModelProvidersConfig({
        openai: [{ id: 'new-openai', name: 'New OpenAI' }],
        anthropic: [{ id: 'claude', name: 'Claude' }],
        gemini: [{ id: 'gemini-ultra', name: 'Gemini Ultra' }],
      });

      const allModels = modelsConfig.getAllConfiguredModels();
      const has = (id: string) => allModels.some((m) => m.id === id);
      for (const gone of ['gpt-4', 'gpt-3.5', 'gemini-pro']) {
        expect(has(gone)).toBe(false);
      }
      for (const added of ['new-openai', 'claude', 'gemini-ultra']) {
        expect(has(added)).toBe(true);
      }
    });
  });

  describe('max_tokens in modelsConfig', () => {
    const gpt4 = (generationConfig?: ModelConfig['generationConfig']) =>
      openaiConfig([
        entry(
          'gpt-4',
          'GPT-4',
          'https://api.openai.example.com/v1',
          undefined,
          generationConfig,
        ),
      ]);

    it('should not auto-fill max_tokens when samplingParams is undefined', async () => {
      // No generationConfig.samplingParams defined
      const gc = await switchOpenAI(gpt4(), 'gpt-4');
      expect(gc.samplingParams).toBeUndefined();
    });

    it('should not auto-fill max_tokens when samplingParams exists but max_tokens is missing', async () => {
      const modelsConfig = gpt4({ samplingParams: { temperature: 0.7 } });

      const gc = await switchOpenAI(modelsConfig, 'gpt-4');
      // Should preserve existing sampling params but not inject max_tokens
      expect(gc.samplingParams?.temperature).toBe(0.7);
      expect(gc.samplingParams?.max_tokens).toBeUndefined();
      expect(
        modelsConfig.getGenerationConfigSources()['samplingParams']?.kind,
      ).toBe('modelProviders');
    });

    it('should not override existing max_tokens from modelProviders', async () => {
      const modelsConfig = gpt4({
        samplingParams: { temperature: 0.7, max_tokens: 4096 },
      });

      const gc = await switchOpenAI(modelsConfig, 'gpt-4');
      expect(gc.samplingParams?.temperature).toBe(0.7);
      expect(gc.samplingParams?.max_tokens).toBe(4096);
      expect(
        modelsConfig.getGenerationConfigSources()['samplingParams']?.kind,
      ).toBe('modelProviders');
    });

    it('should not auto-fill max_tokens for different model families', async () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        anthropic: [
          entry(
            'claude-3-opus',
            'Claude 3 Opus',
            'https://api.anthropic.example.com/v1',
          ),
        ],
        gemini: [
          entry(
            'gemini-pro',
            'Gemini Pro',
            'https://api.gemini.example.com/v1',
          ),
        ],
      };
      // Neither provider sets max_tokens.
      const switched = async (authType: AuthType, modelId: string) => {
        const modelsConfig = new ModelsConfig({
          initialAuthType: authType,
          modelProvidersConfig,
        });
        await modelsConfig.switchModel(authType, modelId);
        return currentGenerationConfig(modelsConfig);
      };

      let gc = await switched(AuthType.USE_ANTHROPIC, 'claude-3-opus');
      expect(gc.samplingParams).toBeUndefined();

      gc = await switched(AuthType.USE_GEMINI, 'gemini-pro');
      expect(gc.samplingParams).toBeUndefined();
    });
  });

  describe('getModelDisplayName', () => {
    const openaiEntry = (id: string, name: string) =>
      openaiConfig([
        entry(id, name, 'https://api.openai.example.com/v1', 'OPENAI_API_KEY'),
      ]);

    it('should return resolved.name when model is found in registry', () => {
      expect(
        openaiEntry('gpt-4o', 'GPT-4o').getModelDisplayName('gpt-4o'),
      ).toBe('GPT-4o');
    });

    it('should disambiguate duplicate model ids by current baseUrl', async () => {
      const idealabBaseUrl = 'https://idealab.example.com/api/openai/v1';
      const modelsConfig = openaiConfig([
        entry(
          'qwen3.7-max',
          '[Token Plan] qwen3.7-max',
          'https://token-plan.example.com/v1',
          'TOKEN_PLAN_API_KEY',
        ),
        entry(
          'qwen3.7-max',
          '[Idealab] qwen3.7-max',
          idealabBaseUrl,
          'IDEALAB_API_KEY',
        ),
      ]);

      await modelsConfig.switchModel(AuthType.USE_OPENAI, 'qwen3.7-max', {
        baseUrl: idealabBaseUrl,
      });

      expect(modelsConfig.getModelDisplayName('qwen3.7-max')).toBe(
        '[Idealab] qwen3.7-max',
      );
      expect(modelsConfig.getCurrentRegistryBaseUrl()).toBe(idealabBaseUrl);
    });

    it('tracks implicit and explicit registry routes with the same effective URL', async () => {
      const defaultBaseUrl = OPENAI_URL;
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          { id: 'shared', name: 'Implicit', envKey: 'IMPLICIT_KEY' },
          entry('shared', 'Explicit', defaultBaseUrl, 'EXPLICIT_KEY'),
        ],
      };
      const modelsConfig = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        modelProvidersConfig,
      });

      await modelsConfig.switchModel(AuthType.USE_OPENAI, 'shared');
      expect(modelsConfig.getCurrentRegistryBaseUrl()).toBeNull();
      modelsConfig.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'shared');
      expect(modelsConfig.getGenerationConfig().apiKeyEnvKey).toBe(
        'IMPLICIT_KEY',
      );

      await modelsConfig.switchModel(AuthType.USE_OPENAI, 'shared', {
        baseUrl: defaultBaseUrl,
      });
      expect(modelsConfig.getCurrentRegistryBaseUrl()).toBe(defaultBaseUrl);

      const restored = new ModelsConfig({
        initialAuthType: AuthType.USE_OPENAI,
        initialRegistryBaseUrl: defaultBaseUrl,
        modelProvidersConfig,
        generationConfig: { model: 'shared' },
      });
      restored.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'shared');
      expect(restored.getGenerationConfig().apiKeyEnvKey).toBe('EXPLICIT_KEY');
    });

    it('should return raw modelId when currentAuthType is falsy', () => {
      // currentAuthType is undefined by default
      expect(new ModelsConfig().getModelDisplayName('some-model')).toBe(
        'some-model',
      );
    });

    it('should return raw modelId when model is not found in registry', () => {
      expect(
        openaiEntry('gpt-4o', 'GPT-4o').getModelDisplayName('unknown-model'),
      ).toBe('unknown-model');
    });

    it('should return raw modelId when model.name equals model.id', () => {
      // name === id, so registry returns the id as name
      expect(
        openaiEntry('coder-model', 'coder-model').getModelDisplayName(
          'coder-model',
        ),
      ).toBe('coder-model');
    });
  });

  describe('providerProtocolConfig wiring', () => {
    const idealab = () =>
      ({ idealab: [{ id: 'qwen3.7-max' }] }) as unknown as ModelProvidersConfig;
    const openaiIds = (modelsConfig: ModelsConfig) =>
      modelsConfig
        .getAvailableModelsForAuthType(AuthType.USE_OPENAI)
        .map((m) => m.id);

    it('threads providerProtocolConfig into the registry so custom ids resolve', () => {
      const modelsConfig = new ModelsConfig({
        modelProvidersConfig: idealab(),
        providerProtocolConfig: { idealab: 'openai' },
      });

      // A wire-name typo anywhere in the options->registry chain would make this
      // empty, so this guards the end-to-end plumbing the unit registry tests miss.
      expect(openaiIds(modelsConfig)).toContain('qwen3.7-max');
    });

    it('skips a custom id when no providerProtocolConfig is supplied', () => {
      const modelsConfig = new ModelsConfig({
        modelProvidersConfig: idealab(),
      });

      expect(
        modelsConfig.getAvailableModelsForAuthType(AuthType.USE_OPENAI),
      ).toEqual([]);
    });

    it('threads providerProtocolConfig through reloadModelProvidersConfig', () => {
      const modelsConfig = new ModelsConfig();

      modelsConfig.reloadModelProvidersConfig(idealab(), { idealab: 'openai' });

      expect(openaiIds(modelsConfig)).toContain('qwen3.7-max');
    });
  });
});
