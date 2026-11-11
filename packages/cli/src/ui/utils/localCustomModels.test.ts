/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CustomProviderManager,
  CUSTOM_MODEL_PROVIDER_CONFIG_ERROR,
  runLogger,
  type Config,
} from '@qwen-code/core';
import { CustomProviderRegistry } from '../../../../core/src/provider/custom/registry.js';
import {
  resolveEnvVarsInObject,
  type LoadedSettings,
  type SettingsService,
} from '@qwen-code/resource';
import {
  createLocalProviderFromTui,
  deleteLocalProviderFromTui,
  getLocalModelEdit,
  getLocalProviderDeletionBlock,
  refreshLocalProvidersFromTui,
  updateLocalModelFromTui,
} from './localCustomModels.js';

type ProviderMap = Record<string, Record<string, unknown>>;
type SettingsRoot = Record<string, unknown> & { providers?: ProviderMap };
const provider = {
  baseUrl: 'https://gateway.example/v1',
  apiKey: '',
  model: 'vendor/model',
};
const input = { providerId: 'gateway', ...provider };

function createHarness(initial: SettingsRoot = {}) {
  let disk = structuredClone(initial);
  const overrides = {
    project: {} as ProviderMap,
    local: {} as ProviderMap,
    flag: {} as ProviderMap,
  };
  const state = {
    readOnly: false,
    trusted: true,
    accessMode: 'local' as 'local' | 'sdk' | 'disabled',
  };
  const snapshot = () => {
    const user = resolveEnvVarsInObject(structuredClone(disk)) as SettingsRoot;
    return {
      user: {
        settings: user,
        get readOnly() {
          return state.readOnly;
        },
      },
      project: { settings: { providers: overrides.project } },
      local: { settings: { providers: overrides.local } },
      flag: { settings: { providers: overrides.flag } },
      get isTrusted() {
        return state.trusted;
      },
      errors: [],
      merged: {
        providers: {
          ...user.providers,
          ...overrides.project,
          ...overrides.local,
          ...overrides.flag,
        },
      },
    } as unknown as LoadedSettings;
  };
  let loaded = snapshot();
  const source = {
    read: vi.fn(() => JSON.stringify(disk)),
    invalidate: vi.fn(),
    mutate: vi.fn((mutation: (value: Record<string, unknown>) => boolean) => {
      const next = structuredClone(disk);
      if (mutation(next)) disk = next;
    }),
  };
  const settingsService = {
    peekUserSettingsSource: () => source,
  } as unknown as SettingsService;
  const manager = new CustomProviderManager(settingsService);
  const registry = new CustomProviderRegistry();
  registry.replace(loaded.merged.providers);
  const config = {
    getCustomProviderManager: () => manager,
    getLoadedSettings: () => loaded,
    getCustomProviderAccessMode: () => state.accessMode,
    ensureCustomProvidersAccess: vi.fn(async () => true),
    getCustomProviderRegistry: () => registry,
    getModelProviderManager: () => ({
      getModel: vi.fn(async (key: string) => registry.getModelDescriptor(key)),
    }),
    reloadModelConfigFromDisk: vi.fn(async () => {
      loaded = snapshot();
      await config.replaceCustomProviderSettings(loaded.merged.providers);
    }),
    getCustomProvidersState: () => ({ status: 'active' }),
    replaceCustomProviderSettings: vi.fn(async (providers: unknown) => {
      registry.replace(providers);
      return { status: 'active' };
    }),
  };
  return {
    config,
    asConfig: config as unknown as Config,
    manager,
    registry,
    source,
    state,
    overrides,
    disk: () => disk,
    writeDisk: (next: SettingsRoot) => {
      disk = structuredClone(next);
    },
  };
}

describe('localCustomModels', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(runLogger, level).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('borrows CRUD and applies the merged session settings after persistence', async () => {
    const h = createHarness({ theme: 'keep' });
    const create = vi.spyOn(h.manager, 'create');
    await expect(
      createLocalProviderFromTui(h.asConfig, input),
    ).resolves.toEqual({
      modelKey: 'gateway/vendor/model',
      applied: true,
    });
    expect(create).toHaveBeenCalledWith(input);
    expect(h.config.reloadModelConfigFromDisk).toHaveBeenCalledOnce();
    expect(h.registry.getPublicModels()).toMatchObject([
      { key: 'gateway/vendor/model' },
    ]);
    expect(h.disk()['theme']).toBe('keep');
  });

  it('refreshes from user and project settings', async () => {
    const h = createHarness({ providers: { gateway: provider } });
    h.overrides.project['project'] = { ...provider, model: 'project-model' };
    await refreshLocalProvidersFromTui(h.asConfig);
    expect(h.registry.getPublicModels().map((model) => model.key)).toEqual([
      'gateway/vendor/model',
      'project/project-model',
    ]);
  });

  it('does not report applied when only the display registry contains the saved model', async () => {
    const h = createHarness();
    h.config.getModelProviderManager = () => ({
      getModel: vi.fn(async () => undefined),
    });
    await expect(
      createLocalProviderFromTui(h.asConfig, input),
    ).resolves.toEqual({
      modelKey: 'gateway/vendor/model',
      applied: false,
    });
    expect(h.disk().providers?.['gateway']).toBeDefined();
  });

  it('keeps concurrent unrelated configurations when creating', async () => {
    const h = createHarness({ custom: 'keep' });
    h.writeDisk({ custom: 'keep', providers: { other: provider } });
    await createLocalProviderFromTui(h.asConfig, input);
    expect(h.disk()).toMatchObject({
      custom: 'keep',
      providers: { other: provider },
    });
    expect(
      h.registry
        .getPublicModels()
        .map((model) => model.key)
        .sort(),
    ).toEqual(['gateway/vendor/model', 'other/vendor/model']);
  });

  it.each(['create', 'update'] as const)(
    'reports durable %s separately from a failed refresh',
    async (operation) => {
      const h = createHarness(
        operation === 'update' ? { providers: { gateway: provider } } : {},
      );
      h.config.replaceCustomProviderSettings.mockRejectedValueOnce(
        new Error('runtime unavailable'),
      );
      const result =
        operation === 'create'
          ? await createLocalProviderFromTui(h.asConfig, input)
          : await updateLocalModelFromTui(
              h.asConfig,
              getLocalModelEdit(h.asConfig, 'gateway/vendor/model')!,
              {
                baseUrl: 'https://updated.example',
                model: { model: 'vendor/model' },
              },
            );
      expect(result).toEqual({
        modelKey: 'gateway/vendor/model',
        applied: false,
      });
      expect(h.disk().providers?.['gateway']).toBeDefined();
    },
  );

  it.each(['sdk', 'disabled', 'access-denied', 'readonly'] as const)(
    'rejects creation before writing (%s)',
    async (scenario) => {
      const h = createHarness();
      if (scenario === 'sdk' || scenario === 'disabled')
        h.state.accessMode = scenario;
      if (scenario === 'access-denied')
        h.config.ensureCustomProvidersAccess.mockResolvedValueOnce(false);
      if (scenario === 'readonly') h.state.readOnly = true;
      await expect(
        createLocalProviderFromTui(h.asConfig, input),
      ).rejects.toMatchObject({
        code:
          scenario === 'readonly'
            ? CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.persistFailed
            : CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.accessDenied,
      });
      expect(h.source.mutate).not.toHaveBeenCalled();
    },
  );

  it.each([
    'user',
    'project',
    'local',
    'flag',
    'shared',
    'readonly',
    'changed',
  ] as const)(
    'deletes only a user-owned single-model provider (%s)',
    async (scope) => {
      const own = {
        ...provider,
        ...(scope === 'shared'
          ? { models: [{ model: 'vendor/model' }, { model: 'other' }] }
          : {}),
      };
      const initial = { theme: 'keep', providers: { gateway: own } };
      const h = createHarness(initial);
      if (scope === 'project' || scope === 'local' || scope === 'flag')
        h.overrides[scope]['gateway'] = own;
      if (scope === 'readonly') h.state.readOnly = true;
      if (scope === 'changed') {
        expect(
          getLocalProviderDeletionBlock(h.asConfig, 'gateway/vendor/model'),
        ).toBeUndefined();
        h.overrides.project['gateway'] = own;
      }
      if (scope === 'user') {
        await deleteLocalProviderFromTui(h.asConfig, 'gateway/vendor/model');
        expect(h.disk()).toEqual({ theme: 'keep', providers: {} });
      } else {
        expect(
          getLocalProviderDeletionBlock(h.asConfig, 'gateway/vendor/model'),
        ).toBe(scope === 'shared' ? 'shared' : 'source');
        await expect(
          deleteLocalProviderFromTui(h.asConfig, 'gateway/vendor/model'),
        ).rejects.toMatchObject({
          code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.accessDenied,
        });
        expect(h.disk()).toEqual(initial);
      }
    },
  );

  it('does not block user edits because of an untrusted project override', async () => {
    const h = createHarness({ providers: { gateway: provider } });
    h.state.trusted = false;
    h.overrides.project['gateway'] = provider;
    expect(
      getLocalProviderDeletionBlock(h.asConfig, 'gateway/vendor/model'),
    ).toBeUndefined();
    await deleteLocalProviderFromTui(h.asConfig, 'gateway/vendor/model');
    expect(h.disk().providers).toEqual({});
  });

  it('allows editing an owned provider without a legacy registry snapshot', () => {
    const h = createHarness({ providers: { gateway: provider } });
    h.registry.clear();
    expect(
      getLocalProviderDeletionBlock(h.asConfig, 'gateway/vendor/model'),
    ).toBeUndefined();
    expect(getLocalModelEdit(h.asConfig, 'gateway/vendor/model')).toMatchObject(
      {
        providerId: 'gateway',
        modelKey: 'gateway/vendor/model',
      },
    );
  });

  it.each(['edit', 'delete-shared', 'delete-removed'] as const)(
    'delegates transaction-time conflict checks (%s)',
    async (operation) => {
      const h = createHarness({ providers: { gateway: provider } });
      const original = getLocalModelEdit(h.asConfig, 'gateway/vendor/model')!;
      const latest: SettingsRoot = {
        providers:
          operation === 'delete-removed'
            ? {}
            : {
                gateway:
                  operation === 'edit'
                    ? { ...provider, baseUrl: 'https://changed.example' }
                    : {
                        ...provider,
                        models: [{ model: 'vendor/model' }, { model: 'other' }],
                      },
              },
      };
      const mutate = h.source.mutate.getMockImplementation()!;
      h.source.mutate.mockImplementationOnce((mutation) => {
        h.writeDisk(latest);
        return mutate(mutation);
      });
      await expect(
        operation === 'edit'
          ? updateLocalModelFromTui(h.asConfig, original, {
              baseUrl: original.baseUrl,
              model: original.model,
            })
          : deleteLocalProviderFromTui(h.asConfig, 'gateway/vendor/model'),
      ).rejects.toMatchObject({
        code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.accessDenied,
      });
      expect(h.disk()).toEqual(latest);
      expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
    },
  );

  it('updates through the manager and then refreshes the session', async () => {
    vi.stubEnv('LOCAL_EDIT_KEY', 'resolved-secret');
    const h = createHarness({
      providers: { gateway: { ...provider, apiKey: '${LOCAL_EDIT_KEY}' } },
    });
    const original = getLocalModelEdit(h.asConfig, 'gateway/vendor/model')!;
    expect(JSON.stringify(original)).not.toContain('resolved-secret');
    const update = vi.spyOn(h.manager, 'updateModel');
    const patch = {
      baseUrl: original.baseUrl,
      model: { ...original.model, contextWindow: 256000 },
    };
    await expect(
      updateLocalModelFromTui(h.asConfig, original, patch),
    ).resolves.toEqual({ modelKey: original.modelKey, applied: true });
    expect(update).toHaveBeenCalledWith(original, patch);
    expect(h.disk().providers?.['gateway']?.['apiKey']).toBe(
      '${LOCAL_EDIT_KEY}',
    );
    expect(h.registry.getPublicModels()[0]?.contextWindow).toBe(256000);
  });
});
