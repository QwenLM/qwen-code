/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { performInitialAuth } from './auth.js';

const mockLogAuth = vi.fn();
vi.mock('@qwen-code/qwen-code-core', () => ({
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logAuth: (...args: unknown[]) => mockLogAuth(...args),
  AuthEvent: vi.fn().mockImplementation((type, method, status, message?) => ({
    type,
    method,
    status,
    message,
  })),
}));

describe('performInitialAuth', () => {
  let mockConfig: {
    refreshAuth: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('should return null on successful authentication', async () => {
    mockConfig.refreshAuth.mockResolvedValue(undefined);

    const result = await performInitialAuth(
      mockConfig as never,
      'api_key' as never,
    );

    expect(result).toBeNull();
    expect(mockConfig.refreshAuth).toHaveBeenCalledWith('api_key', true);
    expect(mockLogAuth).toHaveBeenCalledTimes(1);
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
