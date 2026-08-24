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
  deepseekProvider,
  kimiProvider,
  minimaxProvider,
  KIMI_API_ENV_KEY,
  KIMI_CODE_ENV_KEY,
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

const METADATA_KEY = 'coding-plan--aliyun';
const TOKEN_METADATA_KEY = 'token-plan--cn-beijing';

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
    mockSettings.merged['env'] = {};
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      apiKeyEnvKey: CODING_PLAN_ENV_KEY,
    });
    mockConfig.getModel.mockReturnValue('qwen3.5-plus');
    mockModelsConfig.syncAfterAuthRefresh.mockReset();
    delete process.env[CODING_PLAN_ENV_KEY];
    delete process.env[KIMI_API_ENV_KEY];
    delete process.env[KIMI_CODE_ENV_KEY];
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

  it('preserves baseUrl-less custom models when executing an update', async () => {
    const deepseekBaseUrl = 'https://api.deepseek.com';
    const deepseekEnvKey = 'DEEPSEEK_API_KEY';
    const deepseekTemplate = buildProviderTemplate(
      deepseekProvider,
      deepseekBaseUrl,
    );
    const deepseekVersion = computeModelListVersion(deepseekTemplate);
    const customModel = {
      id: 'my-custom-model',
      envKey: deepseekEnvKey,
      name: '[DeepSeek] my-custom-model',
    };
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'deepseek'
    ] = {
      baseUrl: deepseekBaseUrl,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...deepseekTemplate, customModel],
    };
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: deepseekBaseUrl,
      apiKeyEnvKey: deepseekEnvKey,
    });
    mockConfig.getModel.mockReturnValue('deepseek-v4-flash');
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
    expect(
      reloaded[AuthType.USE_OPENAI].filter(
        (model: typeof customModel) => model.id === 'my-custom-model',
      ),
    ).toEqual([customModel]);
    // The persisted version tracks the built-in template, never the
    // selection — a carried custom model must not poison the hash and
    // re-trigger the prompt on the next launch.
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.deepseek.version`,
      deepseekVersion,
    );
    delete process.env[deepseekEnvKey];
  });

  it('replaces a baseUrl-less legacy built-in instead of duplicating it, and does not report it as added (R45-6)', async () => {
    // deepseek is a non-merge, single-endpoint (string baseUrl) provider. A
    // pre-stamping legacy install keeps its BUILT-IN models without a baseUrl.
    // The update must (a) count such an entry as installed — the diff must not
    // claim it will be "added" — and (b) replace it with the stamped template
    // instead of preserving it beside the copy (a permanent duplicate).
    const deepseekBaseUrl = 'https://api.deepseek.com';
    const deepseekEnvKey = 'DEEPSEEK_API_KEY';
    const deepseekTemplate = buildProviderTemplate(
      deepseekProvider,
      deepseekBaseUrl,
    );
    const builtinIds = deepseekTemplate.map(
      (model: { id: string }) => model.id,
    );
    expect(builtinIds.length).toBeGreaterThan(1);
    const installedLegacyId = builtinIds[0];
    // Legacy shape: one built-in installed WITHOUT baseUrl (the others absent,
    // so they legitimately appear as additions).
    const legacyEntry = {
      id: installedLegacyId,
      envKey: deepseekEnvKey,
      name: `[DeepSeek] ${installedLegacyId}`,
    };
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'deepseek'
    ] = {
      baseUrl: deepseekBaseUrl,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [legacyEntry],
    };
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: deepseekBaseUrl,
      apiKeyEnvKey: deepseekEnvKey,
    });
    mockConfig.getModel.mockReturnValue(installedLegacyId);
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

    // The installed baseUrl-less built-in is visible to the diff: it is NOT
    // reported as an addition, while the genuinely-new ids are.
    const diff = result.current.providerUpdateRequest!.entries[0].diff;
    expect(diff.added).not.toContain(installedLegacyId);
    expect(diff.added).toEqual(builtinIds.slice(1));

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    });

    const reloaded = mockConfig.reloadModelProvidersConfig.mock.calls[0][0];
    // The built-in now appears exactly once — stamped at the endpoint. The
    // baseUrl-less original was replaced, not carried beside the copy.
    const entries = reloaded[AuthType.USE_OPENAI].filter(
      (model: { id: string }) => model.id === installedLegacyId,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].baseUrl).toBe(deepseekBaseUrl);
    delete process.env[deepseekEnvKey];
  });

  it('preserves owned custom models using a proxy URL during an update', async () => {
    const deepseekBaseUrl = 'https://api.deepseek.com';
    const deepseekEnvKey = 'DEEPSEEK_API_KEY';
    const deepseekTemplate = buildProviderTemplate(
      deepseekProvider,
      deepseekBaseUrl,
    );
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'deepseek'
    ] = {
      baseUrl: deepseekBaseUrl,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [
        ...deepseekTemplate,
        {
          id: 'my-custom-model',
          envKey: deepseekEnvKey,
          name: '[DeepSeek] my-custom-model',
          baseUrl: 'https://corp-proxy.example/v1',
          generationConfig: {
            samplingParams: { temperature: 0.25 },
          },
        },
      ],
    };
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: deepseekBaseUrl,
      apiKeyEnvKey: deepseekEnvKey,
    });

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
    expect(
      mockConfig.reloadModelProvidersConfig.mock.calls[0][0][
        AuthType.USE_OPENAI
      ],
    ).toEqual(
      expect.arrayContaining([
        {
          id: 'my-custom-model',
          envKey: deepseekEnvKey,
          name: '[DeepSeek] my-custom-model',
          baseUrl: 'https://corp-proxy.example/v1',
          generationConfig: {
            samplingParams: { temperature: 0.25 },
          },
        },
      ]),
    );
  });

  it('does not re-prompt when the stored version matches the template but the selection differs', () => {
    // Installed with a deselected default and an added custom model: the
    // selection hash differs from the template hash, yet the stored version
    // (template-derived at install time) agrees with the current template.
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      METADATA_KEY
    ] = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: chinaVersion,
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [
        ...chinaTemplate.slice(1),
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

    expect(result.current.providerUpdateRequest).toBeUndefined();
  });

  it('preserves custom models colliding with sibling endpoint defaults', async () => {
    const baseUrl = 'https://api.kimi.com/coding/v1';
    const customModel = {
      id: 'kimi-k3',
      baseUrl,
      envKey: 'KIMI_CODE_API_KEY',
      name: '[Kimi Code] kimi-k3',
    };
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'kimi'
    ] = { baseUrl, version: 'old-version-hash' };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [
        ...buildProviderTemplate(kimiProvider, baseUrl),
        customModel,
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

    const entry = result.current.providerUpdateRequest?.entries[0];
    expect(entry?.diff.added).toEqual([]);
    expect(entry?.diff.removed).toEqual([]);
    expect(entry?.diff.currentModelAffected).toBe(false);

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    });

    const reloaded = mockConfig.reloadModelProvidersConfig.mock.calls[0][0];
    expect(reloaded[AuthType.USE_OPENAI]).toEqual(
      expect.arrayContaining([expect.objectContaining(customModel)]),
    );
  });

  it('updates only the models for the installed endpoint', async () => {
    const baseUrl = 'https://api.moonshot.ai/v1';
    const apiTemplate = buildProviderTemplate(kimiProvider, baseUrl);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'kimi'
    ] = { baseUrl, version: 'old-version-hash' };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: apiTemplate,
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

    // Installed models already match this endpoint's defaults, so the diff
    // must be empty; a provider-wide diff would add the other endpoint's
    // models.
    const entry = result.current.providerUpdateRequest?.entries[0];
    expect(entry?.diff.added).toEqual([]);
    expect(entry?.diff.removed).toEqual([]);
    expect(entry?.diff.currentModelAffected).toBe(false);

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    });

    const reloaded =
      mockConfig.reloadModelProvidersConfig.mock.calls[0][0][
        AuthType.USE_OPENAI
      ];
    expect(reloaded.map((model: { id: string }) => model.id)).toEqual([
      'kimi-k3',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
    ]);
  });

  it('updates one Kimi endpoint without cloning sibling models into it', async () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    const codingTemplate = buildProviderTemplate(kimiProvider, codingUrl);
    const apiTemplate = buildProviderTemplate(kimiProvider, apiUrl);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'kimi'
    ] = { baseUrl: apiUrl, version: 'old-version-hash' };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...codingTemplate, ...apiTemplate],
    };
    mockConfig.getModel.mockReturnValue('k3-256k');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: codingUrl,
      apiKeyEnvKey: 'KIMI_CODE_API_KEY',
    });
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
    const reloaded =
      mockConfig.reloadModelProvidersConfig.mock.calls[0][0][
        AuthType.USE_OPENAI
      ];
    expect(reloaded).toHaveLength(8);
    expect(
      reloaded.filter(
        (model: { baseUrl?: string }) => model.baseUrl === apiUrl,
      ),
    ).toHaveLength(4);
    expect(mockModelsConfig.syncAfterAuthRefresh).not.toHaveBeenCalled();
    // The live session sits on the sibling Coding Plan endpoint; updating the
    // API endpoint must not re-auth (and rebuild) the untouched session.
    expect(mockConfig.refreshAuth).not.toHaveBeenCalled();
  });

  it('preserves sibling endpoints for non-merge array providers', async () => {
    const intlUrl = 'https://api.minimax.io/v1';
    const chinaUrl = 'https://api.minimaxi.com/v1';
    const intlTemplate = buildProviderTemplate(minimaxProvider, intlUrl);
    const chinaTemplate = buildProviderTemplate(minimaxProvider, chinaUrl);
    const metadataKey = 'minimax';
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      metadataKey
    ] = { baseUrl: chinaUrl, version: 'old-version-hash' };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...intlTemplate, ...chinaTemplate],
    };
    mockConfig.getModel.mockReturnValue('MiniMax-M3');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: intlUrl,
      apiKeyEnvKey: 'MINIMAX_API_KEY',
    });

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
    const reloaded =
      mockConfig.reloadModelProvidersConfig.mock.calls[0][0][
        AuthType.USE_OPENAI
      ];
    expect(
      reloaded.filter(
        (model: { baseUrl?: string }) => model.baseUrl === intlUrl,
      ),
    ).toHaveLength(intlTemplate.length);
    expect(
      reloaded.filter(
        (model: { baseUrl?: string }) => model.baseUrl === chinaUrl,
      ),
    ).toHaveLength(chinaTemplate.length);
    expect(mockConfig.refreshAuth).not.toHaveBeenCalled();
  });

  it('does not re-home a baseUrl-less Kimi model during an endpoint update', async () => {
    const apiUrl = 'https://api.moonshot.ai/v1';
    const apiTemplate = buildProviderTemplate(kimiProvider, apiUrl);
    const legacyCustom = {
      id: 'legacy-custom',
      envKey: 'MOONSHOT_API_KEY',
      name: '[Kimi API] legacy-custom',
    };
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'kimi'
    ] = { baseUrl: apiUrl, version: 'old-version-hash' };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...apiTemplate, legacyCustom],
    };
    mockConfig.getModel.mockReturnValue('kimi-k3');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: apiUrl,
      apiKeyEnvKey: 'MOONSHOT_API_KEY',
    });
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
    const reloaded =
      mockConfig.reloadModelProvidersConfig.mock.calls[0][0][
        AuthType.USE_OPENAI
      ];
    expect(
      reloaded.filter((model: { id: string }) => model.id === legacyCustom.id),
    ).toEqual([legacyCustom]);
  });

  it('isolates same-envKey API regions during an endpoint update', async () => {
    // api-china and api-international share MOONSHOT_API_KEY, the name
    // prefix, and identical model lists; updating one must leave the other
    // byte-identical.
    const chinaUrl = 'https://api.moonshot.cn/v1';
    const intlUrl = 'https://api.moonshot.ai/v1';
    const chinaTemplate = buildProviderTemplate(kimiProvider, chinaUrl);
    const intlTemplate = buildProviderTemplate(kimiProvider, intlUrl);
    const chinaCustom = {
      id: 'china-custom',
      baseUrl: chinaUrl,
      envKey: 'MOONSHOT_API_KEY',
      name: '[Kimi API] china-custom',
    };
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs['kimi--api-china'] = {
      baseUrl: chinaUrl,
      version: computeModelListVersion(chinaTemplate),
    };
    metadataNs['kimi--api-international'] = {
      baseUrl: intlUrl,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...chinaTemplate, chinaCustom, ...intlTemplate],
    };
    mockConfig.getModel.mockReturnValue('kimi-k3');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: intlUrl,
      apiKeyEnvKey: 'MOONSHOT_API_KEY',
    });
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
    // Only the stale endpoint prompts.
    expect(result.current.providerUpdateRequest?.entries).toHaveLength(1);
    expect(result.current.providerUpdateRequest?.entries[0]?.metadataKey).toBe(
      'kimi--api-international',
    );

    await result.current.providerUpdateRequest!.onConfirm('update');

    await waitFor(() => {
      expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    });
    const reloaded =
      mockConfig.reloadModelProvidersConfig.mock.calls[0][0][
        AuthType.USE_OPENAI
      ];
    expect(reloaded).toEqual([...chinaTemplate, chinaCustom, ...intlTemplate]);
  });

  it('detects updates for every installed Kimi endpoint with legacy metadata', async () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    const olderCodingTemplate = buildProviderTemplate(
      kimiProvider,
      codingUrl,
    ).slice(0, -1);
    const apiTemplate = buildProviderTemplate(kimiProvider, apiUrl);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'kimi'
    ] = {
      baseUrl: apiUrl,
      version: computeModelListVersion(apiTemplate),
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [...olderCodingTemplate, ...apiTemplate],
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
    expect(result.current.providerUpdateRequest?.entries).toHaveLength(1);
    expect(
      result.current.providerUpdateRequest?.entries[0]?.diff.added,
    ).toEqual(['kimi-for-coding-highspeed']);
    expect(mockSettings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--coding-plan.version`,
          value: computeModelListVersion(olderCodingTemplate),
        },
      ]),
    );
    expect(mockSettings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--api-international.version`,
          value: computeModelListVersion(apiTemplate),
        },
      ]),
    );
  });

  it('does not infer metadata for a provider after its credentials are cleared', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: buildProviderTemplate(
        kimiProvider,
        codingUrl,
      ).slice(0, -1),
    };
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
    });

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(new RegExp(`^${PROVIDER_METADATA_NS}\\.kimi--`)),
      expect.anything(),
    );
  });

  it('does not infer metadata from a stale process credential after sign-out', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: buildProviderTemplate(
        kimiProvider,
        codingUrl,
      ).slice(0, -1),
    };
    process.env[KIMI_CODE_ENV_KEY] = 'sk-stale';
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
    });

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(new RegExp(`^${PROVIDER_METADATA_NS}\\.kimi--`)),
      expect.anything(),
    );
  });

  it('infers endpoint metadata when its credential is still configured', async () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: buildProviderTemplate(
        kimiProvider,
        codingUrl,
      ).slice(0, -1),
    };
    mockSettings.merged['env'] = { [KIMI_CODE_ENV_KEY]: 'sk-live' };
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
    });

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
    expect(result.current.providerUpdateRequest?.entries[0]?.metadataKey).toBe(
      'kimi--coding-plan',
    );
    expect(mockSettings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--coding-plan.version`,
          value: expect.any(String),
        },
      ]),
    );
  });

  it('skips inferred endpoint updates when metadata persistence fails', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: buildProviderTemplate(
        kimiProvider,
        codingUrl,
      ).slice(0, -1),
    };
    mockSettings.merged['env'] = { [KIMI_CODE_ENV_KEY]: 'sk-live' };
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
    });
    mockSettings.setValues.mockImplementationOnce(() => {
      throw new Error('settings file is read-only');
    });

    let request: unknown = 'not rendered';
    expect(() => {
      const { result } = renderHook(() =>
        useProviderUpdates(
          mockSettings as never,
          mockConfig as never,
          mockAddItem,
        ),
      );
      request = result.current.providerUpdateRequest;
    }).not.toThrow();

    expect(request).toBeUndefined();
  });

  it('preserves an ignored version when inferring from base-URL-less legacy metadata', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const codingTemplate = buildProviderTemplate(kimiProvider, codingUrl);
    const codingVersion = computeModelListVersion(codingTemplate);
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: codingTemplate.slice(0, -1),
    };
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'kimi'
    ] = {
      version: 'legacy-version',
      ignoredVersion: codingVersion,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
    expect(mockSettings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--coding-plan.ignoredVersion`,
          value: codingVersion,
        },
      ]),
    );
  });

  it('preserves a postponed cooldown when inferring from base-URL-less legacy metadata', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const codingTemplate = buildProviderTemplate(kimiProvider, codingUrl);
    const codingVersion = computeModelListVersion(codingTemplate);
    const postponedAt = Date.now();
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: codingTemplate.slice(0, -1),
    };
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'kimi'
    ] = {
      version: 'legacy-version',
      postponedVersion: codingVersion,
      postponedAt,
    };

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
    expect(mockSettings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--coding-plan.postponedVersion`,
          value: codingVersion,
        },
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--coding-plan.postponedAt`,
          value: postponedAt,
        },
      ]),
    );
  });

  it('does not infer coding metadata from a sibling endpoint credential', () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: buildProviderTemplate(
        kimiProvider,
        codingUrl,
      ).slice(0, -1),
    };
    mockSettings.merged['env'] = { [KIMI_API_ENV_KEY]: 'sk-sibling' };
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api.moonshot.ai/v1',
      apiKeyEnvKey: KIMI_API_ENV_KEY,
    });

    const { result } = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.providerUpdateRequest).toBeUndefined();
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(new RegExp(`^${PROVIDER_METADATA_NS}\\.kimi--`)),
      expect.anything(),
    );
  });

  it('honors endpoint-scoped ignoredVersion while reading legacy Kimi metadata', () => {
    const apiUrl = 'https://api.moonshot.ai/v1';
    const apiTemplate = buildProviderTemplate(kimiProvider, apiUrl);
    const apiVersion = computeModelListVersion(apiTemplate);
    const metadata = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadata['kimi'] = { baseUrl: apiUrl, version: 'old-version-hash' };
    metadata['kimi--api-international'] = { ignoredVersion: apiVersion };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: apiTemplate,
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

  it('preserves a legacy postponed cooldown when migrating endpoint metadata', () => {
    const apiUrl = 'https://api.moonshot.ai/v1';
    const apiTemplate = buildProviderTemplate(kimiProvider, apiUrl);
    const apiVersion = computeModelListVersion(apiTemplate);
    const postponedAt = Date.now();
    const metadata = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadata['kimi'] = {
      baseUrl: apiUrl,
      version: 'old-version-hash',
      postponedVersion: apiVersion,
      postponedAt,
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: apiTemplate,
    };

    const firstLaunch = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(firstLaunch.result.current.providerUpdateRequest).toBeUndefined();
    expect(mockSettings.setValues).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--api-international.postponedVersion`,
          value: apiVersion,
        },
        {
          scope: 'User',
          key: `${PROVIDER_METADATA_NS}.kimi--api-international.postponedAt`,
          value: postponedAt,
        },
      ]),
    );
    firstLaunch.unmount();

    metadata['kimi--api-international'] = {
      baseUrl: apiUrl,
      version: 'old-version-hash',
      postponedVersion: apiVersion,
      postponedAt,
    };
    delete metadata['kimi'];
    const secondLaunch = renderHook(() =>
      useProviderUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(secondLaunch.result.current.providerUpdateRequest).toBeUndefined();
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
      `${PROVIDER_METADATA_NS}.${METADATA_KEY}.version`,
      chinaVersion,
    );
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

  it('does not refresh auth when updating an inactive provider on the same protocol', async () => {
    mockConfig.getModel.mockReturnValue('qwen3.7-plus');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
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
    expect(mockModelsConfig.syncAfterAuthRefresh).not.toHaveBeenCalled();
  });

  it('never rewrites the live model selection for an inactive provider update', async () => {
    // Active session on Token Plan with a model the updated Coding Plan
    // template does not contain: the update targets an inactive provider and
    // must not switch the session.
    mockConfig.getModel.mockReturnValue('qwen3.7-max');
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      authType: AuthType.USE_OPENAI,
      baseUrl: TOKEN_PLAN_BASE_URL,
      apiKeyEnvKey: TOKEN_PLAN_ENV_KEY,
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
    const selectionWrites = mockSettings.setValue.mock.calls.filter(
      (call: unknown[]) =>
        call[1] === 'model.name' || call[1] === 'model.baseUrl',
    );
    expect(selectionWrites).toHaveLength(0);
    expect(mockAddItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: 'Coding Plan configuration updated successfully.',
      },
      expect.any(Number),
    );
    expect(mockAddItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('switched') }),
      expect.any(Number),
    );
  });

  it('preserves the stored global base URL when updating', async () => {
    const globalTemplate = buildProviderTemplate(
      codingPlanProvider,
      CODING_PLAN_GLOBAL_BASE_URL,
    );
    const globalVersion = computeModelListVersion(globalTemplate);
    (mockSettings.merged[PROVIDER_METADATA_NS] as Record<string, unknown>)[
      'coding-plan--alibabacloud'
    ] = {
      baseUrl: CODING_PLAN_GLOBAL_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: globalTemplate,
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

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.coding-plan--alibabacloud.baseUrl`,
      CODING_PLAN_GLOBAL_BASE_URL,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `${PROVIDER_METADATA_NS}.coding-plan--alibabacloud.version`,
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

  it('labels same-provider endpoint updates with stable unique identities', async () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const apiUrl = 'https://api.moonshot.ai/v1';
    const metadataNs = mockSettings.merged[PROVIDER_METADATA_NS] as Record<
      string,
      unknown
    >;
    metadataNs['kimi--coding-plan'] = {
      baseUrl: codingUrl,
      version: 'old-version-hash',
    };
    metadataNs['kimi--api-international'] = {
      baseUrl: apiUrl,
      version: 'old-version-hash',
    };
    mockSettings.merged['modelProviders'] = {
      [AuthType.USE_OPENAI]: [
        ...buildProviderTemplate(kimiProvider, codingUrl),
        ...buildProviderTemplate(kimiProvider, apiUrl),
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
      expect(result.current.providerUpdateRequest?.entries).toHaveLength(2);
    });
    expect(result.current.providerUpdateRequest?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadataKey: 'kimi--coding-plan',
          providerLabel: 'Kimi',
          endpointLabel: 'Coding Plan',
        }),
        expect.objectContaining({
          metadataKey: 'kimi--api-international',
          providerLabel: 'Kimi',
          endpointLabel: 'API Key (International)',
        }),
      ]),
    );
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
