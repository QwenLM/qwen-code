/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp } from './initializer.js';

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
    const originalEnv = process.env['QWEN_CODE_LANG'];
    process.env['QWEN_CODE_LANG'] = 'zh';

    try {
      await initializeApp(mockConfig as never, mockSettings as never);
      expect(mockInitializeI18n).toHaveBeenCalledWith('zh');
    } finally {
      if (originalEnv === undefined) {
        delete process.env['QWEN_CODE_LANG'];
      } else {
        process.env['QWEN_CODE_LANG'] = originalEnv;
      }
    }
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
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      expect.anything(),
      'security.auth.selectedType',
      undefined,
    );
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
});
