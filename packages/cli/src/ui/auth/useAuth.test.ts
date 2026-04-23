/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthType } from '@qwen-code/qwen-code-core';
import { useAuthCommand } from './useAuth.js';

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
  OPENROUTER_DEFAULT_MODEL: 'openai/gpt-4o-mini',
  OPENROUTER_OAUTH_CALLBACK_URL: 'http://localhost:3000/openrouter/callback',
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
      message: 'Waiting for OpenRouter callback...',
      detail: 'http://localhost:3000/openrouter/callback',
    });
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          'Starting OpenRouter OAuth in your browser',
        ),
      }),
      expect.any(Number),
    );
  });
});
