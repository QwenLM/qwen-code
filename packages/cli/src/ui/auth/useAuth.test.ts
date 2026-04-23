/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { useAuthCommand } from './useAuth.js';
import {
  OPENROUTER_OAUTH_CALLBACK_URL,
  createOpenRouterOAuthSession,
  runOpenRouterOAuthLogin,
} from '../../commands/auth/openrouterOAuth.js';

vi.mock('../hooks/useQwenAuth.js', () => ({
  useQwenAuth: vi.fn(() => ({
    qwenAuthState: {},
    cancelQwenAuth: vi.fn(),
  })),
}));

vi.mock('../../utils/settingsUtils.js', () => ({
  backupSettingsFile: vi.fn(),
}));

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => 'user'),
}));

vi.mock('../../commands/auth/openrouterOAuth.js', () => ({
  OPENROUTER_ENV_KEY: 'OPENROUTER_API_KEY',
  OPENROUTER_OAUTH_CALLBACK_URL: 'http://localhost:3000/openrouter/callback',
  createOpenRouterOAuthSession: vi.fn(() => ({
    callbackUrl: 'http://localhost:3000/openrouter/callback',
    codeVerifier: 'test-verifier',
    authorizationUrl:
      'https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fopenrouter%2Fcallback&code_challenge=test-challenge',
  })),
  getPreferredOpenRouterModelId: vi.fn(
    (models: Array<{ id: string }>) => models[0]?.id,
  ),
  runOpenRouterOAuthLogin: vi.fn(
    () => new Promise(() => undefined) as Promise<{ apiKey: string }>,
  ),
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
  ]),
  selectRecommendedOpenRouterModels: vi.fn((models: unknown[]) =>
    (models as Array<{ id: string }>).filter(
      (model) => model.id === 'openai/gpt-4o-mini:free',
    ),
  ),
  mergeOpenRouterConfigs: vi.fn(
    (existingConfigs: unknown[], models: unknown[]) => [
      ...models,
      ...existingConfigs,
    ],
  ),
}));

const createSettings = () => ({
  merged: {
    modelProviders: {},
  },
  setValue: vi.fn(),
  forScope: vi.fn(() => ({
    path: '/tmp/settings.json',
  })),
});

const createConfig = () => ({
  getAuthType: vi.fn(() => AuthType.USE_OPENAI),
  getUsageStatisticsEnabled: vi.fn(() => false),
  reloadModelProvidersConfig: vi.fn(),
  refreshAuth: vi.fn(async () => undefined),
});

describe('useAuthCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('closes auth dialog immediately when starting OpenRouter OAuth', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    act(() => {
      result.current.openAuthDialog();
    });

    expect(result.current.isAuthDialogOpen).toBe(true);

    await act(async () => {
      void result.current.handleOpenRouterSubmit();
      await Promise.resolve();
    });

    expect(result.current.pendingAuthType).toBe(AuthType.USE_OPENAI);
    expect(result.current.isAuthenticating).toBe(true);
    expect(result.current.externalAuthState).toEqual({
      title: 'OpenRouter Authentication',
      message:
        'Open the authorization page if your browser does not launch automatically.',
      detail: expect.stringContaining('https://openrouter.ai/auth'),
    });
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(addItem).not.toHaveBeenCalled();
  });

  it('cancels OpenRouter OAuth wait and reopens the auth dialog', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      void result.current.handleOpenRouterSubmit();
      await Promise.resolve();
    });

    expect(result.current.isAuthenticating).toBe(true);
    expect(createOpenRouterOAuthSession).toHaveBeenCalledWith(
      OPENROUTER_OAUTH_CALLBACK_URL,
    );
    expect(runOpenRouterOAuthLogin).toHaveBeenCalledWith(
      OPENROUTER_OAUTH_CALLBACK_URL,
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        session: expect.objectContaining({
          authorizationUrl: expect.stringContaining(
            'https://openrouter.ai/auth',
          ),
        }),
      }),
    );

    act(() => {
      result.current.cancelAuthentication();
    });

    const abortSignal = vi.mocked(runOpenRouterOAuthLogin).mock.calls[0]?.[1]
      ?.abortSignal;
    expect(abortSignal?.aborted).toBe(true);
    expect(result.current.isAuthenticating).toBe(false);
    expect(result.current.externalAuthState).toBe(null);
    expect(result.current.isAuthDialogOpen).toBe(true);
  });

  it('adds /model and /manage-models guidance after OpenRouter auth succeeds', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    vi.mocked(runOpenRouterOAuthLogin).mockResolvedValueOnce({
      apiKey: 'oauth-key-123',
      userId: 'user-1',
    });

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleOpenRouterSubmit();
    });

    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Successfully configured OpenRouter.' }),
      expect.any(Number),
    );
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Use /model to switch models.' }),
      expect.any(Number),
    );
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Want more OpenRouter models? Use /manage-models to browse and enable them.',
      }),
      expect.any(Number),
    );
  });
});
