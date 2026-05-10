/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mockWarn and mockConsoleError so they're available to both the vi.mock and test cases
const { mockWarn, mockConsoleError } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockConsoleError: vi.fn(),
}));

vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    info: vi.fn(),
  }),
  mockWarn,
}));

// Spy on console.error
vi.spyOn(console, 'error').mockImplementation(mockConsoleError);

vi.mock('undici', () => {
  class MockAgent {
    options: UndiciOptions;
    constructor(options: UndiciOptions) {
      this.options = options;
    }
  }

  class MockProxyAgent {
    options: UndiciOptions;
    uri: string;
    constructor(options: UndiciOptions) {
      this.options = options;
      this.uri = (options as { uri?: string }).uri || '';
      // Simulate failure for invalid proxy URLs or URLs with credentials
      if (
        this.uri === 'http://invalid-proxy' ||
        this.uri === 'http://user:secret@proxy.local'
      ) {
        throw new Error('Invalid proxy URL: http://user:secret@proxy.local');
      }
    }
  }

  return {
    Agent: MockAgent,
    ProxyAgent: MockProxyAgent,
  };
});

import {
  buildRuntimeFetchOptions,
  getOrCreateSharedDispatcher,
  redactProxyCredentials,
  resetDispatcherCache,
  resetRejectedProxyCache,
} from './runtimeFetchOptions.js';

type UndiciOptions = Record<string, unknown>;

describe('buildRuntimeFetchOptions (node runtime)', () => {
  beforeEach(() => {
    resetDispatcherCache();
    resetRejectedProxyCache();
    mockWarn.mockClear();
    mockConsoleError.mockClear();
  });
  it('returns undefined for OpenAI when no proxy is set', () => {
    const result = buildRuntimeFetchOptions('openai');
    expect(result).toBeUndefined();
  });

  it('returns empty object for Anthropic when no proxy is set', () => {
    const result = buildRuntimeFetchOptions('anthropic');
    expect(result).toEqual({});
  });

  it('uses ProxyAgent with disabled timeouts when proxy is set', () => {
    const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');

    expect(result).toBeDefined();
    expect(result && 'fetchOptions' in result).toBe(true);

    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      uri: 'http://proxy.local',
      headersTimeout: 0,
      bodyTimeout: 0,
    });
  });

  it('returns fetchOptions with ProxyAgent for Anthropic with proxy', () => {
    const result = buildRuntimeFetchOptions('anthropic', 'http://proxy.local');

    expect(result).toBeDefined();
    expect(result && 'fetchOptions' in result).toBe(true);

    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      uri: 'http://proxy.local',
      headersTimeout: 0,
      bodyTimeout: 0,
    });
  });

  it('returns undefined for OpenAI when dispatcher creation fails', () => {
    const result = buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    // Should fallback to undefined (no dispatcher) on error
    expect(result).toBeUndefined();
    // Should log the failure for visibility
    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create proxy dispatcher'),
    );
    // Should also log to console.error for production visibility
    expect(mockConsoleError).toHaveBeenCalledOnce();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('[RUNTIME_FETCH]'),
    );
  });

  it('returns empty object for Anthropic when dispatcher creation fails', () => {
    const result = buildRuntimeFetchOptions(
      'anthropic',
      'http://invalid-proxy',
    );
    // Should fallback to empty object on error
    expect(result).toEqual({});
    // Should log the failure for visibility
    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to create proxy dispatcher'),
    );
    // Should also log to console.error for production visibility
    expect(mockConsoleError).toHaveBeenCalledOnce();
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('[RUNTIME_FETCH]'),
    );
  });

  it('redacts credentials from proxy URL in error message', () => {
    const result = buildRuntimeFetchOptions(
      'openai',
      'http://user:secret@proxy.local',
    );
    expect(result).toBeUndefined();
    // Should redact credentials in the log message
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('<redacted>'),
    );
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('secret'),
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('<redacted>'),
    );
    expect(mockConsoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('secret'),
    );
  });

  it('logs only once for repeated failures with the same proxy URL', () => {
    // Simulate multiple requests failing with the same broken proxy config
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    buildRuntimeFetchOptions('anthropic', 'http://invalid-proxy');
    // Should only log once due to rejectedProxyCache dedup
    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockConsoleError).toHaveBeenCalledOnce();
  });

  it('logs again for a different failing proxy URL', () => {
    // Different proxy URLs should each trigger separate logging
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    buildRuntimeFetchOptions('openai', 'http://user:secret@proxy.local');
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockConsoleError).toHaveBeenCalledTimes(2);
  });
});

describe('getOrCreateSharedDispatcher', () => {
  beforeEach(() => {
    resetDispatcherCache();
    resetRejectedProxyCache();
    mockWarn.mockClear();
    mockConsoleError.mockClear();
  });

  it('returns the same instance for repeated calls without proxy', () => {
    const d1 = getOrCreateSharedDispatcher();
    const d2 = getOrCreateSharedDispatcher();
    expect(d1).toBe(d2);
  });

  it('returns the same instance for repeated calls with the same proxy', () => {
    const d1 = getOrCreateSharedDispatcher('http://proxy.local');
    const d2 = getOrCreateSharedDispatcher('http://proxy.local');
    expect(d1).toBe(d2);
  });

  it('returns different instances for different proxy URLs', () => {
    const d1 = getOrCreateSharedDispatcher();
    const d2 = getOrCreateSharedDispatcher('http://proxy.local');
    expect(d1).not.toBe(d2);
  });
  it('shares the same ProxyAgent dispatcher with buildRuntimeFetchOptions when proxy is set', () => {
    const shared = getOrCreateSharedDispatcher('http://proxy.local');
    const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');
    const sdkDispatcher = (
      result as { fetchOptions?: { dispatcher?: unknown } }
    ).fetchOptions?.dispatcher;
    expect(sdkDispatcher).toBe(shared);
  });
});

describe('redactProxyCredentials', () => {
  it('redacts credentials from a single proxy URL', () => {
    const msg = 'Failed to connect: http://user:secret@proxy.local';
    expect(redactProxyCredentials(msg)).toBe(
      'Failed to connect: http://<redacted>@proxy.local',
    );
  });

  it('redacts every credential occurrence in a multi-URL error message', () => {
    const msg = 'Failed: http://a:b@p1; cause: http://c:d@p2';
    expect(redactProxyCredentials(msg)).toBe(
      'Failed: http://<redacted>@p1; cause: http://<redacted>@p2',
    );
  });

  it('does not over-redact non-userinfo @ characters past the hostname', () => {
    const msg = 'http://user:pass@proxy.local/contact@example.com';
    expect(redactProxyCredentials(msg)).toBe(
      'http://<redacted>@proxy.local/contact@example.com',
    );
  });

  it('preserves messages without proxy URLs unchanged', () => {
    const msg = 'Network timeout occurred';
    expect(redactProxyCredentials(msg)).toBe(msg);
  });
});
