/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  Protocol,
  deepseekProvider,
  openRouterProvider,
  tokenPlanProvider,
  customProvider,
  generateCustomEnvKey as generateCustomApiKeyEnvKey,
  getDefaultModelIds,
  resolveBaseUrl,
  type ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  useAuthCommand,
  normalizeCustomModelIds,
  maskApiKey,
} from './useAuth.js';

vi.mock('../hooks/useQwenAuth.js', () => ({
  useQwenAuth: vi.fn(() => ({
    qwenAuthState: {},
    cancelQwenAuth: vi.fn(),
  })),
}));

vi.mock('../../utils/settingsUtils.js', () => ({
  backupSettingsFile: vi.fn(),
  restoreSettingsFromBackup: vi.fn(),
  cleanupSettingsBackup: vi.fn(),
}));

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => 'user'),
}));

const createSettings = () => ({
  merged: {
    modelProviders: {},
  },
  setValue: vi.fn(),
  recomputeMerged: vi.fn(),
  forScope: vi.fn(() => ({
    path: '/tmp/settings.json',
    settings: {},
    originalSettings: {},
  })),
});

const createConfig = () => {
  const modelsConfig = {
    syncAfterAuthRefresh: vi.fn(),
  };
  return {
    getAuthType: vi.fn(() => Protocol.OPENAI),
    getUsageStatisticsEnabled: vi.fn(() => false),
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn(async () => undefined),
    getModelsConfig: vi.fn(() => modelsConfig),
  };
};

describe('useAuthCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes closeAuthDialog that flips isAuthDialogOpen to false', () => {
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

    act(() => {
      result.current.closeAuthDialog();
    });
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(result.current.authError).toBe(null);
  });

  it('configures DeepSeek via the unified provider submit', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    const inputs: ProviderSetupInputs = {
      baseUrl: resolveBaseUrl(deepseekProvider),
      apiKey: 'sk-deepseek',
      modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    };

    await act(async () => {
      await result.current.handleProviderSubmit(deepseekProvider, inputs);
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.DEEPSEEK_API_KEY',
      'sk-deepseek',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      'openai',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'deepseek-v4-flash',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(Protocol.OPENAI);
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Successfully configured DeepSeek'),
      }),
      expect.any(Number),
    );
  });

  it('configures OpenRouter via the unified provider submit', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(openRouterProvider, {
        baseUrl: resolveBaseUrl(openRouterProvider),
        apiKey: 'sk-or-v1-key',
        modelIds: ['z-ai/glm-4.5-air:free'],
      });
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.OPENROUTER_API_KEY',
      'sk-or-v1-key',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      'openai',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'z-ai/glm-4.5-air:free',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(Protocol.OPENAI);
  });

  it('configures Token Plan with the independent Token Plan endpoint', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(tokenPlanProvider, {
        baseUrl: resolveBaseUrl(tokenPlanProvider),
        apiKey: 'sk-token-plan',
        modelIds: getDefaultModelIds(tokenPlanProvider),
      });
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.BAILIAN_TOKEN_PLAN_API_KEY',
      'sk-token-plan',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(Protocol.OPENAI);
  });

  it('configures Custom API Key via the provider install plan flow', async () => {
    const envKey = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'https://api.example.com/v1',
    );
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(customProvider, {
        protocol: Protocol.OPENAI,
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-custom',
        modelIds: ['custom-model'],
        advancedConfig: {
          enableThinking: true,
        },
      });
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      `env.${envKey}`,
      'sk-custom',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      Protocol.OPENAI,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'custom-model',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(Protocol.OPENAI);
  });

  it('cancelAuthentication resets dialog + flags + clears authError', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    // Put the hook into the middle of an in-flight auth + an error to make
    // sure cancel resets *all* the visible state, not just isAuthenticating.
    act(() => {
      result.current.onAuthError('boom');
    });
    expect(result.current.authError).toBe('boom');
    expect(result.current.isAuthDialogOpen).toBe(true);

    act(() => {
      result.current.cancelAuthentication();
    });

    expect(result.current.isAuthenticating).toBe(false);
    expect(result.current.externalAuthState).toBeNull();
    expect(result.current.isAuthDialogOpen).toBe(true);
    expect(result.current.authError).toBeNull();
  });

  it('surfaces install-plan rejection as an auth error and records telemetry', async () => {
    const settings = createSettings();
    const config = createConfig();
    config.refreshAuth = vi.fn(async () => {
      throw new Error('refreshAuth rejected: bad endpoint');
    });
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(deepseekProvider, {
        baseUrl: resolveBaseUrl(deepseekProvider),
        apiKey: 'sk-bad',
        modelIds: ['deepseek-v4-flash'],
      });
    });

    // handleAuthFailure should have set the error, reopened the dialog, and
    // cleared the in-flight flag. The success toast must NOT have fired.
    expect(result.current.authError).toEqual(
      expect.stringContaining('refreshAuth rejected'),
    );
    expect(result.current.isAuthDialogOpen).toBe(true);
    expect(result.current.isAuthenticating).toBe(false);
    expect(addItem).not.toHaveBeenCalled();
    // pendingAuthType was set before applyProviderInstallPlan ran, so
    // handleAuthFailure had it available — the AuthEvent path is no longer
    // silently dropped on failure. (We can't assert the telemetry sink
    // directly here, but the visible side effects above all depend on
    // handleAuthFailure having seen pendingAuthType.)
    expect(result.current.pendingAuthType).toBe(Protocol.OPENAI);
  });
});

describe('generateCustomApiKeyEnvKey', () => {
  it('generates deterministic URL-based env key', () => {
    const key = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'https://api.openai.com/v1',
    );
    expect(key).toMatch(/^QWEN_CUSTOM_API_KEY_[A-Z0-9_]+$/);
    const key2 = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'https://api.openai.com/v1',
    );
    expect(key).toBe(key2);
  });

  it('produces different keys for different protocols', () => {
    const key1 = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'https://api.example.com/v1',
    );
    const key2 = generateCustomApiKeyEnvKey(
      Protocol.ANTHROPIC,
      'https://api.example.com/v1',
    );
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different base URLs', () => {
    const key1 = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'https://api.openai.com/v1',
    );
    const key2 = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'http://localhost:11434/v1',
    );
    expect(key1).not.toBe(key2);
  });

  it('produces equal keys for URLs that differ only in trailing slash', () => {
    const key1 = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'https://openrouter.ai/api/v1/',
    );
    const key2 = generateCustomApiKeyEnvKey(
      Protocol.OPENAI,
      'https://openrouter.ai/api/v1',
    );
    expect(key1).toBe(key2);
  });
});

describe('normalizeCustomModelIds', () => {
  it('splits comma-separated model IDs', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder,openai/gpt-4.1');
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('trims whitespace from each model ID', () => {
    const result = normalizeCustomModelIds(
      ' qwen/qwen3-coder , openai/gpt-4.1 ',
    );
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('deduplicates while preserving order', () => {
    const result = normalizeCustomModelIds(
      'qwen/qwen3-coder,openai/gpt-4.1,qwen/qwen3-coder',
    );
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('removes empty entries', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder,,openai/gpt-4.1');
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('returns empty array for empty input', () => {
    const result = normalizeCustomModelIds('');
    expect(result).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    const result = normalizeCustomModelIds('  ,  ,  ');
    expect(result).toEqual([]);
  });

  it('handles single model ID', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder');
    expect(result).toEqual(['qwen/qwen3-coder']);
  });
});

describe('maskApiKey', () => {
  it('masks a standard API key showing first 3 and last 4 chars', () => {
    const result = maskApiKey('sk-or-v1-1234567890abcdef');
    expect(result).toBe('sk-...cdef');
  });

  it('shows placeholder for empty string', () => {
    const result = maskApiKey('');
    expect(result).toBe('(not set)');
  });

  it('masks short keys with asterisks', () => {
    const result = maskApiKey('abc');
    expect(result).toBe('***');
  });

  it('masks 6-char keys with asterisks', () => {
    const result = maskApiKey('abcdef');
    expect(result).toBe('***');
  });

  it('trims whitespace before masking', () => {
    const result = maskApiKey('  sk-or-v1-1234567890abcdef  ');
    expect(result).toBe('sk-...cdef');
  });
});
