/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { initializeApp } from './initializer.js';
import { performInitialAuth } from './auth.js';
import { validateTheme } from './theme.js';
import { initializeI18n } from '../i18n/index.js';

vi.mock('./auth.js', () => ({
  performInitialAuth: vi.fn(),
}));

vi.mock('./theme.js', () => ({
  validateTheme: vi.fn(),
}));

vi.mock('../i18n/index.js', () => ({
  initializeI18n: vi.fn(),
}));

describe('initializeApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['QWEN_CODE_LANG'];

    vi.mocked(initializeI18n).mockResolvedValue(undefined);
    vi.mocked(validateTheme).mockReturnValue(null);
  });

  function createMockConfig(
    options: {
      authType?: AuthType;
      wasAuthTypeExplicitlyProvided?: boolean;
      geminiMdFileCount?: number;
      ideMode?: boolean;
    } = {},
  ): Config {
    const {
      authType = AuthType.USE_OPENAI,
      wasAuthTypeExplicitlyProvided = true,
      geminiMdFileCount = 0,
      ideMode = false,
    } = options;

    return {
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue(authType),
        wasAuthTypeExplicitlyProvided: vi
          .fn()
          .mockReturnValue(wasAuthTypeExplicitlyProvided),
      }),
      getIdeMode: vi.fn().mockReturnValue(ideMode),
      getGeminiMdFileCount: vi.fn().mockReturnValue(geminiMdFileCount),
    } as unknown as Config;
  }

  function createMockSettings(): LoadedSettings {
    return {
      merged: {
        general: {
          language: 'en',
        },
      },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
  }

  it('should not clear selected auth type when initial auth fails', async () => {
    vi.mocked(performInitialAuth).mockResolvedValue(
      'Failed to login. Message: missing OLLAMA_API_KEY',
    );

    const config = createMockConfig({
      authType: AuthType.USE_OPENAI,
      wasAuthTypeExplicitlyProvided: true,
    });
    const settings = createMockSettings();

    const result = await initializeApp(config, settings);

    expect(result.authError).toBe(
      'Failed to login. Message: missing OLLAMA_API_KEY',
    );
    expect(result.shouldOpenAuthDialog).toBe(true);
    expect(settings.setValue).not.toHaveBeenCalled();
  });

  it('should not open auth dialog when auth is explicit and succeeds', async () => {
    vi.mocked(performInitialAuth).mockResolvedValue(null);

    const config = createMockConfig({
      authType: AuthType.USE_OPENAI,
      wasAuthTypeExplicitlyProvided: true,
    });
    const settings = createMockSettings();

    const result = await initializeApp(config, settings);

    expect(result.authError).toBeNull();
    expect(result.shouldOpenAuthDialog).toBe(false);
  });
});
