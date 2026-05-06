/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { useCodingPlanUpdates } from './useCodingPlanUpdates.js';
import {
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
  codingPlanProvider,
} from '../../auth/providers/alibaba/codingPlan.js';
import {
  buildProviderTemplate,
  computeModelListVersion,
} from '../../auth/providerConfig.js';

vi.mock('../../utils/settingsUtils.js', () => ({
  backupSettingsFile: vi.fn(),
}));

const chinaTemplate = buildProviderTemplate(
  codingPlanProvider,
  CODING_PLAN_CHINA_BASE_URL,
);
const chinaVersion = computeModelListVersion(chinaTemplate);

describe('useCodingPlanUpdates', () => {
  const mockSettings = {
    merged: {
      modelProviders: {},
      codingPlan: {},
    },
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
    mockSettings.merged.modelProviders = {};
    mockSettings.merged.codingPlan = {};
    mockConfig.getModel.mockReturnValue('qwen3.5-plus');
    mockModelsConfig.syncAfterAuthRefresh.mockClear();
    delete process.env[CODING_PLAN_ENV_KEY];
  });

  it('does not show update prompt when no version is stored', () => {
    const { result } = renderHook(() =>
      useCodingPlanUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.codingPlanUpdateRequest).toBeUndefined();
  });

  it('does not show update prompt when versions match', () => {
    mockSettings.merged.codingPlan = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: chinaVersion,
    };
    mockSettings.merged.modelProviders = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useCodingPlanUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    expect(result.current.codingPlanUpdateRequest).toBeUndefined();
  });

  it('shows update prompt when versions differ', async () => {
    mockSettings.merged.codingPlan = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged.modelProviders = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useCodingPlanUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.codingPlanUpdateRequest).toBeDefined();
    });

    expect(result.current.codingPlanUpdateRequest?.prompt).toContain(
      'Coding Plan',
    );
  });

  it('executes update when user confirms', async () => {
    mockSettings.merged.codingPlan = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged.modelProviders = {
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
      useCodingPlanUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.codingPlanUpdateRequest).toBeDefined();
    });

    await result.current.codingPlanUpdateRequest!.onConfirm(true);

    await waitFor(() => {
      expect(mockSettings.setValue).toHaveBeenCalled();
    });

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      'codingPlan.version',
      chinaVersion,
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      'codingPlan.baseUrl',
      CODING_PLAN_CHINA_BASE_URL,
    );
    expect(mockConfig.reloadModelProvidersConfig).toHaveBeenCalled();
    expect(mockModelsConfig.syncAfterAuthRefresh).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3.5-plus',
    );
    expect(mockConfig.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('does not execute update when user declines', async () => {
    mockSettings.merged.codingPlan = {
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
      version: 'old-version-hash',
    };
    mockSettings.merged.modelProviders = {
      [AuthType.USE_OPENAI]: chinaTemplate,
    };

    const { result } = renderHook(() =>
      useCodingPlanUpdates(
        mockSettings as never,
        mockConfig as never,
        mockAddItem,
      ),
    );

    await waitFor(() => {
      expect(result.current.codingPlanUpdateRequest).toBeDefined();
    });

    await result.current.codingPlanUpdateRequest!.onConfirm(false);

    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(mockConfig.reloadModelProvidersConfig).not.toHaveBeenCalled();
  });
});
