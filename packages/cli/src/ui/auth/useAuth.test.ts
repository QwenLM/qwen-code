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
  normalizeCustomModelIds,
  maskApiKey,
} from './useAuth.js';
import { generateCustomEnvKey as generateCustomApiKeyEnvKey } from '../../auth/allProviders.js';
import {
  OPENROUTER_OAUTH_CALLBACK_URL,
  createOpenRouterOAuthSession,
  runOpenRouterOAuthLogin,
} from '../../auth/providers/oauth/openrouterOAuth.js';

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

vi.mock('../../auth/providers/oauth/openrouterOAuth.js', () => ({
  OPENROUTER_OAUTH_CALLBACK_URL: 'http://localhost:3000/openrouter/callback',
  createOpenRouterOAuthSession: vi.fn(() => ({
    callbackUrl: 'http://localhost:3000/openrouter/callback',
    codeVerifier: 'test-verifier',
    state: 'test-state',
    authorizationUrl:
      'https://openrouter.ai/auth?callback_url=http%3A%2F%2Flocalhost%3A3000%2Fopenrouter%2Fcallback&code_challenge=test-challenge&state=test-state',
  })),
  getOpenRouterModelsWithFallback: vi.fn(async () => [
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
  ]),
  getPreferredOpenRouterModelId: vi.fn((models) => models[0]?.id),
  isOpenRouterConfig: vi.fn((model) =>
    Boolean(model.baseUrl?.includes('openrouter.ai')),
  ),
  OPENROUTER_ENV_KEY: 'OPENROUTER_API_KEY',
  OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
  selectRecommendedOpenRouterModels: vi.fn((models) => models),
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

const createConfig = () => {
  const modelsConfig = {
    syncAfterAuthRefresh: vi.fn(),
  };
  return {
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
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

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.OPENROUTER_API_KEY',
      'oauth-key-123',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'modelProviders.openai',
      [
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
    );
    expect(config.reloadModelProvidersConfig).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: [
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
    });
    expect(config.refreshAuth).not.toHaveBeenCalled();
    expect(result.current.authError).toBe(null);
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Successfully configured OpenRouter. Use /model to switch models.',
      }),
      expect.any(Number),
    );
  });

  it('configures DeepSeek via the shared API key provider flow', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleApiKeyProviderSubmit(
        'deepseek',
        ' sk-deepseek ',
        'deepseek-v4-flash, deepseek-v4-pro, deepseek-v4-flash',
      );
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.DEEPSEEK_API_KEY',
      'sk-deepseek',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'modelProviders.openai',
      [
        {
          id: 'deepseek-v4-flash',
          name: '[DeepSeek] deepseek-v4-flash',
          baseUrl: 'https://api.deepseek.com',
          envKey: 'DEEPSEEK_API_KEY',
          generationConfig: { contextWindowSize: 1000000 },
        },
        {
          id: 'deepseek-v4-pro',
          name: '[DeepSeek] deepseek-v4-pro',
          baseUrl: 'https://api.deepseek.com',
          envKey: 'DEEPSEEK_API_KEY',
          generationConfig: {
            contextWindowSize: 1000000,
            extra_body: { enable_thinking: true },
            modalities: { image: true, video: true },
          },
        },
      ],
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
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'providerMetadata.deepseek.version',
      expect.any(String),
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'providerMetadata.deepseek.baseUrl',
      'https://api.deepseek.com',
    );
    expect(config.reloadModelProvidersConfig).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: expect.any(Array),
    });
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('configures Token Plan with the independent Token Plan endpoint', async () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleTokenPlanSubmit('sk-token-plan');
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.BAILIAN_TOKEN_PLAN_API_KEY',
      'sk-token-plan',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'modelProviders.openai',
      expect.arrayContaining([
        expect.objectContaining({
          id: 'qwen3.6-plus',
          name: '[ModelStudio Token Plan] qwen3.6-plus',
          baseUrl:
            'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
        }),
        expect.objectContaining({
          id: 'deepseek-v3.2',
          name: '[ModelStudio Token Plan] deepseek-v3.2',
          baseUrl:
            'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
        }),
        expect.objectContaining({
          id: 'glm-5',
          name: '[ModelStudio Token Plan] glm-5',
          baseUrl:
            'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
        }),
        expect.objectContaining({
          id: 'MiniMax-M2.5',
          name: '[ModelStudio Token Plan] MiniMax-M2.5',
          baseUrl:
            'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
        }),
      ]),
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('configures Custom API Key via the provider install plan flow', async () => {
    const envKey = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.example.com/v1',
    );
    const settings = createSettings();
    settings.merged.modelProviders = {
      [AuthType.USE_OPENAI]: [
        {
          id: 'old-custom',
          name: 'old-custom',
          baseUrl: 'https://api.example.com/v1',
          envKey,
        },
        {
          id: 'preserved-model',
          name: 'preserved-model',
          baseUrl: 'https://api.other.com/v1',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 999 },
        },
      ],
    };
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleCustomApiKeySubmit(
        AuthType.USE_OPENAI,
        ' https://api.example.com/v1 ',
        ' sk-custom ',
        'custom-model, custom-model-2, custom-model',
        {
          enableThinking: true,
          multimodal: { image: true, video: false, audio: true },
          maxTokens: 4096,
        },
      );
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      `env.${envKey}`,
      'sk-custom',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'modelProviders.openai',
      [
        {
          id: 'custom-model',
          name: 'custom-model',
          baseUrl: 'https://api.example.com/v1',
          envKey,
          generationConfig: {
            modalities: { image: true, video: false, audio: true },
            extra_body: { enable_thinking: true },
            samplingParams: { max_tokens: 4096 },
          },
        },
        {
          id: 'custom-model-2',
          name: 'custom-model-2',
          baseUrl: 'https://api.example.com/v1',
          envKey,
          generationConfig: {
            modalities: { image: true, video: false, audio: true },
            extra_body: { enable_thinking: true },
            samplingParams: { max_tokens: 4096 },
          },
        },
        {
          id: 'old-custom',
          name: 'old-custom',
          baseUrl: 'https://api.example.com/v1',
          envKey,
        },
        {
          id: 'preserved-model',
          name: 'preserved-model',
          baseUrl: 'https://api.other.com/v1',
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 999 },
        },
      ],
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'custom-model',
    );
    expect(config.reloadModelProvidersConfig).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: expect.arrayContaining([
        expect.objectContaining({ id: 'custom-model' }),
        expect.objectContaining({ id: 'preserved-model' }),
      ]),
    });
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('configures Alibaba standard regional endpoints via the shared API key provider flow', async () => {
    const settings = createSettings();
    settings.merged.modelProviders = {
      [AuthType.USE_OPENAI]: [
        {
          id: 'deepseek-v4-flash',
          name: '[DeepSeek] deepseek-v4-flash',
          baseUrl: 'https://api.deepseek.com',
          envKey: 'DEEPSEEK_API_KEY',
        },
        {
          id: 'old-qwen',
          name: '[ModelStudio Standard] old-qwen',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
        {
          id: 'custom-dashscope-compatible',
          name: '[Custom] custom-dashscope-compatible',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ],
    };
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleApiKeyProviderSubmit(
        'alibabaStandard',
        'sk-dashscope',
        'qwen3.5-plus',
        'sg-singapore',
      );
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'env.DASHSCOPE_API_KEY',
      'sk-dashscope',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'modelProviders.openai',
      [
        {
          id: 'qwen3.5-plus',
          name: '[ModelStudio Standard] qwen3.5-plus',
          baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
        {
          id: 'deepseek-v4-flash',
          name: '[DeepSeek] deepseek-v4-flash',
          baseUrl: 'https://api.deepseek.com',
          envKey: 'DEEPSEEK_API_KEY',
        },
        {
          id: 'custom-dashscope-compatible',
          name: '[Custom] custom-dashscope-compatible',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          envKey: 'DASHSCOPE_API_KEY',
        },
      ],
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      'openai',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'qwen3.5-plus',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'providerMetadata.alibabaStandard.version',
      expect.any(String),
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'providerMetadata.alibabaStandard.baseUrl',
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
  });
});

describe('generateCustomApiKeyEnvKey', () => {
  it('generates deterministic URL-based env key', () => {
    const key = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.openai.com/v1',
    );
    expect(key).toMatch(/^QWEN_CUSTOM_API_KEY_[A-Z0-9_]+$/);
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.openai.com/v1',
    );
    expect(key).toBe(key2);
  });

  it('produces different keys for different protocols', () => {
    const key1 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.example.com/v1',
    );
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_ANTHROPIC,
      'https://api.example.com/v1',
    );
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different base URLs', () => {
    const key1 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://api.openai.com/v1',
    );
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:11434/v1',
    );
    expect(key1).not.toBe(key2);
  });

  it('produces equal keys for URLs that differ only in trailing slash', () => {
    // Trailing slashes are normalized away, so these should be equal.
    const key1 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'https://openrouter.ai/api/v1/',
    );
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
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
