/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '../../core/contentGenerator.js';
import type { ModelConfig, ModelProvidersConfig } from '../../models/types.js';
import {
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  generateCustomEnvKey,
  minimaxProvider,
  ProviderInstallError,
  type ProviderConfig,
  type ProviderInstallPlan,
  type ProviderModelProvidersPatch,
  type ProviderSettingsAdapter,
  type ProviderSetupInputs,
} from '../index.js';

function createAdapter(
  modelProviders: ModelProvidersConfig = {},
  values?: Record<string, unknown>,
) {
  let snapshot = modelProviders;
  return {
    getValue: vi.fn((key: string) => values?.[key]),
    setValue: vi.fn((key: string, value: unknown) => {
      if (key.startsWith('modelProviders.'))
        modelProviders = {
          ...modelProviders,
          [key.slice('modelProviders.'.length)]:
            value as ModelProvidersConfig[string],
        };
    }),
    getModelProviders: vi.fn(() => modelProviders),
    persist: vi.fn(),
    backup: vi.fn(() => {
      snapshot = modelProviders;
    }),
    restore: vi.fn(() => {
      modelProviders = snapshot;
    }),
    cleanupBackup: vi.fn(),
  } satisfies ProviderSettingsAdapter;
}

type Adapter = ReturnType<typeof createAdapter>;
type Deps = Omit<Parameters<typeof applyProviderInstallPlan>[1], 'settings'>;

const MEDIA = 'https://media.example/v1';
const MINIMAX = 'https://api.minimax.io/v1';
const DASHSCOPE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const GATEWAY = 'https://gateway.test/v1';
const IMAGE = { imageOnly: true, supportsImageGeneration: true };

/** The install writes process.env directly; afterEach unstubs these keys. */
function preserveEnv(...keys: string[]) {
  for (const key of keys) vi.stubEnv(key, process.env[key]);
}

function makePlan(
  overrides: Partial<ProviderInstallPlan> = {},
): ProviderInstallPlan {
  return {
    providerId: 'test-provider',
    authType: AuthType.USE_OPENAI,
    ...overrides,
  };
}

/** A plan carrying one modelProviders patch (openai, prepend-and-remove-owned). */
function modelsPlan(
  models: ModelConfig[],
  patch: Partial<ProviderModelProvidersPatch> = {},
  overrides: Partial<ProviderInstallPlan> = {},
): ProviderInstallPlan {
  return makePlan({
    modelProviders: [
      {
        authType: AuthType.USE_OPENAI,
        models,
        mergeStrategy: 'prepend-and-remove-owned',
        ...patch,
      },
    ],
    ...overrides,
  });
}

/** A custom-provider plan (media endpoint by default); `existing` is the reconnect's list. */
const customPlan = (
  inputs: Partial<ProviderSetupInputs> & Pick<ProviderSetupInputs, 'modelIds'>,
  existing?: Parameters<typeof buildInstallPlan>[2],
) =>
  buildInstallPlan(
    customProvider,
    { baseUrl: MEDIA, apiKey: 'test-only', ...inputs },
    existing,
  );

/** A MiniMax preset plan, at the international endpoint by default. */
const minimaxPlan = (
  modelIds: string[],
  inputs: Partial<ProviderSetupInputs> = {},
) =>
  buildInstallPlan(minimaxProvider, {
    baseUrl: MINIMAX,
    apiKey: 'test-only',
    modelIds,
    ...inputs,
  });

const minimaxModel = (
  id: string,
  name: string,
  extra: Partial<ModelConfig> = {},
) => ({ id, name, baseUrl: MINIMAX, envKey: 'MINIMAX_API_KEY', ...extra });

/** qwen3-asr-flash already installed as a voice model at the first endpoint. */
const firstVoice = (): ModelConfig => ({
  id: 'qwen3-asr-flash',
  baseUrl: 'https://first.example/v1',
  voiceOnly: true,
  envKey: 'FIRST',
});

/** Connects qwen3-asr-flash at `baseUrl` with a throwaway key. */
const asrPlan = (
  baseUrl: string,
  advancedConfig?: ProviderSetupInputs['advancedConfig'],
) =>
  customPlan({
    baseUrl,
    apiKey: 'unused',
    modelIds: ['qwen3-asr-flash'],
    ...(advancedConfig && { advancedConfig }),
  });

const planModels = (plan: ProviderInstallPlan) =>
  plan.modelProviders![0]!.models;

const rejecting = (message: string) =>
  vi.fn(async () => {
    throw new Error(message);
  });

/** Applies `plan` to `settings` (a fresh adapter by default). */
const apply = (
  plan: ProviderInstallPlan,
  settings: ProviderSettingsAdapter = createAdapter(),
  deps: Deps = {},
) => applyProviderInstallPlan(plan, { settings, ...deps });

const rejectsPurpose = (
  plan: ProviderInstallPlan,
  settings: Adapter,
  deps: Deps = {},
) =>
  expect(apply(plan, settings, deps)).rejects.toMatchObject({
    step: 'modelPurpose',
  });

/** Applies `plan` with a refreshAuth rejecting `message`; asserts the rethrow. */
const failRefresh = (
  plan: ProviderInstallPlan,
  settings: Adapter,
  message: string,
  deps: Deps = {},
) =>
  expect(
    apply(plan, settings, { refreshAuth: rejecting(message), ...deps }),
  ).rejects.toThrow(message);

function expectNothingWritten(adapter: Adapter) {
  expect(adapter.setValue).not.toHaveBeenCalled();
  expect(adapter.backup).not.toHaveBeenCalled();
  expect(adapter.persist).not.toHaveBeenCalled();
}

/** One setValue assertion per `key: value` entry. */
function expectSet(adapter: Adapter, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values))
    expect(adapter.setValue).toHaveBeenCalledWith(key, value);
}

function expectNotSet(adapter: Adapter, ...keys: string[]) {
  for (const key of keys)
    expect(adapter.setValue).not.toHaveBeenCalledWith(key, expect.anything());
}

async function expectMerged(
  existing: ModelConfig[],
  plan: ProviderInstallPlan,
  merged: ModelConfig[],
) {
  const adapter = createAdapter({ openai: existing });
  await apply(plan, adapter);
  expectSet(adapter, { 'modelProviders.openai': merged });
}

/** Installs `models` on the Responses route while OpenAI `current` is selected at the gateway. */
async function installResponses(
  providers: ModelProvidersConfig,
  current: string,
  models: ModelConfig[],
  modelId: string,
  patch?: Partial<ProviderModelProvidersPatch>,
) {
  const adapter = createAdapter(providers, {
    'security.auth.selectedType': AuthType.USE_OPENAI,
    'model.name': current,
    'model.baseUrl': GATEWAY,
  });
  const syncAuthState = vi.fn();
  await apply(
    modelsPlan(models, patch, {
      authType: AuthType.USE_OPENAI_RESPONSES,
      modelSelection: { modelId, baseUrl: GATEWAY },
    }),
    adapter,
    { syncAuthState },
  );
  return { adapter, syncAuthState };
}

/** Settings holding an OpenAI-routed `idealab` bucket with an invalid `wireApi`. */
const idealabAdapter = (
  providers: ModelProvidersConfig = {},
  values: Record<string, unknown> = {},
) =>
  createAdapter(
    {
      idealab: [
        { id: 'q1', envKey: 'A', wireApi: 'resp' as ModelConfig['wireApi'] },
      ],
      ...providers,
    },
    {
      'security.auth.selectedType': AuthType.USE_OPENAI,
      providerProtocol: { idealab: 'openai' },
      ...values,
    },
  );

describe('applyProviderInstallPlan', () => {
  it('rolls back a provider write shadowed by a higher-precedence scope before selecting it', async () => {
    const original = { openai: [{ id: 'workspace-chat' }] };
    const adapter = createAdapter(original);
    vi.mocked(adapter.getModelProviders).mockReturnValue(original);
    const plan = modelsPlan(
      [{ id: 'new-user-model' }],
      { mergeStrategy: 'append' },
      { modelSelection: { modelId: 'new-user-model' } },
    );
    const reload = vi.fn();
    await expect(
      apply(plan, adapter, { reloadModelProviders: reload }),
    ).rejects.toMatchObject({ step: 'modelProviders' });
    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'workspace-chat' },
      { id: 'new-user-model' },
    ]);
    expectNotSet(adapter, 'model.name', 'security.auth.selectedType');
    expect(adapter.restore).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledExactlyOnceWith(original);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['TEST_API_KEY'];
    delete process.env['BRAND_NEW_KEY'];
    delete process.env['SHADOW_KEY'];
    delete process.env['EMPTY_SHADOW_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(['image', 'voice'] as const)(
    'rejects a slash-varied %s reconnect before it can overwrite conversation credentials',
    async (purpose) => {
      const chatKey = generateCustomEnvKey(AuthType.USE_OPENAI, MEDIA);
      const serviceKey = `${chatKey}_${purpose.toUpperCase()}`;
      const models = [
        { id: 'chat', baseUrl: MEDIA, envKey: chatKey },
        {
          id: 'service',
          baseUrl: `${MEDIA}/`,
          envKey: serviceKey,
          ...(purpose === 'image' ? { imageOnly: true } : { voiceOnly: true }),
          generationConfig: { contextWindowSize: 65536 },
        },
      ];
      const adapter = createAdapter({ openai: models });
      vi.stubEnv(chatKey, 'chat-old');
      vi.stubEnv(serviceKey, 'service-old');
      const inputs = { protocol: AuthType.USE_OPENAI, apiKey: 'service-new' };
      await expect(
        (async () =>
          apply(
            customPlan({ ...inputs, modelIds: ['service'] }, models),
            adapter,
          ))(),
      ).rejects.toMatchObject({ step: 'modelPurpose' });
      expect(adapter.setValue).not.toHaveBeenCalled();
      expect(process.env[chatKey]).toBe('chat-old');
      expect(process.env[serviceKey]).toBe('service-old');
      expect(adapter.getModelProviders()).toEqual({ openai: models });
    },
  );

  it.each(['image', 'voice'] as const)(
    'installs %s models without changing conversation selection',
    async (purpose) => {
      const adapter = createAdapter({ anthropic: [{ id: 'main' }] });
      const plan = customPlan({
        protocol: AuthType.USE_OPENAI,
        modelIds: [purpose === 'voice' ? 'qwen3-asr-flash' : 'image-01'],
        advancedConfig: { purpose, contextWindowSize: 65536 },
      });
      preserveEnv(Object.keys(plan.env!)[0]!);
      const refreshAuth = vi.fn();
      const syncAuthState = vi.fn();
      expect(plan.modelSelection).toBeUndefined();
      const result = await apply(plan, adapter, { refreshAuth, syncAuthState });
      expect(result.updatedModelProviders['openai']?.[0]).toMatchObject({
        ...(purpose === 'image' ? IMAGE : { voiceOnly: true }),
        generationConfig: { contextWindowSize: 65536 },
      });
      expect(result.updatedModelProviders['anthropic']).toEqual([
        { id: 'main' },
      ]);
      expect(
        adapter.setValue.mock.calls.some(
          ([key]) =>
            key === 'security.auth.selectedType' ||
            key === 'model.name' ||
            key === 'model.baseUrl',
        ),
      ).toBe(false);
      expect(refreshAuth).not.toHaveBeenCalled();
      expect(syncAuthState).not.toHaveBeenCalled();
      expect(adapter.persist).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'installs beside null provider buckets (target null: %s)',
    async (targetNull) => {
      const providers = {
        openai: targetNull ? null : [],
        gemini: null,
      } as unknown as ModelProvidersConfig;
      const plan = customPlan(
        {
          baseUrl: 'https://new.example/v1',
          apiKey: 'test',
          modelIds: ['chat'],
        },
        providers['openai'],
      );
      preserveEnv(Object.keys(plan.env!)[0]!);
      const result = await apply(plan, createAdapter(providers));
      expect(result.updatedModelProviders['openai']).toEqual([
        expect.objectContaining({ id: 'chat' }),
      ]);
      expect(result.updatedModelProviders['gemini']).toBeNull();
    },
  );

  it('replaces a same-identity custom image route with the preset credential', async () => {
    const adapter = createAdapter({
      openai: [
        {
          id: 'image-01',
          baseUrl: MINIMAX,
          envKey: `${generateCustomEnvKey(AuthType.USE_OPENAI, MINIMAX)}_IMAGE`,
          ...IMAGE,
        },
      ],
    });
    const plan = minimaxPlan(['image-01'], { apiKey: 'test-preset-key' });
    preserveEnv('MINIMAX_API_KEY');
    const result = await apply(plan, adapter);
    expect(result.updatedModelProviders['openai']).toEqual([
      expect.objectContaining({
        id: 'image-01',
        baseUrl: MINIMAX,
        envKey: 'MINIMAX_API_KEY',
        imageOnly: true,
      }),
    ]);
  });

  it.each([undefined, 'voice'] as const)(
    'rejects a second endpoint for an existing voice ID before writing (%s)',
    async (purpose) => {
      const adapter = createAdapter({ openai: [firstVoice()] });
      const plan = asrPlan('https://second.example/v1', purpose && { purpose });
      await rejectsPurpose(plan, adapter);
      expectNothingWritten(adapter);
    },
  );

  it.each(['image', 'voice'] as const)(
    'reconnects a mixed provider without losing the %s configuration or independent key',
    async (purpose) => {
      const [service] = planModels(
        customPlan({
          apiKey: 'old-service',
          modelIds: ['service'],
          advancedConfig: { purpose, contextWindowSize: 65536 },
        }),
      );
      const chatKey = generateCustomEnvKey(AuthType.USE_OPENAI, MEDIA);
      const existing = [
        { id: 'chat', baseUrl: MEDIA, envKey: chatKey },
        {
          ...service!,
          name: 'My service',
          generationConfig: {
            ...service!.generationConfig,
            customHeaders: { 'X-Test': 'preserved' },
          },
        },
      ];
      const plan = customPlan(
        { apiKey: 'new-chat', modelIds: ['chat', 'service'] },
        existing,
      );
      preserveEnv(chatKey);
      expect(plan.env).toEqual({ [chatKey]: 'new-chat' });
      const result = await apply(plan, createAdapter({ openai: existing }));
      expect(
        result.updatedModelProviders['openai']?.find(
          (model) => model.id === 'service',
        ),
      ).toEqual(existing[1]);
      expect(plan.modelSelection?.modelId).toBe('chat');
    },
  );

  it('rotates the key of a realtime-only provider without touching the conversation selection', async () => {
    const envKey = `${generateCustomEnvKey(AuthType.USE_OPENAI, DASHSCOPE)}_REALTIME`;
    const existing = [
      { id: 'omni-realtime', baseUrl: DASHSCOPE, envKey, realtimeOnly: true },
    ];
    const plan = customPlan(
      { baseUrl: DASHSCOPE, apiKey: 'rotated', modelIds: ['omni-realtime'] },
      existing,
    );
    expect(plan.env).toEqual({ [envKey]: 'rotated' });
    expect(planModels(plan)).toEqual([
      expect.objectContaining({ id: 'omni-realtime', realtimeOnly: true }),
    ]);
    expect(plan.modelSelection).toBeUndefined();

    const adapter = createAdapter({ openai: existing });
    const refreshAuth = vi.fn();
    preserveEnv(envKey);
    await apply(plan, adapter, { refreshAuth });
    // A service-role reconnect must not re-point the chat session.
    expectNotSet(adapter, 'security.auth.selectedType', 'model.name');
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it('refuses a realtime reconnect that would land on another route’s credential key', () => {
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, DASHSCOPE);
    expect(() =>
      customPlan(
        { baseUrl: DASHSCOPE, apiKey: 'new', modelIds: ['omni-realtime'] },
        [
          {
            id: 'omni-realtime',
            baseUrl: `${DASHSCOPE}/`,
            envKey,
            realtimeOnly: true,
          },
        ],
      ),
    ).toThrow('A service model already uses this credential endpoint');
  });

  it.each(['image', 'voice'] as const)(
    'rekeys a purpose-less %s reconnect at the original credential key',
    (purpose) => {
      const originalModels = planModels(
        customPlan({
          apiKey: 'old',
          modelIds: ['service'],
          advancedConfig: { purpose },
        }),
      );
      const reconnect = customPlan(
        { apiKey: 'new', modelIds: ['service'] },
        originalModels,
      );
      expect(reconnect.env).toEqual({ [originalModels[0]!.envKey!]: 'new' });
      expect(planModels(reconnect)).toEqual(originalModels);
      expect(reconnect.modelSelection).toBeUndefined();
    },
  );

  it('rejects a single credential update for independently keyed image and voice models', () => {
    const existing = (['image', 'voice'] as const).flatMap((purpose) =>
      planModels(
        customPlan({
          apiKey: 'unused',
          modelIds: [purpose],
          advancedConfig: { purpose },
        }),
      ),
    );
    expect(() =>
      customPlan({ apiKey: 'unused', modelIds: ['image', 'voice'] }, existing),
    ).toThrow('separately');
  });

  it.each([
    ['chat', 'image'],
    ['chat', 'voice'],
    ['image', 'chat'],
    ['voice', 'chat'],
    ['image', 'voice'],
    ['voice', 'image'],
  ] as const)(
    'rejects changing the same model identity from %s to %s before any write',
    async (from, to) => {
      const existing: ModelProvidersConfig = {
        openai: [
          {
            id: 'main',
            baseUrl: MEDIA,
            ...(from === 'image' ? { imageOnly: true } : {}),
            ...(from === 'voice' ? { voiceOnly: true } : {}),
          },
        ],
      };
      const snapshot = structuredClone(existing);
      const adapter = createAdapter(existing);
      process.env['TEST_API_KEY'] = 'unchanged';
      const plan = customPlan({
        protocol: AuthType.USE_OPENAI,
        modelIds: ['main'],
        ...(to === 'chat' ? {} : { advancedConfig: { purpose: to } }),
      });
      plan.env = { TEST_API_KEY: 'must-not-write' };
      const reloadModelProviders = vi.fn();
      await expect(
        apply(plan, adapter, { reloadModelProviders }),
      ).rejects.toMatchObject({
        name: 'ProviderInstallError',
        step: 'modelPurpose',
        authType: AuthType.USE_OPENAI,
      });
      expectNothingWritten(adapter);
      expect(reloadModelProviders).not.toHaveBeenCalled();
      expect(process.env['TEST_API_KEY']).toBe('unchanged');
      expect(existing).toEqual(snapshot);
    },
  );

  it('rejects a service preset that would remove an owned conversation model', async () => {
    const conversation = minimaxModel('MiniMax-M2.7', '[MiniMax] MiniMax-M2.7');
    const adapter = createAdapter({ openai: [conversation] });
    const plan = minimaxPlan(['image-01'], { apiKey: 'must-not-write' });
    vi.stubEnv('MINIMAX_API_KEY', 'chat-secret');
    expect(plan.modelSelection).toBeUndefined();
    expect(plan.modelProviders?.[0]?.ownsModel?.(conversation)).toBe(true);
    await rejectsPurpose(plan, adapter);
    expectNothingWritten(adapter);
    expect(adapter.getModelProviders()).toEqual({ openai: [conversation] });
    expect(process.env['MINIMAX_API_KEY']).toBe('chat-secret');
  });

  it.each(['image', 'voice', 'mixed'] as const)(
    'rejects a conversation preset that would remove an owned service model (%s)',
    async (purpose) => {
      const service = minimaxModel(
        purpose === 'voice' ? 'qwen3-asr-flash' : 'image-01',
        '[MiniMax] service',
        purpose === 'voice' ? { voiceOnly: true } : IMAGE,
      );
      const adapter = createAdapter({ openai: [service] });
      const plan = minimaxPlan(
        purpose === 'mixed'
          ? ['MiniMax-M2.7', 'image-01-live']
          : ['MiniMax-M2.7'],
        { apiKey: 'must-not-write' },
      );
      vi.stubEnv('MINIMAX_API_KEY', 'service-secret');
      const reloadModelProviders = vi.fn();
      expect(plan.modelProviders?.[0]?.ownsModel?.(service)).toBe(true);
      await rejectsPurpose(plan, adapter, { reloadModelProviders });
      expectNothingWritten(adapter);
      expect(reloadModelProviders).not.toHaveBeenCalled();
      expect(adapter.getModelProviders()).toEqual({ openai: [service] });
      expect(process.env['MINIMAX_API_KEY']).toBe('service-secret');
    },
  );

  it.each(['conversation', 'service'] as const)(
    'does not reject a %s preset over an owned model in a sibling route bucket it never rewrites',
    async (installs) => {
      // The other purpose's owned model lives in a user-named bucket that only
      // resolves to the same protocol. The install rewrites only
      // `modelProviders.openai`, so nothing can drop it: no guard may fire.
      const sibling =
        installs === 'conversation'
          ? minimaxModel('image-01', '[MiniMax] service', IMAGE)
          : minimaxModel('MiniMax-M2.7', '[MiniMax] MiniMax-M2.7');
      const adapter = createAdapter(
        { myrouter: [sibling], openai: [] },
        { providerProtocol: { myrouter: 'openai' } },
      );
      const plan = minimaxPlan(
        installs === 'conversation' ? ['MiniMax-M2.7'] : ['image-01'],
      );
      delete plan.env;
      expect(plan.modelProviders?.[0]?.ownsModel?.(sibling)).toBe(true);
      const result = await apply(plan, adapter);
      expect(adapter.getModelProviders()).toEqual({
        myrouter: [sibling],
        openai: planModels(plan),
      });
      expect(result.updatedModelProviders).toEqual(adapter.getModelProviders());
      expectNotSet(adapter, 'modelProviders.myrouter');
      expect(adapter.persist).toHaveBeenCalledOnce();
    },
  );

  it('still rejects a purpose change for the same identity in a sibling Responses bucket', async () => {
    // Unlike the removal guards, the purpose-change guard stays route-aware:
    // the legacy-bucket cleanup deletes an identity match from any bucket on
    // the Responses route, so replacing an image model there is a real removal.
    const existing: ModelProvidersConfig = {
      myrouter: [{ id: 'main', baseUrl: MEDIA, imageOnly: true }],
      openai: [],
    };
    const snapshot = structuredClone(existing);
    const adapter = createAdapter(existing, {
      providerProtocol: { myrouter: 'openai-responses' },
    });
    const plan = customPlan({
      protocol: AuthType.USE_OPENAI,
      wireApi: 'responses',
      modelIds: ['main'],
    });
    plan.env = { TEST_API_KEY: 'must-not-write' };
    await expect(apply(plan, adapter)).rejects.toMatchObject({
      step: 'modelPurpose',
      message: expect.stringContaining('another purpose'),
    });
    expectNothingWritten(adapter);
    expect(process.env['TEST_API_KEY']).toBeUndefined();
    expect(existing).toEqual(snapshot);
  });

  it.each(['append-chat', 'reselect-service', 'reselect-chat'] as const)(
    'preserves intentional preset merge behavior (%s)',
    async (scenario) => {
      const existing = minimaxModel(
        scenario === 'reselect-chat' ? 'MiniMax-M2.7' : 'image-01',
        '[MiniMax] existing',
        scenario === 'reselect-chat' ? {} : IMAGE,
      );
      const plan = minimaxPlan([
        scenario === 'reselect-service'
          ? 'image-01-live'
          : 'MiniMax-M2.7-highspeed',
      ]);
      if (scenario === 'append-chat')
        plan.modelProviders![0]!.mergeStrategy = 'append';
      delete plan.env;
      const result = await apply(plan, createAdapter({ openai: [existing] }));
      expect(result.updatedModelProviders['openai']).toEqual([
        ...(scenario === 'append-chat' ? [existing] : []),
        ...planModels(plan),
      ]);
    },
  );

  it.each([MINIMAX, 'https://api.minimaxi.com/v1'])(
    'reinstalls owned conversation and image models at %s',
    async (baseUrl) => {
      const modelIds = ['MiniMax-M2.7', 'image-01'];
      const existing = planModels(minimaxPlan(modelIds));
      const foreign = { id: 'foreign', envKey: 'OTHER_KEY' };
      const adapter = createAdapter({ openai: [...existing, foreign] });
      const plan = minimaxPlan(modelIds, { baseUrl });
      delete plan.env;
      const reloadModelProviders = vi.fn();
      const result = await apply(plan, adapter, { reloadModelProviders });
      const models = result.updatedModelProviders['openai']!;
      expect(models).toHaveLength(3);
      expect(models).toContainEqual(foreign);
      expect(models).toContainEqual(
        expect.objectContaining({ id: 'MiniMax-M2.7', baseUrl }),
      );
      expect(models).toContainEqual(
        expect.objectContaining({
          id: 'image-01',
          baseUrl,
          imageOnly: true,
          envKey: 'MINIMAX_API_KEY',
        }),
      );
      expect(adapter.persist).toHaveBeenCalledOnce();
      expect(reloadModelProviders).toHaveBeenCalledExactlyOnceWith(
        result.updatedModelProviders,
      );
    },
  );

  it.each(['chat', 'voice'] as const)(
    'rejects migrating an owned image model to %s at a different endpoint before writing',
    async (purpose) => {
      const service = minimaxModel('image-01', '[MiniMax] image-01', IMAGE);
      const adapter = createAdapter({ openai: [service] });
      const plan = minimaxPlan(['MiniMax-M2.7', service.id], {
        baseUrl: 'https://api.minimaxi.com/v1',
      });
      const replacement = planModels(plan)[1]!;
      replacement.imageOnly = false;
      replacement.voiceOnly = purpose === 'voice';
      replacement.supportsImageGeneration = false;
      plan.env = { TEST_API_KEY: 'must-not-write' };
      process.env['TEST_API_KEY'] = 'unchanged';
      await rejectsPurpose(plan, adapter);
      expect(adapter.getModelProviders()).toEqual({ openai: [service] });
      expectNothingWritten(adapter);
      expect(process.env['TEST_API_KEY']).toBe('unchanged');
    },
  );

  it.each(['image', 'voice'] as const)(
    'isolates %s credentials from a conversation model at the same endpoint',
    async (purpose) => {
      const protocol = AuthType.USE_OPENAI;
      const chat = customPlan({
        protocol,
        apiKey: 'chat-secret',
        modelIds: ['chat-model'],
      });
      const service = customPlan({
        protocol,
        apiKey: 'service-secret',
        modelIds: ['service-model'],
        advancedConfig: { purpose },
      });
      const chatKey = Object.keys(chat.env!)[0]!;
      const serviceKey = Object.keys(service.env!)[0]!;
      preserveEnv(chatKey, serviceKey);
      expect(serviceKey).not.toBe(chatKey);
      const installed = await apply(chat);
      const adapter = createAdapter(installed.updatedModelProviders);
      const result = await apply(service, adapter);
      expect(result.updatedModelProviders['openai']).toEqual([
        ...installed.updatedModelProviders['openai']!,
        expect.objectContaining({ id: 'service-model', envKey: serviceKey }),
      ]);
      expect(result.updatedModelProviders['openai']?.[0]?.envKey).toBe(chatKey);
      expectSet(adapter, { [`env.${serviceKey}`]: 'service-secret' });
      expectNotSet(adapter, `env.${chatKey}`);
      expect(process.env[chatKey]).toBe('chat-secret');
      expect(process.env[serviceKey]).toBe('service-secret');
    },
  );

  it('updates a service model while preserving the same conversation ID at another endpoint', async () => {
    const conversation = { id: 'model', baseUrl: 'https://chat.example/v1' };
    const adapter = createAdapter({
      openai: [conversation, { id: 'model', baseUrl: MEDIA, imageOnly: true }],
    });
    const plan = customPlan({
      protocol: AuthType.USE_OPENAI,
      modelIds: ['model'],
      advancedConfig: { purpose: 'image', contextWindowSize: 65536 },
    });
    plan.env = {};
    const result = await apply(plan, adapter);
    expect(result.updatedModelProviders['openai']).toHaveLength(2);
    expect(result.updatedModelProviders['openai']?.[0]).toEqual(conversation);
    expect(result.updatedModelProviders['openai']).toContainEqual(
      expect.objectContaining({
        id: 'model',
        baseUrl: MEDIA,
        imageOnly: true,
        generationConfig: { contextWindowSize: 65536 },
      }),
    );
  });

  it('refuses an install plan that sets a reserved env var (NODE_OPTIONS)', async () => {
    const adapter = createAdapter();
    // CI sets NODE_OPTIONS (e.g. --max-old-space-size): snapshot it to assert
    // the rejected plan left it UNCHANGED rather than assuming it's unset.
    const originalNodeOptions = process.env['NODE_OPTIONS'];
    const plan = makePlan({ env: { NODE_OPTIONS: '--require /tmp/evil.js' } });

    await expect(apply(plan, adapter)).rejects.toThrow(
      /reserved environment variable: NODE_OPTIONS/,
    );
    // The evil value must not leak into the live process.
    expect(process.env['NODE_OPTIONS']).toBe(originalNodeOptions);
    expect(process.env['NODE_OPTIONS']).not.toBe('--require /tmp/evil.js');
    expectNotSet(adapter, 'env.NODE_OPTIONS');
  });

  it('matches the env denylist case-insensitively (Path)', async () => {
    const plan = makePlan({ env: { Path: 'C:\\evil' } });

    await expect(apply(plan)).rejects.toThrow(
      /reserved environment variable: Path/,
    );
  });

  it.each(['TMP', 'TEMP', 'tmp'])(
    'rejects the Windows temp-redirect env var %s',
    async (key) => {
      const plan = makePlan({ env: { [key]: 'C:\\evil-temp' } });

      await expect(apply(plan)).rejects.toThrow(
        /reserved environment variable/,
      );
    },
  );

  it('persists env, auth selection, selected model, and merged model providers', async () => {
    const preserved = () => ({
      id: 'preserved',
      envKey: 'OTHER_API_KEY',
      generationConfig: { contextWindowSize: 456 },
    });
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        {
          id: 'old-owned',
          envKey: 'TEST_API_KEY',
          generationConfig: { contextWindowSize: 123 },
        },
        preserved(),
      ],
    });
    const reloadModelProviders = vi.fn();
    const syncAuthState = vi.fn();
    const refreshAuth = vi.fn(async () => undefined);

    const plan = modelsPlan(
      [{ id: 'new-model', envKey: 'TEST_API_KEY' }],
      { ownsModel: (model) => model.envKey === 'TEST_API_KEY' },
      {
        env: { TEST_API_KEY: 'sk-test' },
        modelSelection: { modelId: 'new-model' },
      },
    );

    await apply(plan, adapter, {
      reloadModelProviders,
      syncAuthState,
      refreshAuth,
    });

    expectSet(adapter, { 'env.TEST_API_KEY': 'sk-test' });
    expect(process.env['TEST_API_KEY']).toBe('sk-test');
    const merged = [{ id: 'new-model', envKey: 'TEST_API_KEY' }, preserved()];
    expectSet(adapter, {
      'modelProviders.openai': merged,
      'security.auth.selectedType': AuthType.USE_OPENAI,
      'model.name': 'new-model',
      // Id-only selection must clear any stale baseUrl disambiguator
      // (empty-string tombstone overrides a lower-scope value on merge).
      'model.baseUrl': '',
    });
    expect(adapter.persist).toHaveBeenCalled();
    expect(reloadModelProviders).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: merged,
    });
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'new-model',
      undefined,
    );
    expect(refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(adapter.cleanupBackup).toHaveBeenCalled();
  });

  it('can skip immediate auth refresh', async () => {
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => undefined);
    const plan = makePlan({ env: { TEST_API_KEY: 'sk-test' } });

    await apply(plan, adapter, { refreshAuth, doRefreshAuth: false });

    expectSet(adapter, { 'env.TEST_API_KEY': 'sk-test' });
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it('prints a shadowing warning when an env key changes', async () => {
    process.env['SHADOW_KEY'] = 'old-value';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan = makePlan({ env: { SHADOW_KEY: 'new-value' } });

    await apply(plan);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('SHADOW_KEY is also set'),
    );
    expect(process.env['SHADOW_KEY']).toBe('new-value');
  });

  it('does not print a shadowing warning for same or empty env values', async () => {
    process.env['SHADOW_KEY'] = 'same-value';
    process.env['EMPTY_SHADOW_KEY'] = '';
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan = makePlan({
      env: { SHADOW_KEY: 'same-value', EMPTY_SHADOW_KEY: 'filled-value' },
    });

    await apply(plan);

    expect(consoleError).not.toHaveBeenCalled();
    expect(process.env['SHADOW_KEY']).toBe('same-value');
    expect(process.env['EMPTY_SHADOW_KEY']).toBe('filled-value');
  });

  it('uses patch ownsModel for merge filtering', () =>
    expectMerged(
      [
        { id: 'old-a', envKey: 'A' },
        { id: 'old-b', envKey: 'B' },
      ],
      modelsPlan([{ id: 'new-a', envKey: 'A' }], {
        ownsModel: (model) => model.envKey === 'A',
      }),
      [
        { id: 'new-a', envKey: 'A' },
        { id: 'old-b', envKey: 'B' },
      ],
    ));

  it('falls back to id+baseUrl identity when ownsModel is omitted', () =>
    expectMerged(
      [
        // Same id, different baseUrl → preserved (different identity)
        { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
        // Same id+baseUrl as incoming → removed
        { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        // Different id, same baseUrl as incoming → preserved
        { id: 'gpt-3.5', baseUrl: 'https://api.openai.com/v1' },
      ],
      // ownsModel intentionally omitted — exercises isSameModelIdentity path
      modelsPlan([{ id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' }]),
      [
        { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
        { id: 'gpt-3.5', baseUrl: 'https://api.openai.com/v1' },
      ],
    ));

  it('appends models with append merge strategy', () =>
    expectMerged(
      [
        { id: 'existing-1', envKey: 'A' },
        { id: 'existing-2', envKey: 'B' },
      ],
      modelsPlan([{ id: 'new-model', envKey: 'C' }], {
        mergeStrategy: 'append',
      }),
      [
        { id: 'existing-1', envKey: 'A' },
        { id: 'existing-2', envKey: 'B' },
        { id: 'new-model', envKey: 'C' },
      ],
    ));

  it('replaces owned models with replace-owned strategy (appends new at end)', () =>
    expectMerged(
      [
        { id: 'owned-1', envKey: 'A' },
        { id: 'unrelated', envKey: 'B' },
        { id: 'owned-2', envKey: 'A' },
      ],
      modelsPlan([{ id: 'new-a', envKey: 'A' }], {
        mergeStrategy: 'replace-owned',
        ownsModel: (model) => model.envKey === 'A',
      }),
      [
        { id: 'unrelated', envKey: 'B' },
        { id: 'new-a', envKey: 'A' },
      ],
    ));

  it.each([false, true])(
    'preserves the other API sibling when installing Responses (ownsModel=%s)',
    async (owned) => {
      const chat = { id: 'same', baseUrl: GATEWAY, envKey: 'TEST_API_KEY' };
      const responses = { ...chat, wireApi: 'responses' as const };
      const { adapter, syncAuthState } = await installResponses(
        { openai: [chat, { ...responses, name: 'old' }] },
        'same',
        [responses],
        'same',
        owned ? { ownsModel: () => true } : {},
      );
      expectSet(adapter, { 'modelProviders.openai': [responses, chat] });
      expect(syncAuthState).toHaveBeenCalledWith(
        AuthType.USE_OPENAI_RESPONSES,
        'same',
        GATEWAY,
      );
    },
  );

  it('preserves a non-first canonical Responses selection across reinstall', async () => {
    const models = ['first', 'chosen'].map((id) => ({
      id,
      baseUrl: GATEWAY,
      wireApi: 'responses' as const,
    }));
    const { adapter, syncAuthState } = await installResponses(
      { openai: models },
      'chosen',
      models,
      'first',
    );
    // The reinstall still persists the merged providers map — preserving the
    // selection must not silently skip the install itself.
    expectSet(adapter, { 'modelProviders.openai': models });
    expectNotSet(adapter, 'model.name');
    expect(syncAuthState).not.toHaveBeenCalled();
  });

  it('keeps a non-first current model when reinstalling across an API route change', async () => {
    const chatModels = ['glm-4.6', 'qwen3-max', 'deepseek-v3'].map((id) => ({
      id,
      baseUrl: GATEWAY,
      envKey: 'TEST_API_KEY',
    }));
    const { adapter, syncAuthState } = await installResponses(
      { openai: chatModels },
      'qwen3-max',
      chatModels.map((model) => ({ ...model, wireApi: 'responses' as const })),
      'glm-4.6',
    );
    // The plan still offers the user's chosen model on the new route: keep it
    // over the plan's first model, but re-sync the live session onto the wire.
    expectNotSet(adapter, 'model.name');
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI_RESPONSES,
      'qwen3-max',
      GATEWAY,
    );
  });

  it('does not throw when an owned stored entry has an invalid wireApi', async () => {
    const invalid = {
      id: 'old',
      envKey: 'TEST_API_KEY',
      wireApi: 'invalid' as ModelConfig['wireApi'],
    };
    const result = await apply(
      modelsPlan([{ id: 'new', envKey: 'TEST_API_KEY' }], {
        ownsModel: (model) => model.envKey === 'TEST_API_KEY',
      }),
      createAdapter({ openai: [invalid] }),
    );
    expect(result.updatedModelProviders['openai']).toEqual([
      { id: 'new', envKey: 'TEST_API_KEY' },
      invalid,
    ]);
  });

  it('does not let an invalid api elsewhere in settings abort a non-OpenAI install', async () => {
    const adapter = createAdapter(
      {
        openai: [
          {
            id: 'm',
            envKey: 'A',
            wireApi: 'response' as ModelConfig['wireApi'],
          },
        ],
      },
      { 'security.auth.selectedType': AuthType.USE_OPENAI, 'model.name': 'm' },
    );
    // The pre-install wire resolution scans every modelProviders entry, so an
    // invalid `wireApi` in an unrelated bucket would throw ahead of the plan's own
    // error contract. A non-OpenAI plan never consults it.
    const plan = modelsPlan(
      [{ id: 'm', envKey: 'ANTHROPIC_API_KEY' }],
      { authType: AuthType.USE_ANTHROPIC },
      { authType: AuthType.USE_ANTHROPIC, modelSelection: { modelId: 'm' } },
    );
    await expect(apply(plan, adapter)).resolves.toMatchObject({
      updatedModelProviders: {
        anthropic: [{ id: 'm', envKey: 'ANTHROPIC_API_KEY' }],
      },
    });
  });

  it('does not let an invalid api elsewhere in settings abort an OpenAI-family install', async () => {
    // The pre-install wire probe walks every bucket of the previous providers
    // map with the throwing resolver; an invalid `wireApi` in a bucket the plan
    // never touches must skip the probe, not refuse the install.
    const adapter = idealabAdapter({}, { 'model.name': 'q1' });
    const plan = modelsPlan(
      [{ id: 'q1', envKey: 'TEST_API_KEY', wireApi: 'responses' as const }],
      undefined,
      {
        authType: AuthType.USE_OPENAI_RESPONSES,
        modelSelection: { modelId: 'q1' },
      },
    );
    await expect(apply(plan, adapter)).resolves.toMatchObject({
      updatedModelProviders: {
        openai: [{ id: 'q1', envKey: 'TEST_API_KEY', wireApi: 'responses' }],
      },
    });
  });

  it('does not let an invalid api elsewhere in settings abort a voice install', async () => {
    // The voice-conflict probe rebuilds a registry over every bucket of the
    // prospective providers map, and the registry constructor validates each
    // entry. An invalid `wireApi` in a bucket the plan never touches must not
    // refuse the install, least of all with a bare Error the daemon answers as
    // a 500 instead of the 400 `model_purpose_conflict`.
    const baseUrl = 'https://voice.example/v1';
    const adapter = idealabAdapter({
      openai: [
        {
          id: 'qwen3-asr-flash',
          baseUrl,
          voiceOnly: true,
          envKey: `${generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl)}_VOICE`,
        },
      ],
    });
    const plan = asrPlan(baseUrl, { purpose: 'voice' });
    await expect(apply(plan, adapter)).resolves.toMatchObject({
      updatedModelProviders: {
        openai: [{ id: 'qwen3-asr-flash', baseUrl, voiceOnly: true }],
      },
    });
  });

  it('keeps the duplicate-voice refusal on its step next to an invalid api elsewhere', async () => {
    // Same map, but the plan reconnects the voice id at another endpoint: the
    // refusal must still be the `modelPurpose` ProviderInstallError the daemon
    // maps to `model_purpose_conflict`, not the registry's validation Error.
    const adapter = idealabAdapter({ openai: [firstVoice()] });
    const plan = asrPlan('https://second.example/v1', { purpose: 'voice' });
    await expect(apply(plan, adapter)).rejects.toMatchObject({
      name: 'ProviderInstallError',
      step: 'modelPurpose',
    });
    expect(adapter.setValue).not.toHaveBeenCalled();
  });

  it('retires a recorded model-list version when reinstalling on the Responses route', async () => {
    const baseUrl = 'https://api.test.com/v1';
    const preset: ProviderConfig = {
      id: 'test',
      label: 'Test',
      description: 'Test',
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      envKey: 'TEST_API_KEY',
      models: [{ id: 'model-a' }],
      modelNamePrefix: 'Test',
    };
    const adapter = createAdapter();
    const inputs = { baseUrl, apiKey: 'sk-test', modelIds: ['model-a'] };
    const defaultPlan = buildInstallPlan(preset, inputs);
    expect(
      defaultPlan.providerState?.['providerMetadata.test']?.['version'],
    ).toBeDefined();

    const responsesPlan = buildInstallPlan(preset, {
      ...inputs,
      wireApi: 'responses',
    });
    await apply(responsesPlan, adapter);

    // The drift check's template rebuild can never reproduce an api-stamped
    // install's version, so the reinstall retires the default route's one;
    // otherwise the next template change prompts a spurious update whose
    // accept path duplicates every model.
    expectSet(adapter, { 'providerMetadata.test.version': undefined });
  });

  it('preserves existing custom provider models and selects the installed endpoint', async () => {
    const baseUrl = 'http://new.example/v1';
    const otherBaseUrl = 'http://192.168.100.100:8000/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    const otherEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, otherBaseUrl);
    const other = { baseUrl: otherBaseUrl, envKey: otherEnvKey };
    // model-b at another baseUrl: keep both and select the one just installed.
    const stored = () => [
      { id: 'model-b', name: 'model-b', ...other },
      { id: 'model-a', name: 'model-a', baseUrl, envKey },
      { id: 'shared-model', name: 'shared-model', ...other },
    ];
    const syncAuthState = vi.fn();
    const adapter = createAdapter({ [AuthType.USE_OPENAI]: stored() });
    const plan = customPlan({
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['model-b'],
    });

    expect(plan.modelProviders?.[0]?.ownsModel).toBeUndefined();
    expect(plan.modelSelection).toEqual({ modelId: 'model-b', baseUrl });

    preserveEnv(envKey);
    await apply(plan, adapter, { syncAuthState, doRefreshAuth: false });

    expectSet(adapter, {
      'modelProviders.openai': [
        { id: 'model-b', name: 'model-b', baseUrl, envKey },
        ...stored(),
      ],
      'model.name': 'model-b',
      'model.baseUrl': baseUrl,
    });
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'model-b',
      baseUrl,
    );
  });

  it('writes provider state and legacy credentials', async () => {
    const adapter = createAdapter();
    const plan = makePlan({
      legacyCredentials: {
        apiKey: 'legacy-key',
        baseUrl: 'https://example.com/v1',
      },
      providerState: {
        codingPlan: { baseUrl: 'https://coding.example.com/v1', version: 'v1' },
      },
    });

    await apply(plan, adapter);

    expectSet(adapter, {
      'security.auth.apiKey': 'legacy-key',
      'security.auth.baseUrl': 'https://example.com/v1',
      'codingPlan.baseUrl': 'https://coding.example.com/v1',
      'codingPlan.version': 'v1',
    });
  });

  it('rolls back process.env on error', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    const plan = makePlan({ env: { TEST_API_KEY: 'new-value' } });

    await failRefresh(plan, adapter, 'network error');

    expect(process.env['TEST_API_KEY']).toBe('old-value');
    expect(adapter.restore).toHaveBeenCalled();
  });

  it('deletes env var on rollback if it did not exist before', async () => {
    const plan = makePlan({ env: { BRAND_NEW_KEY: 'value' } });

    await failRefresh(plan, createAdapter(), 'fail');

    expect(process.env['BRAND_NEW_KEY']).toBeUndefined();
  });

  // -- Rollback safety nets -------------------------------------------------
  // The catch path in applyProviderInstallPlan has three deliberate safety
  // nets, previously untested; these pin them down so a refactor that
  // "simplifies" the catch can't silently regress.

  it('restores runtime model providers when refreshAuth rejects after reloadModelProviders ran', async () => {
    const previousProviders = {
      [AuthType.USE_OPENAI]: [{ id: 'previous', envKey: 'OLD_KEY' }],
    };
    const adapter = createAdapter(previousProviders);
    const reloadModelProviders = vi.fn();
    const plan = modelsPlan(
      [{ id: 'new-model', envKey: 'TEST_API_KEY' }],
      { ownsModel: (model) => model.envKey === 'TEST_API_KEY' },
      { env: { TEST_API_KEY: 'sk-new' } },
    );

    await failRefresh(plan, adapter, 'refreshAuth rejected', {
      reloadModelProviders,
    });

    // Two reloads: the success-path one with the patched providers, then the
    // rollback one handing back the snapshot taken *before* any patch.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(reloadModelProviders).toHaveBeenLastCalledWith(previousProviders);
  });

  it('still rolls back env vars when backup() throws before persist', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    adapter.backup.mockImplementation(() => {
      throw new Error('backup failed');
    });
    const plan = makePlan({ env: { TEST_API_KEY: 'new-value' } });

    await expect(apply(plan, adapter)).rejects.toThrow('backup failed');

    // A backup() throw inside the try must still reach the env rollback (before
    // the "backup inside try" fix it escaped uncaught and env vars leaked).
    expect(process.env['TEST_API_KEY']).toBe('old-value');
  });

  it('continues env rollback even when settings.restore itself throws', async () => {
    process.env['TEST_API_KEY'] = 'before-install';
    const adapter = createAdapter();
    adapter.restore.mockImplementation(() => {
      throw new Error('restore failed');
    });
    const plan = makePlan({ env: { TEST_API_KEY: 'during-install' } });

    await failRefresh(plan, adapter, 'original error');

    // restore() throwing must not mask the original error and must not skip
    // the env-var rollback loop that runs after it.
    expect(adapter.restore).toHaveBeenCalled();
    expect(process.env['TEST_API_KEY']).toBe('before-install');
  });

  it('annotates the rethrown error with the failing step and preserves the original cause', async () => {
    process.env['TEST_API_KEY'] = 'old';
    const refreshAuth = rejecting('endpoint unreachable');
    const plan = makePlan({ env: { TEST_API_KEY: 'new' } });

    const caught: unknown = await apply(plan, createAdapter(), {
      refreshAuth,
    }).catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(ProviderInstallError); // a class at runtime
    const err = caught as ProviderInstallError & { cause?: Error };
    // Step + authType are structured properties; the user-facing message stays
    // the underlying error text.
    expect(err.step).toBe('refreshAuth');
    expect(err.authType).toBe('openai');
    expect(err.message).toBe('endpoint unreachable');
    // Original error preserved via cause so callers matching on err.code
    // (NodeJS.ErrnoException) still work.
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe('endpoint unreachable');
  });

  it('continues throw + env rollback when reloadModelProviders rollback itself throws', async () => {
    process.env['TEST_API_KEY'] = 'before';
    const previousProviders = {
      [AuthType.USE_OPENAI]: [{ id: 'previous', envKey: 'OLD' }],
    };
    const adapter = createAdapter(previousProviders);
    let reloadCalls = 0;
    const reloadModelProviders = vi.fn(() => {
      // The rollback-time reload (the second call) explodes.
      if (++reloadCalls === 2) throw new Error('reload restore failed');
    });
    const plan = makePlan({ env: { TEST_API_KEY: 'during' } });

    await failRefresh(plan, adapter, 'original error', {
      reloadModelProviders,
    });

    // The rethrow must still carry the original error, env vars must still
    // be rolled back, and the broken rollback reload must not mask anything.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(process.env['TEST_API_KEY']).toBe('before');
  });
});
