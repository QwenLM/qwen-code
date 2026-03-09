/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  describe('NO_PROXY handling', () => {
    const originalEnv: { [key: string]: string | undefined } = {};

    beforeEach(() => {
      // Save original environment variables
      originalEnv['NO_PROXY'] = process.env['NO_PROXY'];
      originalEnv['no_proxy'] = process.env['no_proxy'];
      // Clear environment variables before each test
      delete process.env['NO_PROXY'];
      delete process.env['no_proxy'];
    });

    afterEach(() => {
      // Restore original environment variables
      if (originalEnv['NO_PROXY'] !== undefined) {
        process.env['NO_PROXY'] = originalEnv['NO_PROXY'];
      } else {
        delete process.env['NO_PROXY'];
      }
      if (originalEnv['no_proxy'] !== undefined) {
        process.env['no_proxy'] = originalEnv['no_proxy'];
      } else {
        delete process.env['no_proxy'];
      }
    });

    it('should pass noProxy option when NO_PROXY environment variable is set', () => {
      process.env['NO_PROXY'] = 'localhost,127.0.0.1,internal.local';

      const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');

      expect(result).toBeDefined();
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        uri: 'http://proxy.local',
        headersTimeout: 0,
        bodyTimeout: 0,
        noProxy: 'localhost,127.0.0.1,internal.local',
      });
    });

    it('should pass noProxy option when no_proxy (lowercase) environment variable is set', () => {
      process.env['no_proxy'] = 'api.local,*.internal';

      const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');

      expect(result).toBeDefined();
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        uri: 'http://proxy.local',
        headersTimeout: 0,
        bodyTimeout: 0,
        noProxy: 'api.local,*.internal',
      });
    });

    it('should prioritize NO_PROXY over no_proxy when both are set', () => {
      process.env['NO_PROXY'] = 'priority.local';
      process.env['no_proxy'] = 'fallback.local';

      const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');

      expect(result).toBeDefined();
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        noProxy: 'priority.local',
      });
    });

    it('should not pass noProxy option when neither NO_PROXY nor no_proxy is set', () => {
      const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');

      expect(result).toBeDefined();
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        uri: 'http://proxy.local',
        headersTimeout: 0,
        bodyTimeout: 0,
      });
      expect(dispatcher?.options).not.toHaveProperty('noProxy');
    });

    it('should handle NO_PROXY with wildcard (*)', () => {
      process.env['NO_PROXY'] = '*';

      const result = buildRuntimeFetchOptions(
        'anthropic',
        'http://proxy.local',
      );

      expect(result).toBeDefined();
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        uri: 'http://proxy.local',
        noProxy: '*',
      });
    });
  });
});
