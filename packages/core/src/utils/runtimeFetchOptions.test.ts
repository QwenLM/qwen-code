/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { buildRuntimeFetchOptions } from './runtimeFetchOptions.js';

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

  describe('insecure flag (#3535)', () => {
    it('omits connect option when insecure is unset', () => {
      const result = buildRuntimeFetchOptions('openai');
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).not.toHaveProperty('connect');
    });

    it('forwards rejectUnauthorized: false to undici Agent', () => {
      const result = buildRuntimeFetchOptions('openai', { insecure: true });
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        connect: { rejectUnauthorized: false },
        headersTimeout: 0,
        bodyTimeout: 0,
      });
    });

    it('forwards rejectUnauthorized: false to undici ProxyAgent', () => {
      const result = buildRuntimeFetchOptions('openai', {
        proxyUrl: 'http://proxy.local',
        insecure: true,
      });
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        uri: 'http://proxy.local',
        connect: { rejectUnauthorized: false },
        headersTimeout: 0,
        bodyTimeout: 0,
      });
    });

    it('treats a bare proxy-URL string identically to legacy callers', () => {
      const stringResult = buildRuntimeFetchOptions(
        'openai',
        'http://proxy.local',
      );
      const objectResult = buildRuntimeFetchOptions('openai', {
        proxyUrl: 'http://proxy.local',
      });
      const stringDispatcher = (
        stringResult as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher?.options;
      const objectDispatcher = (
        objectResult as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher?.options;
      expect(stringDispatcher).toEqual(objectDispatcher);
    });

    it('also threads insecure into Anthropic builders', () => {
      const result = buildRuntimeFetchOptions('anthropic', { insecure: true });
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        connect: { rejectUnauthorized: false },
      });
    });
  });
});
