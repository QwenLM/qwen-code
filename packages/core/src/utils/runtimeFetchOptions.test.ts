/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

const { mockUndiciFetch } = vi.hoisted(() => ({
  mockUndiciFetch: vi.fn(),
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
      // Simulate failure for specifically invalid proxy URLs
      // Note: Real ProxyAgent accepts credential URLs — only syntactically invalid URIs fail
      if (this.uri === 'http://invalid-proxy') {
        throw new Error('Invalid proxy URL: http://user:secret@proxy.local');
      }
    }
  }

  return {
    Agent: MockAgent,
    ProxyAgent: MockProxyAgent,
    fetch: mockUndiciFetch,
  };
});

import {
  buildRuntimeFetchOptions,
  extractHostnameFromProxyUrl,
  getOrCreateSharedDispatcher,
  redactProxyCredentials,
  redactProxyError,
  resetDispatcherCache,
} from './runtimeFetchOptions.js';

type UndiciOptions = Record<string, unknown>;

describe('buildRuntimeFetchOptions (node runtime)', () => {
  beforeEach(() => {
    resetDispatcherCache();
    mockWarn.mockClear();
    mockConsoleError.mockClear();
    vi.spyOn(console, 'error').mockImplementation(mockConsoleError);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('returns dispatcher with bodyTimeout=0 for OpenAI when no proxy is set', () => {
    const result = buildRuntimeFetchOptions('openai');
    expect(result).toBeDefined();
    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      bodyTimeout: 0,
      headersTimeout: 0,
      keepAliveTimeout: 60_000,
    });
  });

  it('returns dispatcher with bodyTimeout=0 for Anthropic when no proxy is set', () => {
    const result = buildRuntimeFetchOptions('anthropic');
    expect(result).toBeDefined();
    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      bodyTimeout: 0,
      headersTimeout: 0,
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

  it('pins fetch to undici when proxy is set so dispatcher and fetch share a version', () => {
    // Regression for `invalid onError method`: Node's built-in fetch (newer
    // undici) cannot accept a ProxyAgent built from a different undici major.
    // The function must hand back the bundled undici's fetch alongside the
    // dispatcher.
    const openaiResult = buildRuntimeFetchOptions(
      'openai',
      'http://proxy.local',
    );
    expect((openaiResult as { fetch?: unknown }).fetch).toBe(mockUndiciFetch);

    const anthropicResult = buildRuntimeFetchOptions(
      'anthropic',
      'http://proxy.local',
    );
    expect((anthropicResult as { fetch?: unknown }).fetch).toBe(
      mockUndiciFetch,
    );
  });

  it('pins fetch to undici when no proxy is set (dispatcher version compatibility)', () => {
    const openaiResult = buildRuntimeFetchOptions('openai');
    expect((openaiResult as { fetch?: unknown }).fetch).toBe(mockUndiciFetch);

    const anthropicResult = buildRuntimeFetchOptions('anthropic');
    expect((anthropicResult as { fetch?: unknown }).fetch).toBe(
      mockUndiciFetch,
    );
  });

  it('ignores custom bodyTimeout when proxy is set (proxy hardcodes bodyTimeout: 0)', () => {
    const result = buildRuntimeFetchOptions('openai', 'http://proxy.local', {
      bodyTimeout: 60000,
    });
    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      uri: 'http://proxy.local',
      bodyTimeout: 0,
    });
  });

  it('respects custom bodyTimeout option in no-proxy path', () => {
    const result = buildRuntimeFetchOptions('openai', undefined, {
      bodyTimeout: 60000,
    });
    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      bodyTimeout: 60000,
      headersTimeout: 0,
    });
  });

  it('caches no-proxy dispatchers by bodyTimeout value', () => {
    const result1 = buildRuntimeFetchOptions('openai', undefined, {
      bodyTimeout: 0,
    });
    const result2 = buildRuntimeFetchOptions('openai', undefined, {
      bodyTimeout: 0,
    });
    const dispatcher1 = (
      result1 as {
        fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
      }
    ).fetchOptions?.dispatcher;
    const dispatcher2 = (
      result2 as {
        fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
      }
    ).fetchOptions?.dispatcher;
    expect(dispatcher1).toBe(dispatcher2);
  });

  it.each([
    { input: -1, expected: 0, label: 'negative', shouldWarn: true },
    { input: 3.14, expected: 0, label: 'float', shouldWarn: true },
    { input: NaN, expected: 0, label: 'NaN', shouldWarn: true },
    { input: Infinity, expected: 0, label: 'Infinity', shouldWarn: true },
    { input: undefined, expected: 0, label: 'undefined', shouldWarn: false },
    { input: 0, expected: 0, label: 'zero', shouldWarn: false },
    {
      input: 60000,
      expected: 60000,
      label: 'positive integer',
      shouldWarn: false,
    },
  ])(
    'sanitizes invalid bodyTimeout ($label → $expected)',
    ({ input, expected, shouldWarn }) => {
      const result = buildRuntimeFetchOptions('openai', undefined, {
        bodyTimeout: input as number,
      });
      const dispatcher = (
        result as {
          fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
        }
      ).fetchOptions?.dispatcher;
      expect(dispatcher?.options).toMatchObject({
        bodyTimeout: expected,
        headersTimeout: 0,
      });
      if (shouldWarn) {
        expect(mockWarn).toHaveBeenCalledWith(
          expect.stringContaining('Invalid bodyTimeout'),
        );
      } else {
        expect(mockWarn).not.toHaveBeenCalledWith(
          expect.stringContaining('Invalid bodyTimeout'),
        );
      }
    },
  );

  it('falls back to no-proxy dispatcher when proxy creation fails (OpenAI)', () => {
    const result = buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    // Should fallback to a no-proxy Agent with bodyTimeout preserved
    expect(result).toBeDefined();
    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      bodyTimeout: 0,
      headersTimeout: 0,
    });
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

  it('falls back to no-proxy dispatcher when proxy creation fails (Anthropic)', () => {
    const result = buildRuntimeFetchOptions(
      'anthropic',
      'http://invalid-proxy',
    );
    // Should fallback to a no-proxy Agent with bodyTimeout preserved
    expect(result).toBeDefined();
    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      bodyTimeout: 0,
      headersTimeout: 0,
    });
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

  it('preserves custom bodyTimeout in proxy-failure fallback', () => {
    const result = buildRuntimeFetchOptions('openai', 'http://invalid-proxy', {
      bodyTimeout: 60000,
    });
    const dispatcher = (
      result as { fetchOptions?: { dispatcher?: { options?: UndiciOptions } } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher?.options).toMatchObject({
      bodyTimeout: 60000,
      headersTimeout: 0,
    });
  });

  it('returns different dispatchers for different bodyTimeout values', () => {
    const result0 = buildRuntimeFetchOptions('openai', undefined, {
      bodyTimeout: 0,
    });
    const result60k = buildRuntimeFetchOptions('openai', undefined, {
      bodyTimeout: 60000,
    });
    const dispatcher0 = (result0 as { fetchOptions?: { dispatcher?: unknown } })
      .fetchOptions?.dispatcher;
    const dispatcher60k = (
      result60k as { fetchOptions?: { dispatcher?: unknown } }
    ).fetchOptions?.dispatcher;
    expect(dispatcher0).not.toBe(dispatcher60k);
  });

  it('redacts credentials from proxy URL in error message', () => {
    // http://invalid-proxy triggers dispatcher failure whose error message
    // contains credentials that should be redacted
    const result = buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    expect(result).toBeDefined();
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

  it('logs hostname (without credentials) in failure message', () => {
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('invalid-proxy'),
    );
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.stringContaining('secret'),
    );
  });

  it('logs each failure separately (no deduplication)', () => {
    // Deduplication was removed to allow administrators to see each credential
    // change attempt's failure when debugging proxy issues
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    buildRuntimeFetchOptions('anthropic', 'http://invalid-proxy');
    // Should log each failure (no dedup)
    expect(mockWarn).toHaveBeenCalledTimes(3);
    expect(mockConsoleError).toHaveBeenCalledTimes(3);
    expect(mockWarn).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('(first failure)'),
    );
    expect(mockWarn).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('(failure #2)'),
    );
    expect(mockWarn).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('(failure #3)'),
    );
  });
});

describe('getOrCreateSharedDispatcher', () => {
  beforeEach(() => {
    resetDispatcherCache();
    mockWarn.mockClear();
    mockConsoleError.mockClear();
  });

  it('returns the same instance for repeated calls with the same proxy', () => {
    const d1 = getOrCreateSharedDispatcher('http://proxy.local');
    const d2 = getOrCreateSharedDispatcher('http://proxy.local');
    expect(d1).toBe(d2);
  });

  it('returns different instances for different proxy URLs', () => {
    const d1 = getOrCreateSharedDispatcher('http://proxy.local');
    const d2 = getOrCreateSharedDispatcher('http://proxy.other');
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

  it('does not redact ordinary email addresses', () => {
    const msg = 'Contact support@example.com or set email=user@example.com';
    expect(redactProxyCredentials(msg)).toBe(msg);
  });

  it('redacts credentials in Node.js native error format (no scheme)', () => {
    const msg = 'connect ECONNREFUSED user:pass@proxy.local:8080';
    expect(redactProxyCredentials(msg)).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
  });

  it('redacts token-only credentials in Node.js native error format', () => {
    const msg = 'connect ECONNREFUSED token@proxy.local:8080';
    expect(redactProxyCredentials(msg)).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
  });

  it('redacts token-only credentials for localhost proxy endpoints', () => {
    const msg = 'connect ECONNREFUSED token@localhost:8080';
    expect(redactProxyCredentials(msg)).toBe(
      'connect ECONNREFUSED <redacted>@localhost:8080',
    );
  });

  it('redacts token-only credentials for IP proxy endpoints', () => {
    const msg = 'connect ECONNREFUSED token@10.0.0.5:8080';
    expect(redactProxyCredentials(msg)).toBe(
      'connect ECONNREFUSED <redacted>@10.0.0.5:8080',
    );
  });

  it('redacts token-only credentials for corporate proxy endpoints', () => {
    const msg = 'connect ECONNREFUSED token@gateway.corp.local:8080';
    expect(redactProxyCredentials(msg)).toBe(
      'connect ECONNREFUSED <redacted>@gateway.corp.local:8080',
    );
  });

  it('does not redact SSH-style host and port strings', () => {
    const msg = 'ssh failed for git@github.com:22';
    expect(redactProxyCredentials(msg)).toBe(msg);
  });

  it('does not redact email-like strings followed by numeric suffixes', () => {
    const msg = 'see user@example.com:42 for line reference';
    expect(redactProxyCredentials(msg)).toBe(msg);
  });

  it('does not redact email-like strings followed by larger line numbers', () => {
    const msg = 'see user@example.com:123 for line reference';
    expect(redactProxyCredentials(msg)).toBe(msg);
  });

  it('does not redact email-like strings near ordinary request prose', () => {
    const msg = 'request mentions user@example.com:123 in prose';
    expect(redactProxyCredentials(msg)).toBe(msg);
  });

  it('does not redact email-like strings near ordinary fetch prose', () => {
    const msg = 'fetch the owner from user@example.local:123';
    expect(redactProxyCredentials(msg)).toBe(msg);
  });

  it('redacts token-only credentials for public hosts in network error context', () => {
    const msg = 'connect ECONNREFUSED token@public.example.com:8080';
    expect(redactProxyCredentials(msg)).toBe(
      'connect ECONNREFUSED <redacted>@public.example.com:8080',
    );
  });

  it('redacts bare credentials when the password contains colons', () => {
    const msg = 'connect ECONNREFUSED user:pass:word@proxy.local:8080';
    expect(redactProxyCredentials(msg)).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
  });

  it('preserves labels and delimiters around bare proxy credentials', () => {
    const msg = 'cause=(user:pass@proxy.local:8080)';
    expect(redactProxyCredentials(msg)).toBe(
      'cause=(<redacted>@proxy.local:8080)',
    );
  });

  it('does not double-redact when both patterns are present', () => {
    const msg =
      'http://user:pass@proxy.local — cause: connect ECONNREFUSED user:pass@proxy.local:8080';
    const result = redactProxyCredentials(msg);
    expect(result).not.toContain('user');
    expect(result).not.toContain('pass');
    expect(result).toContain('proxy.local');
  });
});

describe('redactProxyError', () => {
  it('redacts proxy credentials from Error message and stack in-place', () => {
    const error = new Error('connect ECONNREFUSED token@proxy.local:8080');
    error.stack =
      'Error: connect ECONNREFUSED token@proxy.local:8080\n    at test';

    const result = redactProxyError(error);

    expect(result).toBe(error);
    expect(error.message).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
    expect(error.stack).toContain('<redacted>@proxy.local:8080');
    expect(error.stack).not.toContain('token@');
  });

  it('redacts proxy credentials from string errors', () => {
    expect(redactProxyError('407 via http://user:pass@proxy.local')).toBe(
      '407 via http://<redacted>@proxy.local',
    );
  });

  it('preserves SDK error metadata while redacting nested causes', () => {
    const cause = new Error('connect ECONNREFUSED token@localhost:8080');
    const error = Object.assign(
      new Error('request failed via http://user:pass@proxy.local'),
      { status: 407, code: 'proxy_auth_required', cause },
    );

    const result = redactProxyError(error);

    expect(result).toBe(error);
    expect(error.status).toBe(407);
    expect(error.code).toBe('proxy_auth_required');
    expect(error.message).toBe(
      'request failed via http://<redacted>@proxy.local',
    );
    expect(cause.message).toBe(
      'connect ECONNREFUSED <redacted>@localhost:8080',
    );
  });

  it('does not throw on circular causes', () => {
    const error = new Error(
      'connect ECONNREFUSED token@proxy.local:8080',
    ) as Error & { cause?: unknown };
    error.cause = error;

    expect(() => redactProxyError(error)).not.toThrow();
    expect(error.message).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
    expect(error.cause).toBe(error);
  });

  it('returns a redacted clone when an error-like object has read-only fields', () => {
    const error: { message?: string; stack?: string } = {};
    Object.defineProperty(error, 'message', {
      value: 'connect ECONNREFUSED token@proxy.local:8080',
      writable: false,
    });
    Object.defineProperty(error, 'status', {
      value: 407,
      enumerable: true,
    });

    const result = redactProxyError(error) as {
      message?: string;
      status?: number;
    };

    expect(result).not.toBe(error);
    expect(result.message).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
    expect(result.status).toBe(407);
    expect(error.message).toBe('connect ECONNREFUSED token@proxy.local:8080');
  });

  it('preserves Error subclass prototype when cloning read-only fields', () => {
    class ProxySdkError extends Error {
      status = 407;
    }

    const error = new ProxySdkError(
      'connect ECONNREFUSED token@proxy.local:8080',
    );
    Object.defineProperty(error, 'message', {
      value: error.message,
      writable: false,
      configurable: false,
    });

    const result = redactProxyError(error) as ProxySdkError;

    expect(result).not.toBe(error);
    expect(result).toBeInstanceOf(ProxySdkError);
    expect(result.status).toBe(407);
    expect(result.message).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
  });

  it('keeps read-only circular causes on the redacted clone', () => {
    class ProxySdkError extends Error {
      status = 407;
      override cause?: unknown;
    }

    const error = new ProxySdkError(
      'connect ECONNREFUSED token@proxy.local:8080',
    );
    Object.defineProperty(error, 'message', {
      value: error.message,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(error, 'cause', {
      value: error,
      writable: false,
      configurable: false,
    });

    const result = redactProxyError(error) as ProxySdkError;

    expect(result).not.toBe(error);
    expect(result).toBeInstanceOf(ProxySdkError);
    expect(result.status).toBe(407);
    expect(result.message).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
    expect(result.cause).toBe(result);
    expect((result.cause as Error).message).not.toContain('token@');
  });

  it('redacts nested AggregateError errors', () => {
    const nestedError = new Error(
      'connect ECONNREFUSED token@proxy.local:8080',
    );
    const aggregateError = new AggregateError(
      [nestedError],
      'fetch failed via http://user:pass@proxy.local',
    );

    const result = redactProxyError(aggregateError) as AggregateError;
    const [redactedNestedError] = result.errors as Error[];

    expect(result).toBe(aggregateError);
    expect(result.message).toBe(
      'fetch failed via http://<redacted>@proxy.local',
    );
    expect(redactedNestedError).toBe(nestedError);
    expect(redactedNestedError.message).toBe(
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    );
  });
});

describe('extractHostnameFromProxyUrl', () => {
  it('extracts host and port from a valid credentialed proxy URL', () => {
    expect(
      extractHostnameFromProxyUrl('http://user:secret@proxy.local:8080'),
    ).toBe('proxy.local:8080');
  });

  it('extracts host and port from a scheme-less credentialed proxy value', () => {
    expect(extractHostnameFromProxyUrl('user:secret@proxy.local:8080')).toBe(
      'proxy.local:8080',
    );
  });

  it('redacts fallback output when no safe hostname can be extracted', () => {
    expect(extractHostnameFromProxyUrl('http://user:secret@')).toBe(
      'http://<redacted>@',
    );
  });
});
