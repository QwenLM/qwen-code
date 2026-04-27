/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  useAuthCommand,
  generateCustomApiKeyEnvKey,
  normalizeCustomModelIds,
  maskApiKey,
} from './useAuth.js';
import {
  OPENROUTER_OAUTH_CALLBACK_URL,
  applyOpenRouterModelsConfiguration,
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
  OPENROUTER_OAUTH_CALLBACK_URL: 'http://localhost:3000/openrouter/callback',
  createOpenRouterOAuthSession: vi.fn(() => ({
    callbackUrl: 'http://localhost:3000/openrouter/callback',
    codeVerifier: 'test-verifier',
    state: 'test-state',
    authorizationUrl:
      'https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fopenrouter%2Fcallback&code_challenge=test-challenge&state=test-state',
  })),
  applyOpenRouterModelsConfiguration: vi.fn(async () => ({
    updatedConfigs: [
      {
        id: 'openai/gpt-4o-mini:free',
        name: 'OpenRouter · GPT-4o mini',
        baseUrl: 'https://openrouter.ai/api/v1',
        envKey: 'OPENROUTER_API_KEY',
      },
    ],
    activeModelId: 'openai/gpt-4o-mini:free',
    persistScope: 'user',
  })),
  runOpenRouterOAuthLogin: vi.fn(
    () => new Promise(() => undefined) as Promise<{ apiKey: string }>,
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

    act(() => {
      result.current.openAuthDialog();
    });

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
    expect(result.current.pendingAuthType).toBe(AuthType.USE_OPENAI);
    expect(result.current.isAuthDialogOpen).toBe(true);
  });

  it('cleans up UI state when OpenRouter OAuth rejects with AbortError', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    vi.mocked(runOpenRouterOAuthLogin).mockRejectedValueOnce(
      new DOMException('OpenRouter OAuth cancelled.', 'AbortError'),
    );

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleOpenRouterSubmit();
    });

    expect(result.current.isAuthenticating).toBe(false);
    expect(result.current.externalAuthState).toBe(null);
    expect(result.current.pendingAuthType).toBeUndefined();
    expect(result.current.isAuthDialogOpen).toBe(true);
    expect(addItem).not.toHaveBeenCalled();
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

    expect(applyOpenRouterModelsConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.anything(),
        config: expect.anything(),
        apiKey: 'oauth-key-123',
        reloadConfig: true,
      }),
    );
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

describe('generateCustomApiKeyEnvKey', () => {
  it('generates env key from openai protocol and base URL', () => {
    const key = generateCustomApiKeyEnvKey(
      'openai',
      'https://api.openai.com/v1',
    );
    expect(key).toBe('QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_API_OPENAI_COM_V1');
  });

  it('generates env key from anthropic protocol and base URL', () => {
    const key = generateCustomApiKeyEnvKey(
      'anthropic',
      'https://api.anthropic.com/v1',
    );
    expect(key).toBe(
      'QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_ANTHROPIC_COM_V1',
    );
  });

  it('generates env key from gemini protocol and base URL', () => {
    const key = generateCustomApiKeyEnvKey(
      'gemini',
      'https://generativelanguage.googleapis.com',
    );
    expect(key).toBe(
      'QWEN_CUSTOM_API_KEY_GEMINI_HTTPS_GENERATIVELANGUAGE_GOOGLEAPIS_COM',
    );
  });

  it('handles localhost URLs', () => {
    const key = generateCustomApiKeyEnvKey(
      'openai',
      'http://localhost:11434/v1',
    );
    expect(key).toBe('QWEN_CUSTOM_API_KEY_OPENAI_HTTP_LOCALHOST_11434_V1');
  });

  it('normalizes trailing slashes and special chars', () => {
    const key = generateCustomApiKeyEnvKey(
      'openai',
      'https://openrouter.ai/api/v1/',
    );
    expect(key).toBe('QWEN_CUSTOM_API_KEY_OPENAI_HTTPS_OPENROUTER_AI_API_V1');
  });

  it('different protocols with same base URL produce different keys', () => {
    const baseUrl = 'https://api.example.com/v1';
    const openaiKey = generateCustomApiKeyEnvKey('openai', baseUrl);
    const anthropicKey = generateCustomApiKeyEnvKey('anthropic', baseUrl);
    expect(openaiKey).not.toBe(anthropicKey);
    expect(openaiKey).toContain('OPENAI');
    expect(anthropicKey).toContain('ANTHROPIC');
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
