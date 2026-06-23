/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  findProviderByCredentials,
  getAllProviderBaseUrls,
  getDefaultModelIds,
  resolveBaseUrl,
  shouldShowStep,
  providerMatchesCredentials,
  type ProviderConfig,
} from '@qwen-code/qwen-code-core';
import { Protocol } from '../../core/contentGenerator.js';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test',
    label: 'Test',
    description: 'A test provider',
    protocol: Protocol.OPENAI,
    baseUrl: 'https://api.test.com/v1',
    envKey: 'TEST_API_KEY',
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
    expect(plan.authType).toBe(Protocol.OPENAI);
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

  it('applies advancedConfig to editable unknown model IDs only', () => {
    const config = makeConfig({ modelsEditable: true });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['model-a', 'unknown-model'],
      advancedConfig: {
        contextWindowSize: 1000000,
        multimodal: { image: true, video: true },
      },
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]?.generationConfig).toMatchObject({
      contextWindowSize: 8192,
    });
    expect(models?.[1]).toMatchObject({
      id: 'unknown-model',
      name: '[Test] unknown-model',
      generationConfig: {
        contextWindowSize: 1000000,
        modalities: { image: true, video: true },
      },
    });
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
      protocol: Protocol.ANTHROPIC,
      baseUrl: 'https://custom.com',
      apiKey: 'sk-c',
      modelIds: ['m1'],
    });

    expect(plan.authType).toBe(Protocol.ANTHROPIC);
    expect(plan.modelProviders?.[0]?.authType).toBe(Protocol.ANTHROPIC);
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
      protocolOptions: [Protocol.OPENAI],
    });
    const multi = makeConfig({
      protocolOptions: [Protocol.OPENAI, Protocol.ANTHROPIC],
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

  it('always shows the apiKey step', () => {
    expect(shouldShowStep(makeConfig(), 'apiKey')).toBe(true);
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

  it('matches when function-typed envKey derives a matching key', () => {
    // Previously asserted toBe(false) when envKey was non-string. The
    // provider matcher now resolves function-typed envKey so custom
    // providers stay visible to /doctor and AppHeader. Uses the relative
    // source import (declared with the other dist-bypass aliases below)
    // so the new behaviour is exercised before dist/ is rebuilt; see the
    // 'providerMatchesCredentials with function envKey' suite below for
    // protocol-iteration coverage.
    const config = makeConfig({ envKey: () => 'DYNAMIC' });
    expect(
      providerMatchesCredentialsSrc(
        config,
        'https://api.test.com/v1',
        'DYNAMIC',
      ),
    ).toBe(true);
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

describe('findProviderByCredentials', () => {
  it('finds a preset by its env key + base URL', () => {
    const found = findProviderByCredentials(
      'https://api.deepseek.com',
      'DEEPSEEK_API_KEY',
    );
    expect(found?.id).toBe('deepseek');
  });

  it('returns undefined for an unknown env key', () => {
    expect(
      findProviderByCredentials('https://api.deepseek.com', 'NOT_A_REAL_KEY'),
    ).toBeUndefined();
  });

  it('returns undefined for a known env key but mismatched base URL', () => {
    expect(
      findProviderByCredentials(
        'https://wrong.example.com/v1',
        'DEEPSEEK_API_KEY',
      ),
    ).toBeUndefined();
  });

  it('matches a multi-baseUrl preset against any of its registered URLs', () => {
    // coding-plan ships both China and Singapore endpoints under the same env key.
    const china = findProviderByCredentials(
      'https://coding.dashscope.aliyuncs.com/v1',
      'BAILIAN_CODING_PLAN_API_KEY',
    );
    const intl = findProviderByCredentials(
      'https://coding-intl.dashscope.aliyuncs.com/v1',
      'BAILIAN_CODING_PLAN_API_KEY',
    );
    expect(china?.id).toBe('coding-plan');
    expect(intl?.id).toBe('coding-plan');
  });
});

describe('getAllProviderBaseUrls', () => {
  it('returns a non-empty list including known preset URLs', () => {
    const urls = getAllProviderBaseUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls).toContain('https://api.deepseek.com');
    expect(urls).toContain('https://openrouter.ai/api/v1');
  });

  it('expands BaseUrlOption[] presets into each option URL', () => {
    const urls = getAllProviderBaseUrls();
    // coding-plan has China + Singapore options
    expect(urls).toContain('https://coding.dashscope.aliyuncs.com/v1');
    expect(urls).toContain('https://coding-intl.dashscope.aliyuncs.com/v1');
  });
});

// The package-name imports above resolve to dist/, which lags the source on a
// branch that hasn't been built yet. Re-import via the relative source path so
// these new edge-case tests exercise the in-tree implementation.
import {
  resolveBaseUrl as resolveBaseUrlSrc,
  providerMatchesCredentials as providerMatchesCredentialsSrc,
} from '../provider-config.js';

describe('resolveBaseUrl edge cases', () => {
  it('does not crash on an empty baseUrl array — falls back to selected or ""', () => {
    const config = makeConfig({ baseUrl: [] });
    // Without selectedBaseUrl, return '' instead of throwing on [0].url
    expect(resolveBaseUrlSrc(config)).toBe('');
    // With selectedBaseUrl, return that instead
    expect(resolveBaseUrlSrc(config, 'https://api.user.com/v1')).toBe(
      'https://api.user.com/v1',
    );
  });

  it('matches BaseUrlOption trailing-slash variants', () => {
    const config = makeConfig({
      baseUrl: [
        { id: 'a', label: 'A', url: 'https://a.com/v1' },
        { id: 'b', label: 'B', url: 'https://b.com/v1' },
        { id: 'c', label: 'C', url: 'https://c.com/v1/' },
      ],
    });
    expect(resolveBaseUrlSrc(config, 'https://b.com/v1/')).toBe(
      'https://b.com/v1',
    );
    expect(resolveBaseUrlSrc(config, 'https://a.com/v1///')).toBe(
      'https://a.com/v1',
    );
    expect(resolveBaseUrlSrc(config, 'https://c.com/v1')).toBe(
      'https://c.com/v1/',
    );
  });
});

describe('providerMatchesCredentials with function envKey (custom provider)', () => {
  // Custom provider derives envKey from (protocol, baseUrl) via a function.
  // Treating non-string envKey as "no match" made custom providers invisible
  // to findProviderByCredentials → /doctor and system-info diagnostics.
  it('matches a custom-style provider whose envKey is a function deriving from baseUrl', () => {
    const derivedFor = (_protocol: Protocol, baseUrl: string) =>
      `QWEN_CUSTOM_${Buffer.from(baseUrl).toString('hex').slice(0, 8)}`;
    const config = makeConfig({
      id: 'custom-like',
      envKey: derivedFor,
      baseUrl: undefined, // user-picked
      protocol: Protocol.OPENAI,
    });

    const url = 'https://api.example.com/v1';
    const expectedKey = derivedFor(Protocol.OPENAI, url);
    expect(providerMatchesCredentialsSrc(config, url, expectedKey)).toBe(true);
  });

  it('does not match when the derived key differs from the supplied envKey', () => {
    const derivedFor = (_protocol: Protocol, baseUrl: string) =>
      `QWEN_CUSTOM_${baseUrl.length}`;
    const config = makeConfig({
      id: 'custom-like',
      envKey: derivedFor,
      baseUrl: undefined,
      protocol: Protocol.OPENAI,
    });
    expect(
      providerMatchesCredentialsSrc(
        config,
        'https://api.example.com/v1',
        'WRONG_ENV_KEY',
      ),
    ).toBe(false);
  });

  it('returns false (not crash) when the function envKey itself throws', () => {
    const config = makeConfig({
      id: 'custom-like',
      envKey: () => {
        throw new Error('boom');
      },
      baseUrl: undefined,
    });
    expect(
      providerMatchesCredentialsSrc(
        config,
        'https://api.example.com/v1',
        'ANY',
      ),
    ).toBe(false);
  });

  it('iterates protocolOptions and matches when any one derives the env key', () => {
    // buildInstallPlan derives the persisted env key from inputs.protocol
    // (which may be USE_ANTHROPIC or USE_GEMINI for a custom provider), not
    // from config.protocol. The matcher must try every protocolOption so a
    // custom provider configured under Anthropic/Gemini still gets matched
    // back from the on-disk envKey.
    const derivedFor = (protocol: Protocol, baseUrl: string) =>
      `QWEN_CUSTOM_${protocol.toUpperCase()}_${baseUrl.length}`;
    const config = makeConfig({
      id: 'custom-like',
      envKey: derivedFor,
      baseUrl: undefined,
      protocol: Protocol.OPENAI, // default
      protocolOptions: [Protocol.OPENAI, Protocol.ANTHROPIC, Protocol.GEMINI],
    });

    const url = 'https://api.example.com/v1';
    // User picked Anthropic at install time, so the persisted key derives
    // from USE_ANTHROPIC, not the default USE_OPENAI.
    const anthropicKey = derivedFor(Protocol.ANTHROPIC, url);
    expect(providerMatchesCredentialsSrc(config, url, anthropicKey)).toBe(true);

    // Gemini path also matches.
    const geminiKey = derivedFor(Protocol.GEMINI, url);
    expect(providerMatchesCredentialsSrc(config, url, geminiKey)).toBe(true);
  });
});

import { resolveMetadataKey as resolveMetadataKeySrc } from '../provider-config.js';

describe('customHeaders in ProviderConfig', () => {
  it('merges customHeaders into generationConfig for fixed models', () => {
    const config = makeConfig({
      customHeaders: {
        'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
        'X-Title': 'Qwen Code',
      },
    });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['model-a'],
    });

    const gc = plan.modelProviders?.[0]?.models[0]?.generationConfig;
    expect(gc?.customHeaders).toEqual({
      'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
      'X-Title': 'Qwen Code',
    });
    // existing fields preserved
    expect(gc?.extra_body).toEqual({ enable_thinking: true });
    expect(gc?.contextWindowSize).toBe(8192);
  });

  it('merges customHeaders into generationConfig for editable unknown models', () => {
    const config = makeConfig({
      modelsEditable: true,
      customHeaders: { 'X-Custom': 'val' },
    });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['unknown-model'],
    });

    expect(
      plan.modelProviders?.[0]?.models[0]?.generationConfig?.customHeaders,
    ).toEqual({ 'X-Custom': 'val' });
  });

  it('merges customHeaders for custom-provider models (no predefined list)', () => {
    const config = makeConfig({
      models: undefined,
      modelNamePrefix: '',
      customHeaders: { Authorization: 'Bearer test' },
    });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://custom.com/v1',
      apiKey: 'sk-custom',
      modelIds: ['my-model'],
    });

    expect(
      plan.modelProviders?.[0]?.models[0]?.generationConfig?.customHeaders,
    ).toEqual({ Authorization: 'Bearer test' });
  });

  it('does not add generationConfig when customHeaders is absent', () => {
    const config = makeConfig({ models: [{ id: 'plain' }] });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['plain'],
    });

    expect(
      plan.modelProviders?.[0]?.models[0]?.generationConfig,
    ).toBeUndefined();
  });

  it('applies customHeaders to every model in the list', () => {
    const config = makeConfig({
      models: [{ id: 'a' }, { id: 'b' }],
      customHeaders: { 'X-Test': 'yes' },
    });
    const plan = buildInstallPlan(config, {
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'sk-test',
      modelIds: ['a', 'b'],
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]?.generationConfig?.customHeaders).toEqual({
      'X-Test': 'yes',
    });
    expect(models?.[1]?.generationConfig?.customHeaders).toEqual({
      'X-Test': 'yes',
    });
  });

  it('includes customHeaders in buildProviderTemplate', () => {
    const config = makeConfig({
      models: [{ id: 'x' }],
      customHeaders: { 'X-Template': 'val' },
    });
    const template = buildProviderTemplate(config);
    expect(template[0]?.generationConfig?.customHeaders).toEqual({
      'X-Template': 'val',
    });
  });
});

describe('resolveMetadataKey dotted-id guard', () => {
  it('returns the id unchanged for normal providers with static models', () => {
    const config = makeConfig({ id: 'deepseek', models: [{ id: 'm1' }] });
    expect(resolveMetadataKeySrc(config)).toBe('deepseek');
  });

  it('returns undefined for providers without static models', () => {
    const config = makeConfig({ id: 'custom-like', models: undefined });
    expect(resolveMetadataKeySrc(config)).toBeUndefined();
  });

  it("throws when the id contains '.' (would corrupt dotted setValue writes)", () => {
    const config = makeConfig({ id: 'company.ai', models: [{ id: 'm1' }] });
    expect(() => resolveMetadataKeySrc(config)).toThrow(/must not contain/);
  });
});
