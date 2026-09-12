/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '../../core/contentGenerator.js';
import type { ModelProvidersConfig } from '../../models/types.js';
import {
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  generateCustomEnvKey,
  minimaxProvider,
  ProviderInstallError,
  type ProviderInstallPlan,
  type ProviderSettingsAdapter,
} from '../index.js';

function createAdapter(modelProviders: ModelProvidersConfig = {}) {
  let snapshot = modelProviders;
  const adapter: ProviderSettingsAdapter & {
    setValue: ReturnType<typeof vi.fn>;
    persist: ReturnType<typeof vi.fn>;
    backup: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    cleanupBackup: ReturnType<typeof vi.fn>;
  } = {
    getValue: vi.fn(),
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
  };
  return adapter;
}

describe('applyProviderInstallPlan', () => {
  it('rolls back a provider write shadowed by a higher-precedence scope before selecting it', async () => {
    const original = { openai: [{ id: 'workspace-chat' }] };
    const adapter = createAdapter(original);
    vi.mocked(adapter.getModelProviders).mockReturnValue(original);
    const plan: ProviderInstallPlan = {
      providerId: 'test',
      authType: AuthType.USE_OPENAI,
      modelSelection: { modelId: 'new-user-model' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-user-model' }],
          mergeStrategy: 'append',
        },
      ],
    };
    const reload = vi.fn();
    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders: reload,
      }),
    ).rejects.toMatchObject({ step: 'modelProviders' });
    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'workspace-chat' },
      { id: 'new-user-model' },
    ]);
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'security.auth.selectedType',
      expect.anything(),
    );
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
  });

  it.each(['image', 'voice'] as const)(
    'rejects a slash-varied %s reconnect before it can overwrite conversation credentials',
    async (purpose) => {
      const baseUrl = 'https://media.example/v1';
      const chatKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
      const serviceKey = `${chatKey}_${purpose.toUpperCase()}`;
      const models = [
        { id: 'chat', baseUrl, envKey: chatKey },
        {
          id: 'service',
          baseUrl: `${baseUrl}/`,
          envKey: serviceKey,
          ...(purpose === 'image' ? { imageOnly: true } : { voiceOnly: true }),
          generationConfig: { contextWindowSize: 65536 },
        },
      ];
      const adapter = createAdapter({ openai: models });
      vi.stubEnv(chatKey, 'chat-old');
      vi.stubEnv(serviceKey, 'service-old');
      try {
        await expect(
          (async () => {
            const plan = buildInstallPlan(
              customProvider,
              {
                protocol: AuthType.USE_OPENAI,
                baseUrl,
                apiKey: 'service-new',
                modelIds: ['service'],
              },
              models,
            );
            await applyProviderInstallPlan(plan, { settings: adapter });
          })(),
        ).rejects.toMatchObject({ step: 'modelPurpose' });
        expect(adapter.setValue).not.toHaveBeenCalled();
        expect(process.env[chatKey]).toBe('chat-old');
        expect(process.env[serviceKey]).toBe('service-old');
        expect(adapter.getModelProviders()).toEqual({ openai: models });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(['image', 'voice'] as const)(
    'installs %s models without changing conversation selection',
    async (purpose) => {
      const adapter = createAdapter({ anthropic: [{ id: 'main' }] });
      const plan = buildInstallPlan(customProvider, {
        protocol: AuthType.USE_OPENAI,
        baseUrl: 'https://media.example/v1',
        apiKey: 'test-only',
        modelIds: [purpose === 'voice' ? 'qwen3-asr-flash' : 'image-01'],
        advancedConfig: { purpose, contextWindowSize: 65536 },
      });
      const envKey = Object.keys(plan.env!)[0]!;
      const previous = process.env[envKey];
      const refreshAuth = vi.fn();
      const syncAuthState = vi.fn();
      try {
        expect(plan.modelSelection).toBeUndefined();
        const result = await applyProviderInstallPlan(plan, {
          settings: adapter,
          refreshAuth,
          syncAuthState,
        });
        expect(result.updatedModelProviders['openai']?.[0]).toMatchObject({
          ...(purpose === 'image'
            ? { imageOnly: true, supportsImageGeneration: true }
            : { voiceOnly: true }),
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
      } finally {
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
      }
    },
  );

  it.each([false, true])(
    'installs beside null provider buckets (target null: %s)',
    async (targetNull) => {
      const providers = {
        openai: targetNull ? null : [],
        gemini: null,
      } as unknown as ModelProvidersConfig;
      const plan = buildInstallPlan(
        customProvider,
        {
          baseUrl: 'https://new.example/v1',
          apiKey: 'test',
          modelIds: ['chat'],
        },
        providers['openai'],
      );
      const envKey = Object.keys(plan.env!)[0]!;
      const previous = process.env[envKey];
      try {
        const result = await applyProviderInstallPlan(plan, {
          settings: createAdapter(providers),
        });
        expect(result.updatedModelProviders['openai']).toEqual([
          expect.objectContaining({ id: 'chat' }),
        ]);
        expect(result.updatedModelProviders['gemini']).toBeNull();
      } finally {
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
      }
    },
  );

  it('replaces a same-identity custom image route with the preset credential', async () => {
    const baseUrl = 'https://api.minimax.io/v1';
    const adapter = createAdapter({
      openai: [
        {
          id: 'image-01',
          baseUrl,
          envKey: `${generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl)}_IMAGE`,
          imageOnly: true,
          supportsImageGeneration: true,
        },
      ],
    });
    const plan = buildInstallPlan(minimaxProvider, {
      baseUrl,
      apiKey: 'test-preset-key',
      modelIds: ['image-01'],
    });
    const previous = process.env['MINIMAX_API_KEY'];
    try {
      const result = await applyProviderInstallPlan(plan, {
        settings: adapter,
      });
      expect(result.updatedModelProviders['openai']).toEqual([
        expect.objectContaining({
          id: 'image-01',
          baseUrl,
          envKey: 'MINIMAX_API_KEY',
          imageOnly: true,
        }),
      ]);
    } finally {
      if (previous === undefined) delete process.env['MINIMAX_API_KEY'];
      else process.env['MINIMAX_API_KEY'] = previous;
    }
  });

  it.each([undefined, 'voice'] as const)(
    'rejects a second endpoint for an existing voice ID before writing (%s)',
    async (purpose) => {
      const adapter = createAdapter({
        openai: [
          {
            id: 'qwen3-asr-flash',
            baseUrl: 'https://first.example/v1',
            voiceOnly: true,
            envKey: 'FIRST',
          },
        ],
      });
      const plan = buildInstallPlan(customProvider, {
        baseUrl: 'https://second.example/v1',
        apiKey: 'unused',
        modelIds: ['qwen3-asr-flash'],
        ...(purpose ? { advancedConfig: { purpose } } : {}),
      });
      await expect(
        applyProviderInstallPlan(plan, { settings: adapter }),
      ).rejects.toMatchObject({ step: 'modelPurpose' });
      expect(adapter.setValue).not.toHaveBeenCalled();
      expect(adapter.backup).not.toHaveBeenCalled();
      expect(adapter.persist).not.toHaveBeenCalled();
    },
  );

  it.each(['image', 'voice'] as const)(
    'reconnects a mixed provider without losing the %s configuration or independent key',
    async (purpose) => {
      const baseUrl = 'https://media.example/v1';
      const service = buildInstallPlan(customProvider, {
        baseUrl,
        apiKey: 'old-service',
        modelIds: ['service'],
        advancedConfig: { purpose, contextWindowSize: 65536 },
      }).modelProviders![0]!.models[0]!;
      const chatKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
      const existing = [
        { id: 'chat', baseUrl, envKey: chatKey },
        {
          ...service,
          name: 'My service',
          generationConfig: {
            ...service.generationConfig,
            customHeaders: { 'X-Test': 'preserved' },
          },
        },
      ];
      const plan = buildInstallPlan(
        customProvider,
        { baseUrl, apiKey: 'new-chat', modelIds: ['chat', 'service'] },
        existing,
      );
      const previous = process.env[chatKey];
      try {
        expect(plan.env).toEqual({ [chatKey]: 'new-chat' });
        const result = await applyProviderInstallPlan(plan, {
          settings: createAdapter({ openai: existing }),
        });
        expect(
          result.updatedModelProviders['openai']?.find(
            (model) => model.id === 'service',
          ),
        ).toEqual(existing[1]);
        expect(plan.modelSelection?.modelId).toBe('chat');
      } finally {
        if (previous === undefined) delete process.env[chatKey];
        else process.env[chatKey] = previous;
      }
    },
  );

  it.each(['image', 'voice'] as const)(
    'rekeys a purpose-less %s reconnect at the original credential key',
    (purpose) => {
      const inputs = {
        baseUrl: 'https://media.example/v1',
        apiKey: 'old',
        modelIds: ['service'],
      };
      const installed = buildInstallPlan(customProvider, {
        ...inputs,
        advancedConfig: { purpose },
      });
      const originalModels = installed.modelProviders![0]!.models;
      const reconnect = buildInstallPlan(
        customProvider,
        { ...inputs, apiKey: 'new' },
        originalModels,
      );
      expect(reconnect.env).toEqual({ [originalModels[0]!.envKey!]: 'new' });
      expect(reconnect.modelProviders![0]!.models).toEqual(originalModels);
      expect(reconnect.modelSelection).toBeUndefined();
    },
  );

  it('rejects a single credential update for independently keyed image and voice models', () => {
    const inputs = {
      baseUrl: 'https://media.example/v1',
      apiKey: 'unused',
      modelIds: [] as string[],
    };
    const existing = (['image', 'voice'] as const).flatMap(
      (purpose) =>
        buildInstallPlan(customProvider, {
          ...inputs,
          modelIds: [purpose],
          advancedConfig: { purpose },
        }).modelProviders![0]!.models,
    );
    expect(() =>
      buildInstallPlan(
        customProvider,
        { ...inputs, modelIds: ['image', 'voice'] },
        existing,
      ),
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
            baseUrl: 'https://media.example/v1',
            ...(from === 'image' ? { imageOnly: true } : {}),
            ...(from === 'voice' ? { voiceOnly: true } : {}),
          },
        ],
      };
      const snapshot = structuredClone(existing);
      const adapter = createAdapter(existing);
      process.env['TEST_API_KEY'] = 'unchanged';
      const plan = buildInstallPlan(customProvider, {
        protocol: AuthType.USE_OPENAI,
        baseUrl: 'https://media.example/v1',
        apiKey: 'test-only',
        modelIds: ['main'],
        ...(to === 'chat' ? {} : { advancedConfig: { purpose: to } }),
      });
      plan.env = { TEST_API_KEY: 'must-not-write' };
      const reloadModelProviders = vi.fn();
      await expect(
        applyProviderInstallPlan(plan, {
          settings: adapter,
          reloadModelProviders,
        }),
      ).rejects.toMatchObject({
        name: 'ProviderInstallError',
        step: 'modelPurpose',
        authType: AuthType.USE_OPENAI,
      });
      expect(adapter.setValue).not.toHaveBeenCalled();
      expect(adapter.backup).not.toHaveBeenCalled();
      expect(adapter.persist).not.toHaveBeenCalled();
      expect(reloadModelProviders).not.toHaveBeenCalled();
      expect(process.env['TEST_API_KEY']).toBe('unchanged');
      expect(existing).toEqual(snapshot);
    },
  );

  it('rejects a service preset that would remove an owned conversation model', async () => {
    const conversation = {
      id: 'MiniMax-M2.7',
      name: '[MiniMax] MiniMax-M2.7',
      baseUrl: 'https://api.minimax.io/v1',
      envKey: 'MINIMAX_API_KEY',
    };
    const adapter = createAdapter({ openai: [conversation] });
    const plan = buildInstallPlan(minimaxProvider, {
      baseUrl: conversation.baseUrl,
      apiKey: 'must-not-write',
      modelIds: ['image-01'],
    });
    const previous = process.env['MINIMAX_API_KEY'];
    process.env['MINIMAX_API_KEY'] = 'chat-secret';
    try {
      expect(plan.modelSelection).toBeUndefined();
      expect(plan.modelProviders?.[0]?.ownsModel?.(conversation)).toBe(true);
      await expect(
        applyProviderInstallPlan(plan, { settings: adapter }),
      ).rejects.toMatchObject({ step: 'modelPurpose' });
      expect(adapter.setValue).not.toHaveBeenCalled();
      expect(adapter.backup).not.toHaveBeenCalled();
      expect(adapter.persist).not.toHaveBeenCalled();
      expect(adapter.getModelProviders()).toEqual({ openai: [conversation] });
      expect(process.env['MINIMAX_API_KEY']).toBe('chat-secret');
    } finally {
      if (previous === undefined) delete process.env['MINIMAX_API_KEY'];
      else process.env['MINIMAX_API_KEY'] = previous;
    }
  });

  it.each(['image', 'voice', 'mixed'] as const)(
    'rejects a conversation preset that would remove an owned service model (%s)',
    async (purpose) => {
      const service = {
        id: purpose === 'voice' ? 'qwen3-asr-flash' : 'image-01',
        name: '[MiniMax] service',
        baseUrl: 'https://api.minimax.io/v1',
        envKey: 'MINIMAX_API_KEY',
        ...(purpose === 'voice'
          ? { voiceOnly: true }
          : { imageOnly: true, supportsImageGeneration: true }),
      };
      const adapter = createAdapter({ openai: [service] });
      const plan = buildInstallPlan(minimaxProvider, {
        baseUrl: service.baseUrl,
        apiKey: 'must-not-write',
        modelIds:
          purpose === 'mixed'
            ? ['MiniMax-M2.7', 'image-01-live']
            : ['MiniMax-M2.7'],
      });
      const previous = process.env['MINIMAX_API_KEY'];
      process.env['MINIMAX_API_KEY'] = 'service-secret';
      const reloadModelProviders = vi.fn();
      try {
        expect(plan.modelProviders?.[0]?.ownsModel?.(service)).toBe(true);
        await expect(
          applyProviderInstallPlan(plan, {
            settings: adapter,
            reloadModelProviders,
          }),
        ).rejects.toMatchObject({ step: 'modelPurpose' });
        expect(adapter.setValue).not.toHaveBeenCalled();
        expect(adapter.backup).not.toHaveBeenCalled();
        expect(adapter.persist).not.toHaveBeenCalled();
        expect(reloadModelProviders).not.toHaveBeenCalled();
        expect(adapter.getModelProviders()).toEqual({ openai: [service] });
        expect(process.env['MINIMAX_API_KEY']).toBe('service-secret');
      } finally {
        if (previous === undefined) delete process.env['MINIMAX_API_KEY'];
        else process.env['MINIMAX_API_KEY'] = previous;
      }
    },
  );

  it.each(['append-chat', 'reselect-service', 'reselect-chat'] as const)(
    'preserves intentional preset merge behavior (%s)',
    async (scenario) => {
      const existing = {
        id: scenario === 'reselect-chat' ? 'MiniMax-M2.7' : 'image-01',
        name: '[MiniMax] existing',
        baseUrl: 'https://api.minimax.io/v1',
        envKey: 'MINIMAX_API_KEY',
        ...(scenario === 'reselect-chat'
          ? {}
          : { imageOnly: true, supportsImageGeneration: true }),
      };
      const plan = buildInstallPlan(minimaxProvider, {
        baseUrl: existing.baseUrl,
        apiKey: 'test-only',
        modelIds: [
          scenario === 'reselect-service'
            ? 'image-01-live'
            : 'MiniMax-M2.7-highspeed',
        ],
      });
      if (scenario === 'append-chat')
        plan.modelProviders![0]!.mergeStrategy = 'append';
      delete plan.env;
      const result = await applyProviderInstallPlan(plan, {
        settings: createAdapter({ openai: [existing] }),
      });
      expect(result.updatedModelProviders['openai']).toEqual([
        ...(scenario === 'append-chat' ? [existing] : []),
        ...plan.modelProviders![0]!.models,
      ]);
    },
  );

  it.each(['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1'])(
    'reinstalls owned conversation and image models at %s',
    async (baseUrl) => {
      const inputs = {
        baseUrl: 'https://api.minimax.io/v1',
        apiKey: 'test-only',
        modelIds: ['MiniMax-M2.7', 'image-01'],
      };
      const existing = buildInstallPlan(minimaxProvider, inputs)
        .modelProviders![0]!.models;
      const foreign = { id: 'foreign', envKey: 'OTHER_KEY' };
      const adapter = createAdapter({ openai: [...existing, foreign] });
      const plan = buildInstallPlan(minimaxProvider, { ...inputs, baseUrl });
      delete plan.env;
      const reloadModelProviders = vi.fn();
      const result = await applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders,
      });
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
      const service = {
        id: 'image-01',
        name: '[MiniMax] image-01',
        baseUrl: 'https://api.minimax.io/v1',
        envKey: 'MINIMAX_API_KEY',
        imageOnly: true,
        supportsImageGeneration: true,
      };
      const adapter = createAdapter({ openai: [service] });
      const plan = buildInstallPlan(minimaxProvider, {
        baseUrl: 'https://api.minimaxi.com/v1',
        apiKey: 'test-only',
        modelIds: ['MiniMax-M2.7', service.id],
      });
      const replacement = plan.modelProviders![0]!.models[1]!;
      replacement.imageOnly = false;
      replacement.voiceOnly = purpose === 'voice';
      replacement.supportsImageGeneration = false;
      plan.env = { TEST_API_KEY: 'must-not-write' };
      process.env['TEST_API_KEY'] = 'unchanged';
      await expect(
        applyProviderInstallPlan(plan, { settings: adapter }),
      ).rejects.toMatchObject({ step: 'modelPurpose' });
      expect(adapter.getModelProviders()).toEqual({ openai: [service] });
      expect(adapter.setValue).not.toHaveBeenCalled();
      expect(adapter.backup).not.toHaveBeenCalled();
      expect(adapter.persist).not.toHaveBeenCalled();
      expect(process.env['TEST_API_KEY']).toBe('unchanged');
    },
  );

  it.each(['image', 'voice'] as const)(
    'isolates %s credentials from a conversation model at the same endpoint',
    async (purpose) => {
      const inputs = {
        protocol: AuthType.USE_OPENAI,
        baseUrl: 'https://media.example/v1',
      };
      const chat = buildInstallPlan(customProvider, {
        ...inputs,
        apiKey: 'chat-secret',
        modelIds: ['chat-model'],
      });
      const service = buildInstallPlan(customProvider, {
        ...inputs,
        apiKey: 'service-secret',
        modelIds: ['service-model'],
        advancedConfig: { purpose },
      });
      const chatKey = Object.keys(chat.env!)[0]!;
      const serviceKey = Object.keys(service.env!)[0]!;
      const previous = new Map(
        [chatKey, serviceKey].map((key) => [key, process.env[key]]),
      );
      try {
        expect(serviceKey).not.toBe(chatKey);
        const installed = await applyProviderInstallPlan(chat, {
          settings: createAdapter(),
        });
        const adapter = createAdapter(installed.updatedModelProviders);
        const result = await applyProviderInstallPlan(service, {
          settings: adapter,
        });
        expect(result.updatedModelProviders['openai']).toEqual([
          ...installed.updatedModelProviders['openai']!,
          expect.objectContaining({ id: 'service-model', envKey: serviceKey }),
        ]);
        expect(result.updatedModelProviders['openai']?.[0]?.envKey).toBe(
          chatKey,
        );
        expect(adapter.setValue).toHaveBeenCalledWith(
          `env.${serviceKey}`,
          'service-secret',
        );
        expect(adapter.setValue).not.toHaveBeenCalledWith(
          `env.${chatKey}`,
          expect.anything(),
        );
        expect(process.env[chatKey]).toBe('chat-secret');
        expect(process.env[serviceKey]).toBe('service-secret');
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

  it('updates a service model while preserving the same conversation ID at another endpoint', async () => {
    const conversation = { id: 'model', baseUrl: 'https://chat.example/v1' };
    const adapter = createAdapter({
      openai: [
        conversation,
        { id: 'model', baseUrl: 'https://media.example/v1', imageOnly: true },
      ],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl: 'https://media.example/v1',
      apiKey: 'test-only',
      modelIds: ['model'],
      advancedConfig: { purpose: 'image', contextWindowSize: 65536 },
    });
    plan.env = {};
    const result = await applyProviderInstallPlan(plan, { settings: adapter });
    expect(result.updatedModelProviders['openai']).toHaveLength(2);
    expect(result.updatedModelProviders['openai']?.[0]).toEqual(conversation);
    expect(result.updatedModelProviders['openai']).toContainEqual(
      expect.objectContaining({
        id: 'model',
        baseUrl: 'https://media.example/v1',
        imageOnly: true,
        generationConfig: { contextWindowSize: 65536 },
      }),
    );
  });

  it('refuses an install plan that sets a reserved env var (NODE_OPTIONS)', async () => {
    const adapter = createAdapter();
    // CI sets NODE_OPTIONS (e.g. --max-old-space-size); snapshot whatever it
    // is so we can assert the rejected plan left it UNCHANGED rather than
    // assuming it's unset.
    const originalNodeOptions = process.env['NODE_OPTIONS'];
    const plan: ProviderInstallPlan = {
      providerId: 'evil',
      authType: AuthType.USE_OPENAI,
      env: { NODE_OPTIONS: '--require /tmp/evil.js' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow(/reserved environment variable: NODE_OPTIONS/);
    // The evil value must not have leaked into the live process; the
    // pre-existing value (if any) is untouched.
    expect(process.env['NODE_OPTIONS']).toBe(originalNodeOptions);
    expect(process.env['NODE_OPTIONS']).not.toBe('--require /tmp/evil.js');
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'env.NODE_OPTIONS',
      expect.anything(),
    );
  });

  it('matches the env denylist case-insensitively (Path)', async () => {
    const adapter = createAdapter();
    const plan: ProviderInstallPlan = {
      providerId: 'evil',
      authType: AuthType.USE_OPENAI,
      env: { Path: 'C:\\evil' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow(/reserved environment variable: Path/);
  });

  it.each(['TMP', 'TEMP', 'tmp'])(
    'rejects the Windows temp-redirect env var %s',
    async (key) => {
      const adapter = createAdapter();
      const plan: ProviderInstallPlan = {
        providerId: 'evil',
        authType: AuthType.USE_OPENAI,
        env: { [key]: 'C:\\evil-temp' },
      };

      await expect(
        applyProviderInstallPlan(plan, { settings: adapter }),
      ).rejects.toThrow(/reserved environment variable/);
    },
  );

  it('persists env, auth selection, selected model, and merged model providers', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        {
          id: 'old-owned',
          envKey: 'TEST_API_KEY',
          generationConfig: { contextWindowSize: 123 },
        },
        {
          id: 'preserved',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 456 },
        },
      ],
    });
    const reloadModelProviders = vi.fn();
    const syncAuthState = vi.fn();
    const refreshAuth = vi.fn(async () => undefined);

    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-test' },
      modelSelection: { modelId: 'new-model' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-model', envKey: 'TEST_API_KEY' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: (model) => model.envKey === 'TEST_API_KEY',
        },
      ],
    };

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      reloadModelProviders,
      syncAuthState,
      refreshAuth,
    });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(process.env['TEST_API_KEY']).toBe('sk-test');
    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'new-model', envKey: 'TEST_API_KEY' },
      {
        id: 'preserved',
        envKey: 'OTHER_API_KEY',
        generationConfig: { contextWindowSize: 456 },
      },
    ]);
    expect(adapter.setValue).toHaveBeenCalledWith(
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'new-model');
    // Id-only model selection must clear any stale baseUrl disambiguator
    // (empty-string tombstone overrides a lower-scope value on merge).
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', '');
    expect(adapter.persist).toHaveBeenCalled();
    expect(reloadModelProviders).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: [
        { id: 'new-model', envKey: 'TEST_API_KEY' },
        {
          id: 'preserved',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 456 },
        },
      ],
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
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-test' },
    };

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      refreshAuth,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it('prints a shadowing warning when an env key changes', async () => {
    process.env['SHADOW_KEY'] = 'old-value';
    const adapter = createAdapter();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { SHADOW_KEY: 'new-value' },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('SHADOW_KEY is also set'),
    );
    expect(process.env['SHADOW_KEY']).toBe('new-value');
  });

  it('does not print a shadowing warning for same or empty env values', async () => {
    process.env['SHADOW_KEY'] = 'same-value';
    process.env['EMPTY_SHADOW_KEY'] = '';
    const adapter = createAdapter();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: {
        SHADOW_KEY: 'same-value',
        EMPTY_SHADOW_KEY: 'filled-value',
      },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(consoleError).not.toHaveBeenCalled();
    expect(process.env['SHADOW_KEY']).toBe('same-value');
    expect(process.env['EMPTY_SHADOW_KEY']).toBe('filled-value');
  });

  it('uses patch ownsModel for merge filtering', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'old-a', envKey: 'A' },
        { id: 'old-b', envKey: 'B' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-a', envKey: 'A' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: (model) => model.envKey === 'A',
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'new-a', envKey: 'A' },
      { id: 'old-b', envKey: 'B' },
    ]);
  });

  it('falls back to id+baseUrl identity when ownsModel is omitted', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        // Same id, different baseUrl → should be preserved (different identity)
        { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
        // Same id+baseUrl as incoming → should be removed
        { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        // Different id, same baseUrl as incoming → should be preserved
        { id: 'gpt-3.5', baseUrl: 'https://api.openai.com/v1' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' }],
          mergeStrategy: 'prepend-and-remove-owned',
          // ownsModel intentionally omitted — exercises isSameModelIdentity path
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
      { id: 'gpt-4o', baseUrl: 'https://proxy-a.example/v1' },
      { id: 'gpt-3.5', baseUrl: 'https://api.openai.com/v1' },
    ]);
  });

  it('preserves existing custom provider models and selects the installed endpoint', async () => {
    const baseUrl = 'http://new.example/v1';
    const otherBaseUrl = 'http://192.168.100.100:8000/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, baseUrl);
    const otherEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, otherBaseUrl);
    const syncAuthState = vi.fn();
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        // Same model id, different baseUrl: keep both and select the one just
        // installed.
        {
          id: 'model-b',
          name: 'model-b',
          baseUrl: otherBaseUrl,
          envKey: otherEnvKey,
        },
        { id: 'model-a', name: 'model-a', baseUrl, envKey },
        {
          id: 'shared-model',
          name: 'shared-model',
          baseUrl: otherBaseUrl,
          envKey: otherEnvKey,
        },
      ],
    });
    const plan = buildInstallPlan(customProvider, {
      protocol: AuthType.USE_OPENAI,
      baseUrl,
      apiKey: 'sk-new',
      modelIds: ['model-b'],
    });

    expect(plan.modelProviders?.[0]?.ownsModel).toBeUndefined();
    expect(plan.modelSelection).toEqual({ modelId: 'model-b', baseUrl });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        syncAuthState,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'model-b', name: 'model-b', baseUrl, envKey },
      {
        id: 'model-b',
        name: 'model-b',
        baseUrl: otherBaseUrl,
        envKey: otherEnvKey,
      },
      { id: 'model-a', name: 'model-a', baseUrl, envKey },
      {
        id: 'shared-model',
        name: 'shared-model',
        baseUrl: otherBaseUrl,
        envKey: otherEnvKey,
      },
    ]);
    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'model-b');
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', baseUrl);
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'model-b',
      baseUrl,
    );
  });

  it('writes provider state and legacy credentials', async () => {
    const adapter = createAdapter();
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      legacyCredentials: {
        apiKey: 'legacy-key',
        baseUrl: 'https://example.com/v1',
      },
      providerState: {
        codingPlan: {
          baseUrl: 'https://coding.example.com/v1',
          version: 'v1',
        },
      },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'security.auth.apiKey',
      'legacy-key',
    );
    expect(adapter.setValue).toHaveBeenCalledWith(
      'security.auth.baseUrl',
      'https://example.com/v1',
    );
    expect(adapter.setValue).toHaveBeenCalledWith(
      'codingPlan.baseUrl',
      'https://coding.example.com/v1',
    );
    expect(adapter.setValue).toHaveBeenCalledWith('codingPlan.version', 'v1');
  });

  it('appends models with append merge strategy', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'existing-1', envKey: 'A' },
        { id: 'existing-2', envKey: 'B' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-model', envKey: 'C' }],
          mergeStrategy: 'append',
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'existing-1', envKey: 'A' },
      { id: 'existing-2', envKey: 'B' },
      { id: 'new-model', envKey: 'C' },
    ]);
  });

  it('replaces owned models with replace-owned strategy (appends new at end)', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        { id: 'owned-1', envKey: 'A' },
        { id: 'unrelated', envKey: 'B' },
        { id: 'owned-2', envKey: 'A' },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-a', envKey: 'A' }],
          mergeStrategy: 'replace-owned',
          ownsModel: (model) => model.envKey === 'A',
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'unrelated', envKey: 'B' },
      { id: 'new-a', envKey: 'A' },
    ]);
  });

  it('rolls back process.env on error', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('network error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new-value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('network error');

    expect(process.env['TEST_API_KEY']).toBe('old-value');
    expect(adapter.restore).toHaveBeenCalled();
  });

  it('deletes env var on rollback if it did not exist before', async () => {
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('fail');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { BRAND_NEW_KEY: 'value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('fail');

    expect(process.env['BRAND_NEW_KEY']).toBeUndefined();
  });

  // -- Rollback safety nets -------------------------------------------------
  // The catch path in applyProviderInstallPlan has three deliberate
  // safety nets that were previously untested. These tests pin them down so
  // a future refactor that "simplifies" the catch can't silently regress.

  it('restores runtime model providers when refreshAuth rejects after reloadModelProviders ran', async () => {
    const previousProviders = {
      [AuthType.USE_OPENAI]: [{ id: 'previous', envKey: 'OLD_KEY' }],
    };
    const adapter = createAdapter(previousProviders);
    const reloadModelProviders = vi.fn();
    const refreshAuth = vi.fn(async () => {
      throw new Error('refreshAuth rejected');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-new' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-model', envKey: 'TEST_API_KEY' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel: (model) => model.envKey === 'TEST_API_KEY',
        },
      ],
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders,
        refreshAuth,
      }),
    ).rejects.toThrow('refreshAuth rejected');

    // Two reload calls: the success-path one with the patched providers,
    // then a rollback one that hands back the snapshot we took *before*
    // applying any patches.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(reloadModelProviders).toHaveBeenLastCalledWith(previousProviders);
  });

  it('still rolls back env vars when backup() throws before persist', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    adapter.backup.mockImplementation(() => {
      throw new Error('backup failed');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new-value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow('backup failed');

    // backup() throwing inside the try must still hand control to the
    // catch path so env vars are restored. (Before this commit's
    // "backup inside try" fix the throw escaped uncaught and env vars
    // leaked.)
    expect(process.env['TEST_API_KEY']).toBe('old-value');
  });

  it('continues env rollback even when settings.restore itself throws', async () => {
    process.env['TEST_API_KEY'] = 'before-install';
    const adapter = createAdapter();
    adapter.restore.mockImplementation(() => {
      throw new Error('restore failed');
    });
    const refreshAuth = vi.fn(async () => {
      throw new Error('original error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'during-install' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('original error');

    // restore() throwing must not mask the original error and must not skip
    // the env-var rollback loop that runs after it.
    expect(adapter.restore).toHaveBeenCalled();
    expect(process.env['TEST_API_KEY']).toBe('before-install');
  });

  it('annotates the rethrown error with the failing step and preserves the original cause', async () => {
    process.env['TEST_API_KEY'] = 'old';
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('endpoint unreachable');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new' },
    };

    let caught: unknown;
    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        refreshAuth,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // ProviderInstallError is a class, so instanceof works at runtime.
    expect(caught).toBeInstanceOf(ProviderInstallError);
    const err = caught as ProviderInstallError & { cause?: Error };
    // Step + authType are structured properties (not baked into the
    // user-facing message, which stays the underlying error text).
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
      reloadCalls += 1;
      if (reloadCalls === 2) {
        // The rollback-time reload (the second call) explodes.
        throw new Error('reload restore failed');
      }
    });
    const refreshAuth = vi.fn(async () => {
      throw new Error('original error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'during' },
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders,
        refreshAuth,
      }),
    ).rejects.toThrow('original error');

    // The rethrow must still carry the original error, env vars must still
    // be rolled back, and the broken rollback reload must not mask anything.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(process.env['TEST_API_KEY']).toBe('before');
  });
});
