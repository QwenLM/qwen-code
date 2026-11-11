/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveEnvVarsInObject,
  type LoadedSettings,
  type SettingsService,
} from '@qwen-code/resource';
import type { Config } from '../../config/config.js';
import { Storage } from '../../config/storage.js';
import { CustomProviderRegistry } from './registry.js';
import { runLogger } from '../../utils/runLogger.js';
import { CUSTOM_MODEL_PROVIDER_CONFIG_ERROR } from '../impl/customModelProviderConfigCommon.js';
import { CustomProviderManager } from './customProviderManager.js';

type ProviderMap = Record<string, Record<string, unknown>>;
type OverrideScope = 'project' | 'local' | 'flag';
type SettingsRoot = Record<string, unknown> & { providers?: ProviderMap };

/**
 * 内存版 user settings：`mutate` 语义与 SettingsService 的 user source 一致，
 * 会话快照只在 `reloadModelConfigFromDisk` 时刷新。
 */
function createHarness(initial: SettingsRoot = {}) {
  let disk: SettingsRoot = structuredClone(initial);
  const overrides: Record<OverrideScope, ProviderMap> = {
    project: {},
    local: {},
    flag: {},
  };
  const state = {
    readOnly: false,
    sourceAvailable: true,
    accessMode: 'local' as 'sdk' | 'local' | 'disabled',
  };
  const snapshot = (): LoadedSettings => {
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
      isTrusted: true,
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
    peekUserSettingsSource: vi.fn(() =>
      state.sourceAvailable ? source : undefined,
    ),
  };
  const manager = new CustomProviderManager(
    settingsService as unknown as SettingsService,
  );
  const registry = new CustomProviderRegistry();
  const config = {
    getCustomProviderManager: () => manager,
    getLoadedSettings: () => loaded,
    getSettingsService: () => settingsService,
    reloadModelConfigFromDisk: vi.fn(async () => {
      loaded = snapshot();
    }),
    ensureCustomProvidersAccess: vi.fn(async () => true),
    getCustomProviderAccessMode: () => state.accessMode,
    getCustomProviderRegistry: () => registry,
    replaceCustomProviderSettings: vi.fn(async (providers: unknown) => {
      registry.replace(providers);
      return { status: 'active' };
    }),
    getModelProviderManager: () => ({ getModel: async () => undefined }),
  };
  return {
    config,
    asConfig: config as unknown as Config,
    source,
    settingsService,
    manager,
    registry,
    overrides,
    state,
    disk: () => disk,
    /** 模拟另一个写者：只改盘面，不刷新会话快照。 */
    writeDisk: (value: SettingsRoot) => {
      disk = structuredClone(value);
    },
  };
}

function loggedEntries(level: 'log' | 'warn' | 'error') {
  return vi
    .mocked(runLogger[level])
    .mock.calls.map(([line]) => String(line))
    .filter((line) => line.startsWith('[custom-provider] {'))
    .map((line) => JSON.parse(line.slice('[custom-provider] '.length)));
}

const gatewayInput = {
  providerId: 'gateway',
  baseUrl: 'https://gateway.example/v1',
  apiKey: 'private-test-credential',
  model: 'model-1',
};

describe('CustomProviderManager', () => {
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(runLogger, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reads a model edit directly from the shared source without a session registry', () => {
    const h = createHarness({
      providers: {
        gateway: {
          baseUrl: 'https://gateway.example',
          apiKey: 'private-key',
          model: 'vendor/model',
        },
      },
    });
    const edit = h.manager.getModelEdit('gateway/vendor/model');
    expect(edit).toMatchObject({
      providerId: 'gateway',
      modelKey: 'gateway/vendor/model',
      hasApiKey: true,
    });
    expect(JSON.stringify(edit)).not.toContain('private-key');
    expect(h.registry.getPublicModels()).toEqual([]);
    expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
  });

  it('edits capabilities without losing credentials or advanced provider settings', async () => {
    const provider = {
      baseUrl: 'https://gateway.example/v1',
      protocol: 'anthropic' as const,
      anthropic: { version: '2023-06-01', betas: ['old-beta'] },
      apiKey: '${LOCAL_EDIT_KEY}',
      firstPayloadTimeoutMs: 12345,
      model: 'model',
      models: [
        { model: 'model', maxTokensField: 'max_completion_tokens' as const },
      ],
    };
    vi.stubEnv('LOCAL_EDIT_KEY', 'resolved-secret');
    const h = createHarness({
      providers: { gateway: provider },
      theme: 'keep',
    });
    h.registry.replace({ gateway: { ...provider, apiKey: 'resolved-secret' } });

    const original = h.manager.getModelEdit('gateway/model')!;
    expect(original).toBeDefined();
    expect(JSON.stringify(original)).not.toContain('LOCAL_EDIT_KEY');
    expect(JSON.stringify(original)).not.toContain('resolved-secret');

    await h.manager.updateModel(original, {
      baseUrl: original.baseUrl,
      model: {
        ...original.model,
        contextWindow: 256000,
        capabilities: {
          ...original.model.capabilities,
          vision: true,
          thinking: {
            modes: ['enabled'],
            requiresBudgetForEnabled: false,
            supportedEffortLevels: ['low', 'high'],
          },
        },
      },
    });

    expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
    expect(h.disk().providers?.['gateway']).toMatchObject({
      apiKey: '${LOCAL_EDIT_KEY}',
      firstPayloadTimeoutMs: 12345,
      anthropic: { version: '2023-06-01', betas: ['old-beta'] },
      models: [
        {
          model: 'model',
          contextWindow: 256000,
          maxTokensField: 'max_completion_tokens',
        },
      ],
    });
    expect(h.disk()['theme']).toBe('keep');
    expect(h.manager.getModelEdit('gateway/model')?.model).toMatchObject({
      contextWindow: 256000,
      capabilities: {
        vision: true,
        thinking: { supportedEffortLevels: ['low', 'high'] },
      },
    });
    await expect(
      h.manager.updateModel(original, {
        baseUrl: original.baseUrl,
        model: original.model,
      }),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.accessDenied,
    });
  });

  it('deletes a single-model configuration without changing unrelated settings', async () => {
    const h = createHarness({
      theme: 'keep',
      providers: {
        gateway: {
          baseUrl: 'https://gateway.example',
          apiKey: '',
          model: 'vendor/model',
        },
      },
    });
    await h.manager.deleteModel('gateway/vendor/model');
    expect(h.disk()).toEqual({ theme: 'keep', providers: {} });
    expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
  });

  it.each(['edit', 'delete-shared', 'delete-removed'] as const)(
    'validates the latest transaction value while the session is stale (%s)',
    async (operation) => {
      const provider = {
        baseUrl: 'https://gateway.example',
        apiKey: '',
        model: 'model',
      };
      const h = createHarness({ providers: { gateway: provider } });
      h.registry.replace({ gateway: provider });
      const loaded = h.config.getLoadedSettings();
      const original = h.manager.getModelEdit('gateway/model')!;
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
                        models: [{ model: 'model' }, { model: 'other' }],
                      },
              },
      };
      const mutate = h.source.mutate.getMockImplementation()!;
      h.source.mutate.mockImplementationOnce((mutation) => {
        // Another writer wins after the UI check, before the transaction runs.
        h.writeDisk(latest);
        return mutate(mutation);
      });

      await expect(
        operation === 'edit'
          ? h.manager.updateModel(original, {
              baseUrl: original.baseUrl,
              model: original.model,
            })
          : h.manager.deleteModel('gateway/model'),
      ).rejects.toMatchObject({
        code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.accessDenied,
      });
      expect(h.disk()).toEqual(latest);
      expect(h.config.getLoadedSettings()).toBe(loaded);
      expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
      expect(h.config.replaceCustomProviderSettings).not.toHaveBeenCalled();
    },
  );

  it('leaves every CRUD operation free of access checks', async () => {
    const h = createHarness();
    const manager = h.manager;

    await manager.create(gatewayInput);
    await manager.update({ providerId: 'gateway', displayName: 'Gateway' });
    await manager.check(gatewayInput);
    expect(await manager.list()).toHaveLength(1);
    expect(await manager.listCached('uid')).toHaveLength(1);
    await manager.delete({ providerId: 'gateway' });

    expect(h.config.ensureCustomProvidersAccess).not.toHaveBeenCalled();
    expect(h.disk().providers).toEqual({});
  });

  it('rejects configurations without a providerId', async () => {
    const h = createHarness();
    await expect(
      h.manager.create({
        provider: 'openai',
        model: 'gpt-test',
        parameters: { api_key: 'secret' },
      }),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.accessDenied,
      message:
        'Only Custom Provider configurations are available in this runtime',
    });
    expect(h.source.mutate).not.toHaveBeenCalled();
  });

  it('logs the invalid field without changing the validation error', async () => {
    const h = createHarness();
    await expect(
      h.manager.check(
        { ...gatewayInput, protocol: 'invalid' },
        undefined,
        'invalid-field',
      ),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.invalid,
    });
    expect(loggedEntries('warn')).toContainEqual(
      expect.objectContaining({
        request_id: 'invalid-field',
        operation: 'check',
        result: 'failed',
        stage: 'validation',
        field: 'protocol',
        code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.invalid,
      }),
    );
    expect(JSON.stringify(loggedEntries('warn'))).not.toContain(
      'private-test-credential',
    );
  });

  it('reports failed settings writes without leaking parser excerpts', async () => {
    const h = createHarness();
    h.source.mutate.mockImplementationOnce(() => {
      throw new SyntaxError(
        'Unexpected token in {"private-unknown-credential"',
      );
    });

    await expect(
      h.manager.create(gatewayInput, 'bad-settings'),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.persistFailed,
    });
    expect(loggedEntries('error')).toContainEqual(
      expect.objectContaining({
        request_id: 'bad-settings',
        result: 'failed',
        stage: 'parse',
        storage: 'settings.providers',
        code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.persistFailed,
        reason: 'Failed to parse stored provider configuration',
      }),
    );
    const output = JSON.stringify(loggedEntries('error'));
    expect(output).not.toContain('private-unknown-credential');
    expect(output).not.toContain('private-test-credential');
    expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
  });

  it('rejects writes when the shared user source is unavailable', async () => {
    const h = createHarness();
    h.state.sourceAvailable = false;
    await expect(h.manager.create(gatewayInput)).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.persistFailed,
    });
    expect(h.source.mutate).not.toHaveBeenCalled();
    expect(h.disk()).toEqual({});
  });

  it('does not capture any session source policy', async () => {
    const h = createHarness();
    h.state.readOnly = true;
    await expect(h.manager.create(gatewayInput)).resolves.toEqual({
      providerId: 'gateway',
    });
  });

  it('writes through the shared source without capturing or refreshing a session', async () => {
    const h = createHarness();
    const snapshot = h.config.getLoadedSettings();
    await h.manager.create(gatewayInput);
    expect(h.settingsService.peekUserSettingsSource).toHaveBeenCalledWith(
      Storage.getGlobalSettingsPath(),
    );
    expect(h.source.mutate).toHaveBeenCalledOnce();
    expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
    expect(h.config.getLoadedSettings()).toBe(snapshot);
    expect(await h.manager.list()).toHaveLength(1);
  });

  it('actively reads external edits without consulting the session snapshot', async () => {
    const h = createHarness();
    expect(await h.manager.list()).toEqual([]);
    h.writeDisk({
      providers: {
        gateway: {
          baseUrl: gatewayInput.baseUrl,
          apiKey: gatewayInput.apiKey,
          model: gatewayInput.model,
        },
      },
    });
    expect(await h.manager.list()).toMatchObject([{ providerId: 'gateway' }]);
    expect(h.source.invalidate).toHaveBeenCalledTimes(2);
    expect(
      h.config.getLoadedSettings().user.settings.providers,
    ).toBeUndefined();
    expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
  });

  it('logs storage completion, changed field names and list counts', async () => {
    const h = createHarness();
    const manager = h.manager;
    await manager.create(
      { ...gatewayInput, apiKey: 'private-old-credential' },
      'created',
    );
    await manager.update(
      { providerId: 'gateway', apiKey: 'private-new-credential' },
      'updated',
    );
    await manager.list('listed');
    await manager.delete({ providerId: 'gateway' }, 'deleted');

    expect(loggedEntries('log')).toContainEqual(
      expect.objectContaining({
        request_id: 'updated',
        result: 'success',
        persisted: true,
        changed_fields: 'apiKey',
        storage: 'settings.providers',
      }),
    );
    expect(loggedEntries('log')).toContainEqual(
      expect.objectContaining({
        request_id: 'listed',
        result: 'success',
        custom_provider_count: 1,
      }),
    );
    expect(loggedEntries('log')).toContainEqual(
      expect.objectContaining({
        request_id: 'deleted',
        result: 'success',
        persisted: true,
      }),
    );
    const output = JSON.stringify(loggedEntries('log'));
    expect(output).not.toContain('private-old-credential');
    expect(output).not.toContain('private-new-credential');
  });

  it('rejects an empty cache uid', async () => {
    const h = createHarness();
    await expect(h.manager.listCached(' ')).rejects.toThrow('requires uid');
  });

  it.each([false, true])(
    'lists secret-free Custom Provider configs (cacheOnly=%s)',
    async (cacheOnly) => {
      const h = createHarness({
        providers: {
          openai: {
            baseUrl: 'https://custom.example/v1',
            apiKey: 'secret-value',
            protocol: 'openai-responses',
            model: 'custom-model',
          },
        },
        modelConfigs: {
          customModels: [
            {
              provider: 'manual',
              model: 'manual-model',
              apiKey: 'manual-secret',
            },
          ],
        },
      });
      if (cacheOnly) {
        h.config.ensureCustomProvidersAccess.mockImplementation(
          () => new Promise(() => {}),
        );
      }
      const manager = h.manager;

      const result = cacheOnly
        ? await manager.listCached('cache-user')
        : await manager.list();

      if (cacheOnly)
        expect(h.config.ensureCustomProvidersAccess).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        providerId: 'openai',
        protocol: 'openai-responses',
        defaultModelId: 'custom-model',
        models: [expect.objectContaining({ id: 'custom-model' })],
      });
      expect(JSON.stringify(result)).not.toContain('secret-value');
      expect(JSON.stringify(result)).not.toContain('manual-model');
    },
  );

  it('creates, updates and deletes a Custom Provider without dropping advanced fields', async () => {
    const h = createHarness({
      theme: 'dark',
      providers: {
        gateway: {
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'key-1',
          model: 'model-1',
          routing: { summary: 'model-1' },
        },
      },
    });
    const manager = h.manager;

    await expect(
      manager.create({
        providerId: 'second-gateway',
        baseUrl: 'https://second.example/v1',
        apiKey: 'key-2',
        protocol: 'anthropic',
        model: 'model-2',
      }),
    ).resolves.toEqual({ providerId: 'second-gateway' });

    await manager.update({
      providerId: 'gateway',
      baseUrl: 'https://gateway.example/v2',
    });
    expect(h.disk()).toMatchObject({
      theme: 'dark',
      providers: {
        gateway: {
          baseUrl: 'https://gateway.example/v2',
          apiKey: 'key-1',
          routing: { summary: 'model-1' },
        },
      },
    });

    await manager.delete({ providerId: 'second-gateway' });
    expect(h.disk()).toEqual({
      theme: 'dark',
      providers: {
        gateway: {
          baseUrl: 'https://gateway.example/v2',
          apiKey: 'key-1',
          model: 'model-1',
          routing: { summary: 'model-1' },
        },
      },
    });
    expect(h.config.reloadModelConfigFromDisk).not.toHaveBeenCalled();
    expect(await manager.list()).toMatchObject([
      { providerId: 'gateway', baseUrl: 'https://gateway.example/v2' },
    ]);
    await expect(
      manager.delete({ providerId: 'second-gateway' }),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.notFound,
    });
    await expect(
      manager.create({ ...gatewayInput, providerId: 'gateway' }),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.alreadyExists,
    });
  });

  it('checks, creates and explicitly clears an empty Custom Provider API key', async () => {
    const h = createHarness();
    const manager = h.manager;
    const input = {
      providerId: 'local-gateway',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      protocol: 'openai' as const,
      model: 'local-model',
    };

    await expect(manager.check(input)).resolves.toBeUndefined();
    await expect(manager.create(input)).resolves.toEqual({
      providerId: 'local-gateway',
    });
    expect(h.disk().providers?.['local-gateway']).toMatchObject({
      apiKey: '',
    });

    await manager.update({
      providerId: 'local-gateway',
      apiKey: 'temporary-key',
    });
    await manager.update({ providerId: 'local-gateway', apiKey: '' });
    expect(h.disk().providers?.['local-gateway']).toMatchObject({
      apiKey: '',
    });

    await expect(
      manager.check({ ...input, apiKey: '   ' }),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.invalid,
      message: 'apiKey must be a non-empty string',
    });
  });

  it('persists model capabilities when creating and updating a Custom Provider', async () => {
    const h = createHarness();
    const manager = h.manager;
    const capabilities = {
      tools: true,
      vision: true,
      cacheControl: true,
      thinking: {
        modes: ['enabled', 'adaptive'],
        preferredMode: 'adaptive',
        requiresBudgetForEnabled: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'],
        requiredBetasForEffort: ['effort-beta'],
      },
    };

    await manager.create({
      providerId: 'gateway',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'secret',
      protocol: 'anthropic',
      model: 'model-1',
      models: [{ model: 'model-1', capabilities }],
    });
    expect(h.disk().providers?.['gateway']).toMatchObject({
      models: [{ model: 'model-1', capabilities }],
    });

    const disabled = {
      vision: false,
      thinking: {
        modes: [],
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    };
    await manager.update({
      providerId: 'gateway',
      models: [{ model: 'model-1', capabilities: disabled }],
    });
    expect(h.disk().providers?.['gateway']).toMatchObject({
      models: [{ model: 'model-1', capabilities: disabled }],
    });
  });

  it('rejects invalid Custom Provider model capabilities at the control boundary', async () => {
    const h = createHarness();
    await expect(
      h.manager.create({
        providerId: 'gateway',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'secret',
        models: [{ model: 'model-1', capabilities: { vision: 'yes' } }],
      }),
    ).rejects.toMatchObject({
      code: CUSTOM_MODEL_PROVIDER_CONFIG_ERROR.invalid,
      field: 'models[0].capabilities.vision',
    });
    expect(h.source.mutate).not.toHaveBeenCalled();
  });

  it('checks Custom Provider candidates locally without persisting them', async () => {
    const h = createHarness();
    await h.manager.check(
      {
        providerId: 'gateway',
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'secret',
        protocol: 'openai',
        model: 'z-ai/glm-5.3-flash',
      },
      undefined,
      'custom-local-check',
    );

    expect(h.source.mutate).not.toHaveBeenCalled();
    expect(loggedEntries('log')).toContainEqual(
      expect.objectContaining({
        request_id: 'custom-local-check',
        operation: 'check',
        stage: 'validation',
        result: 'success',
      }),
    );
  });
});
