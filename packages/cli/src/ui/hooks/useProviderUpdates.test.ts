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
import { useProviderUpdates } from './useProviderUpdates.js';

vi.mock('../../config/settingsUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settingsUtils.js')>();
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

describe('useProviderUpdates', () => {
  const mockSettings = {
    merged: {
      modelProviders: {} as Record<string, unknown>,
      [PROVIDER_METADATA_NS]: {} as Record<string, unknown>,
    } as Record<string, unknown>,
    setValue: vi.fn(),
    setValues: vi.fn(),
    forScope: vi.fn(() => ({ path: '/tmp/settings.json' })),
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
    getModel: vi.fn().mockReturnValue('qwen3.5-plus'),
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
    mockConfig.getModel.mockReturnValue('qwen3.5-plus');
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
    expect(mockConfig.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
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
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.ignoredVersion`,
      chinaVersion,
    );
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

  it('skip persists ignoredVersion for all providers in batch', async () => {
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
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.ignoredVersion`,
      chinaVersion,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.${TOKEN_METADATA_KEY}.ignoredVersion`,
      tokenVersion,
    );
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
});
