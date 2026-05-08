/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthType,
  type Config,
  type ModelProvidersConfig,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  fetchManageModelsCatalog,
  getEnabledModelIdsForSource,
  saveManageModelsSelection,
} from './manageModels.js';

const {
  mockFetchOpenRouterModels,
  mockMergeOpenRouterConfigs,
  mockIsOpenRouterConfig,
} = vi.hoisted(() => ({
  mockFetchOpenRouterModels: vi.fn(),
  mockMergeOpenRouterConfigs: vi.fn(),
  mockIsOpenRouterConfig: vi.fn(),
}));

vi.mock('../../auth/providers/oauth/openrouterOAuth.js', () => ({
  OPENROUTER_DEFAULT_MODEL: 'z-ai/glm-4.5-air:free',
  fetchOpenRouterModels: mockFetchOpenRouterModels,
  mergeOpenRouterConfigs: mockMergeOpenRouterConfigs,
  isOpenRouterConfig: mockIsOpenRouterConfig,
}));

describe('manageModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchManageModelsCatalog maps OpenRouter models into catalog entries', async () => {
    mockFetchOpenRouterModels.mockResolvedValue([
      {
        id: 'qwen/qwen3-coder:free',
        name: 'OpenRouter · Qwen3 Coder',
        capabilities: { vision: true },
        generationConfig: { contextWindowSize: 1_000_000 },
      },
    ]);

    const catalog = await fetchManageModelsCatalog('openrouter');

    expect(catalog.source).toBe('openrouter');
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.label).toBe('Qwen3 Coder');
    expect(catalog.entries[0]?.badges).toEqual(
      expect.arrayContaining(['free', 'vision', 'long-context']),
    );
  });

  it('getEnabledModelIdsForSource only returns OpenRouter-enabled ids', () => {
    mockIsOpenRouterConfig.mockImplementation(
      (config: { baseUrl?: string }) =>
        config.baseUrl?.includes('openrouter') ?? false,
    );

    const settings = {
      merged: {
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'openai/gpt-4o-mini',
              baseUrl: 'https://openrouter.ai/api/v1',
            },
            { id: 'custom/model', baseUrl: 'https://example.com/v1' },
          ],
        },
      },
    } as unknown as LoadedSettings;

    expect(getEnabledModelIdsForSource('openrouter', settings)).toEqual([
      'openai/gpt-4o-mini',
    ]);
  });

  it('saveManageModelsSelection merges selected OpenRouter models and reloads config', async () => {
    const settings = {
      isTrusted: false,
      user: { settings: { modelProviders: {} } },
      workspace: { settings: {} },
      merged: {
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            { id: 'old-openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
            { id: 'custom/model', baseUrl: 'https://example.com/v1' },
          ],
        } satisfies ModelProvidersConfig,
      },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const config = {
      getContentGeneratorConfig: vi
        .fn()
        .mockReturnValue({ authType: AuthType.USE_OPENAI }),
      getModel: vi.fn().mockReturnValue('old-openrouter'),
      reloadModelProvidersConfig: vi.fn(),
      refreshAuth: vi.fn().mockResolvedValue(undefined),
    } as unknown as Config;

    mockMergeOpenRouterConfigs.mockReturnValue([
      { id: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' },
      { id: 'custom/model', baseUrl: 'https://example.com/v1' },
    ]);

    const result = await saveManageModelsSelection({
      source: 'openrouter',
      selectedModels: [
        { id: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' },
      ],
      settings,
      config,
    });

    expect(mockMergeOpenRouterConfigs).toHaveBeenCalled();
    expect(settings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      `modelProviders.${AuthType.USE_OPENAI}`,
      [
        { id: 'openai/gpt-4o-mini', baseUrl: 'https://openrouter.ai/api/v1' },
        { id: 'custom/model', baseUrl: 'https://example.com/v1' },
      ],
    );
    expect(config.reloadModelProvidersConfig).toHaveBeenCalled();
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(result.selectedIds).toEqual(['openai/gpt-4o-mini']);
    expect(result.activeModelId).toBe('openai/gpt-4o-mini');
  });
});
