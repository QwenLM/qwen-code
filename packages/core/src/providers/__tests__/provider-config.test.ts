/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AuthType,
  buildInstallPlan,
  buildProviderTemplate,
  computeModelListVersion,
  findExistingProviderModels,
  findProviderByCredentials,
  getDefaultModelIds,
  resolveBaseUrl,
  shouldShowStep,
  providerMatchesCredentials,
  customProvider,
  generateCustomEnvKey,
  type ModelSpec,
  type ProviderConfig,
  type ProviderModelConfig,
  type ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  TOKEN_PLAN_CHINA_BASE_URL,
  TOKEN_PLAN_ENV_KEY,
  TOKEN_PLAN_GLOBAL_BASE_URL,
} from '../presets/alibaba-token-plan.js';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test',
    label: 'Test',
    description: 'A test provider',
    protocol: AuthType.USE_OPENAI,
    baseUrl: 'https://api.test.com/v1',
    envKey: 'TEST_API_KEY',
    models: [{ id: 'model-a', contextWindowSize: 8192, enableThinking: true }],
    modelNamePrefix: 'Test',
    ...overrides,
  };
}

/** makeConfig for a custom-style provider: no fixed models, no name prefix. */
const customLike = (overrides: Partial<ProviderConfig> = {}) =>
  makeConfig({ models: undefined, modelNamePrefix: '', ...overrides });
const TEST_URL = 'https://api.test.com/v1';
const testInputs = (
  modelIds = ['model-a'],
  extra: Partial<ProviderSetupInputs> = {},
): ProviderSetupInputs => ({
  baseUrl: TEST_URL,
  apiKey: 'sk-test',
  modelIds,
  ...extra,
});
const customInputs = (
  modelIds: string[],
  extra: Partial<ProviderSetupInputs> = {},
): ProviderSetupInputs => ({
  baseUrl: 'https://custom.com/v1',
  apiKey: 'sk-custom',
  modelIds,
  ...extra,
});
const modelsOf = <M>(plan: { modelProviders?: Array<{ models: M[] }> }) =>
  plan.modelProviders![0]!.models;
/** buildInstallPlan (dist) and return the models of its provider patch. */
const installModels = (config: ProviderConfig, inputs: ProviderSetupInputs) =>
  modelsOf(buildInstallPlan(config, inputs));
const abUrls = () => [
  { id: 'a', label: 'A', url: 'https://a.com' },
  { id: 'b', label: 'B', url: 'https://b.com' },
];
const RETIRED_VERSION = { 'providerMetadata.test': { version: undefined } };

describe('buildInstallPlan', () => {
  it.each([false, true])(
    'preserves each preset API and its selected route (same-id siblings: %s)',
    (siblings) => {
      const config = makeConfig({
        models: [{ id: 'model-a', enableThinking: true }, { id: 'model-b' }],
      });
      const inputs = testInputs(['model-a', 'model-b'], {
        apiKey: 'test-only-new',
      });
      const chat = modelsOf(buildInstallPlanSrc(config, inputs));
      const responses = modelsOf(
        buildInstallPlanSrc(config, { ...inputs, wireApi: 'responses' }),
      );
      const existing = [
        chat[0]!,
        ...(siblings ? [responses[0]!] : []),
        responses[1]!,
      ];
      const before = structuredClone(existing);
      const plan = buildInstallPlanSrc(config, inputs, existing, {
        id: 'model-b',
        baseUrl: inputs.baseUrl,
        authType: AuthType.USE_OPENAI_RESPONSES,
      });
      expect(plan.authType).toBe(AuthType.USE_OPENAI_RESPONSES);
      expect(plan.modelSelection).toMatchObject({ modelId: 'model-b' });
      expect(modelsOf(plan)).toEqual(existing);
      expect(plan.providerState).toEqual(RETIRED_VERSION);
      expect(existing).toEqual(before);
      const explicit = buildInstallPlanSrc(
        config,
        { ...inputs, wireApi: 'chat-completions' },
        existing,
        { id: 'model-b', authType: AuthType.USE_OPENAI_RESPONSES },
      );
      expect(explicit.authType).toBe(AuthType.USE_OPENAI);
      expect(modelsOf(explicit).map((model) => model.wireApi)).toEqual([
        'chat-completions',
        'chat-completions',
      ]);
    },
  );

  it('keeps a hand-written realtimeOnly route on reconnect and never selects it', () => {
    const baseUrl = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    // Listed first on purpose: position must not make it the conversation
    // model.
    const existing = [
      { id: 'omni-realtime', baseUrl, envKey, realtimeOnly: true },
      { id: 'chat', baseUrl, envKey },
    ];
    const plan = buildInstallPlanSrc(
      customProvider,
      {
        protocol: AuthType.USE_OPENAI,
        baseUrl,
        apiKey: 'test-only',
        modelIds: ['omni-realtime', 'chat'],
      },
      existing,
    );
    expect(
      modelsOf(plan).find((model) => model.id === 'omni-realtime')
        ?.realtimeOnly,
    ).toBe(true);
    expect(plan.modelSelection).toMatchObject({ modelId: 'chat' });
  });

  it.each(['generated', 'prebuilt', 'preserved'] as const)(
    'rejects a final Responses voice model (%s)',
    (source) => {
      const inputs = {
        protocol: AuthType.USE_OPENAI,
        wireApi: 'responses' as const,
        baseUrl: 'https://voice.example/v1',
        apiKey: 'test-only',
        modelIds: ['qwen3-asr-flash'],
      };
      const model = {
        id: 'qwen3-asr-flash',
        baseUrl: inputs.baseUrl,
        envKey: generateCustomEnvKey(AuthType.USE_OPENAI, inputs.baseUrl),
        wireApi: 'responses' as const,
        voiceOnly: true,
      };
      expect(() =>
        buildInstallPlanSrc(
          customProvider,
          {
            ...inputs,
            ...(source === 'generated'
              ? { advancedConfig: { purpose: 'voice' as const } }
              : {}),
            ...(source === 'prebuilt' ? { prebuiltModels: [model] } : {}),
          },
          source === 'preserved' ? [model] : [],
        ),
      ).toThrow('Voice transcription requires the OpenAI Chat Completions API');
    },
  );

  it.each([
    { purpose: 'voice' as const, wireApi: undefined },
    { purpose: 'voice' as const, wireApi: 'chat-completions' as const },
    { purpose: 'image' as const, wireApi: 'responses' as const },
    { purpose: undefined, wireApi: 'responses' as const },
  ])(
    'accepts supported purpose/wire combinations: %j',
    ({ purpose, wireApi }) => {
      expect(() =>
        buildInstallPlanSrc(customProvider, {
          baseUrl: 'https://media.example/v1',
          apiKey: 'test-only',
          modelIds: ['qwen3-asr-flash'],
          wireApi,
          advancedConfig: { purpose },
        }),
      ).not.toThrow();
    },
  );

  it.each(['chat-completions', 'responses'] as const)(
    'clears explicitly submitted advanced controls without losing unrelated settings (%s)',
    (wireApi) => {
      const inputs = {
        protocol: AuthType.USE_OPENAI,
        wireApi,
        baseUrl: 'https://custom.example/v1',
        apiKey: 'new-key',
        modelIds: ['custom-model'],
      };
      const existing = modelsOf(
        buildInstallPlanSrc(customProvider, {
          ...inputs,
          advancedConfig: {
            enableThinking: true,
            multimodal: { image: true, audio: true },
            contextWindowSize: 131072,
            maxTokens: 8192,
          },
        }),
      );
      existing[0]!.generationConfig = {
        ...existing[0]!.generationConfig,
        extra_body: {
          ...existing[0]!.generationConfig?.extra_body,
          custom_flag: 'retained',
        },
        samplingParams: { max_tokens: 8192, temperature: 0.2 },
        customHeaders: { 'X-Route': 'paid' },
        timeout: 12345,
      };
      const before = structuredClone(existing);
      /** Reinstall over `existing` with these advanced controls submitted. */
      const reinstall = (
        advancedConfig: NonNullable<ProviderSetupInputs['advancedConfig']>,
      ) =>
        modelsOf(
          buildInstallPlanSrc(
            customProvider,
            { ...inputs, advancedConfig },
            existing,
          ),
        )[0]!;
      expect(
        modelsOf(buildInstallPlanSrc(customProvider, inputs, existing)),
      ).toEqual(existing);
      for (const advancedConfig of [{}, { contextWindowSize: 65536 }]) {
        expect(reinstall(advancedConfig).generationConfig).toEqual({
          ...existing[0]!.generationConfig,
          ...(advancedConfig.contextWindowSize
            ? { contextWindowSize: 65536 }
            : {}),
        });
      }
      const disabled = reinstall({ enableThinking: false });
      const expectedDisabled = structuredClone(existing[0]!.generationConfig!);
      delete expectedDisabled.extra_body!['enable_thinking'];
      if (wireApi === 'responses') delete expectedDisabled.reasoning;
      expect(disabled.generationConfig).toEqual(expectedDisabled);
      const withoutModalities = reinstall({ multimodal: {} });
      const expectedModalities = structuredClone(
        existing[0]!.generationConfig!,
      );
      delete expectedModalities.modalities;
      expect(withoutModalities.generationConfig).toEqual(expectedModalities);
      const cleared = reinstall({ replaceExisting: true });
      expect(cleared.generationConfig).toEqual({
        extra_body: { custom_flag: 'retained' },
        samplingParams: { temperature: 0.2 },
        customHeaders: { 'X-Route': 'paid' },
        timeout: 12345,
      });
      expect(cleared.envKey).toBe(existing[0]!.envKey);
      const enabled = reinstall({ enableThinking: true });
      expect(enabled.generationConfig?.extra_body).toEqual({
        custom_flag: 'retained',
        ...(wireApi === 'chat-completions' ? { enable_thinking: true } : {}),
      });
      expect(enabled.generationConfig).toEqual(existing[0]!.generationConfig);
      const replaced = reinstall({
        replaceExisting: true,
        contextWindowSize: 32768,
        maxTokens: 4096,
      });
      expect(replaced.generationConfig).toEqual({
        ...cleared.generationConfig,
        contextWindowSize: 32768,
        samplingParams: { temperature: 0.2, max_tokens: 4096 },
      });
      expect(existing).toEqual(before);
    },
  );

  it('builds a plan with fixed models (not editable)', () => {
    const plan = buildInstallPlan(makeConfig(), testInputs());
    expect(plan.providerId).toBe('test');
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.env).toEqual({ TEST_API_KEY: 'sk-test' });
    expect(plan.modelSelection).toEqual({ modelId: 'model-a' });
    expect(modelsOf(plan)[0]).toMatchObject({
      id: 'model-a',
      name: '[Test] model-a',
      generationConfig: {
        extra_body: { enable_thinking: true },
        contextWindowSize: 8192,
      },
    });
  });

  it('builds a plan with editable models and unknown IDs', () => {
    const config = makeConfig({
      modelsEditable: true,
      models: [
        { id: 'model-a', contextWindowSize: 8192, enableThinking: true },
        { id: 'model-b' },
      ],
    });
    const plan = buildInstallPlanSrc(
      config,
      testInputs(['model-a', 'unknown-model']),
    );
    const models = modelsOf(plan);
    expect(models).toHaveLength(2);
    expect(models[0]?.generationConfig).toBeDefined();
    expect(models[1]).toMatchObject({
      id: 'unknown-model',
      name: '[Test] unknown-model',
    });
    expect(models[1]?.generationConfig).toBeUndefined();
    expect(plan.providerState?.['providerMetadata.test']?.['version']).toBe(
      computeModelListVersion(models),
    );
  });

  it('retires version metadata when the install stamps an explicit API', () => {
    const config = makeConfig();
    const planWith = (wireApi?: ProviderSetupInputs['wireApi']) =>
      buildInstallPlan(
        config,
        testInputs(['model-a'], wireApi ? { wireApi } : {}),
      );
    // A version hashed from a `wireApi`-stamped model list can never match the
    // drift check's template rebuild (no `wireApi`, and the default route's
    // generationConfig shape), so the provider would prompt an "update" on
    // every launch, and accepting it would duplicate every model. The install
    // records no version and retires one an earlier default-route install left
    // behind (adapters treat `undefined` as unset). The same holds for an
    // explicit `chat-completions` on a preset whose own protocol already is
    // USE_OPENAI: the stamp alone makes the hash irreproducible by
    // buildProviderTemplate.
    expect(planWith('responses').providerState).toEqual(RETIRED_VERSION);
    expect(planWith('chat-completions').providerState).toEqual(RETIRED_VERSION);
    expect(
      planWith().providerState?.['providerMetadata.test']?.['version'],
    ).toBe(computeModelListVersion(buildProviderTemplate(config, TEST_URL)));
  });

  it('keeps an edited window when reconnecting a model with a preset default', () => {
    const config = makeConfig();
    const inputs = testInputs(['model-a'], { apiKey: 'test' });
    const initial = buildInstallPlan(config, inputs);
    const original = modelsOf(initial);
    original[0]!.generationConfig = { contextWindowSize: 65536 };
    const reconnected = buildInstallPlan(config, inputs, original);
    expect(reconnected.providerState).toEqual(initial.providerState);
    expect(modelsOf(reconnected)[0]!.generationConfig?.contextWindowSize).toBe(
      65536,
    );
  });

  it('applies advancedConfig to editable unknown model IDs only', () => {
    const models = installModels(
      makeConfig({ modelsEditable: true }),
      testInputs(['model-a', 'unknown-model'], {
        advancedConfig: {
          contextWindowSize: 1000000,
          multimodal: { image: true, video: true },
        },
      }),
    );
    expect(models[0]?.generationConfig).toMatchObject({
      contextWindowSize: 8192,
    });
    expect(models[1]).toMatchObject({
      id: 'unknown-model',
      name: '[Test] unknown-model',
      generationConfig: {
        contextWindowSize: 1000000,
        modalities: { image: true, video: true },
      },
    });
  });

  it('builds a plan with no predefined models (custom provider path)', () => {
    const models = installModels(customLike(), customInputs(['my-model']));
    expect(models[0]).toMatchObject({ id: 'my-model', name: 'my-model' });
    expect(models[0]?.generationConfig).toBeUndefined();
  });

  it('builds custom model configs with advancedConfig', () => {
    const models = installModels(
      customLike({ modelNamePrefix: 'C' }),
      customInputs(['m1', 'm2'], {
        advancedConfig: {
          enableThinking: true,
          multimodal: { image: true, video: false, audio: false },
          maxTokens: 4096,
        },
      }),
    );
    const gc = models[0]?.generationConfig;
    expect(models).toHaveLength(2);
    expect(gc?.extra_body).toEqual({ enable_thinking: true });
    expect(gc?.modalities).toEqual({ image: true, video: false, audio: false });
    expect(gc?.samplingParams).toEqual({ max_tokens: 4096 });
  });

  it('routes advancedConfig.enableThinking through reasoning.effort for the Responses protocol', () => {
    const gc = installModels(
      customLike({ modelNamePrefix: 'C' }),
      customInputs(['m1'], {
        wireApi: 'responses',
        advancedConfig: { enableThinking: true },
      }),
    )[0]?.generationConfig;
    expect(gc).toEqual({ reasoning: { effort: 'medium' } });
    expect(gc?.extra_body).toBeUndefined();
  });

  it('keeps omitted custom wireApi on Chat when the same model has a Responses entry', () => {
    const plan = buildInstallPlan(
      makeConfig({ models: undefined, protocolOptions: [AuthType.USE_OPENAI] }),
      testInputs(['same'], {
        apiKey: 'key',
        advancedConfig: { enableThinking: true },
      }),
      [
        {
          id: 'same',
          name: '[Test] same',
          baseUrl: TEST_URL,
          envKey: 'TEST_API_KEY',
          wireApi: 'responses',
          generationConfig: { reasoning: { effort: 'high' } },
        },
      ],
    );
    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    expect(modelsOf(plan)[0]!.wireApi).toBeUndefined();
    expect(modelsOf(plan)[0]!.generationConfig).toEqual({
      extra_body: { enable_thinking: true },
    });
  });

  it('uses the explicit model API for thinking and rejects incompatible setup inputs', () => {
    const config = makeConfig({ models: undefined });
    const inputs = customInputs(['m1'], {
      wireApi: 'responses',
      advancedConfig: { enableThinking: true },
    });
    const plan = buildInstallPlan(config, inputs);
    expect(plan.authType).toBe(AuthType.USE_OPENAI_RESPONSES);
    expect(plan.modelProviders?.[0]).toMatchObject({
      authType: AuthType.USE_OPENAI,
      models: [
        {
          id: 'm1',
          wireApi: 'responses',
          generationConfig: { reasoning: { effort: 'medium' } },
        },
      ],
    });
    expect(() =>
      buildInstallPlan(config, { ...inputs, protocol: AuthType.USE_ANTHROPIC }),
    ).toThrow(/api/i);
    expect(() =>
      buildInstallPlan(config, {
        ...inputs,
        wireApi: 'invalid' as 'responses',
      }),
    ).toThrow(/api/i);
  });

  it('produces independent generationConfig objects per custom model', () => {
    const models = installModels(
      customLike(),
      customInputs(['m1', 'm2'], { advancedConfig: { enableThinking: true } }),
    );
    expect(models[0]?.generationConfig).not.toBe(models[1]?.generationConfig);
  });

  it('uses prebuiltModels when provided', () => {
    const prebuilt = [{ id: 'pre-1', baseUrl: 'https://x.com', envKey: 'X' }];
    const plan = buildInstallPlan(
      makeConfig(),
      testInputs([], { prebuiltModels: prebuilt }),
    );
    expect(modelsOf(plan)).toBe(prebuilt);
    expect(plan.modelSelection).toEqual({ modelId: 'pre-1' });
  });

  it('throws when models list is empty', () => {
    expect(() => buildInstallPlan(customLike(), customInputs([]))).toThrow(
      /No models configured for provider/,
    );
  });

  it('resolves envKey from function', () => {
    const config = customLike({
      envKey: (protocol, baseUrl) =>
        `CUSTOM_${protocol}_${baseUrl.replace(/\W+/g, '_')}`,
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
    const plan = buildInstallPlan(customLike(), {
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
  const templateFor = (spec: ModelSpec) =>
    buildProviderTemplate(makeConfig({ models: [spec] }))[0];

  it('omits generationConfig when spec has no thinking or context window', () => {
    expect(
      templateFor({ id: 'plain-model' })?.generationConfig,
    ).toBeUndefined();
  });

  it('includes generationConfig only when spec has values', () => {
    expect(
      templateFor({ id: 'm', contextWindowSize: 4096 })?.generationConfig,
    ).toEqual({ contextWindowSize: 4096 });
  });

  it('includes description when spec has one', () => {
    expect(templateFor({ id: 'm', description: 'A model' })?.description).toBe(
      'A model',
    );
  });

  it('preserves image-only model metadata in the provider template', () => {
    expect(templateFor({ id: 'image-model', imageOnly: true })?.imageOnly).toBe(
      true,
    );
  });

  it('preserves image generation capability in the provider template', () => {
    expect(
      templateFor({ id: 'dual-role-model', supportsImageGeneration: true })
        ?.supportsImageGeneration,
    ).toBe(true);
  });
});

describe('resolveOwnsModel (via buildInstallPlan)', () => {
  const ownsModelFor = (config: ProviderConfig) =>
    buildInstallPlan(config, testInputs()).modelProviders?.[0]?.ownsModel;

  it('auto-derives ownership from string envKey + prefix', () => {
    const ownsModel = ownsModelFor(makeConfig({ modelNamePrefix: 'Pfx' }));
    expect(ownsModel).toBeDefined();
    for (const [envKey, name, owns] of [
      ['TEST_API_KEY', '[Pfx] x', true],
      ['OTHER_KEY', '[Pfx] x', false],
      ['TEST_API_KEY', 'no prefix', false],
    ] as const) {
      expect(ownsModel?.({ id: 'x', envKey, name })).toBe(owns);
    }
  });

  it('auto-derives ownership from envKey only when prefix is empty', () => {
    const ownsModel = ownsModelFor(makeConfig({ modelNamePrefix: '' }));
    expect(ownsModel?.({ id: 'x', envKey: 'TEST_API_KEY' })).toBe(true);
    expect(ownsModel?.({ id: 'x', envKey: 'OTHER' })).toBe(false);
  });

  it('throws when envKey is a function and models list is empty', () => {
    const config = customLike({ envKey: () => 'DYNAMIC' });
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
    expect(ownsModelFor(makeConfig({ ownsModel: customOwns }))).toBe(
      customOwns,
    );
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
    const config = makeConfig({ baseUrl: abUrls() });
    expect(resolveBaseUrl(config, 'https://b.com')).toBe('https://b.com');
  });

  it('falls back to first option when no match', () => {
    const config = makeConfig({ baseUrl: abUrls() });
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
    const config = makeConfig({ models: [{ id: 'a' }, { id: 'b' }] });
    expect(getDefaultModelIds(config)).toEqual(['a', 'b']);
  });

  it('returns empty array when no models', () => {
    expect(getDefaultModelIds(makeConfig({ models: undefined }))).toEqual([]);
  });
});

describe('findExistingProviderModels', () => {
  const config = makeConfig({ modelNamePrefix: '', envKey: 'TEST_API_KEY' });
  /** A saved model under the provider's own env key. */
  const owned = (id: string, extra: Partial<ProviderModelConfig> = {}) => ({
    id,
    envKey: 'TEST_API_KEY',
    ...extra,
  });

  it('returns the user-saved models owned by the provider', () => {
    const result = findExistingProviderModels(config, {
      [AuthType.USE_OPENAI]: [
        owned('custom-model'),
        owned('default-model'),
        { id: 'other-provider-model', envKey: 'OTHER_API_KEY' },
      ],
    });
    expect(result).toEqual({
      protocol: AuthType.USE_OPENAI,
      models: [owned('custom-model'), owned('default-model')],
    });
  });

  it.each(['openai'])(
    'finds saved Responses models in the %s bucket',
    (bucket) => {
      const model = owned('responses-model', { wireApi: 'responses' });
      expect(findExistingProviderModels(config, { [bucket]: [model] })).toEqual(
        { protocol: AuthType.USE_OPENAI_RESPONSES, models: [model] },
      );
    },
  );

  it('returns undefined when no saved models are owned by the provider', () => {
    expect(
      findExistingProviderModels(config, {
        [AuthType.USE_OPENAI]: [{ id: 'x', envKey: 'OTHER_API_KEY' }],
      }),
    ).toBeUndefined();
  });

  it('returns undefined when modelProviders is empty or missing', () => {
    expect(findExistingProviderModels(config, {})).toBeUndefined();
    expect(findExistingProviderModels(config, undefined)).toBeUndefined();
  });

  it('returns undefined when ownership cannot be resolved (function envKey)', () => {
    const customConfig = makeConfig({
      envKey: () => 'DYNAMIC_KEY',
      modelNamePrefix: '',
    });
    expect(
      findExistingProviderModels(customConfig, {
        [AuthType.USE_OPENAI]: [{ id: 'x', envKey: 'DYNAMIC_KEY' }],
      }),
    ).toBeUndefined();
  });

  it('reports the current wire after a switch left both APIs in the bucket', () => {
    // A wire switch preserves the old route's entry and prepends the new one,
    // so the canonical bucket holds both; the answer must come from the most
    // recently installed entry, not a hard-coded chat-first preference.
    const baseUrl = 'https://proxy.example/v1';
    const responses = owned('same', { baseUrl, wireApi: 'responses' });
    const chat = owned('same', { baseUrl });
    expect(
      findExistingProviderModels(config, {
        [AuthType.USE_OPENAI]: [responses, chat],
      }),
    ).toEqual({ protocol: AuthType.USE_OPENAI_RESPONSES, models: [responses] });
  });

  it('skips entries whose api cannot be resolved instead of throwing', () => {
    expect(
      findExistingProviderModels(config, {
        [AuthType.USE_OPENAI]: [
          owned('broken', { wireApi: 'Responses' as 'responses' }),
          owned('good'),
        ],
        [AuthType.USE_GEMINI]: [
          owned('wrong-family', { wireApi: 'responses' }),
        ],
      }),
    ).toEqual({ protocol: AuthType.USE_OPENAI, models: [owned('good')] });
  });

  it('scans protocolOptions in order and picks the first with owned models', () => {
    const multiProtocol = makeConfig({
      modelNamePrefix: '',
      envKey: 'TEST_API_KEY',
      protocolOptions: [AuthType.USE_ANTHROPIC, AuthType.USE_OPENAI],
    });
    const result = findExistingProviderModels(multiProtocol, {
      [AuthType.USE_OPENAI]: [owned('openai-model')],
      [AuthType.USE_ANTHROPIC]: [owned('anthropic-model')],
    });
    expect(result?.protocol).toBe(AuthType.USE_ANTHROPIC);
    expect(result?.models.map((m) => m.id)).toEqual(['anthropic-model']);
  });
});

describe('shouldShowStep', () => {
  const show = (
    step: Parameters<typeof shouldShowStep>[1],
    overrides?: Partial<ProviderConfig>,
  ) => shouldShowStep(makeConfig(overrides), step);

  it('shows protocol step only when multiple options', () => {
    expect(show('protocol', { protocolOptions: [AuthType.USE_OPENAI] })).toBe(
      false,
    );
    expect(
      show('protocol', {
        protocolOptions: [AuthType.USE_OPENAI, AuthType.USE_ANTHROPIC],
      }),
    ).toBe(true);
  });

  it('shows baseUrl step when undefined or array', () => {
    expect(show('baseUrl', { baseUrl: undefined })).toBe(true);
    expect(
      show('baseUrl', {
        baseUrl: [{ id: 'a', label: 'A', url: 'https://a.com' }],
      }),
    ).toBe(true);
    expect(show('baseUrl', { baseUrl: 'https://fixed.com' })).toBe(false);
  });

  it('always shows the apiKey step', () => {
    expect(show('apiKey')).toBe(true);
  });

  it('shows models step only when editable or undefined', () => {
    expect(show('models', { models: undefined })).toBe(true);
    expect(show('models', { modelsEditable: true })).toBe(true);
    expect(show('models', { modelsEditable: false })).toBe(false);
  });

  it('shows advancedConfig step only when enabled', () => {
    expect(show('advancedConfig', { showAdvancedConfig: true })).toBe(true);
    expect(show('advancedConfig')).toBe(false);
  });
});

describe('providerMatchesCredentials', () => {
  it.each(['IMAGE', 'VOICE'])(
    'recognizes custom %s credentials only at their own endpoint',
    (purpose) => {
      const baseUrl = 'https://media.example/v1';
      const envKey = `${generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl)}_${purpose}`;
      expect(providerMatchesCredentials(customProvider, baseUrl, envKey)).toBe(
        true,
      );
      expect(
        providerMatchesCredentials(
          customProvider,
          'https://other.example/v1',
          envKey,
        ),
      ).toBe(false);
    },
  );

  it.each([
    [
      'matches by string envKey and string baseUrl',
      TEST_URL,
      'TEST_API_KEY',
      true,
    ],
    ['rejects mismatched envKey', TEST_URL, 'OTHER', false],
    ['rejects mismatched baseUrl', 'https://other.com', 'TEST_API_KEY', false],
  ])('%s', (_title, baseUrl, envKey, expected) => {
    expect(providerMatchesCredentials(makeConfig(), baseUrl, envKey)).toBe(
      expected,
    );
  });

  it('matches against BaseUrlOption array', () => {
    const config = makeConfig({ baseUrl: abUrls() });
    expect(
      providerMatchesCredentials(config, 'https://b.com', 'TEST_API_KEY'),
    ).toBe(true);
    expect(
      providerMatchesCredentials(config, 'https://c.com', 'TEST_API_KEY'),
    ).toBe(false);
  });

  it('matches when function-typed envKey derives a matching key', () => {
    // Previously asserted toBe(false) for a non-string envKey; the matcher now
    // resolves function-typed envKey so custom providers stay visible to
    // /doctor and AppHeader. Uses the relative source import (the dist-bypass
    // aliases below) so the behaviour is exercised before dist/ is rebuilt;
    // the 'providerMatchesCredentials with function envKey' suite below
    // covers protocol iteration.
    const config = makeConfig({ envKey: () => 'DYNAMIC' });
    expect(providerMatchesCredentialsSrc(config, TEST_URL, 'DYNAMIC')).toBe(
      true,
    );
  });
});

describe('computeModelListVersion', () => {
  it('produces consistent hashes', () => {
    const models = [{ id: 'a' }, { id: 'b' }];
    const v1 = computeModelListVersion(models);
    expect(v1).toBe(computeModelListVersion(models));
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
    const template = buildProviderTemplate(
      makeConfig({
        baseUrl: 'https://fixed.com',
        models: [{ id: 'x' }, { id: 'y' }],
      }),
    );
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
    expect(
      findProviderByCredentials('https://api.deepseek.com', 'DEEPSEEK_API_KEY')
        ?.id,
    ).toBe('deepseek');
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
    for (const url of [
      'https://coding.dashscope.aliyuncs.com/v1',
      'https://coding-intl.dashscope.aliyuncs.com/v1',
    ]) {
      expect(
        findProviderByCredentials(url, 'BAILIAN_CODING_PLAN_API_KEY')?.id,
      ).toBe('coding-plan');
    }
  });

  it('matches Token Plan credentials against both registered region URLs', () => {
    for (const url of [TOKEN_PLAN_CHINA_BASE_URL, TOKEN_PLAN_GLOBAL_BASE_URL]) {
      expect(findProviderByCredentialsSrc(url, TOKEN_PLAN_ENV_KEY)?.id).toBe(
        'token-plan',
      );
    }
  });
});

describe('getAllProviderBaseUrls', () => {
  it('returns a non-empty list including known preset URLs', () => {
    const urls = getAllProviderBaseUrlsSrc();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls).toContain('https://api.deepseek.com');
    expect(urls).toContain('https://openrouter.ai/api/v1');
  });

  it('expands BaseUrlOption[] presets into each option URL', () => {
    const urls = getAllProviderBaseUrlsSrc();
    // coding-plan has China + Singapore options
    expect(urls).toContain('https://coding.dashscope.aliyuncs.com/v1');
    expect(urls).toContain('https://coding-intl.dashscope.aliyuncs.com/v1');
    expect(urls).toContain(TOKEN_PLAN_CHINA_BASE_URL);
    expect(urls).toContain(TOKEN_PLAN_GLOBAL_BASE_URL);
  });
});

// The package-name imports above resolve to dist/, which lags the source on a
// branch that hasn't been built yet. Re-import via the relative source path so
// these new edge-case tests exercise the in-tree implementation.
import {
  findProviderByCredentials as findProviderByCredentialsSrc,
  getAllProviderBaseUrls as getAllProviderBaseUrlsSrc,
} from '../all-providers.js';
import {
  buildInstallPlan as buildInstallPlanSrc,
  resolveBaseUrl as resolveBaseUrlSrc,
  resolveMetadataKey as resolveMetadataKeySrc,
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
    for (const [selected, resolved] of [
      ['https://b.com/v1/', 'https://b.com/v1'],
      ['https://a.com/v1///', 'https://a.com/v1'],
      ['https://c.com/v1', 'https://c.com/v1/'],
    ]) {
      expect(resolveBaseUrlSrc(config, selected)).toBe(resolved);
    }
  });
});

describe('providerMatchesCredentials with function envKey (custom provider)', () => {
  // Custom provider derives envKey from (protocol, baseUrl) via a function.
  // Treating non-string envKey as "no match" made custom providers invisible
  // to findProviderByCredentials → /doctor and system-info diagnostics.
  const url = 'https://api.example.com/v1';
  /** A custom-like config with a user-picked baseUrl and derived envKey. */
  const derivedConfig = (
    envKey: ProviderConfig['envKey'],
    extra: Partial<ProviderConfig> = {},
  ) => makeConfig({ id: 'custom-like', envKey, baseUrl: undefined, ...extra });

  it('matches a custom-style provider whose envKey is a function deriving from baseUrl', () => {
    const derivedFor = (_protocol: AuthType, baseUrl: string) =>
      `QWEN_CUSTOM_${Buffer.from(baseUrl).toString('hex').slice(0, 8)}`;
    const config = derivedConfig(derivedFor);
    const expectedKey = derivedFor(AuthType.USE_OPENAI, url);
    expect(providerMatchesCredentialsSrc(config, url, expectedKey)).toBe(true);
  });

  it('does not match when the derived key differs from the supplied envKey', () => {
    const config = derivedConfig(
      (_protocol, baseUrl) => `QWEN_CUSTOM_${baseUrl.length}`,
    );
    expect(providerMatchesCredentialsSrc(config, url, 'WRONG_ENV_KEY')).toBe(
      false,
    );
  });

  it('returns false (not crash) when the function envKey itself throws', () => {
    const config = derivedConfig(() => {
      throw new Error('boom');
    });
    expect(providerMatchesCredentialsSrc(config, url, 'ANY')).toBe(false);
  });

  it('iterates protocolOptions and matches when any one derives the env key', () => {
    // buildInstallPlan derives the persisted env key from inputs.protocol
    // (possibly USE_ANTHROPIC or USE_GEMINI for a custom provider), not from
    // config.protocol (default USE_OPENAI). The matcher must try every
    // protocolOption so such a provider is matched back from the on-disk
    // envKey.
    const derivedFor = (protocol: AuthType, baseUrl: string) =>
      `QWEN_CUSTOM_${protocol.toUpperCase()}_${baseUrl.length}`;
    const config = derivedConfig(derivedFor, {
      protocolOptions: [
        AuthType.USE_OPENAI,
        AuthType.USE_ANTHROPIC,
        AuthType.USE_GEMINI,
      ],
    });
    // User picked Anthropic at install time; the Gemini path also matches.
    for (const protocol of [AuthType.USE_ANTHROPIC, AuthType.USE_GEMINI]) {
      expect(
        providerMatchesCredentialsSrc(config, url, derivedFor(protocol, url)),
      ).toBe(true);
    }
  });
});

describe('customHeaders in ProviderConfig', () => {
  const headersOf = (config: ProviderConfig, inputs: ProviderSetupInputs) =>
    installModels(config, inputs)[0]?.generationConfig?.customHeaders;

  it('merges customHeaders into generationConfig for fixed models', () => {
    const customHeaders = {
      'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
      'X-Title': 'Qwen Code',
    };
    const gc = installModels(makeConfig({ customHeaders }), testInputs())[0]
      ?.generationConfig;
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
    expect(headersOf(config, testInputs(['unknown-model']))).toEqual({
      'X-Custom': 'val',
    });
  });

  it('merges customHeaders for custom-provider models (no predefined list)', () => {
    const config = customLike({
      customHeaders: { Authorization: 'Bearer test' },
    });
    expect(headersOf(config, customInputs(['my-model']))).toEqual({
      Authorization: 'Bearer test',
    });
  });

  it('does not add generationConfig when customHeaders is absent', () => {
    const models = installModels(
      makeConfig({ models: [{ id: 'plain' }] }),
      testInputs(['plain']),
    );
    expect(models[0]?.generationConfig).toBeUndefined();
  });

  it('applies customHeaders to every model in the list', () => {
    const config = makeConfig({
      models: [{ id: 'a' }, { id: 'b' }],
      customHeaders: { 'X-Test': 'yes' },
    });
    const models = installModels(config, testInputs(['a', 'b']));
    expect(models).toHaveLength(2);
    for (const model of models) {
      expect(model.generationConfig?.customHeaders).toEqual({
        'X-Test': 'yes',
      });
    }
  });

  it('includes customHeaders in buildProviderTemplate', () => {
    const config = makeConfig({
      models: [{ id: 'x' }],
      customHeaders: { 'X-Template': 'val' },
    });
    expect(
      buildProviderTemplate(config)[0]?.generationConfig?.customHeaders,
    ).toEqual({ 'X-Template': 'val' });
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

describe('output budget key written by the installer', () => {
  // The provider-setup "Max output tokens" field becomes a samplingParams
  // entry, and samplingParams passes through to the wire verbatim, so on
  // Chat Completions it has to use the key the model family accepts (GPT-5 /
  // o-series reject `max_tokens`, #16343). The Responses wire reads
  // `max_tokens` and maps it to `max_output_tokens`, so it keeps that key.
  const budgetsOf = (
    modelIds: string[],
    extra: Partial<ProviderSetupInputs> = {},
  ) =>
    modelsOf(
      buildInstallPlanSrc(customProvider, {
        ...customInputs(modelIds),
        protocol: AuthType.USE_OPENAI,
        advancedConfig: { maxTokens: 32000 },
        ...extra,
      }),
    ).map((model) => model.generationConfig?.samplingParams);

  it('writes max_completion_tokens for GPT-5 / o-series ids on Chat Completions and max_tokens for the rest', () => {
    expect(
      budgetsOf(['openai.gpt-5.5', 'o3', 'gpt-4.1', 'xai.grok-4.3']),
    ).toEqual([
      { max_completion_tokens: 32000 },
      { max_completion_tokens: 32000 },
      { max_tokens: 32000 },
      { max_tokens: 32000 },
    ]);
  });

  it('keeps max_tokens for every family on the Responses wire', () => {
    expect(
      budgetsOf(['openai.gpt-5.5', 'gpt-4.1'], { wireApi: 'responses' }),
    ).toEqual([{ max_tokens: 32000 }, { max_tokens: 32000 }]);
  });

  it('clears an installed max_completion_tokens on replaceExisting like max_tokens', () => {
    const inputs = {
      ...customInputs(['openai.gpt-5.5']),
      protocol: AuthType.USE_OPENAI,
    };
    const existing = modelsOf(
      buildInstallPlanSrc(customProvider, {
        ...inputs,
        advancedConfig: { maxTokens: 32000 },
      }),
    );
    expect(existing[0]!.generationConfig?.samplingParams).toEqual({
      max_completion_tokens: 32000,
    });
    const cleared = modelsOf(
      buildInstallPlanSrc(
        customProvider,
        { ...inputs, advancedConfig: { replaceExisting: true } },
        existing,
      ),
    )[0]!;
    expect(cleared.generationConfig?.samplingParams).toBeUndefined();
  });

  it('replaces an older max_tokens budget on re-install without replaceExisting instead of keeping both keys', () => {
    // An entry an earlier installer wrote as `max_tokens` for a GPT-5 id must
    // not come out of a plain re-run as `{ max_tokens, max_completion_tokens }`:
    // the pipeline would keep `max_tokens` as the wire key and the endpoint
    // would still reject it. Only the budget key is swapped; the other
    // preserved samplingParams stay.
    const inputs = {
      ...customInputs(['openai.gpt-5.5']),
      protocol: AuthType.USE_OPENAI,
    };
    const existing = modelsOf(
      buildInstallPlanSrc(customProvider, {
        ...inputs,
        advancedConfig: { maxTokens: 32000 },
      }),
    );
    existing[0]!.generationConfig!.samplingParams = {
      max_tokens: 32000,
      temperature: 0.2,
    };
    const rerun = (
      advancedConfig: NonNullable<ProviderSetupInputs['advancedConfig']>,
    ) =>
      modelsOf(
        buildInstallPlanSrc(
          customProvider,
          { ...inputs, advancedConfig },
          existing,
        ),
      )[0]!.generationConfig?.samplingParams;
    expect(rerun({ maxTokens: 32000 })).toEqual({
      temperature: 0.2,
      max_completion_tokens: 32000,
    });
    // No new budget submitted: the stale key is still migrated, since the
    // pipeline forwards an explicit `max_tokens` verbatim and the endpoint
    // would keep rejecting it. The other preserved knobs stay.
    expect(rerun({})).toEqual({
      temperature: 0.2,
      max_completion_tokens: 32000,
    });
  });

  it('migrates a preserved max_tokens onto max_completion_tokens for a GPT-5 id on a plain re-run', () => {
    // A plain re-run of provider setup passes no advancedConfig at all; an
    // entry an earlier build persisted as `max_tokens` must still come out
    // repaired, not pinned.
    const inputs = {
      ...customInputs(['openai.gpt-5.5']),
      protocol: AuthType.USE_OPENAI,
    };
    const existing = modelsOf(buildInstallPlanSrc(customProvider, inputs));
    existing[0]!.generationConfig = {
      samplingParams: { max_tokens: 32000, temperature: 0.2 },
    };
    const refreshed = modelsOf(
      buildInstallPlanSrc(customProvider, inputs, existing),
    )[0]!;
    expect(refreshed.generationConfig?.samplingParams).toEqual({
      temperature: 0.2,
      max_completion_tokens: 32000,
    });
  });

  it('leaves a preserved budget alone when the endpoint accepts its key', () => {
    const budgetAfterRerun = (
      modelId: string,
      samplingParams: Record<string, unknown>,
      extra: Partial<ProviderSetupInputs> = {},
    ) => {
      const inputs = {
        ...customInputs([modelId]),
        protocol: AuthType.USE_OPENAI,
        ...extra,
      };
      const existing = modelsOf(buildInstallPlanSrc(customProvider, inputs));
      existing[0]!.generationConfig = { samplingParams };
      return modelsOf(buildInstallPlanSrc(customProvider, inputs, existing))[0]!
        .generationConfig?.samplingParams;
    };
    // GPT-4.1 reads either key: a hand-written max_completion_tokens stays.
    expect(
      budgetAfterRerun('gpt-4.1', { max_completion_tokens: 4096 }),
    ).toEqual({ max_completion_tokens: 4096 });
    // max_tokens is the right key for every other family.
    expect(budgetAfterRerun('xai.grok-4.3', { max_tokens: 4096 })).toEqual({
      max_tokens: 4096,
    });
    // The Responses wire translates max_tokens itself; nothing to migrate.
    expect(
      budgetAfterRerun(
        'openai.gpt-5.5',
        { max_tokens: 4096 },
        { wireApi: 'responses' },
      ),
    ).toEqual({ max_tokens: 4096 });
    // A pair is never produced: a stale max_tokens next to an existing
    // max_completion_tokens is not re-keyed on top of it.
    expect(
      budgetAfterRerun('openai.gpt-5.5', {
        max_tokens: 1000,
        max_completion_tokens: 4096,
      }),
    ).toEqual({ max_tokens: 1000, max_completion_tokens: 4096 });
  });

  it('replaces a preserved family key with a new max_tokens value on a model that reads max_tokens', () => {
    // The "new budget replaces the preserved keys" guard, in the shape the
    // stale-key migration does not cover: the migration only moves
    // `max_tokens` onto `max_completion_tokens` for GPT-5 / o-series ids, so
    // a preserved `max_completion_tokens` (or `max_new_tokens`) on gpt-4.1
    // plus a new value relies on the guard alone. Without it the entry
    // would come out as `{ max_completion_tokens: 4096, max_tokens: 8000 }`,
    // the pair the endpoint rejects.
    const inputs = {
      ...customInputs(['gpt-4.1']),
      protocol: AuthType.USE_OPENAI,
    };
    const rerunOver = (samplingParams: Record<string, unknown>) => {
      const existing = modelsOf(buildInstallPlanSrc(customProvider, inputs));
      existing[0]!.generationConfig = { samplingParams };
      return modelsOf(
        buildInstallPlanSrc(
          customProvider,
          { ...inputs, advancedConfig: { maxTokens: 8000 } },
          existing,
        ),
      )[0]!.generationConfig?.samplingParams;
    };
    expect(
      rerunOver({ max_completion_tokens: 4096, temperature: 0.2 }),
    ).toEqual({ temperature: 0.2, max_tokens: 8000 });
    expect(rerunOver({ max_new_tokens: 2048 })).toEqual({ max_tokens: 8000 });
  });
});
