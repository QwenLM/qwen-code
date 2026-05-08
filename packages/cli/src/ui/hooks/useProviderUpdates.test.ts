/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { useProviderUpdates } from './useProviderUpdates.js';
import {
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  codingPlanProvider,
} from '../../auth/providers/alibaba/codingPlan.js';
import {
  TOKEN_PLAN_BASE_URL,
  tokenPlanProvider,
} from '../../auth/providers/alibaba/tokenPlan.js';
import {
  buildProviderTemplate,
  computeModelListVersion,
  PROVIDER_METADATA_NS,
} from '../../auth/providerConfig.js';

vi.mock('../../utils/settingsUtils.js', () => ({
  backupSettingsFile: vi.fn(),
  restoreSettingsFromBackup: vi.fn(),
  cleanupSettingsBackup: vi.fn(),
}));

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
    getModel: vi.fn().mockReturnValue('qwen3.5-plus'),
    getModelsConfig: vi.fn(() => mockModelsConfig),
  };

  const mockAddItem = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.merged['modelProviders'] = {};
    mockSettings.merged[PROVIDER_METADATA_NS] = {};
    mockConfig.getModel.mockReturnValue('qwen3.5-plus');
    mockModelsConfig.syncAfterAuthRefresh.mockClear();
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

  it('reports currentModelAffected when model is removed', async () => {
    mockConfig.getModel.mockReturnValue('old-deprecated-model');
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
          id: 'old-deprecated-model',
          baseUrl: CODING_PLAN_CHINA_BASE_URL,
          envKey: CODING_PLAN_ENV_KEY,
          name: '[Coding Plan] old-deprecated-model',
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
    expect(entry?.diff.currentModelAffected).toBe(true);
    expect(entry?.diff.removed).toContain('old-deprecated-model');
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

  it('switches model when previous model is no longer available', async () => {
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
      expect(mockSettings.setValue).toHaveBeenCalled();
    });

    expect(mockModelsConfig.syncAfterAuthRefresh).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3.5-plus',
    );
  });

  it('dismisses without persisting when user chooses "later"', async () => {
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

    await result.current.providerUpdateRequest!.onConfirm('later');

    await waitFor(() => {
      expect(result.current.providerUpdateRequest).toBeUndefined();
    });
    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(mockConfig.reloadModelProvidersConfig).not.toHaveBeenCalled();
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
