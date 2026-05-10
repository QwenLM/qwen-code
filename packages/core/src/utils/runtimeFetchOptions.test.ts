/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mockWarn so it's available to both the vi.mock and test cases
const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));

vi.mock('./debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    info: vi.fn(),
  }),
  mockWarn,
}));

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
      // Simulate failure for invalid proxy URLs
      if (this.uri === 'http://invalid-proxy') {
        throw new Error('Invalid proxy URL');
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
  resetDispatcherCache,
} from './runtimeFetchOptions.js';

type UndiciOptions = Record<string, unknown>;

describe('buildRuntimeFetchOptions (node runtime)', () => {
  beforeEach(() => {
    resetDispatcherCache();
    mockWarn.mockClear();
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
  });
});

describe('getOrCreateSharedDispatcher', () => {
  beforeEach(() => {
    resetDispatcherCache();
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

  it('returns undefined dispatcher for OpenAI without proxy (uses built-in fetch)', () => {
    const result = buildRuntimeFetchOptions('openai');
    expect(result).toBeUndefined();
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
