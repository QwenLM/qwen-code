/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, initializeI18nFromSettings } from './initializer.js';

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
    getGeminiMdFileCount: ReturnType<typeof vi.fn>;
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
      getGeminiMdFileCount: vi.fn().mockReturnValue(0),
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
    expect(result.geminiMdFileCount).toBe(0);
  });

  it('should return authError when auth fails', async () => {
    mockPerformInitialAuth.mockResolvedValue('Auth failed');

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(result.authError).toBe('Auth failed');
    expect(result.shouldOpenAuthDialog).toBe(true);
    // initializeApp does not clear the selected auth type on failure
    expect(mockSettings.setValue).not.toHaveBeenCalled();
  });

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

  it('should connect to IDE when in IDE mode', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);

    await initializeApp(mockConfig as never, mockSettings as never);

    expect(mockGetInstance).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(mockLogIdeConnection).toHaveBeenCalled();
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

  // PR-B-β1: parallelization tests
  it('skips i18n when called with { skipI18n: true } (caller already awaited)', async () => {
    mockInitializeI18n.mockClear();
    await initializeApp(mockConfig as never, mockSettings as never, {
      skipI18n: true,
    });
    expect(mockInitializeI18n).not.toHaveBeenCalled();
  });

  it('initializeI18nFromSettings can be invoked independently for parallel use', async () => {
    mockInitializeI18n.mockClear();
    await initializeI18nFromSettings(mockSettings as never);
    expect(mockInitializeI18n).toHaveBeenCalledTimes(1);
  });

  it('runs auth and IDE connect concurrently — auth failure does not abort IDE init', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);
    mockPerformInitialAuth.mockRejectedValue(new Error('auth-boom'));

    // allSettled means both are attempted; auth's rejection becomes a string
    // in the result and IDE still gets to connect.
    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    expect(mockPerformInitialAuth).toHaveBeenCalled();
    expect(mockGetInstance).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
    expect(result.authError).toContain('auth-boom');
  });

  it('runs auth and IDE connect concurrently — IDE failure does not abort auth', async () => {
    mockConfig.getIdeMode.mockReturnValue(true);
    mockConnect.mockRejectedValue(new Error('ide-boom'));
    mockPerformInitialAuth.mockResolvedValue(null);

    const result = await initializeApp(
      mockConfig as never,
      mockSettings as never,
    );

    // Auth still ran to completion and returned null (no error).
    expect(mockPerformInitialAuth).toHaveBeenCalled();
    expect(result.authError).toBeNull();
  });
});
