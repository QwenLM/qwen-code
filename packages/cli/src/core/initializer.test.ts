/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { LoadedSettings, type SettingsFile } from '../config/settings.js';
import { connectIdeForStartup, initializeApp } from './initializer.js';

const mockPerformInitialAuth = vi.fn();
const mockValidateTheme = vi.fn();
const mockInitializeI18n = vi.fn();

vi.mock('./auth.js', () => ({
  performInitialAuth: (...args: unknown[]) => mockPerformInitialAuth(...args),
}));

vi.mock('./theme.js', () => ({
  validateTheme: (...args: unknown[]) => mockValidateTheme(...args),
}));

vi.mock('../i18n/index.js', () => ({
  initializeI18n: (...args: unknown[]) => mockInitializeI18n(...args),
  resolveLanguageSetting: (settingsLang?: string) =>
    process.env['QWEN_CODE_LANG'] || settingsLang || 'auto',
}));

const mockConnect = vi.fn();
const mockGetInstance = vi.fn().mockResolvedValue({ connect: mockConnect });
const mockLogIdeConnection = vi.fn();

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    IdeClient: { getInstance: () => mockGetInstance() },
    IdeConnectionEvent: vi.fn().mockImplementation((type) => ({ type })),
    IdeConnectionType: { START: 'start' },
    logIdeConnection: (...args: unknown[]) => mockLogIdeConnection(...args),
  };
});

describe('initializeApp', () => {
  let mockConfig: {
    getModelsConfig: ReturnType<typeof vi.fn>;
    getIdeMode: ReturnType<typeof vi.fn>;
    getMemoryFileCount: ReturnType<typeof vi.fn>;
    getAuthType: ReturnType<typeof vi.fn>;
    getModel: ReturnType<typeof vi.fn>;
  };
  let mockSettings: {
    merged: Record<string, unknown>;
    setValue: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getCurrentAuthType: vi.fn().mockReturnValue('api_key'),
        wasAuthTypeExplicitlyProvided: vi.fn().mockReturnValue(false),
      }),
      getIdeMode: vi.fn().mockReturnValue(false),
      getMemoryFileCount: vi.fn().mockReturnValue(0),
      getAuthType: vi.fn(),
      getModel: vi.fn().mockReturnValue('saved-model'),
    };

    mockSettings = {
      merged: { general: { language: 'en' } },
      setValue: vi.fn(),
    };

    mockPerformInitialAuth.mockResolvedValue(null);
    mockValidateTheme.mockReturnValue(null);
    mockInitializeI18n.mockResolvedValue(undefined);
  });

  it('should initialize i18n with language from settings', async () => {
    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockInitializeI18n).toHaveBeenCalledWith('en');
  });

  it('should initialize i18n with QWEN_CODE_LANG env var if set', async () => {
    vi.stubEnv('QWEN_CODE_LANG', 'zh');

    await initializeApp(mockConfig as never, mockSettings as never);
    expect(mockInitializeI18n).toHaveBeenCalledWith('zh');

    vi.unstubAllEnvs();
  });

  it('should return no errors on successful initialization', async () => {
    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.authError).toBeNull();
    expect(result.themeError).toBeNull();
    expect(result.memoryFileCount).toBe(0);
  });

  it('should return authError when auth fails', async () => {
    mockPerformInitialAuth.mockResolvedValue('Auth failed');

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.authError).toBe('Auth failed');
    expect(result.shouldOpenAuthDialog).toBe(true);
    expect(result.skipStartupAuthDialog).toBeUndefined();
    // initializeApp does not clear the selected auth type on failure
    expect(mockSettings.setValue).not.toHaveBeenCalled();
  });

  it.each([
    null,
    'The selected model, saved-model, is no longer available. Run /model to choose another model.',
  ])(
    'keeps the composer open for a configured subscription (%s)',
    async (error) => {
      mockConfig
        .getModelsConfig()
        .getCurrentAuthType.mockReturnValue('qwen-subscription');
      mockPerformInitialAuth.mockResolvedValue(error);
      const result = await initializeApp(
        mockConfig as never,
        mockSettings as never,
      );
      expect(result.skipStartupAuthDialog).toBe(true);
      expect(result.authNotice).toBe(error ?? undefined);
      expect(result.authError).toBe(error);
    },
  );

  it.each<{
    label: string;
    allow?: boolean;
    workspace?: SettingsFile['settings'];
    system?: SettingsFile['settings'];
    expected?: string;
  }>([
    { label: 'model-only override', expected: 'user-model' },
    { label: 'explicit CLI selection', allow: false },
    {
      label: 'workspace endpoint',
      workspace: { model: { name: 'saved-model', baseUrl: '' } },
    },
    {
      label: 'workspace authentication',
      workspace: {
        security: { auth: { selectedType: AuthType.QWEN_SUBSCRIPTION } },
      },
    },
    { label: 'workspace providers', workspace: { modelProviders: {} } },
    {
      label: 'system authentication',
      system: {
        security: { auth: { selectedType: AuthType.QWEN_SUBSCRIPTION } },
      },
    },
    {
      label: 'a policy requiring another authentication type',
      system: { security: { auth: { enforcedType: AuthType.USE_OPENAI } } },
    },
  ])(
    'resolves the startup subscription fallback for $label',
    async ({ allow = true, workspace, system, expected }) => {
      mockConfig
        .getModelsConfig()
        .getCurrentAuthType.mockReturnValue(AuthType.QWEN_SUBSCRIPTION);
      const layer = (
        settings: SettingsFile['settings'] = {},
      ): SettingsFile => ({
        path: '',
        settings,
        originalSettings: settings,
      });
      const settings = new LoadedSettings(
        layer(system),
        layer(),
        layer({
          security: { auth: { selectedType: AuthType.QWEN_SUBSCRIPTION } },
          model: { name: 'user-model' },
        }),
        layer({ model: { name: 'saved-model' }, ...workspace }),
        true,
        new Set(),
      );

      await initializeApp(mockConfig as never, settings, {
        allowSubscriptionStartupFallback: allow,
      });

      expect(mockPerformInitialAuth).toHaveBeenCalledExactlyOnceWith(
        mockConfig,
        AuthType.QWEN_SUBSCRIPTION,
        expected,
      );
    },
  );

  it('should return themeError when theme validation fails', async () => {
    mockValidateTheme.mockReturnValue('Theme not found');

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.themeError).toBe('Theme not found');
  });

  it('should set shouldOpenAuthDialog when auth was not explicitly provided', async () => {
    mockConfig
      .getModelsConfig()
      .wasAuthTypeExplicitlyProvided.mockReturnValue(false);

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.shouldOpenAuthDialog).toBe(true);
  });

  it('should set shouldOpenAuthDialog when auth error occurs', async () => {
    mockConfig
      .getModelsConfig()
      .wasAuthTypeExplicitlyProvided.mockReturnValue(true);
    mockPerformInitialAuth.mockResolvedValue('Auth failed');

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.shouldOpenAuthDialog).toBe(true);
  });

  it('should not open auth dialog when auth was explicitly provided and succeeds', async () => {
    mockConfig
      .getModelsConfig()
      .wasAuthTypeExplicitlyProvided.mockReturnValue(true);

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.shouldOpenAuthDialog).toBe(false);
  });

  it('should connect to IDE by default when in IDE mode', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockGetInstance).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(mockLogIdeConnection).toHaveBeenCalled();
  });

  it('should not connect to IDE when deferred', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);

    await initializeApp(mockConfig as never, mockSettings as never, {
      deferIdeConnection: true,
    });

    expect(mockGetInstance).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockLogIdeConnection).not.toHaveBeenCalled();
  });

  it('should connect to IDE through startup helper', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);

    await connectIdeForStartup(mockConfig as never);

    expect(mockGetInstance).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(mockLogIdeConnection).toHaveBeenCalled();
  });

  it('should not connect to IDE through startup helper when not in IDE mode', async () => {
    mockConfig.getIdeMode.mockReturnValue(false);

    await connectIdeForStartup(mockConfig as never);

    expect(mockGetInstance).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockLogIdeConnection).not.toHaveBeenCalled();
  });

  it('should not connect to IDE when not in IDE mode', async () => {
    mockConfig.getIdeMode.mockReturnValue(false);

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockGetInstance).not.toHaveBeenCalled();
  });

  it('should default language to auto when no setting is provided', async () => {
    mockSettings.merged = {};

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockInitializeI18n).toHaveBeenCalledWith('auto');
  });
});
