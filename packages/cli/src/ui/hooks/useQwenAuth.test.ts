/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQwenAuth, DeviceAuthorizationInfo } from './useQwenAuth.js';
import {
  AuthType,
  qwenOAuth2Events,
  QwenOAuth2Event,
} from '@qwen-code/qwen-code-core';
import { LoadedSettings } from '../../config/settings.js';

// Mock the qwenOAuth2Events
vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual('@qwen-code/qwen-code-core');
  const mockEmitter = {
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnThis(),
  };
  return {
    ...actual,
    qwenOAuth2Events: mockEmitter,
    QwenOAuth2Event: {
      AuthUri: 'authUri',
      AuthProgress: 'authProgress',
    },
  };
});

const mockQwenOAuth2Events = vi.mocked(qwenOAuth2Events);

describe('useQwenAuth', () => {
  const mockDeviceAuth: DeviceAuthorizationInfo = {
    verification_uri: 'https://oauth.qwen.com/device',
    verification_uri_complete: 'https://oauth.qwen.com/device?user_code=ABC123',
    user_code: 'ABC123',
    expires_in: 1800,
  };

  const createMockSettings = (authType: AuthType): LoadedSettings =>
    ({
      merged: {
        selectedAuthType: authType,
      },
    }) as LoadedSettings;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state when not Qwen auth', () => {
    const settings = createMockSettings(AuthType.USE_GEMINI);
    const { result } = renderHook(() => useQwenAuth(settings, false));

    expect(result.current).toEqual({
      isQwenAuthenticating: false,
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
      isQwenAuth: false,
      cancelQwenAuth: expect.any(Function),
    });
  });

  it('should initialize with default state when Qwen auth but not authenticating', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    const { result } = renderHook(() => useQwenAuth(settings, false));

    expect(result.current).toEqual({
      isQwenAuthenticating: false,
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
      isQwenAuth: true,
      cancelQwenAuth: expect.any(Function),
    });
  });

  it('should set up event listeners when Qwen auth and authenticating', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    renderHook(() => useQwenAuth(settings, true));

    expect(mockQwenOAuth2Events.on).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockQwenOAuth2Events.on).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should handle device auth event', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationInfo) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(settings, true));

    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.authStatus).toBe('polling');
    expect(result.current.isQwenAuthenticating).toBe(true);
  });

  it('should handle auth progress event - success', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(settings, true));

    act(() => {
      handleAuthProgress!('success', 'Authentication successful!');
    });

    expect(result.current.authStatus).toBe('success');
    expect(result.current.authMessage).toBe('Authentication successful!');
  });

  it('should handle auth progress event - error', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(settings, true));

    act(() => {
      handleAuthProgress!('error', 'Authentication failed');
    });

    expect(result.current.authStatus).toBe('error');
    expect(result.current.authMessage).toBe('Authentication failed');
  });

  it('should handle auth progress event - polling', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(settings, true));

    act(() => {
      handleAuthProgress!('polling', 'Waiting for user authorization...');
    });

    expect(result.current.authStatus).toBe('polling');
    expect(result.current.authMessage).toBe(
      'Waiting for user authorization...',
    );
  });

  it('should handle auth progress event - rate_limit', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(settings, true));

    act(() => {
      handleAuthProgress!(
        'rate_limit',
        'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
      );
    });

    expect(result.current.authStatus).toBe('rate_limit');
    expect(result.current.authMessage).toBe(
      'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
    );
  });

  it('should handle auth progress event without message', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleAuthProgress: (
      status: 'success' | 'error' | 'polling' | 'timeout' | 'rate_limit',
      message?: string,
    ) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthProgress) {
        handleAuthProgress = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(settings, true));

    act(() => {
      handleAuthProgress!('success');
    });

    expect(result.current.authStatus).toBe('success');
    expect(result.current.authMessage).toBe(null);
  });

  it('should clean up event listeners when auth type changes', () => {
    const qwenSettings = createMockSettings(AuthType.QWEN_OAUTH);
    const { rerender } = renderHook(
      ({ settings, isAuthenticating }) =>
        useQwenAuth(settings, isAuthenticating),
      { initialProps: { settings: qwenSettings, isAuthenticating: true } },
    );

    // Change to non-Qwen auth
    const geminiSettings = createMockSettings(AuthType.USE_GEMINI);
    rerender({ settings: geminiSettings, isAuthenticating: true });

    expect(mockQwenOAuth2Events.off).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockQwenOAuth2Events.off).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should clean up event listeners when authentication stops', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    const { rerender } = renderHook(
      ({ isAuthenticating }) => useQwenAuth(settings, isAuthenticating),
      { initialProps: { isAuthenticating: true } },
    );

    // Stop authentication
    rerender({ isAuthenticating: false });

    expect(mockQwenOAuth2Events.off).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockQwenOAuth2Events.off).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should clean up event listeners on unmount', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    const { unmount } = renderHook(() => useQwenAuth(settings, true));

    unmount();

    expect(mockQwenOAuth2Events.off).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthUri,
      expect.any(Function),
    );
    expect(mockQwenOAuth2Events.off).toHaveBeenCalledWith(
      QwenOAuth2Event.AuthProgress,
      expect.any(Function),
    );
  });

  it('should reset state when switching from Qwen auth to another auth type', () => {
    const qwenSettings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationInfo) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result, rerender } = renderHook(
      ({ settings, isAuthenticating }) =>
        useQwenAuth(settings, isAuthenticating),
      { initialProps: { settings: qwenSettings, isAuthenticating: true } },
    );

    // Simulate device auth
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.authStatus).toBe('polling');

    // Switch to different auth type
    const geminiSettings = createMockSettings(AuthType.USE_GEMINI);
    rerender({ settings: geminiSettings, isAuthenticating: true });

    expect(result.current.isQwenAuthenticating).toBe(false);
    expect(result.current.deviceAuth).toBe(null);
    expect(result.current.authStatus).toBe('idle');
    expect(result.current.authMessage).toBe(null);
  });

  it('should reset state when authentication stops', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationInfo) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result, rerender } = renderHook(
      ({ isAuthenticating }) => useQwenAuth(settings, isAuthenticating),
      { initialProps: { isAuthenticating: true } },
    );

    // Simulate device auth
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.authStatus).toBe('polling');

    // Stop authentication
    rerender({ isAuthenticating: false });

    expect(result.current.isQwenAuthenticating).toBe(false);
    expect(result.current.deviceAuth).toBe(null);
    expect(result.current.authStatus).toBe('idle');
    expect(result.current.authMessage).toBe(null);
  });

  it('should handle cancelQwenAuth function', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationInfo) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(settings, true));

    // Set up some state
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.deviceAuth).toEqual(mockDeviceAuth);

    // Cancel auth
    act(() => {
      result.current.cancelQwenAuth();
    });

    expect(result.current.isQwenAuthenticating).toBe(false);
    expect(result.current.deviceAuth).toBe(null);
    expect(result.current.authStatus).toBe('idle');
    expect(result.current.authMessage).toBe(null);
  });

  it('should maintain isQwenAuth flag correctly', () => {
    // Test with Qwen OAuth
    const qwenSettings = createMockSettings(AuthType.QWEN_OAUTH);
    const { result: qwenResult } = renderHook(() =>
      useQwenAuth(qwenSettings, false),
    );
    expect(qwenResult.current.isQwenAuth).toBe(true);

    // Test with other auth types
    const geminiSettings = createMockSettings(AuthType.USE_GEMINI);
    const { result: geminiResult } = renderHook(() =>
      useQwenAuth(geminiSettings, false),
    );
    expect(geminiResult.current.isQwenAuth).toBe(false);

    const oauthSettings = createMockSettings(AuthType.LOGIN_WITH_GOOGLE);
    const { result: oauthResult } = renderHook(() =>
      useQwenAuth(oauthSettings, false),
    );
    expect(oauthResult.current.isQwenAuth).toBe(false);
  });

  it('should set isQwenAuthenticating to true when starting authentication with Qwen auth', () => {
    const settings = createMockSettings(AuthType.QWEN_OAUTH);
    const { result } = renderHook(() => useQwenAuth(settings, true));

    expect(result.current.isQwenAuthenticating).toBe(true);
    expect(result.current.authStatus).toBe('idle');
  });
});
