/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  getDefaultModelIds,
  resolveBaseUrl,
  shouldShowStep,
  providerMatchesCredentials,
  type ProviderConfig,
} from './providerConfig.js';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test',
    label: 'Test',
    description: 'A test provider',
    protocol: AuthType.USE_OPENAI,
    baseUrl: 'https://api.test.com/v1',
    envKey: 'TEST_API_KEY',
    authMethod: 'input',
    models: [{ id: 'model-a', contextWindowSize: 8192, enableThinking: true }],
    modelNamePrefix: 'Test',
    ...overrides,
  };
}

describe('buildInstallPlan', () => {
  it('builds a plan with fixed models (not editable)', () => {
    const config = makeConfig();
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['model-a'],
    });

    expect(plan.providerId).toBe('test');
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.env).toEqual({ TEST_API_KEY: 'sk-test' });
    expect(plan.modelSelection).toEqual({ modelId: 'model-a' });
    expect(plan.modelProviders?.[0]?.models[0]).toMatchObject({
      id: 'model-a',
      name: '[Test] model-a',
      generationConfig: {
        extra_body: { enable_thinking: true },
        contextWindowSize: 8192,
      },
    });
  });

  it('builds a plan with editable models and unknown IDs', () => {
    const config = makeConfig({ modelsEditable: true });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['model-a', 'unknown-model'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]?.generationConfig).toBeDefined();
    expect(models?.[1]).toMatchObject({
      id: 'unknown-model',
      name: '[Test] unknown-model',
    });
    expect(models?.[1]?.generationConfig).toBeUndefined();
  });

  it('builds a plan with no predefined models (custom provider path)', () => {
    const config = makeConfig({
      models: undefined,
      modelNamePrefix: '',
    });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://custom.com/v1',
      apiKey: 'sk-custom',
      modelIds: ['my-model'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]).toMatchObject({
      id: 'my-model',
      name: 'my-model',
    });
    expect(models?.[0]?.generationConfig).toBeUndefined();
  });

  it('builds custom model configs with advancedConfig', () => {
    const config = makeConfig({ models: undefined, modelNamePrefix: 'C' });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://custom.com/v1',
      apiKey: 'sk-custom',
      modelIds: ['m1', 'm2'],
      advancedConfig: {
        enableThinking: true,
        multimodal: { image: true, video: false, audio: false },
        maxTokens: 4096,
      },
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]?.generationConfig?.extra_body).toEqual({
      enable_thinking: true,
    });
    expect(models?.[0]?.generationConfig?.modalities).toEqual({
      image: true,
      video: false,
      audio: false,
    });
    expect(models?.[0]?.generationConfig?.samplingParams).toEqual({
      max_tokens: 4096,
    });
  });

  it('produces independent generationConfig objects per custom model', () => {
    const config = makeConfig({ models: undefined, modelNamePrefix: '' });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://custom.com/v1',
      apiKey: 'sk-custom',
      modelIds: ['m1', 'm2'],
      advancedConfig: { enableThinking: true },
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]?.generationConfig).not.toBe(
      models?.[1]?.generationConfig,
    );
  });

  it('uses prebuiltModels when provided', () => {
    const config = makeConfig();
    const prebuilt = [{ id: 'pre-1', baseUrl: 'https://x.com', envKey: 'X' }];
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: [],
      prebuiltModels: prebuilt,
    });

    expect(plan.modelProviders?.[0]?.models).toBe(prebuilt);
    expect(plan.modelSelection).toEqual({ modelId: 'pre-1' });
  });

  it('throws when models list is empty', () => {
    const config = makeConfig({ models: undefined, modelNamePrefix: '' });
    expect(() =>
      buildInstallPlan(config, {
        baseUrl: 'https://custom.com/v1',
        apiKey: 'sk-custom',
        modelIds: [],
      }),
    ).toThrow(/No models configured for provider/);
  });

  it('resolves envKey from function', () => {
    const config = makeConfig({
      envKey: (protocol, baseUrl) =>
        `CUSTOM_${protocol}_${baseUrl.replace(/\W+/g, '_')}`,
      models: undefined,
      modelNamePrefix: '',
    });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://x.com',
      apiKey: 'sk-x',
      modelIds: ['m1'],
    });

    const envKeys = Object.keys(plan.env ?? {});
    expect(envKeys[0]).toContain('CUSTOM_');
    expect(envKeys[0]).toContain('openai');
  });

  it('uses protocol override from inputs', () => {
    const config = makeConfig({
      models: undefined,
      modelNamePrefix: '',
    });
    const plan = buildInstallPlan(config, {
      protocol: AuthType.USE_ANTHROPIC,
      baseUrl: 'https://custom.com',
      apiKey: 'sk-c',
      modelIds: ['m1'],
    });

    expect(plan.authType).toBe(AuthType.USE_ANTHROPIC);
    expect(plan.modelProviders?.[0]?.authType).toBe(AuthType.USE_ANTHROPIC);
  });
});

describe('specToModelConfig (via buildProviderTemplate)', () => {
  it('omits generationConfig when spec has no thinking or context window', () => {
    const config = makeConfig({
      models: [{ id: 'plain-model' }],
    });
    const template = buildProviderTemplate(config);
    expect(template[0]?.generationConfig).toBeUndefined();
  });

  it('includes generationConfig only when spec has values', () => {
    const config = makeConfig({
      models: [{ id: 'm', contextWindowSize: 4096 }],
    });
    const template = buildProviderTemplate(config);
    expect(template[0]?.generationConfig).toEqual({
      contextWindowSize: 4096,
    });
  });

  it('includes description when spec has one', () => {
    const config = makeConfig({
      models: [{ id: 'm', description: 'A model' }],
    });
    const template = buildProviderTemplate(config);
    expect(template[0]?.description).toBe('A model');
  });
});

describe('resolveOwnsModel (via buildInstallPlan)', () => {
  it('auto-derives ownership from string envKey + prefix', () => {
    const config = makeConfig({ modelNamePrefix: 'Pfx' });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['model-a'],
    });

    const ownsModel = plan.modelProviders?.[0]?.ownsModel;
    expect(ownsModel).toBeDefined();
    expect(
      ownsModel?.({ id: 'x', envKey: 'TEST_API_KEY', name: '[Pfx] x' }),
    ).toBe(true);
    expect(ownsModel?.({ id: 'x', envKey: 'OTHER_KEY', name: '[Pfx] x' })).toBe(
      false,
    );
    expect(
      ownsModel?.({ id: 'x', envKey: 'TEST_API_KEY', name: 'no prefix' }),
    ).toBe(false);
  });

  it('auto-derives ownership from envKey only when prefix is empty', () => {
    const config = makeConfig({ modelNamePrefix: '' });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['model-a'],
    });

    const ownsModel = plan.modelProviders?.[0]?.ownsModel;
    expect(ownsModel?.({ id: 'x', envKey: 'TEST_API_KEY' })).toBe(true);
    expect(ownsModel?.({ id: 'x', envKey: 'OTHER' })).toBe(false);
  });

  it('throws when envKey is a function and models list is empty', () => {
    const config = makeConfig({
      envKey: () => 'DYNAMIC',
      models: undefined,
      modelNamePrefix: '',
    });
    expect(() =>
      buildInstallPlan(config, {
        baseUrl: 'https://x.com',
        apiKey: 'sk',
        modelIds: [],
      }),
    ).toThrow(/No models configured for provider/);
  });

  it('uses custom ownsModel when provided', () => {
    const customOwns = (model: { id: string }) => model.id === 'special';
    const config = makeConfig({ ownsModel: customOwns });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['model-a'],
    });

    expect(plan.modelProviders?.[0]?.ownsModel).toBe(customOwns);
  });
});

describe('resolveBaseUrl', () => {
  it('returns fixed string baseUrl', () => {
    const config = makeConfig({ baseUrl: 'https://fixed.com' });
    expect(resolveBaseUrl(config)).toBe('https://fixed.com');
    expect(resolveBaseUrl(config, 'https://ignored.com')).toBe(
      'https://fixed.com',
    );
  });

  it('matches selected URL from BaseUrlOption array', () => {
    const config = makeConfig({
      baseUrl: [
        { id: 'a', label: 'A', url: 'https://a.com' },
        { id: 'b', label: 'B', url: 'https://b.com' },
      ],
    });
    expect(resolveBaseUrl(config, 'https://b.com')).toBe('https://b.com');
  });

  it('falls back to first option when no match', () => {
    const config = makeConfig({
      baseUrl: [
        { id: 'a', label: 'A', url: 'https://a.com' },
        { id: 'b', label: 'B', url: 'https://b.com' },
      ],
    });
    expect(resolveBaseUrl(config, 'https://unknown.com')).toBe('https://a.com');
  });

  it('returns selectedBaseUrl for undefined config.baseUrl', () => {
    const config = makeConfig({ baseUrl: undefined });
    expect(resolveBaseUrl(config, 'https://typed.com')).toBe(
      'https://typed.com',
    );
    expect(resolveBaseUrl(config)).toBe('');
  });
});

describe('getDefaultModelIds', () => {
  it('returns model IDs from config', () => {
    const config = makeConfig({
      models: [{ id: 'a' }, { id: 'b' }],
    });
    expect(getDefaultModelIds(config)).toEqual(['a', 'b']);
  });

  it('returns empty array when no models', () => {
    const config = makeConfig({ models: undefined });
    expect(getDefaultModelIds(config)).toEqual([]);
  });
});

describe('shouldShowStep', () => {
  it('shows protocol step only when multiple options', () => {
    const single = makeConfig({
      protocolOptions: [AuthType.USE_OPENAI],
    });
    const multi = makeConfig({
      protocolOptions: [AuthType.USE_OPENAI, AuthType.USE_ANTHROPIC],
    });
    expect(shouldShowStep(single, 'protocol')).toBe(false);
    expect(shouldShowStep(multi, 'protocol')).toBe(true);
  });

  it('shows baseUrl step when undefined or array', () => {
    expect(shouldShowStep(makeConfig({ baseUrl: undefined }), 'baseUrl')).toBe(
      true,
    );
    expect(
      shouldShowStep(
        makeConfig({
          baseUrl: [{ id: 'a', label: 'A', url: 'https://a.com' }],
        }),
        'baseUrl',
      ),
    ).toBe(true);
    expect(
      shouldShowStep(makeConfig({ baseUrl: 'https://fixed.com' }), 'baseUrl'),
    ).toBe(false);
  });

  it('hides apiKey step for oauth providers', () => {
    expect(shouldShowStep(makeConfig({ authMethod: 'input' }), 'apiKey')).toBe(
      true,
    );
    expect(shouldShowStep(makeConfig({ authMethod: 'oauth' }), 'apiKey')).toBe(
      false,
    );
  });

  it('shows models step only when editable or undefined', () => {
    expect(shouldShowStep(makeConfig({ models: undefined }), 'models')).toBe(
      true,
    );
    expect(shouldShowStep(makeConfig({ modelsEditable: true }), 'models')).toBe(
      true,
    );
    expect(
      shouldShowStep(makeConfig({ modelsEditable: false }), 'models'),
    ).toBe(false);
  });

  it('shows advancedConfig step only when enabled', () => {
    expect(
      shouldShowStep(
        makeConfig({ showAdvancedConfig: true }),
        'advancedConfig',
      ),
    ).toBe(true);
    expect(shouldShowStep(makeConfig(), 'advancedConfig')).toBe(false);
  });
});

describe('providerMatchesCredentials', () => {
  it('matches by string envKey and string baseUrl', () => {
    const config = makeConfig();
    expect(
      providerMatchesCredentials(
        config,
        'https://api.test.com/v1',
        'TEST_API_KEY',
      ),
    ).toBe(true);
  });

  it('rejects mismatched envKey', () => {
    const config = makeConfig();
    expect(
      providerMatchesCredentials(config, 'https://api.test.com/v1', 'OTHER'),
    ).toBe(false);
  });

  it('rejects mismatched baseUrl', () => {
    const config = makeConfig();
    expect(
      providerMatchesCredentials(config, 'https://other.com', 'TEST_API_KEY'),
    ).toBe(false);
  });

  it('matches against BaseUrlOption array', () => {
    const config = makeConfig({
      baseUrl: [
        { id: 'a', label: 'A', url: 'https://a.com' },
        { id: 'b', label: 'B', url: 'https://b.com' },
      ],
    });
    expect(
      providerMatchesCredentials(config, 'https://b.com', 'TEST_API_KEY'),
    ).toBe(true);
    expect(
      providerMatchesCredentials(config, 'https://c.com', 'TEST_API_KEY'),
    ).toBe(false);
  });

  it('returns false for function-typed envKey', () => {
    const config = makeConfig({ envKey: () => 'DYNAMIC' });
    expect(
      providerMatchesCredentials(config, 'https://api.test.com/v1', 'DYNAMIC'),
    ).toBe(false);
  });
});

describe('computeModelListVersion', () => {
  it('produces consistent hashes', () => {
    const models = [{ id: 'a' }, { id: 'b' }];
    const v1 = computeModelListVersion(models);
    const v2 = computeModelListVersion(models);
    expect(v1).toBe(v2);
    expect(v1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('produces different hashes for different models', () => {
    expect(computeModelListVersion([{ id: 'a' }])).not.toBe(
      computeModelListVersion([{ id: 'b' }]),
    );
  });
});

describe('buildProviderTemplate', () => {
  it('uses resolved baseUrl and default model IDs', () => {
    const config = makeConfig({
      baseUrl: 'https://fixed.com',
      models: [{ id: 'x' }, { id: 'y' }],
    });
    const template = buildProviderTemplate(config);
    expect(template).toHaveLength(2);
    expect(template[0]?.baseUrl).toBe('https://fixed.com');
    expect(template[0]?.envKey).toBe('TEST_API_KEY');
  });

  it('uses function-typed modelNamePrefix', () => {
    const config = makeConfig({
      baseUrl: undefined,
      modelNamePrefix: (baseUrl) =>
        baseUrl.includes('intl') ? 'Intl' : 'Default',
      models: [{ id: 'm' }],
    });
    const template = buildProviderTemplate(config, 'https://intl.com');
    expect(template[0]?.name).toBe('[Intl] m');
  });
});
