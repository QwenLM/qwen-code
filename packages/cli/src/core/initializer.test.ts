/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { initializeApp } from './initializer.js';
import { SettingScope } from '../config/settings.js';
import { AuthType } from '@qwen-code/qwen-code-core';

vi.mock('./auth.js', () => ({
  performInitialAuth: vi.fn(),
}));

vi.mock('./theme.js', () => ({
  validateTheme: vi.fn(() => null),
}));

vi.mock('../i18n/index.js', () => ({
  initializeI18n: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    IdeClient: {
      getInstance: vi.fn(),
    },
    logIdeConnection: vi.fn(),
  };
});

import { performInitialAuth } from './auth.js';

describe('initializeApp', () => {
  const mockPerformInitialAuth = vi.mocked(performInitialAuth);

  const createMockConfig = (): Config =>
    ({
      getModelsConfig: () => ({
        getCurrentAuthType: () => AuthType.USE_OPENAI,
        wasAuthTypeExplicitlyProvided: () => false,
      }),
      getIdeMode: () => false,
      getGeminiMdFileCount: () => 0,
    }) as unknown as Config;

  const createMockSettings = () =>
    ({
      merged: {
        general: {
          language: 'en',
        },
      },
      setValue: vi.fn(),
    }) as const;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves selected auth type when initial auth fails', async () => {
    mockPerformInitialAuth.mockResolvedValue('Auth failed');
    const config = createMockConfig();
    const settings = createMockSettings();

    const result = await initializeApp(config, settings as never);

    expect(result.authError).toBe('Auth failed');
    expect(settings.setValue).not.toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      undefined,
    );
  });
});
