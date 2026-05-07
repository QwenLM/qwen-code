/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import { applyProviderInstallPlan } from './applyProviderInstallPlan.js';
import type { ProviderInstallPlan } from '../types.js';

vi.mock('../../utils/settingsUtils.js', () => ({
  backupSettingsFile: vi.fn(),
  restoreSettingsFromBackup: vi.fn(),
  cleanupSettingsBackup: vi.fn(),
}));

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => SettingScope.User),
}));

function createSettings(modelProviders = {}) {
  const settingsObj = {
    settings: {},
    originalSettings: {},
    path: '/tmp/settings.json',
  };
  return {
    merged: {
      modelProviders,
    },
    setValue: vi.fn(),
    forScope: vi.fn(() => settingsObj),
    recomputeMerged: vi.fn(),
  };
}

function createConfig() {
  const modelsConfig = {
    syncAfterAuthRefresh: vi.fn(),
  };
  return {
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn(async () => undefined),
    getModelsConfig: vi.fn(() => modelsConfig),
  };
}

describe('applyProviderInstallPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['TEST_API_KEY'];
  });

  it('persists env, auth selection, selected model, and merged model providers', async () => {
    const settings = createSettings({
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
    const config = createConfig();
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: {
        TEST_API_KEY: 'sk-test',
      },
      modelSelection: {
        modelId: 'new-model',
      },
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
      settings: settings as never,
      config: config as never,
    });

    expect(settings.forScope).toHaveBeenCalledWith(SettingScope.User);
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(process.env['TEST_API_KEY']).toBe('sk-test');
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'modelProviders.openai',
      [
        { id: 'new-model', envKey: 'TEST_API_KEY' },
        {
          id: 'preserved',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 456 },
        },
      ],
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'new-model',
    );
    expect(config.reloadModelProvidersConfig).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: [
        { id: 'new-model', envKey: 'TEST_API_KEY' },
        {
          id: 'preserved',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 456 },
        },
      ],
    });
    expect(config.getModelsConfig().syncAfterAuthRefresh).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'new-model',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('can skip immediate auth refresh after persisting a provider plan', async () => {
    const settings = createSettings();
    const config = createConfig();
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: {
        TEST_API_KEY: 'sk-test',
      },
    };

    await applyProviderInstallPlan(plan, {
      settings: settings as never,
      config: config as never,
      refreshAuth: false,
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(config.reloadModelProvidersConfig).toHaveBeenCalled();
    expect(config.refreshAuth).not.toHaveBeenCalled();
  });

  it('uses patch ownsModel for merge filtering', async () => {
    const settings = createSettings({
      [AuthType.USE_OPENAI]: [
        { id: 'old-a', envKey: 'A' },
        { id: 'old-b', envKey: 'B' },
      ],
    });
    const config = createConfig();
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-a', envKey: 'A' }],
          mergeStrategy: 'prepend-and-remove-owned',
          ownsModel(model) {
            return model.envKey === 'A';
          },
        },
      ],
    };

    await applyProviderInstallPlan(plan, {
      settings: settings as never,
      config: config as never,
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'modelProviders.openai',
      [
        { id: 'new-a', envKey: 'A' },
        { id: 'old-b', envKey: 'B' },
      ],
    );
  });

  it('writes provider state and legacy credentials', async () => {
    const settings = createSettings();
    const config = createConfig();
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

    await applyProviderInstallPlan(plan, {
      settings: settings as never,
      config: config as never,
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.apiKey',
      'legacy-key',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.baseUrl',
      'https://example.com/v1',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'codingPlan.baseUrl',
      'https://coding.example.com/v1',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'codingPlan.version',
      'v1',
    );
  });

  it('appends models with append merge strategy', async () => {
    const settings = createSettings({
      [AuthType.USE_OPENAI]: [
        { id: 'existing-1', envKey: 'A' },
        { id: 'existing-2', envKey: 'B' },
      ],
    });
    const config = createConfig();
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

    await applyProviderInstallPlan(plan, {
      settings: settings as never,
      config: config as never,
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'modelProviders.openai',
      [
        { id: 'existing-1', envKey: 'A' },
        { id: 'existing-2', envKey: 'B' },
        { id: 'new-model', envKey: 'C' },
      ],
    );
  });

  it('replaces owned models with replace-owned strategy (appends new at end)', async () => {
    const settings = createSettings({
      [AuthType.USE_OPENAI]: [
        { id: 'owned-1', envKey: 'A' },
        { id: 'unrelated', envKey: 'B' },
        { id: 'owned-2', envKey: 'A' },
      ],
    });
    const config = createConfig();
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

    await applyProviderInstallPlan(plan, {
      settings: settings as never,
      config: config as never,
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'modelProviders.openai',
      [
        { id: 'unrelated', envKey: 'B' },
        { id: 'new-a', envKey: 'A' },
      ],
    );
  });

  it('rolls back process.env on error', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const settings = createSettings();
    const config = createConfig();
    config.refreshAuth.mockRejectedValueOnce(new Error('network error'));
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new-value' },
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: settings as never,
        config: config as never,
      }),
    ).rejects.toThrow('network error');

    expect(process.env['TEST_API_KEY']).toBe('old-value');
  });

  it('deletes env var on rollback if it did not exist before', async () => {
    delete process.env['BRAND_NEW_KEY'];
    const settings = createSettings();
    const config = createConfig();
    config.refreshAuth.mockRejectedValueOnce(new Error('fail'));
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { BRAND_NEW_KEY: 'value' },
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: settings as never,
        config: config as never,
      }),
    ).rejects.toThrow('fail');

    expect(process.env['BRAND_NEW_KEY']).toBeUndefined();
  });
});
