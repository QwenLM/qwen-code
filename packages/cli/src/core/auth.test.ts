/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performInitialAuth } from './auth.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { SubscriptionOAuthError } from '@qwen-code/qwen-code-core/qwen/subscription-oauth-client.js';

const account = vi.hoisted(() => ({ signedIn: true }));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-session.js', () => ({
  QwenSubscriptionSession: class {
    isSignedIn = () => account.signedIn;
  },
}));

const mockLogAuth = vi.fn();
vi.mock('@qwen-code/qwen-code-core/telemetry/loggers.js', () => ({
  logAuth: (...args: unknown[]) => mockLogAuth(...args),
}));

describe('performInitialAuth', () => {
  let mockConfig: {
    refreshAuth: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    account.signedIn = true;
    mockConfig = {
      refreshAuth: vi.fn(),
    };
  });

  it('should return null when authType is undefined', async () => {
    const result = await performInitialAuth(mockConfig as never, undefined);

    expect(result).toBeNull();
    expect(mockConfig.refreshAuth).not.toHaveBeenCalled();
    expect(mockLogAuth).not.toHaveBeenCalled();
  });

  it('opens normal setup without attempting a saved subscription login after logout', async () => {
    account.signedIn = false;
    expect(
      await performInitialAuth(mockConfig as never, AuthType.QWEN_SUBSCRIPTION),
    ).toBeNull();
    expect(mockConfig.refreshAuth).not.toHaveBeenCalled();
    expect(mockLogAuth).not.toHaveBeenCalled();
  });

  it('does not report an implicit subscription login failure when credentials disappear during startup', async () => {
    mockConfig.refreshAuth.mockRejectedValue(
      new SubscriptionOAuthError('session_changed'),
    );
    expect(
      await performInitialAuth(mockConfig as never, AuthType.QWEN_SUBSCRIPTION),
    ).toBeNull();
    expect(mockLogAuth).not.toHaveBeenCalled();
  });

  it('should return null on successful authentication', async () => {
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const result = await performInitialAuth(
      mockConfig as never,
      'api_key' as never,
    );

    expect(result).toBeNull();
    expect(mockConfig.refreshAuth).toHaveBeenCalledWith(
      'api_key',
      true,
      undefined,
    );
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
  });

  it('passes the eligible subscription fallback to initial auth', async () => {
    await expect(
      performInitialAuth(
        mockConfig as never,
        AuthType.QWEN_SUBSCRIPTION,
        'qwen3.8-max',
      ),
    ).resolves.toBeNull();
    expect(mockConfig.refreshAuth).toHaveBeenCalledExactlyOnceWith(
      AuthType.QWEN_SUBSCRIPTION,
      true,
      'qwen3.8-max',
    );
  });

  it('should return error message on authentication failure', async () => {
    mockConfig.refreshAuth.mockRejectedValue(new Error('Invalid API key'));

    const result = await performInitialAuth(
      mockConfig as never,
      'api_key' as never,
    );

    expect(result).toBe('Failed to login. Message: Invalid API key');
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
  });
});
