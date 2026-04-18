/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildRuntimeFetchOptions,
  getOrCreateSharedDispatcher,
  resetDispatcherCache,
} from './runtimeFetchOptions.js';

type UndiciOptions = Record<string, unknown>;

vi.mock('undici', () => {
  class MockAgent {
    options: UndiciOptions;
    constructor(options: UndiciOptions) {
      this.options = options;
    }
  }

  class MockProxyAgent {
    options: UndiciOptions;
    constructor(options: UndiciOptions) {
      this.options = options;
    }
  }

  return {
    Agent: MockAgent,
    ProxyAgent: MockProxyAgent,
  };
});

describe('buildRuntimeFetchOptions (node runtime)', () => {
  beforeEach(() => {
    resetDispatcherCache();
  });
  it('disables undici timeouts for Agent in OpenAI options', () => {
    const result = buildRuntimeFetchOptions('openai');

    expect(result).toBeDefined();
    expect(result && 'fetchOptions' in result).toBe(true);

    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      headersTimeout: 0,
      bodyTimeout: 0,
      keepAliveTimeout: 60_000,
    });
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
      keepAliveTimeout: 60_000,
    });
  });

  it('returns fetchOptions with dispatcher for Anthropic without proxy', () => {
    const result = buildRuntimeFetchOptions('anthropic');

    expect(result).toBeDefined();
    expect(result && 'fetchOptions' in result).toBe(true);

    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      headersTimeout: 0,
      bodyTimeout: 0,
      keepAliveTimeout: 60_000,
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
      keepAliveTimeout: 60_000,
    });
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

  it('shares the same dispatcher with buildRuntimeFetchOptions', () => {
    const shared = getOrCreateSharedDispatcher();
    const result = buildRuntimeFetchOptions('openai');
    const sdkDispatcher = (
      result as { fetchOptions?: { dispatcher?: unknown } }
    ).fetchOptions?.dispatcher;
    expect(sdkDispatcher).toBe(shared);
  });

  it('sets keepAliveTimeout to 60s for connection reuse', () => {
    const dispatcher = getOrCreateSharedDispatcher() as unknown as {
      options: UndiciOptions;
    };
    expect(dispatcher.options).toMatchObject({
      keepAliveTimeout: 60_000,
    });
  });
});
