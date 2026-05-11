/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleQwenAuth } from './handler.js';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

const {
  mockRefreshAuth,
  mockSetValue,
  mockForScope,
  mockBackupSettingsFile,
  mockLoadCliConfig,
  mockReloadModelProvidersConfig,
  mockSyncAfterAuthRefresh,
} = vi.hoisted(() => {
  const mockRefreshAuth = vi.fn();
  const mockReloadModelProvidersConfig = vi.fn();
  const mockSyncAfterAuthRefresh = vi.fn();
  return {
    mockRefreshAuth,
    mockSetValue: vi.fn(),
    mockForScope: vi.fn(() => ({ path: '/user.json' })),
    mockBackupSettingsFile: vi.fn(),
    mockReloadModelProvidersConfig,
    mockSyncAfterAuthRefresh,
    mockLoadCliConfig: vi.fn(async () => ({
      refreshAuth: mockRefreshAuth,
      reloadModelProvidersConfig: mockReloadModelProvidersConfig,
      getModelsConfig: vi.fn(() => ({
        syncAfterAuthRefresh: mockSyncAfterAuthRefresh,
      })),
    })),
  };
});

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));

vi.mock('../../config/config.js', () => ({
  loadCliConfig: mockLoadCliConfig,
}));

vi.mock('../../utils/settingsUtils.js', () => ({
  backupSettingsFile: mockBackupSettingsFile,
  restoreSettingsFromBackup: vi.fn(),
  cleanupSettingsBackup: vi.fn(),
}));

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => 'user'),
}));

vi.mock('../../auth/providers/oauth/openrouter.js', () => ({
  openRouterProvider: {
    id: 'openrouter',
    label: 'OpenRouter',
    category: 'third-party',
    protocol: 'openai',
    setupMethods: [{ type: 'oauth' }],
    ownsModel: (model: { baseUrl?: string }) =>
      model.baseUrl === 'https://openrouter.ai/api/v1',
  },
  createOpenRouterProviderInstallPlan: vi.fn(async ({ apiKey }) => ({
    providerId: 'openrouter',
    authType: 'openai',
    env: {
      OPENROUTER_API_KEY: apiKey,
    },
    modelSelection: {
      modelId: 'z-ai/glm-4.5-air:free',
    },
    modelProviders: [
      {
        authType: 'openai',
        models: [
          {
            id: 'z-ai/glm-4.5-air:free',
            name: 'OpenRouter · GLM 4.5 Air',
            baseUrl: 'https://openrouter.ai/api/v1',
            envKey: 'OPENROUTER_API_KEY',
          },
          {
            id: 'openai/gpt-oss-120b:free',
            name: 'OpenRouter · GPT OSS 120B',
            baseUrl: 'https://openrouter.ai/api/v1',
            envKey: 'OPENROUTER_API_KEY',
          },
        ],
        mergeStrategy: 'prepend-and-remove-owned',
        ownsModel: (model: { baseUrl?: string }) =>
          (model.baseUrl ?? '').includes('openrouter.ai'),
      },
    ],
  })),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

vi.mock('../../auth/providers/oauth/openrouterOAuth.js', () => ({
  OPENROUTER_ENV_KEY: 'OPENROUTER_API_KEY',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  OPENROUTER_OAUTH_CALLBACK_URL: 'http://localhost:3000/openrouter/callback',
  createOpenRouterOAuthSession: vi.fn(() => ({
    callbackUrl: 'http://localhost:3000/openrouter/callback',
    codeVerifier: 'test-verifier',
    authorizationUrl: 'https://openrouter.ai/auth?manual=1',
  })),
  runOpenRouterOAuthLogin: vi.fn(),
}));

import { loadSettings } from '../../config/settings.js';
import { runOpenRouterOAuthLogin } from '../../auth/providers/oauth/openrouterOAuth.js';

describe('handleQwenAuth openrouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    delete process.env['OPENROUTER_API_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['OPENROUTER_API_KEY'];
  });

  const createMockSettings = (
    merged: Record<string, unknown>,
  ): LoadedSettings =>
    ({
      merged,
      system: { settings: {}, path: '/system.json' },
      systemDefaults: { settings: {}, path: '/system-defaults.json' },
      user: { settings: {}, path: '/user.json' },
      workspace: { settings: {}, path: '/workspace.json' },
      forScope: mockForScope,
      setValue: mockSetValue,
      getUserHooks: vi.fn(() => []),
      getProjectHooks: vi.fn(() => []),
      isTrusted: true,
    }) as unknown as LoadedSettings;

  it('stores OpenRouter key and model provider config', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'gpt-4.1',
              name: 'OpenAI GPT-4.1',
              baseUrl: 'https://api.openai.com/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      }),
    );

    await handleQwenAuth('openrouter', { key: 'or-key-123' });

    expect(mockBackupSettingsFile).toHaveBeenCalledWith('/user.json');
    expect(mockSetValue).toHaveBeenCalledWith(
      'user',
      'env.OPENROUTER_API_KEY',
      'or-key-123',
    );
    expect(mockSetValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(mockSetValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'z-ai/glm-4.5-air:free',
    );

    const modelProvidersCall = mockSetValue.mock.calls.find(
      (call) => call[1] === `modelProviders.${AuthType.USE_OPENAI}`,
    );
    expect(modelProvidersCall).toBeDefined();
    expect(modelProvidersCall?.[2]).toEqual([
      {
        id: 'z-ai/glm-4.5-air:free',
        name: 'OpenRouter · GLM 4.5 Air',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'openai/gpt-oss-120b:free',
        name: 'OpenRouter · GPT OSS 120B',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'gpt-4.1',
        name: 'OpenAI GPT-4.1',
        baseUrl: 'https://api.openai.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    ]);
    expect(mockReloadModelProvidersConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        [AuthType.USE_OPENAI]: expect.arrayContaining([
          expect.objectContaining({ id: 'z-ai/glm-4.5-air:free' }),
        ]),
      }),
    );
    expect(mockSyncAfterAuthRefresh).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'z-ai/glm-4.5-air:free',
    );
    expect(mockRefreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(process.env['OPENROUTER_API_KEY']).toBe('or-key-123');
  });

  it('replaces existing OpenRouter configs instead of duplicating them', async () => {
    vi.mocked(loadSettings).mockReturnValue(
      createMockSettings({
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'old/model',
              name: 'Old OpenRouter Model',
              baseUrl: 'https://openrouter.ai/api/v1',
              envKey: 'OPENROUTER_API_KEY',
            },
            {
              id: 'gpt-4.1',
              name: 'OpenAI GPT-4.1',
              baseUrl: 'https://api.openai.com/v1',
              envKey: 'OPENAI_API_KEY',
            },
          ],
        },
      }),
    );

    await handleQwenAuth('openrouter', { key: 'or-key-456' });

    const modelProvidersCall = mockSetValue.mock.calls.find(
      (call) => call[1] === `modelProviders.${AuthType.USE_OPENAI}`,
    );
    expect(modelProvidersCall?.[2]).toEqual([
      {
        id: 'z-ai/glm-4.5-air:free',
        name: 'OpenRouter · GLM 4.5 Air',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'openai/gpt-oss-120b:free',
        name: 'OpenRouter · GPT OSS 120B',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'gpt-4.1',
        name: 'OpenAI GPT-4.1',
        baseUrl: 'https://api.openai.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    ]);
  });

  it('uses OAuth flow when key is not provided', async () => {
    vi.mocked(loadSettings).mockReturnValue(createMockSettings({}));
    vi.mocked(runOpenRouterOAuthLogin).mockResolvedValue({
      apiKey: 'oauth-key-123',
      userId: 'user-1',
      authorizationUrl: 'https://openrouter.ai/auth?manual=1',
    });

    await handleQwenAuth('openrouter', {});

    expect(runOpenRouterOAuthLogin).toHaveBeenCalledTimes(1);
    expect(mockSetValue).toHaveBeenCalledWith(
      'user',
      'env.OPENROUTER_API_KEY',
      'oauth-key-123',
    );
    expect(process.env['OPENROUTER_API_KEY']).toBe('oauth-key-123');
  });

  it('applies OpenRouter provider updates through the shared installer', async () => {
    vi.mocked(loadSettings).mockReturnValue(createMockSettings({}));

    await handleQwenAuth('openrouter', { key: 'or-key-dynamic' });

    expect(mockSetValue).toHaveBeenCalledWith(
      'user',
      'env.OPENROUTER_API_KEY',
      'or-key-dynamic',
    );
    expect(mockReloadModelProvidersConfig).toHaveBeenCalled();
    expect(mockSyncAfterAuthRefresh).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'z-ai/glm-4.5-air:free',
    );
    expect(mockRefreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });
});
