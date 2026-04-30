/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import { applyProviderInstallPlan } from './applyProviderInstallPlan.js';
import type { LlmProvider, ProviderInstallPlan } from '../types.js';

vi.mock('../../utils/settingsUtils.js', () => ({
  backupSettingsFile: vi.fn(),
}));

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => SettingScope.User),
}));

const provider: LlmProvider = {
  id: 'test-provider',
  label: 'Test Provider',
  category: 'custom',
  protocol: AuthType.USE_OPENAI,
  setupMethods: [{ type: 'manual' }],
  ownsModel(model) {
    return model.envKey === 'TEST_API_KEY';
  },
  async createInstallPlan() {
    throw new Error('not used');
  },
};

function createSettings(modelProviders = {}) {
  return {
    merged: {
      modelProviders,
    },
    setValue: vi.fn(),
    forScope: vi.fn(() => ({ path: '/tmp/settings.json' })),
  };
}

function createConfig() {
  return {
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn(async () => undefined),
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
        },
      ],
    };

    await applyProviderInstallPlan(plan, {
      settings: settings as never,
      config: config as never,
      provider,
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
      provider,
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

  it('uses patch ownership before provider ownership', async () => {
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
      provider: {
        ...provider,
        ownsModel(model) {
          return typeof model.envKey === 'string';
        },
      },
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

  it('writes whitelisted provider state and legacy credentials', async () => {
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
      provider,
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
});
