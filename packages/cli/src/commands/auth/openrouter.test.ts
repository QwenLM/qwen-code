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
} = vi.hoisted(() => {
  const mockRefreshAuth = vi.fn();
  return {
    mockRefreshAuth,
    mockSetValue: vi.fn(),
    mockForScope: vi.fn(() => ({ path: '/user.json' })),
    mockBackupSettingsFile: vi.fn(),
    mockLoadCliConfig: vi.fn(async () => ({
      refreshAuth: mockRefreshAuth,
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
}));

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => 'user'),
}));

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));

vi.mock('./openrouterOAuth.js', () => ({
  OPENROUTER_ENV_KEY: 'OPENROUTER_API_KEY',
  OPENROUTER_DEFAULT_MODEL: 'openai/gpt-4o-mini',
  OPENROUTER_OAUTH_CALLBACK_URL: 'http://localhost:3000/openrouter/callback',
  getOpenRouterModelsWithFallback: vi.fn(async () => [
    {
      id: 'openai/gpt-4o-mini:free',
      name: 'OpenRouter · GPT-4o mini',
      baseUrl: 'https://openrouter.ai/api/v1',
      envKey: 'OPENROUTER_API_KEY',
    },
    {
      id: 'anthropic/claude-3.7-sonnet',
      name: 'OpenRouter · Claude 3.7 Sonnet',
      baseUrl: 'https://openrouter.ai/api/v1',
      envKey: 'OPENROUTER_API_KEY',
    },
    {
      id: 'google/gemini-2.5-flash',
      name: 'OpenRouter · Gemini 2.5 Flash',
      baseUrl: 'https://openrouter.ai/api/v1',
      envKey: 'OPENROUTER_API_KEY',
    },
  ]),
  selectRecommendedOpenRouterModels: vi.fn((models: unknown[]) =>
    (models as Array<{ id: string }>).filter((model) =>
      ['openai/gpt-4o-mini:free', 'anthropic/claude-3.7-sonnet'].includes(
        model.id,
      ),
    ),
  ),
  isOpenRouterConfig: (config: { baseUrl?: string }) =>
    (config.baseUrl || '').includes('openrouter.ai'),
  mergeOpenRouterConfigs: (
    existingConfigs: Array<{ baseUrl?: string }>,
    openRouterModels: unknown[],
  ) => [
    ...openRouterModels,
    ...existingConfigs.filter(
      (config) => !(config.baseUrl || '').includes('openrouter.ai'),
    ),
  ],
  runOpenRouterOAuthLogin: vi.fn(),
}));

import { loadSettings } from '../../config/settings.js';
import { runOpenRouterOAuthLogin } from './openrouterOAuth.js';

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
      'openai/gpt-4o-mini',
    );

    const modelProvidersCall = mockSetValue.mock.calls.find(
      (call) => call[1] === `modelProviders.${AuthType.USE_OPENAI}`,
    );
    expect(modelProvidersCall).toBeDefined();
    expect(modelProvidersCall?.[2]).toEqual([
      {
        id: 'openai/gpt-4o-mini:free',
        name: 'OpenRouter · GPT-4o mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'anthropic/claude-3.7-sonnet',
        name: 'OpenRouter · Claude 3.7 Sonnet',
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
        id: 'openai/gpt-4o-mini:free',
        name: 'OpenRouter · GPT-4o mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'anthropic/claude-3.7-sonnet',
        name: 'OpenRouter · Claude 3.7 Sonnet',
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

  it('stores recommended OpenRouter models instead of the full fetched catalog', async () => {
    const {
      getOpenRouterModelsWithFallback,
      selectRecommendedOpenRouterModels,
    } = await import('./openrouterOAuth.js');
    vi.mocked(loadSettings).mockReturnValue(createMockSettings({}));
    vi.mocked(getOpenRouterModelsWithFallback).mockResolvedValue([
      {
        id: 'openai/gpt-5-mini',
        name: 'OpenRouter · GPT-5 Mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'anthropic/claude-3.7-sonnet',
        name: 'OpenRouter · Claude 3.7 Sonnet',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'google/gemini-2.5-flash',
        name: 'OpenRouter · Gemini 2.5 Flash',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
    ]);

    await handleQwenAuth('openrouter', { key: 'or-key-dynamic' });

    expect(selectRecommendedOpenRouterModels).toHaveBeenCalledWith([
      {
        id: 'openai/gpt-5-mini',
        name: 'OpenRouter · GPT-5 Mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'anthropic/claude-3.7-sonnet',
        name: 'OpenRouter · Claude 3.7 Sonnet',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
      {
        id: 'google/gemini-2.5-flash',
        name: 'OpenRouter · Gemini 2.5 Flash',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
    ]);

    const modelProvidersCall = mockSetValue.mock.calls.find(
      (call) => call[1] === `modelProviders.${AuthType.USE_OPENAI}`,
    );
    expect(modelProvidersCall?.[2]).toEqual([
      {
        id: 'anthropic/claude-3.7-sonnet',
        name: 'OpenRouter · Claude 3.7 Sonnet',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
    ]);
  });
});
