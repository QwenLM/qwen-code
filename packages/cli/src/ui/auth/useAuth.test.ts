/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  AuthType,
  deepseekProvider,
  openRouterProvider,
  tokenPlanProvider,
  customProvider,
  generateCustomEnvKey as generateCustomApiKeyEnvKey,
  getDefaultModelIds,
  resolveBaseUrl,
  findProviderById,
  CopilotTokenNotFoundError,
  type ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  useAuthCommand,
  normalizeCustomModelIds,
  maskApiKey,
} from './useAuth.js';

const copilotMocks = vi.hoisted(() => ({
  discoverGithubToken: vi.fn(),
  runCopilotDeviceFlow: vi.fn(),
  persistGithubToken: vi.fn(),
}));

vi.mock('../hooks/useQwenAuth.js', () => ({
  useQwenAuth: vi.fn(() => ({
    qwenAuthState: {},
    cancelQwenAuth: vi.fn(),
  })),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    discoverGithubToken: copilotMocks.discoverGithubToken,
    runCopilotDeviceFlow: copilotMocks.runCopilotDeviceFlow,
    persistGithubToken: copilotMocks.persistGithubToken,
  };
});

vi.mock('../../utils/settingsUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/settingsUtils.js')>();
  return {
    ...actual,
    backupSettingsFile: vi.fn(),
    restoreSettingsFromBackup: vi.fn(),
    cleanupSettingsBackup: vi.fn(),
  };
});

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => 'user'),
}));

function setNestedValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  const parts = key.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

const createSettings = (initialSettings: Record<string, unknown> = {}) => {
  const settingsFile = {
    path: '/tmp/settings.json',
    settings: structuredClone(initialSettings),
    originalSettings: structuredClone(initialSettings),
  };
  const settings = {
    merged: structuredClone(initialSettings),
    setValue: vi.fn(),
    recomputeMerged: vi.fn(),
    forScope: vi.fn(() => settingsFile),
  };
  settings.setValue.mockImplementation(
    (_scope: string, key: string, value: unknown) => {
      setNestedValue(settingsFile.settings, key, value);
      setNestedValue(settings.merged, key, value);
    },
  );
  settings.recomputeMerged.mockImplementation(() => {
    settings.merged = structuredClone(settingsFile.settings);
  });
  return settings;
};

const createConfig = (recordSlashCommand = vi.fn()) => {
  const modelsConfig = {
    syncAfterAuthRefresh: vi.fn(),
  };
  return {
    getAuthType: vi.fn<() => AuthType | undefined>(() => AuthType.USE_OPENAI),
    getModel: vi.fn(() => 'pre-copilot-model'),
    getCurrentModelRegistryBaseUrl: vi.fn<() => string | null | undefined>(
      () => 'https://pre.example/v1',
    ),
    getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
    getUsageStatisticsEnabled: vi.fn(() => false),
    reloadModelProvidersConfig: vi.fn(),
    refreshAuth: vi.fn<
      (
        authType: AuthType,
        isInitialAuth?: boolean,
        isCurrentTransaction?: () => boolean,
      ) => Promise<void>
    >(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    resetAuth: vi.fn<(modelId?: string) => void>(),
    getModelsConfig: vi.fn(() => modelsConfig),
    getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),
  };
};

describe('useAuthCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('accepts OpenAI Responses as QWEN_DEFAULT_AUTH_TYPE', () => {
    vi.stubEnv('QWEN_DEFAULT_AUTH_TYPE', AuthType.USE_OPENAI_RESPONSES);
    const settings = createSettings();
    const config = createConfig();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, vi.fn()),
    );

    expect(result.current.authError).toBeNull();
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
    const recordSlashCommand = vi.fn();
    const config = createConfig(recordSlashCommand);
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    const inputs: ProviderSetupInputs = {
      baseUrl: resolveBaseUrl(deepseekProvider),
      apiKey: 'sk-deepseek',
      modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    };

    act(() => {
      result.current.openAuthDialog();
    });

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
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Successfully configured DeepSeek'),
      }),
      expect.any(Number),
    );
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/auth',
      outputHistoryItems: [
        expect.objectContaining({
          text: expect.stringContaining('Successfully configured DeepSeek'),
        }),
      ],
    });
  });

  it('keeps live feedback but skips the /auth record when the dialog auto-opened', async () => {
    const settings = createSettings();
    const recordSlashCommand = vi.fn();
    const config = createConfig(recordSlashCommand);
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(deepseekProvider, {
        baseUrl: resolveBaseUrl(deepseekProvider),
        apiKey: 'sk-deepseek',
        modelIds: ['deepseek-v4-flash'],
      });
    });

    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Successfully configured DeepSeek'),
      }),
      expect.any(Number),
    );
    expect(recordSlashCommand).not.toHaveBeenCalled();
  });

  it('clears the /auth recording latch when a command-opened dialog closes', async () => {
    const settings = createSettings();
    const recordSlashCommand = vi.fn();
    const config = createConfig(recordSlashCommand);
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    act(() => {
      result.current.openAuthDialog();
      result.current.closeAuthDialog();
      result.current.onAuthError('later unauthorized');
    });

    await act(async () => {
      await result.current.handleProviderSubmit(deepseekProvider, {
        baseUrl: resolveBaseUrl(deepseekProvider),
        apiKey: 'sk-deepseek',
        modelIds: ['deepseek-v4-flash'],
      });
    });

    expect(addItem).toHaveBeenCalledTimes(1);
    expect(recordSlashCommand).not.toHaveBeenCalled();
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
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
  });

  it('configures Custom API Key via the provider install plan flow', async () => {
    const envKey = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
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
        protocol: AuthType.USE_OPENAI,
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
      AuthType.USE_OPENAI,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'custom-model',
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
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
    expect(result.current.pendingAuthType).toBe(AuthType.USE_OPENAI);
  });

  it('runs Copilot device flow when no GitHub token is found', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    copilotMocks.discoverGithubToken.mockRejectedValueOnce(
      new CopilotTokenNotFoundError('mock: no token'),
    );
    copilotMocks.runCopilotDeviceFlow.mockResolvedValueOnce({
      token: 'ghu_mock',
    });
    copilotMocks.persistGithubToken.mockResolvedValueOnce(undefined);

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    act(() => {
      result.current.openAuthDialog();
    });

    await act(async () => {
      await result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
    });

    expect(copilotMocks.discoverGithubToken).toHaveBeenCalledTimes(1);
    expect(copilotMocks.runCopilotDeviceFlow).toHaveBeenCalledTimes(1);
    expect(copilotMocks.persistGithubToken).toHaveBeenCalledWith('ghu_mock', {
      signal: expect.any(AbortSignal),
    });
    // Device flow succeeded → externalAuthState cleared
    expect(result.current.externalAuthState).toBeNull();
    // buildInstallPlan proceeded: auth type set to copilot
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_COPILOT,
    );
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Successfully configured GitHub Copilot'),
      }),
      expect.any(Number),
    );
  });

  it('restores pre-Copilot live auth, model, and content generator when cancellation wins refreshAuth', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    const runtime = {
      authType: AuthType.USE_OPENAI,
      model: 'pre-copilot-model',
      baseUrl: 'https://pre.example/v1',
      contentGenerator: 'openai-generator',
    };
    config.getAuthType.mockImplementation(() => runtime.authType);
    config.getModel.mockImplementation(() => runtime.model);
    config.getCurrentModelRegistryBaseUrl.mockImplementation(
      () => runtime.baseUrl,
    );
    const modelsConfig = config.getModelsConfig();
    modelsConfig.syncAfterAuthRefresh.mockImplementation(
      (authType: AuthType, model: string, baseUrl?: string) => {
        runtime.authType = authType;
        runtime.model = model;
        runtime.baseUrl = baseUrl ?? '';
      },
    );
    config.switchModel.mockImplementation(async () => {
      runtime.authType = AuthType.USE_OPENAI;
      runtime.model = 'pre-copilot-model';
      runtime.baseUrl = 'https://pre.example/v1';
      runtime.contentGenerator = 'openai-generator';
    });
    let resolveRefresh!: () => void;
    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    config.refreshAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = () => {
            runtime.contentGenerator = 'copilot-generator';
            resolve();
          };
          signalRefreshStarted();
        }),
    );
    copilotMocks.discoverGithubToken.mockResolvedValueOnce({
      token: 'ghu_existing',
      source: 'mock',
    });

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );
    const submit = result.current.handleProviderSubmit(copilotProvider, {
      baseUrl: resolveBaseUrl(copilotProvider),
      apiKey: '',
      modelIds: getDefaultModelIds(copilotProvider),
    });
    await refreshStarted;

    act(() => {
      result.current.cancelAuthentication();
    });
    resolveRefresh();
    await act(async () => {
      await submit;
    });

    expect(settings.recomputeMerged).toHaveBeenCalledTimes(1);
    expect(config.reloadModelProvidersConfig).toHaveBeenLastCalledWith({});
    expect(config.switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'pre-copilot-model',
      { baseUrl: 'https://pre.example/v1' },
    );
    expect(runtime).toEqual({
      authType: AuthType.USE_OPENAI,
      model: 'pre-copilot-model',
      baseUrl: 'https://pre.example/v1',
      contentGenerator: 'openai-generator',
    });
    expect(addItem).not.toHaveBeenCalled();
    expect(result.current.isAuthenticating).toBe(false);
  });

  it('restores a first-time runtime to unauthenticated when cancellation wins refreshAuth', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    const runtime: {
      authType: AuthType | undefined;
      model: string;
      baseUrl: string | undefined;
      contentGenerator: string | undefined;
    } = {
      authType: undefined,
      model: 'unselected',
      baseUrl: undefined,
      contentGenerator: undefined,
    };
    let providerRegistry: Record<string, unknown> = {};
    config.getAuthType.mockImplementation(() => runtime.authType);
    config.getModel.mockImplementation(() => runtime.model);
    config.getCurrentModelRegistryBaseUrl.mockImplementation(
      () => runtime.baseUrl,
    );
    config.reloadModelProvidersConfig.mockImplementation(
      (providers: Record<string, unknown>) => {
        providerRegistry = providers;
      },
    );
    config
      .getModelsConfig()
      .syncAfterAuthRefresh.mockImplementation(
        (authType: AuthType, model: string, baseUrl?: string) => {
          runtime.authType = authType;
          runtime.model = model;
          runtime.baseUrl = baseUrl;
        },
      );
    config.resetAuth.mockImplementation((modelId?: string) => {
      runtime.authType = undefined;
      runtime.model = modelId ?? 'unselected';
      runtime.baseUrl = undefined;
      runtime.contentGenerator = undefined;
    });
    let resolveRefresh!: () => void;
    let signalRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefreshStarted = resolve;
    });
    config.refreshAuth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = () => {
            runtime.contentGenerator = 'copilot-generator';
            resolve();
          };
          signalRefreshStarted();
        }),
    );
    copilotMocks.discoverGithubToken.mockResolvedValueOnce({
      token: 'ghu_existing',
      source: 'mock',
    });
    const originalToken = process.env['GITHUB_COPILOT_TOKEN'];
    delete process.env['GITHUB_COPILOT_TOKEN'];

    try {
      const { result } = renderHook(() =>
        useAuthCommand(settings as never, config as never, addItem),
      );
      const submit = result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
      await refreshStarted;

      act(() => {
        result.current.cancelAuthentication();
      });
      resolveRefresh();
      await act(async () => {
        await submit;
      });

      expect(settings.merged).toEqual({});
      expect(process.env['GITHUB_COPILOT_TOKEN']).toBeUndefined();
      expect(providerRegistry).toEqual({});
      expect(config.reloadModelProvidersConfig).toHaveBeenLastCalledWith({});
      expect(config.resetAuth).toHaveBeenCalledWith('unselected');
      expect(runtime).toEqual({
        authType: undefined,
        model: 'unselected',
        baseUrl: undefined,
        contentGenerator: undefined,
      });
      expect(addItem).not.toHaveBeenCalled();
    } finally {
      if (originalToken === undefined) {
        delete process.env['GITHUB_COPILOT_TOKEN'];
      } else {
        process.env['GITHUB_COPILOT_TOKEN'] = originalToken;
      }
    }
  });

  it('keeps a newer successful Copilot setup when a cancelled refresh resolves late', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    const runtime = {
      authType: AuthType.USE_OPENAI,
      model: 'pre-copilot-model',
      baseUrl: 'https://pre.example/v1',
      contentGenerator: 'openai-generator',
    };
    let providerRegistry: Record<string, unknown> = {};
    config.getAuthType.mockImplementation(() => runtime.authType);
    config.getModel.mockImplementation(() => runtime.model);
    config.getCurrentModelRegistryBaseUrl.mockImplementation(
      () => runtime.baseUrl,
    );
    config.reloadModelProvidersConfig.mockImplementation(
      (providers: Record<string, unknown>) => {
        providerRegistry = providers;
      },
    );
    config
      .getModelsConfig()
      .syncAfterAuthRefresh.mockImplementation(
        (authType: AuthType, model: string, baseUrl?: string) => {
          runtime.authType = authType;
          runtime.model = model;
          runtime.baseUrl = baseUrl ?? '';
        },
      );
    let resolveRefreshA!: () => void;
    let signalRefreshAStarted!: () => void;
    const refreshAStarted = new Promise<void>((resolve) => {
      signalRefreshAStarted = resolve;
    });
    let refreshCount = 0;
    config.refreshAuth = vi.fn(
      (
        _authType: AuthType,
        _isInitialAuth?: boolean,
        isCurrentTransaction?: () => boolean,
      ) => {
        refreshCount += 1;
        if (refreshCount === 1) {
          return new Promise<void>((resolve) => {
            resolveRefreshA = () => {
              if (isCurrentTransaction?.() !== false) {
                runtime.contentGenerator = 'copilot-generator-a';
              }
              resolve();
            };
            signalRefreshAStarted();
          });
        }
        if (isCurrentTransaction?.() !== false) {
          runtime.contentGenerator = 'copilot-generator-b';
        }
        return Promise.resolve();
      },
    );
    copilotMocks.discoverGithubToken.mockResolvedValue({
      token: 'ghu_existing',
      source: 'mock',
    });

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );
    const submitA = result.current.handleProviderSubmit(copilotProvider, {
      baseUrl: resolveBaseUrl(copilotProvider),
      apiKey: '',
      modelIds: ['claude-sonnet-4.6'],
    });
    await refreshAStarted;

    let submitB!: Promise<void>;
    await act(async () => {
      submitB = result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: ['gpt-5.4'],
      });
      await submitB;
    });
    resolveRefreshA();
    await act(async () => {
      await submitA;
    });

    expect(settings.merged).toMatchObject({
      security: { auth: { selectedType: AuthType.USE_COPILOT } },
      model: { name: 'gpt-5.4' },
      modelProviders: {
        [AuthType.USE_COPILOT]: [expect.objectContaining({ id: 'gpt-5.4' })],
      },
    });
    expect(providerRegistry).toMatchObject({
      [AuthType.USE_COPILOT]: [expect.objectContaining({ id: 'gpt-5.4' })],
    });
    expect(runtime).toEqual({
      authType: AuthType.USE_COPILOT,
      model: 'gpt-5.4',
      baseUrl: '',
      contentGenerator: 'copilot-generator-b',
    });
    expect(config.resetAuth).not.toHaveBeenCalled();
    expect(addItem).toHaveBeenCalledTimes(1);
  });

  it('cancels a late Copilot device flow without installing credentials', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    let receivedSignal: AbortSignal | undefined;
    let resolveDeviceFlow!: (result: { token: string }) => void;
    const deviceFlow = new Promise<{ token: string }>((resolve) => {
      resolveDeviceFlow = resolve;
    });

    copilotMocks.discoverGithubToken.mockRejectedValueOnce(
      new CopilotTokenNotFoundError('mock: no token'),
    );
    copilotMocks.runCopilotDeviceFlow.mockImplementationOnce(
      (options: { signal?: AbortSignal }) => {
        receivedSignal = options.signal;
        return deviceFlow;
      },
    );

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );
    let submit!: Promise<void>;
    await act(async () => {
      submit = result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
      await Promise.resolve();
    });

    act(() => {
      result.current.cancelAuthentication();
    });
    resolveDeviceFlow({ token: 'ghu_late' });
    await act(async () => {
      await submit;
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(copilotMocks.persistGithubToken).not.toHaveBeenCalled();
    expect(settings.setValue).not.toHaveBeenCalled();
    expect(config.refreshAuth).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
  });

  it('does not start fallback device auth when cancellation wins discovery', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    let rejectDiscovery!: (error: Error) => void;
    const discovery = new Promise<never>((_resolve, reject) => {
      rejectDiscovery = reject;
    });

    copilotMocks.discoverGithubToken.mockReturnValueOnce(discovery);

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );
    let submit!: Promise<void>;
    await act(async () => {
      submit = result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
      await Promise.resolve();
    });

    act(() => {
      result.current.cancelAuthentication();
    });
    rejectDiscovery(new CopilotTokenNotFoundError('mock: no token'));
    await act(async () => {
      await submit;
    });

    expect(copilotMocks.runCopilotDeviceFlow).not.toHaveBeenCalled();
    expect(copilotMocks.persistGithubToken).not.toHaveBeenCalled();
    expect(settings.setValue).not.toHaveBeenCalled();
    expect(config.refreshAuth).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
  });

  it('does not install Copilot after cancellation during token persistence', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    let resolvePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      resolvePersistence = resolve;
    });

    copilotMocks.discoverGithubToken.mockRejectedValueOnce(
      new CopilotTokenNotFoundError('mock: no token'),
    );
    copilotMocks.runCopilotDeviceFlow.mockResolvedValueOnce({
      token: 'ghu_mock',
    });
    copilotMocks.persistGithubToken.mockReturnValueOnce(persistence);

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );
    let submit!: Promise<void>;
    await act(async () => {
      submit = result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(copilotMocks.persistGithubToken).toHaveBeenCalledWith('ghu_mock', {
      signal: expect.any(AbortSignal),
    });
    act(() => {
      result.current.cancelAuthentication();
    });
    resolvePersistence();
    await act(async () => {
      await submit;
    });

    expect(settings.setValue).not.toHaveBeenCalled();
    expect(config.refreshAuth).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
  });

  it('aborts active Copilot auth on unmount without later continuation', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();
    let receivedSignal: AbortSignal | undefined;
    let resolveDeviceFlow!: (result: { token: string }) => void;
    const deviceFlow = new Promise<{ token: string }>((resolve) => {
      resolveDeviceFlow = resolve;
    });

    copilotMocks.discoverGithubToken.mockRejectedValueOnce(
      new CopilotTokenNotFoundError('mock: no token'),
    );
    copilotMocks.runCopilotDeviceFlow.mockImplementationOnce(
      (options: { signal?: AbortSignal }) => {
        receivedSignal = options.signal;
        return deviceFlow;
      },
    );

    const { result, unmount } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );
    let submit!: Promise<void>;
    await act(async () => {
      submit = result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
      await Promise.resolve();
    });

    unmount();
    resolveDeviceFlow({ token: 'ghu_late' });
    await act(async () => {
      await submit;
    });

    expect(receivedSignal?.aborted).toBe(true);
    expect(copilotMocks.persistGithubToken).not.toHaveBeenCalled();
    expect(settings.setValue).not.toHaveBeenCalled();
    expect(config.refreshAuth).not.toHaveBeenCalled();
    expect(addItem).not.toHaveBeenCalled();
  });

  it.each(['cancellation', 'unmount'] as const)(
    'aborts both overlapping Copilot device flows on %s without continuation',
    async (end) => {
      const copilotProvider = findProviderById('copilot')!;
      const settings = createSettings();
      const config = createConfig();
      const addItem = vi.fn();
      const flows: Array<{
        signal: AbortSignal | undefined;
        resolve: (result: { token: string }) => void;
      }> = [];

      copilotMocks.discoverGithubToken.mockRejectedValue(
        new CopilotTokenNotFoundError('mock: no token'),
      );
      copilotMocks.runCopilotDeviceFlow.mockImplementation(
        (options: { signal?: AbortSignal }) =>
          new Promise<{ token: string }>((resolve) => {
            flows.push({ signal: options.signal, resolve });
          }),
      );

      const { result, unmount } = renderHook(() =>
        useAuthCommand(settings as never, config as never, addItem),
      );
      const inputs = {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      };
      let firstSubmit!: Promise<void>;
      let secondSubmit!: Promise<void>;
      await act(async () => {
        firstSubmit = result.current.handleProviderSubmit(
          copilotProvider,
          inputs,
        );
        await Promise.resolve();
      });
      expect(flows).toHaveLength(1);

      await act(async () => {
        secondSubmit = result.current.handleProviderSubmit(
          copilotProvider,
          inputs,
        );
        await Promise.resolve();
      });
      expect(flows).toHaveLength(2);
      if (end === 'cancellation') {
        act(() => {
          result.current.cancelAuthentication();
        });
      } else {
        unmount();
      }
      flows.forEach((flow, index) => {
        flow.resolve({ token: `ghu_late_${index}` });
      });
      await act(async () => {
        await Promise.all([firstSubmit, secondSubmit]);
      });

      expect(flows.map((flow) => flow.signal?.aborted)).toEqual([true, true]);
      expect(copilotMocks.persistGithubToken).not.toHaveBeenCalled();
      expect(settings.setValue).not.toHaveBeenCalled();
      expect(config.refreshAuth).not.toHaveBeenCalled();
      expect(addItem).not.toHaveBeenCalled();
    },
  );

  it('skips device flow when a GitHub token already exists', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    copilotMocks.discoverGithubToken.mockResolvedValueOnce({
      token: 'ghu_existing',
      source: 'mock',
    });

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
    });

    expect(copilotMocks.discoverGithubToken).toHaveBeenCalledTimes(1);
    expect(copilotMocks.runCopilotDeviceFlow).not.toHaveBeenCalled();
    expect(copilotMocks.persistGithubToken).not.toHaveBeenCalled();
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_COPILOT,
    );
    expect(result.current.isAuthDialogOpen).toBe(false);
  });

  it('surfaces device flow error as auth error when runCopilotDeviceFlow rejects', async () => {
    const copilotProvider = findProviderById('copilot')!;
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    copilotMocks.discoverGithubToken.mockRejectedValueOnce(
      new CopilotTokenNotFoundError('mock: no token'),
    );
    copilotMocks.runCopilotDeviceFlow.mockRejectedValueOnce(
      new Error('Device code expired'),
    );

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(copilotProvider, {
        baseUrl: resolveBaseUrl(copilotProvider),
        apiKey: '',
        modelIds: getDefaultModelIds(copilotProvider),
      });
    });

    expect(copilotMocks.runCopilotDeviceFlow).toHaveBeenCalledTimes(1);
    expect(copilotMocks.persistGithubToken).not.toHaveBeenCalled();
    expect(result.current.authError).toEqual(
      expect.stringContaining('Device code expired'),
    );
    expect(result.current.isAuthDialogOpen).toBe(true);
    expect(result.current.isAuthenticating).toBe(false);
    expect(result.current.externalAuthState).toBeNull();
    expect(addItem).not.toHaveBeenCalled();
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
