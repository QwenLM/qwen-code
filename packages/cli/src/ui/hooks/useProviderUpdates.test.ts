/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import {
  AuthType,
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  CODING_PLAN_GLOBAL_BASE_URL,
  codingPlanProvider,
  TOKEN_PLAN_BASE_URL,
  TOKEN_PLAN_ENV_KEY,
  tokenPlanProvider,
  buildProviderTemplate,
  computeModelListVersion,
  PROVIDER_METADATA_NS,
} from '@qwen-code/qwen-code-core';
import { backupSettingsFile } from '../../utils/settingsUtils.js';
import { useProviderUpdates } from './useProviderUpdates.js';
import { useUiProviderTransaction } from './use-ui-provider-transaction.js';

vi.mock('../../utils/settingsUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/settingsUtils.js')>();
  return {
    ...actual,
    backupSettingsFile: vi.fn(),
    restoreSettingsFromBackup: vi.fn(),
    cleanupSettingsBackup: vi.fn(),
  };
});

const chinaTemplate = buildProviderTemplate(
  codingPlanProvider,
  CODING_PLAN_CHINA_BASE_URL,
);
const chinaVersion = computeModelListVersion(chinaTemplate);

const tokenTemplate = buildProviderTemplate(
  tokenPlanProvider,
  TOKEN_PLAN_BASE_URL,
);
const tokenVersion = computeModelListVersion(tokenTemplate);

const METADATA_KEY = 'coding-plan';
const TOKEN_METADATA_KEY = 'token-plan';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('useProviderUpdates', () => {
  const mockSettings = {
    merged: {
      modelProviders: {} as Record<string, unknown>,
      [PROVIDER_METADATA_NS]: {} as Record<string, unknown>,
    } as Record<string, unknown>,
    setValue: vi.fn(),
    setValues: vi.fn(),
    forScope: vi.fn(() => ({ path: '/tmp/settings.json' })),
    recomputeMerged: vi.fn(),
    isTrusted: true,
    workspace: { settings: {} },
    user: { settings: {} },
  };

  const mockModelsConfig = {
    syncAfterAuthRefresh: vi.fn(),
  };

  const mockConfig = {
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn(),
    getContentGeneratorConfig: vi.fn().mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      apiKeyEnvKey: CODING_PLAN_ENV_KEY,
    }),
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
    getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
    getCurrentModelRegistryBaseUrl: vi.fn(() => CODING_PLAN_CHINA_BASE_URL),
    getModel: vi.fn().mockReturnValue('qwen3.5-plus'),
    switchModel: vi.fn().mockResolvedValue(undefined),
    resetAuth: vi.fn(),
    getModelsConfig: vi.fn(() => mockModelsConfig),
  };

  const mockAddItem = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.merged['modelProviders'] = {};
    mockSettings.merged[PROVIDER_METADATA_NS] = {};
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      apiKeyEnvKey: CODING_PLAN_ENV_KEY,
    });
    mockConfig.getAuthType.mockReturnValue(AuthType.USE_OPENAI);
    mockConfig.getActiveRuntimeModelSnapshot.mockReturnValue(undefined);
    mockConfig.getCurrentModelRegistryBaseUrl.mockReturnValue(
      CODING_PLAN_CHINA_BASE_URL,
    );
    mockConfig.getModel.mockReturnValue('qwen3.5-plus');
    mockConfig.switchModel.mockResolvedValue(undefined);
    mockConfig.refreshAuth.mockReset();
    mockModelsConfig.syncAfterAuthRefresh.mockReset();
    delete process.env[CODING_PLAN_ENV_KEY];
  });

  it('does not show update prompt when no version is stored', () => {
    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
  });

  it('does not show update prompt when versions match', () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: chinaVersion,
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
  });

  it('uses the stored non-default base URL when versions match', () => {
    const globalTemplate = buildProviderTemplate(
      codingPlanProvider,
      CODING_PLAN_GLOBAL_BASE_URL,
    );
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_GLOBAL_BASE_URL,
      version: computeModelListVersion(globalTemplate),
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: globalTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
  });

  it('shows update prompt with structured diff when versions differ', async () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    const entry = result.current.providerUpdateRequest?.entries[0];
    expect(entry?.providerLabel).toContain('Coding Plan');
    expect(entry?.diff).toBeDefined();
    expect(entry?.diff.currentModelAffected).toBe(false);
  });

  it('waits for an active provider transaction before taking an update backup and suppresses stale feedback', async () => {
    const authDeferred = createDeferred<void>();
    const authStarted = createDeferred<void>();
    const refreshDeferred = createDeferred<void>();
    mockConfig.refreshAuth.mockImplementation(() => refreshDeferred.promise);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() => {
      const transaction = useUiProviderTransaction();
      const updates = useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
        transaction.run,
      );
      return { transaction, updates };
    });

    await waitFor(() => {
      expect(result.current.updates.providerUpdateRequest).toBeDefined();
    });

    const authInstall = result.current.transaction.run(async () => {
      authStarted.resolve();
      await authDeferred.promise;
    });
    await authStarted.promise;

    const update =
      result.current.updates.providerUpdateRequest!.onConfirm('update');
    await Promise.resolve();

    expect(backupSettingsFile).not.toHaveBeenCalled();
    expect(result.current.updates.providerUpdateRequest).toBeDefined();

    authDeferred.resolve();
    await authInstall;

    await waitFor(() => {
      expect(backupSettingsFile).toHaveBeenCalledTimes(1);
      expect(mockConfig.refreshAuth).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        undefined,
        expect.any(Function),
      );
    });

    const successor = result.current.transaction.run(async () => {});
    refreshDeferred.reject(new Error('stale refresh failed'));

    await update;
    await successor;

    expect(mockAddItem).not.toHaveBeenCalled();
  });

  it('restores the pre-update runtime after a cancelled provider refresh mutates it', async () => {
    const baselineRuntime = {
      authType: AuthType.USE_OPENAI,
      modelId: 'baseline-model',
      baseUrl: 'https://baseline.example/v1',
    };
    const runtime = { ...baselineRuntime };
    const refreshStarted = createDeferred<void>();
    const refreshDeferred = createDeferred<void>();
    mockConfig.getAuthType.mockImplementation(() => runtime.authType);
    mockConfig.getModel.mockImplementation(() => runtime.modelId);
    mockConfig.getCurrentModelRegistryBaseUrl.mockImplementation(
      () => runtime.baseUrl,
    );
    mockConfig.switchModel.mockImplementation(
      async (authType, modelId, options) => {
        runtime.authType = authType;
        runtime.modelId = modelId;
        runtime.baseUrl = options.baseUrl ?? '';
      },
    );
    mockConfig.refreshAuth.mockImplementation(async () => {
      runtime.modelId = 'updated-model';
      runtime.baseUrl = 'https://updated.example/v1';
      refreshStarted.resolve();
      await refreshDeferred.promise;
    });
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() => {
      const transaction = useUiProviderTransaction();
      const updates = useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
        transaction.run,
      );
      return { transaction, updates };
    });

    await waitFor(() => {
      expect(result.current.updates.providerUpdateRequest).toBeDefined();
    });

    const update =
      result.current.updates.providerUpdateRequest!.onConfirm('update');
    await refreshStarted.promise;
    expect(runtime).toEqual({
      ...baselineRuntime,
      modelId: 'updated-model',
      baseUrl: 'https://updated.example/v1',
    });

    const successor = result.current.transaction.run(async () => {});
    refreshDeferred.resolve();
    await Promise.all([update, successor]);

    expect(mockConfig.switchModel).toHaveBeenCalledWith(
      baselineRuntime.authType,
      baselineRuntime.modelId,
      { baseUrl: baselineRuntime.baseUrl },
    );
    expect(runtime).toEqual(baselineRuntime);
  });

  it.each(['skip', 'later'] as const)(
    'queues a %s confirmation until an active provider transaction settles',
    async (choice) => {
      const authDeferred = createDeferred<void>();
      const authStarted = createDeferred<void>();
      (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
        METADATA_KEY
      ] = {
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        version: 'old-version-hash',
      };
      mockSettings.merged['modelProviders'] = {
        [AuthType.USE_OPENAI]: chinaTemplate,
      };

      const { result } = renderHook(() => {
        const transaction = useUiProviderTransaction();
        const updates = useProviderUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
          transaction.run,
        );
        return { transaction, updates };
      });

      await waitFor(() => {
        expect(result.current.updates.providerUpdateRequest).toBeDefined();
      });

      const authInstall = result.current.transaction.run(async () => {
        authStarted.resolve();
        await authDeferred.promise;
      });
      await authStarted.promise;

      const confirmation =
        result.current.updates.providerUpdateRequest!.onConfirm(choice);
      await Promise.resolve();

      expect(result.current.updates.providerUpdateRequest).toBeDefined();
      expect(mockSettings.setValue).not.toHaveBeenCalled();
      expect(mockSettings.setValues).not.toHaveBeenCalled();

      authDeferred.resolve();
      await authInstall;
      await confirmation;

      if (choice === 'skip') {
        expect(mockSettings.setValues).toHaveBeenCalledTimes(1);
        expect(mockSettings.setValues).toHaveBeenCalledWith([
          {
            scope: 'User',
            key: `${PROVIDER_METADATA_NS}.${METADATA_KEY}.ignoredVersion`,
            value: chinaVersion,
          },
        ]);
        expect(mockSettings.setValue).not.toHaveBeenCalled();
      } else {
        expect(mockSettings.setValues).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('leaves a stale queued skip confirmation visible without writes or feedback', async () => {
    const activeDeferred = createDeferred<void>();
    const activeStarted = createDeferred<void>();
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() => {
      const transaction = useUiProviderTransaction();
      const updates = useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
        transaction.run,
      );
      return { transaction, updates };
    });

    await waitFor(() => {
      expect(result.current.updates.providerUpdateRequest).toBeDefined();
    });

    const active = result.current.transaction.run(async () => {
      activeStarted.resolve();
      await activeDeferred.promise;
    });
    await activeStarted.promise;

    const confirmation =
      result.current.updates.providerUpdateRequest!.onConfirm('skip');
    await Promise.resolve();

    const successor = result.current.transaction.run(async () => {});
    activeDeferred.resolve();
    await Promise.all([active, confirmation, successor]);

    expect(result.current.updates.providerUpdateRequest).toBeDefined();
    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(mockSettings.setValues).not.toHaveBeenCalled();
    expect(mockAddItem).not.toHaveBeenCalled();
  });

  it('excludes user-added custom models from the diff', async () => {
    mockConfig.getModel.mockReturnValue('my-custom-model');
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [
        ...chinaTemplate,
        {
          id: 'my-custom-model',
          baseUrl: CODING_PLAN_CHINA_BASE_URL,
          envKey: CODING_PLAN_ENV_KEY,
          name: '[Coding Plan] my-custom-model',
        },
      ],
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    const entry = result.current.providerUpdateRequest?.entries[0];
    expect(entry?.diff.removed).not.toContain('my-custom-model');
    expect(entry?.diff.currentModelAffected).toBe(false);
  });

  it('detects newly added built-in models when the template grows', async () => {
    // Simulate an older install that lacks the last built-in model.
    const olderTemplate = chinaTemplate.slice(0, -1);
    const addedModelId = chinaTemplate[chinaTemplate.length - 1]!.id;
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: olderTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    const entry = result.current.providerUpdateRequest?.entries[0];
    expect(entry?.diff.added).toContain(addedModelId);
  });

  it('persists the template version and preserves custom models', async () => {
    const customModel = {
      id: 'my-custom-model',
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      envKey: CODING_PLAN_ENV_KEY,
      name: '[Coding Plan] my-custom-model',
    };
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...chinaTemplate, customModel],
    };
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    });

    const reloaded = mockConfig.reloadModelProvidersConfig.mock.calls[0][0];
    expect(reloaded[AuthType.USE_OPENAI]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'my-custom-model' }),
      ]),
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.version`,
      chinaVersion,
    );
  });

  it('executes update when user confirms with "update"', async () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [
        ...chinaTemplate,
        {
          id: 'custom-model',
          baseUrl: 'https://custom.example.com',
          envKey: 'CUSTOM_API_KEY',
        },
      ],
    };
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockSettings.setValue).toHaveBeenCalled();
    });

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.baseUrl`,
      CODING_PLAN_CHINA_BASE_URL,
    );
    expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    expect(mockModelsConfig.syncAfterAuthRefresh).not.toHaveBeenCalled();
    expect(mockConfig.refreshAuth).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      undefined,
      expect.any(Function),
    );
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'security.auth.selectedType',
      expect.anything(),
    );
  });

  it('preserves the stored global base URL when updating', async () => {
    const globalTemplate = buildProviderTemplate(
      codingPlanProvider,
      CODING_PLAN_GLOBAL_BASE_URL,
    );
    const globalVersion = computeModelListVersion(globalTemplate);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_GLOBAL_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: globalTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
    await result.current.providerUpdateRequest!.onConfirm('update');

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.baseUrl`,
      CODING_PLAN_GLOBAL_BASE_URL,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.version`,
      globalVersion,
    );
  });

  it('updates both provider metadata keys from a batched prompt', async () => {
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs[METADATA_KEY] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    metadataNs[TOKEN_METADATA_KEY] = {
      baseUrl: TOKEN_PLAN_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...chinaTemplate, ...tokenTemplate],
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest?.entries).toHaveLength(2);
    });
    await result.current.providerUpdateRequest!.onConfirm('update');

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.version`,
      chinaVersion,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${TOKEN_METADATA_KEY}.version`,
      tokenVersion,
    );
  });

  it.each([
    {
      name: 'on the same protocol',
      activeConfig: {
        authType: AuthType.USE_OPENAI,
        baseUrl: TOKEN_PLAN_BASE_URL,
        apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
      },
    },
    {
      name: 'on a different protocol',
      activeConfig: {
        authType: AuthType.USE_GEMINI,
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKeyEnvKey: 'GEMINI_API_KEY',
      },
    },
  ])(
    'does not change auth when updating an inactive provider $name',
    async ({ activeConfig }) => {
      mockConfig.getContentGeneratorConfig.mockReturnValue(activeConfig);
      (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
        METADATA_KEY
      ] = {
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        version: 'old-version-hash',
      };
      mockSettings.merged['modelProviders'] = {
        [AuthType.USE_OPENAI]: chinaTemplate,
      };

      const { result } = renderHook(() =>
        useProviderUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      await waitFor(() => {
        expect(result.current.providerUpdateRequest).toBeDefined();
      });
      await result.current.providerUpdateRequest!.onConfirm('update');

      expect(mockConfig.refreshAuth).not.toHaveBeenCalled();
      expect(mockSettings.setValue).not.toHaveBeenCalledWith(
        expect.anything(),
        'security.auth.selectedType',
        expect.anything(),
      );
    },
  );

  it('does not refresh auth before auth initialization completes', async () => {
    mockConfig.getContentGeneratorConfig.mockReturnValue(undefined as never);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
    await result.current.providerUpdateRequest!.onConfirm('update');

    expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    expect(mockConfig.refreshAuth).not.toHaveBeenCalled();
  });

  it('does not overwrite existing env key with empty value', async () => {
    process.env[CODING_PLAN_ENV_KEY] = 'sk-sp-existing-key';
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockSettings.setValue).toHaveBeenCalled();
    });

    const envCalls = mockSettings.setValue.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[1] === 'string' && call[1].startsWith('env.'),
    );
    expect(envCalls).toHaveLength(0);
    expect(process.env[CODING_PLAN_ENV_KEY]).toBe('sk-sp-existing-key');
  });

  it('leaves the model selection alone when the previous model is gone', async () => {
    // Template updates do not carry a model-selection intent; even when the
    // current model is absent from the refreshed list the update must not
    // adopt the provider's default or touch model.name / model.baseUrl.
    mockConfig.getModel.mockReturnValue('removed-model');
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    });

    expect(mockModelsConfig.syncAfterAuthRefresh).not.toHaveBeenCalled();
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.name',
      expect.anything(),
    );
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.baseUrl',
      expect.anything(),
    );
    expect(mockAddItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: 'Coding Plan configuration updated successfully.',
      },
      expect.any(Number),
    );
  });

  it.each([
    { name: 'registered under the same protocol', registered: true },
    { name: 'provided by the active runtime config only', registered: false },
  ])('does not move the user off a model $name', async ({ registered }) => {
    const foreignModel = {
      id: 'my-own-model',
      baseUrl: 'https://my-own-gateway.example.com/v1',
      envKey: 'MY_OWN_KEY',
      name: '[Mine] my-own-model',
    };
    mockConfig.getModel.mockReturnValue('my-own-model');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: foreignModel.baseUrl,
      apiKeyEnvKey: foreignModel.envKey,
    });
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: registered
        ? [foreignModel, ...chinaTemplate]
        : chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    });

    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.name',
      expect.anything(),
    );
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.baseUrl',
      expect.anything(),
    );
    expect(mockModelsConfig.syncAfterAuthRefresh).not.toHaveBeenCalled();
    expect(mockAddItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: 'Coding Plan configuration updated successfully.',
      },
      expect.any(Number),
    );
  });

  it('leaves the model selection alone across a multi-provider batch update', async () => {
    // The worst case reported in #8863: several providers update in one
    // confirmation, and each executeUpdate in the loop used to rewrite
    // model.name in turn — the last provider in registry order won,
    // regardless of the user's intent. Neither provider owns the current
    // model here, so the whole batch must leave the selection untouched.
    const foreignModel = {
      id: 'my-own-model',
      baseUrl: 'https://my-own-gateway.example.com/v1',
      envKey: 'MY_OWN_KEY',
      name: '[Mine] my-own-model',
    };
    mockConfig.getModel.mockReturnValue('my-own-model');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: foreignModel.baseUrl,
      apiKeyEnvKey: foreignModel.envKey,
    });
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs[METADATA_KEY] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    metadataNs[TOKEN_METADATA_KEY] = {
      baseUrl: TOKEN_PLAN_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [foreignModel, ...chinaTemplate, ...tokenTemplate],
    };
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
    expect(result.current.providerUpdateRequest!.entries.length).toBe(2);

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        `${PROVIDER_METADATA_NS}.${METADATA_KEY}.version`,
        chinaVersion,
      );
      expect(mockSettings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        `${PROVIDER_METADATA_NS}.${TOKEN_METADATA_KEY}.version`,
        tokenVersion,
      );
    });

    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.name',
      expect.anything(),
    );
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.baseUrl',
      expect.anything(),
    );
    expect(mockModelsConfig.syncAfterAuthRefresh).not.toHaveBeenCalled();
  });

  it('leaves the selection alone even for the active provider in a mixed batch', async () => {
    // A batch mixing the ACTIVE provider (whose plan no longer offers the
    // current model) with an inactive one: since #8889 a template update
    // never applies the plan's model selection, so neither entry may touch
    // model.name — while both updates still run to completion. This pins
    // the batch-loop side of that invariant; the single-provider side is
    // pinned by 'leaves the model selection alone when the previous model
    // is gone' above.
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs[METADATA_KEY] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    metadataNs[TOKEN_METADATA_KEY] = {
      baseUrl: TOKEN_PLAN_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...chinaTemplate, ...tokenTemplate],
    };
    // Default mock credentials point at Coding Plan, so only the first entry
    // is the active provider. The current model exists in neither template.
    mockConfig.getModel.mockReturnValue('removed-model');
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
    expect(result.current.providerUpdateRequest!.entries.length).toBe(2);

    await result.current.providerUpdateRequest!.onConfirm('update');

    // Both entries ran to completion, regardless of provider order.
    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalledTimes(2);
    });

    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.name',
      expect.anything(),
    );
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      'model.baseUrl',
      expect.anything(),
    );
    expect(mockModelsConfig.syncAfterAuthRefresh).not.toHaveBeenCalled();
  });

  it('persists a cooldown (not a full update) when user chooses "later"', async () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    // Pin Date.now so the persisted timestamp can be asserted exactly.
    const postponedAt = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(postponedAt);
    try {
      await result.current.providerUpdateRequest!.onConfirm('later');
    } finally {
      dateNowSpy.mockRestore();
    }

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeUndefined();
    });
    // "later" persists a postponement cooldown so the prompt does not reappear
    // on every launch, but it must not apply the update. The single batched
    // write must contain exactly these two keys — pinning the values the
    // read-side guard compares against and bounding all persisted writes.
    expect(mockSettings.setValues).toHaveBeenCalledTimes(1);
    expect(mockSettings.setValues).toHaveBeenCalledWith([
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${METADATA_KEY}.postponedVersion`,
        value: chinaVersion,
      },
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${METADATA_KEY}.postponedAt`,
        value: postponedAt,
      },
    ]);
    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(mockConfig.reloadModelProvidersConfig).not.toHaveBeenCalled();
  });

  it('later persists the cooldown for all providers in one batched write', async () => {
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs[METADATA_KEY] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    metadataNs[TOKEN_METADATA_KEY] = {
      baseUrl: TOKEN_PLAN_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...chinaTemplate, ...tokenTemplate],
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    const postponedAt = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(postponedAt);
    try {
      await result.current.providerUpdateRequest!.onConfirm('later');
    } finally {
      dateNowSpy.mockRestore();
    }

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeUndefined();
    });
    expect(mockSettings.setValues).toHaveBeenCalledTimes(1);
    expect(mockSettings.setValues).toHaveBeenCalledWith([
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${METADATA_KEY}.postponedVersion`,
        value: chinaVersion,
      },
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${METADATA_KEY}.postponedAt`,
        value: postponedAt,
      },
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${TOKEN_METADATA_KEY}.postponedVersion`,
        value: tokenVersion,
      },
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${TOKEN_METADATA_KEY}.postponedAt`,
        value: postponedAt,
      },
    ]);
  });

  it('surfaces an error but still dismisses when persisting the cooldown fails', async () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    mockSettings.setValues.mockImplementationOnce(() => {
      throw new Error('settings file is read-only');
    });

    await result.current.providerUpdateRequest!.onConfirm('later');

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeUndefined();
    });
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('settings file is read-only'),
      }),
      expect.any(Number),
    );
  });

  it('does not show prompt while the "later" cooldown is active', () => {
    // Pin Date.now on the read side: 23h elapsed is still inside the 24h
    // cooldown. Together with the 25h expiry test this pins the duration.
    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
        METADATA_KEY
      ] = {
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        version: 'old-version-hash',
        postponedVersion: chinaVersion,
        postponedAt: now - 23 * 60 * 60 * 1000,
      };
      mockSettings.merged['modelProviders'] = {
        [AuthType.USE_OPENAI]: chinaTemplate,
      };

      const { result } = renderHook(() =>
        useProviderUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );

      expect(result.current.providerUpdateRequest).toBeUndefined();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('shows prompt again after the "later" cooldown expires', async () => {
    // Pin Date.now on the read side: 25h elapsed is past the 24h cooldown.
    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
      postponedVersion: chinaVersion,
      postponedAt: now - 25 * 60 * 60 * 1000,
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );
    dateNowSpy.mockRestore();

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
  });

  it('shows prompt when the clock stepped backward after postponement', async () => {
    // A backward clock jump makes the elapsed time negative; the cooldown must
    // be treated as expired rather than suppressing the prompt until the wall
    // clock catches up with postponedAt.
    const now = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
      postponedVersion: chinaVersion,
      postponedAt: now + 60 * 60 * 1000,
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );
    dateNowSpy.mockRestore();

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
  });

  it('shows prompt for a newer version despite an active "later" cooldown', async () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
      postponedVersion: 'stale-postponed-hash',
      postponedAt: Date.now(),
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
  });

  it('persists ignoredVersion when user chooses "skip"', async () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('skip');

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeUndefined();
    });
    expect(mockSettings.setValues).toHaveBeenCalledWith([
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${METADATA_KEY}.ignoredVersion`,
        value: chinaVersion,
      },
    ]);
    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(mockConfig.reloadModelProvidersConfig).not.toHaveBeenCalled();
  });

  it('does not show prompt when currentVersion matches ignoredVersion', () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
      ignoredVersion: chinaVersion,
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
  });

  it('batches multiple provider updates into a single prompt', async () => {
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs[METADATA_KEY] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    metadataNs[TOKEN_METADATA_KEY] = {
      baseUrl: TOKEN_PLAN_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...chinaTemplate, ...tokenTemplate],
    };
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    const entries = result.current.providerUpdateRequest!.entries;
    expect(entries.length).toBe(2);

    const labels = entries.map((e) => e.providerLabel);
    expect(labels).toContain('Coding Plan');
    expect(labels).toContain('Token Plan');
  });

  it('persists ignoredVersion for all providers in one atomic skip write', async () => {
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs[METADATA_KEY] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    metadataNs[TOKEN_METADATA_KEY] = {
      baseUrl: TOKEN_PLAN_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...chinaTemplate, ...tokenTemplate],
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('skip');

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeUndefined();
    });
    expect(mockSettings.setValues).toHaveBeenCalledTimes(1);
    expect(mockSettings.setValues).toHaveBeenCalledWith([
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${METADATA_KEY}.ignoredVersion`,
        value: chinaVersion,
      },
      {
        scope: 'User',
        key: `${PROVIDER_METADATA_NS}.${TOKEN_METADATA_KEY}.ignoredVersion`,
        value: tokenVersion,
      },
    ]);
    expect(mockSettings.setValue).not.toHaveBeenCalled();
  });

  it('reports a failed atomic skip without committing ignored versions', async () => {
    const baselineSettings = {
      modelProviders: {
        [AuthType.USE_OPENAI]: [...chinaTemplate, ...tokenTemplate],
      },
      [PROVIDER_METADATA_NS]: {
        [METADATA_KEY]: {
          baseUrl: CODING_PLAN_CHINA_BASE_URL,
          version: 'old-version-hash',
        },
        [TOKEN_METADATA_KEY]: {
          baseUrl: TOKEN_PLAN_BASE_URL,
          version: 'old-version-hash',
        },
      },
    } as const;
    const settingsFile = {
      path: '/tmp/atomic-skip-settings.json',
      settings: structuredClone(baselineSettings) as Record<string, unknown>,
      originalSettings: structuredClone(baselineSettings) as Record<
        string,
        unknown
      >,
    };
    const mutableSettings = {
      merged: settingsFile.settings,
      setValue: vi.fn(),
      setValues: vi.fn(),
      forScope: vi.fn((_scope: unknown) => settingsFile),
      recomputeMerged: vi.fn(),
      isTrusted: true,
      workspace: { settings: {} },
      user: settingsFile,
    };
    const setNestedValue = (
      target: Record<string, unknown>,
      key: string,
      value: unknown,
    ) => {
      const parts = key.split('.');
      let current = target;
      for (const part of parts.slice(0, -1)) {
        const next = current[part];
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]!] = value;
    };
    mutableSettings.recomputeMerged.mockImplementation(() => {
      mutableSettings.merged = settingsFile.settings;
    });
    mutableSettings.setValue.mockImplementation(
      (_scope: unknown, key: string, value: unknown) => {
        const scopeFile = mutableSettings.forScope(_scope);
        setNestedValue(scopeFile.settings, key, value);
        setNestedValue(scopeFile.originalSettings, key, value);
        mutableSettings.recomputeMerged();
      },
    );
    mutableSettings.setValues.mockImplementation(
      (
        writes: ReadonlyArray<{
          scope: unknown;
          key: string;
          value: unknown;
        }>,
      ) => {
        for (const write of writes) {
          const scopeFile = mutableSettings.forScope(write.scope);
          setNestedValue(scopeFile.settings, write.key, write.value);
          setNestedValue(scopeFile.originalSettings, write.key, write.value);
        }
        mutableSettings.recomputeMerged();
        settingsFile.settings = structuredClone(baselineSettings) as Record<
          string,
          unknown
        >;
        settingsFile.originalSettings = structuredClone(
          baselineSettings,
        ) as Record<string, unknown>;
        mutableSettings.recomputeMerged();
        throw new Error('settings file is read-only');
      },
    );

    const { result } = renderHook(() =>
      useProviderUpdates(
        mutableSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });

    await result.current.providerUpdateRequest!.onConfirm('skip');

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeUndefined();
    });
    const metadata = settingsFile.settings[PROVIDER_METADATA_NS] as Record<
      string,
      Record<string, unknown>
    >;
    expect(metadata[METADATA_KEY]).not.toHaveProperty('ignoredVersion');
    expect(metadata[TOKEN_METADATA_KEY]).not.toHaveProperty('ignoredVersion');
    expect(settingsFile.settings).toEqual(baselineSettings);
    expect(settingsFile.originalSettings).toEqual(baselineSettings);
    expect(mutableSettings.setValues).toHaveBeenCalledTimes(1);
    expect(mutableSettings.setValue).not.toHaveBeenCalled();
    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text: expect.stringContaining('settings file is read-only'),
      }),
      expect.any(Number),
    );
  });

  it('captures the historical sequential skip partial commit when a later provider write fails', () => {
    const baselineSettings = {
      modelProviders: {
        [AuthType.USE_OPENAI]: [...chinaTemplate, ...tokenTemplate],
      },
      [PROVIDER_METADATA_NS]: {
        [METADATA_KEY]: {
          baseUrl: CODING_PLAN_CHINA_BASE_URL,
          version: 'old-version-hash',
        },
        [TOKEN_METADATA_KEY]: {
          baseUrl: TOKEN_PLAN_BASE_URL,
          version: 'old-version-hash',
        },
      },
    } as const;
    const settingsFile = {
      path: '/tmp/sequential-skip-settings.json',
      settings: structuredClone(baselineSettings) as Record<string, unknown>,
      originalSettings: structuredClone(baselineSettings) as Record<
        string,
        unknown
      >,
    };
    const mutableSettings = {
      merged: settingsFile.settings,
      setValue: vi.fn(),
      setValues: vi.fn(),
      forScope: vi.fn((_scope: unknown) => settingsFile),
      recomputeMerged: vi.fn(),
      isTrusted: true,
      workspace: { settings: {} },
      user: settingsFile,
    };
    const setNestedValue = (
      target: Record<string, unknown>,
      key: string,
      value: unknown,
    ) => {
      const parts = key.split('.');
      let current = target;
      for (const part of parts.slice(0, -1)) {
        const next = current[part];
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]!] = value;
    };
    mutableSettings.recomputeMerged.mockImplementation(() => {
      mutableSettings.merged = settingsFile.settings;
    });
    let writeCount = 0;
    mutableSettings.setValue.mockImplementation(
      (_scope: unknown, key: string, value: unknown) => {
        writeCount += 1;
        if (writeCount === 2) {
          throw new Error('settings file is read-only');
        }
        const scopeFile = mutableSettings.forScope(_scope);
        setNestedValue(scopeFile.settings, key, value);
        setNestedValue(scopeFile.originalSettings, key, value);
        mutableSettings.recomputeMerged();
      },
    );

    expect(() => {
      mutableSettings.setValue(
        'User',
        `${PROVIDER_METADATA_NS}.${METADATA_KEY}.ignoredVersion`,
        chinaVersion,
      );
      mutableSettings.setValue(
        'User',
        `${PROVIDER_METADATA_NS}.${TOKEN_METADATA_KEY}.ignoredVersion`,
        tokenVersion,
      );
    }).toThrow('settings file is read-only');

    for (const snapshot of [
      settingsFile.settings,
      settingsFile.originalSettings,
    ]) {
      const metadata = snapshot[PROVIDER_METADATA_NS] as Record<
        string,
        Record<string, unknown>
      >;
      expect(metadata[METADATA_KEY]).toMatchObject({
        ignoredVersion: chinaVersion,
      });
      expect(metadata[TOKEN_METADATA_KEY]).not.toHaveProperty('ignoredVersion');
    }
    expect(mutableSettings.setValue).toHaveBeenCalledTimes(2);
    expect(mutableSettings.setValues).not.toHaveBeenCalled();
  });

  it('shows prompt again when a newer version supersedes ignoredVersion', async () => {
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
      ignoredVersion: 'stale-ignored-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeDefined();
    });
  });

  it('restores the entire pending batch when a later provider refresh is cancelled', async () => {
    const baselineRuntime = {
      authType: AuthType.USE_OPENAI,
      modelId: 'baseline-model',
      baseUrl: 'https://baseline.example/v1',
    };
    const baselineSettings = {
      modelProviders: {
        [AuthType.USE_OPENAI]: [],
      },
      [PROVIDER_METADATA_NS]: {
        [METADATA_KEY]: {
          baseUrl: CODING_PLAN_CHINA_BASE_URL,
          version: 'old-version-hash',
        },
        [TOKEN_METADATA_KEY]: {
          baseUrl: TOKEN_PLAN_BASE_URL,
          version: 'old-version-hash',
        },
      },
    };
    const settingsFile = {
      path: '/tmp/batch-settings.json',
      settings: structuredClone(baselineSettings) as Record<string, unknown>,
      originalSettings: structuredClone(baselineSettings) as Record<
        string,
        unknown
      >,
    };
    const batchSettings = {
      merged: settingsFile.settings,
      setValue: vi.fn(),
      setValues: vi.fn(),
      forScope: vi.fn(() => settingsFile),
      recomputeMerged: vi.fn(),
      isTrusted: true,
      workspace: { settings: {} },
      user: { settings: { modelProviders: {} } },
    };
    const setNestedValue = (
      target: Record<string, unknown>,
      key: string,
      value: unknown,
    ) => {
      const parts = key.split('.');
      let current = target;
      for (const part of parts.slice(0, -1)) {
        const next = current[part];
        if (!next || typeof next !== 'object' || Array.isArray(next)) {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]!] = value;
    };
    batchSettings.setValue.mockImplementation(
      (_scope: unknown, key: string, value: unknown) => {
        setNestedValue(settingsFile.settings, key, value);
        setNestedValue(settingsFile.originalSettings, key, value);
        batchSettings.merged = settingsFile.settings;
      },
    );
    batchSettings.recomputeMerged.mockImplementation(() => {
      batchSettings.merged = settingsFile.settings;
    });

    const runtime = {
      ...baselineRuntime,
      modelProviders: structuredClone(
        baselineSettings.modelProviders,
      ) as Record<string, unknown>,
    };
    mockConfig.getAuthType.mockImplementation(() => runtime.authType);
    mockConfig.getModel.mockImplementation(() => runtime.modelId);
    mockConfig.getCurrentModelRegistryBaseUrl.mockImplementation(
      () => runtime.baseUrl,
    );
    mockConfig.getContentGeneratorConfig
      .mockReturnValueOnce({
        authType: AuthType.USE_OPENAI,
        baseUrl: CODING_PLAN_CHINA_BASE_URL,
        apiKeyEnvKey: CODING_PLAN_ENV_KEY,
      })
      .mockReturnValueOnce({
        authType: AuthType.USE_OPENAI,
        baseUrl: TOKEN_PLAN_BASE_URL,
        apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
      });
    mockConfig.reloadModelProvidersConfig.mockImplementation(
      (modelProviders: Record<string, unknown>) => {
        runtime.modelProviders = structuredClone(modelProviders);
      },
    );
    mockConfig.switchModel.mockImplementation(
      async (
        authType: AuthType,
        modelId: string,
        options: { baseUrl?: string },
      ) => {
        runtime.authType = authType;
        runtime.modelId = modelId;
        runtime.baseUrl = options.baseUrl ?? '';
      },
    );

    const secondRefreshStarted = createDeferred<void>();
    const secondRefresh = createDeferred<void>();
    let refreshCount = 0;
    mockConfig.refreshAuth.mockImplementation(
      async (
        _authType: AuthType,
        _isInitialAuth?: boolean,
        _canPublish?: () => boolean,
      ) => {
        refreshCount += 1;
        if (refreshCount === 1) {
          runtime.modelId = 'coding-plan-runtime';
          runtime.baseUrl = CODING_PLAN_CHINA_BASE_URL;
          return;
        }
        runtime.modelId = 'token-plan-runtime';
        runtime.baseUrl = TOKEN_PLAN_BASE_URL;
        secondRefreshStarted.resolve();
        await secondRefresh.promise;
      },
    );

    const { result } = renderHook(() => {
      const transaction = useUiProviderTransaction();
      const updates = useProviderUpdates(
        batchSettings as never,
        mockConfig as never,
        mockAddItem,
        transaction.run,
      );
      return { transaction, updates };
    });

    await waitFor(() => {
      expect(
        result.current.updates.providerUpdateRequest?.entries,
      ).toHaveLength(2);
    });

    const update =
      result.current.updates.providerUpdateRequest!.onConfirm('update');
    await secondRefreshStarted.promise;
    expect(refreshCount).toBe(2);
    expect(
      (
        settingsFile.settings[PROVIDER_METADATA_NS] as Record<
          string,
          { version?: string }
        >
      )[METADATA_KEY]?.version,
    ).toBe(chinaVersion);

    const successor = result.current.transaction.run(async () => {});
    secondRefresh.resolve();
    await Promise.all([update, successor]);

    expect(settingsFile.settings).toEqual(baselineSettings);
    expect(settingsFile.originalSettings).toEqual(baselineSettings);
    expect(runtime).toEqual({
      ...baselineRuntime,
      modelProviders: baselineSettings.modelProviders,
    });
    expect(mockAddItem).not.toHaveBeenCalled();
  });
});
