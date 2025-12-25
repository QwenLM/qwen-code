/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DeviceAuthorizationData } from '@qwen-code/qwen-code-core';
import { useQwenAuth } from './useQwenAuth.js';
import {
  AuthType,
  qwenOAuth2Events,
  QwenOAuth2Event,
} from '@qwen-code/qwen-code-core';

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
  const mockDeviceAuth: DeviceAuthorizationData = {
    verification_uri: 'https://oauth.qwen.com/device',
    verification_uri_complete: 'https://oauth.qwen.com/device?user_code=ABC123',
    user_code: 'ABC123',
    expires_in: 1800,
    device_code: 'device_code_123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with default state when not Qwen auth', () => {
    const { result } = renderHook(() =>
      useQwenAuth(AuthType.USE_GEMINI, false),
    );

    expect(result.current.qwenAuthState).toEqual({
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
    });
    expect(result.current.cancelQwenAuth).toBeInstanceOf(Function);
  });

  it('should initialize with default state when Qwen auth but not authenticating', () => {
    const { result } = renderHook(() =>
      useQwenAuth(AuthType.QWEN_OAUTH, false),
    );

    expect(result.current.qwenAuthState).toEqual({
      deviceAuth: null,
      authStatus: 'idle',
      authMessage: null,
    });
    expect(result.current.cancelQwenAuth).toBeInstanceOf(Function);
  });

  it('should set up event listeners when Qwen auth and authenticating', () => {
    renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

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
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.qwenAuthState.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.qwenAuthState.authStatus).toBe('polling');
  });

  it('should handle auth progress event - success', () => {
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

    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    act(() => {
      handleAuthProgress!('success', 'Authentication successful!');
    });

    expect(result.current.qwenAuthState.authStatus).toBe('success');
    expect(result.current.qwenAuthState.authMessage).toBe(
      'Authentication successful!',
    );
  });

  it('should handle auth progress event - error', () => {
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

    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    act(() => {
      handleAuthProgress!('error', 'Authentication failed');
    });

    expect(result.current.qwenAuthState.authStatus).toBe('error');
    expect(result.current.qwenAuthState.authMessage).toBe(
      'Authentication failed',
    );
  });

  it('should handle auth progress event - polling', () => {
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

    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    act(() => {
      handleAuthProgress!('polling', 'Waiting for user authorization...');
    });

    expect(result.current.qwenAuthState.authStatus).toBe('polling');
    expect(result.current.qwenAuthState.authMessage).toBe(
      'Waiting for user authorization...',
    );
  });

  it('should handle auth progress event - rate_limit', () => {
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

    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    act(() => {
      handleAuthProgress!(
        'rate_limit',
        'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
      );
    });

    expect(result.current.qwenAuthState.authStatus).toBe('rate_limit');
    expect(result.current.qwenAuthState.authMessage).toBe(
      'Too many requests. The server is rate limiting our requests. Please select a different authentication method or try again later.',
    );
  });

  it('should handle auth progress event without message', () => {
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

    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    act(() => {
      handleAuthProgress!('success');
    });

    expect(result.current.qwenAuthState.authStatus).toBe('success');
    expect(result.current.qwenAuthState.authMessage).toBe(null);
  });

  it('should clean up event listeners when auth type changes', () => {
    const { rerender } = renderHook(
      ({ pendingAuthType, isAuthenticating }) =>
        useQwenAuth(pendingAuthType, isAuthenticating),
      {
        initialProps: {
          pendingAuthType: AuthType.QWEN_OAUTH,
          isAuthenticating: true,
        },
      },
    );

    // Change to non-Qwen auth
    rerender({ pendingAuthType: AuthType.USE_GEMINI, isAuthenticating: true });

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
    const { rerender } = renderHook(
      ({ isAuthenticating }) =>
        useQwenAuth(AuthType.QWEN_OAUTH, isAuthenticating),
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
    const { unmount } = renderHook(() =>
      useQwenAuth(AuthType.QWEN_OAUTH, true),
    );

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
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result, rerender } = renderHook(
      ({ pendingAuthType, isAuthenticating }) =>
        useQwenAuth(pendingAuthType, isAuthenticating),
      {
        initialProps: {
          pendingAuthType: AuthType.QWEN_OAUTH,
          isAuthenticating: true,
        },
      },
    );

    // Simulate device auth
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.qwenAuthState.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.qwenAuthState.authStatus).toBe('polling');

    // Switch to different auth type
    rerender({ pendingAuthType: AuthType.USE_GEMINI, isAuthenticating: true });

    expect(result.current.qwenAuthState.deviceAuth).toBe(null);
    expect(result.current.qwenAuthState.authStatus).toBe('idle');
    expect(result.current.qwenAuthState.authMessage).toBe(null);
  });

  it('should reset state when authentication stops', () => {
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result, rerender } = renderHook(
      ({ isAuthenticating }) =>
        useQwenAuth(AuthType.QWEN_OAUTH, isAuthenticating),
      { initialProps: { isAuthenticating: true } },
    );

    // Simulate device auth
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.qwenAuthState.deviceAuth).toEqual(mockDeviceAuth);
    expect(result.current.qwenAuthState.authStatus).toBe('polling');

    // Stop authentication
    rerender({ isAuthenticating: false });

    expect(result.current.qwenAuthState.deviceAuth).toBe(null);
    expect(result.current.qwenAuthState.authStatus).toBe('idle');
    expect(result.current.qwenAuthState.authMessage).toBe(null);
  });

  it('should handle cancelQwenAuth function', () => {
    let handleDeviceAuth: (deviceAuth: DeviceAuthorizationData) => void;

    mockQwenOAuth2Events.on.mockImplementation((event, handler) => {
      if (event === QwenOAuth2Event.AuthUri) {
        handleDeviceAuth = handler;
      }
      return mockQwenOAuth2Events;
    });

    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    // Set up some state
    act(() => {
      handleDeviceAuth!(mockDeviceAuth);
    });

    expect(result.current.qwenAuthState.deviceAuth).toEqual(mockDeviceAuth);

    // Cancel auth
    act(() => {
      result.current.cancelQwenAuth();
    });

    expect(result.current.qwenAuthState.deviceAuth).toBe(null);
    expect(result.current.qwenAuthState.authStatus).toBe('idle');
    expect(result.current.qwenAuthState.authMessage).toBe(null);
  });

  it('should handle different auth types correctly', () => {
    // Test with Qwen OAuth - should set up event listeners when authenticating
    const { result: qwenResult } = renderHook(() =>
      useQwenAuth(AuthType.QWEN_OAUTH, true),
    );
    expect(qwenResult.current.qwenAuthState.authStatus).toBe('idle');
    expect(mockQwenOAuth2Events.on).toHaveBeenCalled();

    // Test with other auth types - should not set up event listeners
    const { result: geminiResult } = renderHook(() =>
      useQwenAuth(AuthType.USE_GEMINI, true),
    );
    expect(geminiResult.current.qwenAuthState.authStatus).toBe('idle');

    const { result: oauthResult } = renderHook(() =>
      useQwenAuth(AuthType.USE_OPENAI, true),
    );
    expect(oauthResult.current.qwenAuthState.authStatus).toBe('idle');
  });

  it('should initialize with idle status when starting authentication with Qwen auth', () => {
    const { result } = renderHook(() => useQwenAuth(AuthType.QWEN_OAUTH, true));

    expect(result.current.qwenAuthState.authStatus).toBe('idle');
    expect(mockQwenOAuth2Events.on).toHaveBeenCalled();
  });
});
