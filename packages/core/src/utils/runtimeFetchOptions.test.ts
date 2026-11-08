/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';

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

  class MockEnvHttpProxyAgent {
    options: UndiciOptions;
    constructor(options: UndiciOptions) {
      this.options = options;
      const httpProxy = (options as { httpProxy?: string }).httpProxy || '';
      // Simulate failure for specifically invalid proxy URLs
      // Note: Real EnvHttpProxyAgent accepts credential URLs — only syntactically invalid URIs fail
      if (httpProxy === 'http://invalid-proxy') {
        throw new Error('Invalid proxy URL: http://user:secret@proxy.local');
      }
    }
  }

  return {
    Agent: MockAgent,
    EnvHttpProxyAgent: MockEnvHttpProxyAgent,
    fetch: mockUndiciFetch,
  };
});

import {
  buildRuntimeFetchOptions,
  extractHostnameFromProxyUrl,
  getOrCreateMcpDispatcher,
  getOrCreateSharedDispatcher,
  isTlsVerificationDisabled,
  preloadRuntimeFetchModule,
  redactProxyCredentials,
  redactProxyError,
  resetDispatcherCache,
  setResolvedProxyUrlForRuntimeFetch,
} from './runtimeFetchOptions.js';

type UndiciOptions = Record<string, unknown>;

// The sync option builders require undici to be preloaded (issue #7264);
// vi.mock('undici') intercepts the dynamic import, so this loads the mock.
beforeAll(async () => {
  await preloadRuntimeFetchModule();
});

type DispatcherResult = {
  fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
};
const getDispatcherOptions = (result: unknown): UndiciOptions | undefined =>
  (result as DispatcherResult).fetchOptions?.dispatcher?.options;
const fetchOf = (result: unknown) => (result as { fetch?: unknown }).fetch;
const containing = (text: string) => expect.stringContaining(text);

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

  // Asserts the result carries fetchOptions and returns its dispatcher options.
  const dispatcherOptionsOf = (result: object | undefined) => {
    expect(result).toBeDefined();
    expect(result && 'fetchOptions' in result).toBe(true);
    return getDispatcherOptions(result);
  };
  const noProxyTimeouts = {
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 60_000,
  };
  const proxiedTimeouts = {
    httpProxy: 'http://proxy.local',
    httpsProxy: 'http://proxy.local',
    headersTimeout: 0,
    bodyTimeout: 0,
  };
  // A dispatcher failure logs once to the debug log and once to
  // console.error for production visibility.
  const expectFailureLoggedOnce = () => {
    expect(mockWarn).toHaveBeenCalledOnce();
    expect(mockWarn).toHaveBeenCalledWith(
      containing('Failed to create proxy dispatcher'),
    );
    expect(mockConsoleError).toHaveBeenCalledOnce();
    expect(mockConsoleError).toHaveBeenCalledWith(
      containing('[RUNTIME_FETCH]'),
    );
  };

  it('returns Agent with disabled timeouts for OpenAI when no proxy is set', () => {
    const result = buildRuntimeFetchOptions('openai');
    expect(dispatcherOptionsOf(result)).toMatchObject(noProxyTimeouts);
    expect(fetchOf(result)).toBe(mockUndiciFetch);
  });

  it('returns Agent with disabled timeouts for Anthropic when no proxy is set', () => {
    const result = buildRuntimeFetchOptions('anthropic');
    expect(dispatcherOptionsOf(result)).toMatchObject(noProxyTimeouts);
    expect(fetchOf(result)).toBe(mockUndiciFetch);
  });

  it('uses EnvHttpProxyAgent with disabled timeouts when proxy is set', () => {
    const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');
    expect(dispatcherOptionsOf(result)).toMatchObject(proxiedTimeouts);
  });

  it('returns fetchOptions with EnvHttpProxyAgent for Anthropic with proxy', () => {
    const result = buildRuntimeFetchOptions('anthropic', 'http://proxy.local');
    expect(dispatcherOptionsOf(result)).toMatchObject(proxiedTimeouts);
  });

  it('pins fetch to undici when proxy is set so dispatcher and fetch share a version', () => {
    // Regression for `invalid onError method`: Node's built-in fetch (newer
    // undici) cannot accept a dispatcher built from a different undici major.
    // The function must hand back the bundled undici's fetch alongside the
    // dispatcher.
    const proxy = 'http://proxy.local';
    const openaiResult = buildRuntimeFetchOptions('openai', proxy);
    expect(fetchOf(openaiResult)).toBe(mockUndiciFetch);
    const anthropicResult = buildRuntimeFetchOptions('anthropic', proxy);
    expect(fetchOf(anthropicResult)).toBe(mockUndiciFetch);
  });

  it('injects undiciFetch when no proxy is set', () => {
    // No-proxy path uses a bundled undici Agent with disabled timeouts,
    // so it also pins undiciFetch to avoid version-mismatch between the
    // bundled undici and Node.js built-in undici.
    expect(fetchOf(buildRuntimeFetchOptions('openai'))).toBe(mockUndiciFetch);
    expect(fetchOf(buildRuntimeFetchOptions('anthropic'))).toBe(
      mockUndiciFetch,
    );
  });

  it('returns undefined for OpenAI when dispatcher creation fails', () => {
    // Falls back to no dispatcher.
    expect(
      buildRuntimeFetchOptions('openai', 'http://invalid-proxy'),
    ).toBeUndefined();
    expectFailureLoggedOnce();
  });

  it('returns empty object for Anthropic when dispatcher creation fails', () => {
    expect(
      buildRuntimeFetchOptions('anthropic', 'http://invalid-proxy'),
    ).toEqual({});
    expectFailureLoggedOnce();
  });

  it('redacts credentials from proxy URL in error message', () => {
    // http://invalid-proxy triggers dispatcher failure whose error message
    // contains credentials that should be redacted in both logs.
    const result = buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    expect(result).toBeUndefined();
    for (const log of [mockWarn, mockConsoleError]) {
      expect(log).toHaveBeenCalledWith(containing('<redacted>'));
      expect(log).not.toHaveBeenCalledWith(containing('secret'));
    }
  });

  it('logs hostname (without credentials) in failure message', () => {
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    expect(mockWarn).toHaveBeenCalledWith(containing('invalid-proxy'));
    expect(mockWarn).not.toHaveBeenCalledWith(containing('secret'));
  });

  it('logs each failure separately (no deduplication)', () => {
    // Deduplication was removed to allow administrators to see each credential
    // change attempt's failure when debugging proxy issues
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    buildRuntimeFetchOptions('openai', 'http://invalid-proxy');
    buildRuntimeFetchOptions('anthropic', 'http://invalid-proxy');
    expect(mockWarn).toHaveBeenCalledTimes(3);
    expect(mockConsoleError).toHaveBeenCalledTimes(3);
    expect(mockWarn).toHaveBeenNthCalledWith(1, containing('(first failure)'));
    expect(mockWarn).toHaveBeenNthCalledWith(2, containing('(failure #2)'));
    expect(mockWarn).toHaveBeenNthCalledWith(3, containing('(failure #3)'));
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

  it('shares the same EnvHttpProxyAgent dispatcher with buildRuntimeFetchOptions when proxy is set', () => {
    const shared = getOrCreateSharedDispatcher('http://proxy.local');
    const result = buildRuntimeFetchOptions('openai', 'http://proxy.local');
    expect((result as DispatcherResult).fetchOptions?.dispatcher).toBe(shared);
  });
});

describe('getOrCreateMcpDispatcher', () => {
  beforeEach(() => {
    resetDispatcherCache();
  });

  it('routes MCP traffic through the explicitly configured proxy dispatcher', () => {
    setResolvedProxyUrlForRuntimeFetch('http://proxy.example.com:8080');
    const dispatcher = getOrCreateMcpDispatcher(false);
    expect(dispatcher).toBe(
      getOrCreateSharedDispatcher('http://proxy.example.com:8080', false),
    );
  });

  it('falls back to a cached env-aware dispatcher when no explicit proxy is registered', () => {
    const d1 = getOrCreateMcpDispatcher(false);
    expect(d1).toBe(getOrCreateMcpDispatcher(false));
    expect(d1).not.toBe(
      getOrCreateSharedDispatcher('http://proxy.local', false),
    );
  });

  it('drops the registered explicit proxy when the dispatcher cache is reset', () => {
    setResolvedProxyUrlForRuntimeFetch('http://proxy.example.com:8080');
    resetDispatcherCache();
    const dispatcher = getOrCreateMcpDispatcher(false);
    expect(dispatcher).not.toBe(
      getOrCreateSharedDispatcher('http://proxy.example.com:8080', false),
    );
  });
});

describe('TLS verification opt-out (insecure)', () => {
  const savedEnv = {
    QWEN_TLS_INSECURE: process.env['QWEN_TLS_INSECURE'],
    NODE_TLS_REJECT_UNAUTHORIZED: process.env['NODE_TLS_REJECT_UNAUTHORIZED'],
  };

  beforeEach(() => {
    resetDispatcherCache();
    delete process.env['QWEN_TLS_INSECURE'];
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const noProxyConnect = () =>
    getDispatcherOptions(buildRuntimeFetchOptions('openai'))?.['connect'];
  const noVerify = { rejectUnauthorized: false };

  it('does not set connect options on the no-proxy Agent by default', () => {
    expect(noProxyConnect()).toBeUndefined();
  });

  it('disables verification on the no-proxy Agent via QWEN_TLS_INSECURE', () => {
    process.env['QWEN_TLS_INSECURE'] = '1';
    expect(noProxyConnect()).toEqual(noVerify);
  });

  it('honors NODE_TLS_REJECT_UNAUTHORIZED=0 for parity', () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    expect(noProxyConnect()).toEqual(noVerify);
  });

  it('ignores falsy QWEN_TLS_INSECURE values', () => {
    process.env['QWEN_TLS_INSECURE'] = '0';
    expect(noProxyConnect()).toBeUndefined();
  });

  it('configures TLS opt-out for direct and proxied requests', () => {
    process.env['QWEN_TLS_INSECURE'] = '1';
    const { options } = getOrCreateSharedDispatcher(
      'http://proxy.local',
    ) as unknown as { options: UndiciOptions };
    expect(options['requestTls']).toEqual(noVerify);
    expect(options['proxyTls']).toEqual(noVerify);
    expect(options['connect']).toEqual(noVerify);
  });

  it('keeps secure and insecure dispatchers in separate cache entries', () => {
    const secure = getOrCreateSharedDispatcher('http://proxy.local');
    process.env['QWEN_TLS_INSECURE'] = '1';
    const insecure = getOrCreateSharedDispatcher('http://proxy.local');
    expect(secure).not.toBe(insecure);
  });

  describe('isTlsVerificationDisabled', () => {
    it.each(['1', 'true', 'TRUE', 'Yes', 'on', '  1  '])(
      'treats QWEN_TLS_INSECURE=%j as enabled',
      (value) => {
        process.env['QWEN_TLS_INSECURE'] = value;
        expect(isTlsVerificationDisabled()).toBe(true);
      },
    );

    it.each(['0', 'false', 'no', 'off', '', 'enabled'])(
      'treats QWEN_TLS_INSECURE=%j as disabled',
      (value) => {
        process.env['QWEN_TLS_INSECURE'] = value;
        expect(isTlsVerificationDisabled()).toBe(false);
      },
    );

    it('honors NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      expect(isTlsVerificationDisabled()).toBe(true);
    });

    it('ignores NODE_TLS_REJECT_UNAUTHORIZED values other than "0"', () => {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
      expect(isTlsVerificationDisabled()).toBe(false);
    });

    it('returns false when neither variable is set', () => {
      expect(isTlsVerificationDisabled()).toBe(false);
    });
  });
});

describe('redactProxyCredentials', () => {
  it.each([
    [
      'redacts credentials from a single proxy URL',
      'Failed to connect: http://user:secret@proxy.local',
      'Failed to connect: http://<redacted>@proxy.local',
    ],
    [
      'redacts every credential occurrence in a multi-URL error message',
      'Failed: http://a:b@p1; cause: http://c:d@p2',
      'Failed: http://<redacted>@p1; cause: http://<redacted>@p2',
    ],
    [
      'does not over-redact non-userinfo @ characters past the hostname',
      'http://user:pass@proxy.local/contact@example.com',
      'http://<redacted>@proxy.local/contact@example.com',
    ],
    [
      'redacts credentials in Node.js native error format (no scheme)',
      'connect ECONNREFUSED user:pass@proxy.local:8080',
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    ],
    [
      'redacts token-only credentials in Node.js native error format',
      'connect ECONNREFUSED token@proxy.local:8080',
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    ],
    [
      'redacts token-only credentials for localhost proxy endpoints',
      'connect ECONNREFUSED token@localhost:8080',
      'connect ECONNREFUSED <redacted>@localhost:8080',
    ],
    [
      'redacts token-only credentials for IP proxy endpoints',
      'connect ECONNREFUSED token@10.0.0.5:8080',
      'connect ECONNREFUSED <redacted>@10.0.0.5:8080',
    ],
    [
      'redacts token-only credentials for corporate proxy endpoints',
      'connect ECONNREFUSED token@gateway.corp.local:8080',
      'connect ECONNREFUSED <redacted>@gateway.corp.local:8080',
    ],
    [
      'redacts token-only credentials for public hosts in network error context',
      'connect ECONNREFUSED token@public.example.com:8080',
      'connect ECONNREFUSED <redacted>@public.example.com:8080',
    ],
    [
      'redacts bare credentials when the password contains colons',
      'connect ECONNREFUSED user:pass:word@proxy.local:8080',
      'connect ECONNREFUSED <redacted>@proxy.local:8080',
    ],
    [
      'preserves labels and delimiters around bare proxy credentials',
      'cause=(user:pass@proxy.local:8080)',
      'cause=(<redacted>@proxy.local:8080)',
    ],
  ])('%s', (_title, msg, redacted) => {
    expect(redactProxyCredentials(msg)).toBe(redacted);
  });

  it.each([
    [
      'preserves messages without proxy URLs unchanged',
      'Network timeout occurred',
    ],
    [
      'does not redact ordinary email addresses',
      'Contact support@example.com or set email=user@example.com',
    ],
    [
      'does not redact SSH-style host and port strings',
      'ssh failed for git@github.com:22',
    ],
    [
      'does not redact email-like strings followed by numeric suffixes',
      'see user@example.com:42 for line reference',
    ],
    [
      'does not redact email-like strings followed by larger line numbers',
      'see user@example.com:123 for line reference',
    ],
    [
      'does not redact email-like strings near ordinary request prose',
      'request mentions user@example.com:123 in prose',
    ],
    [
      'does not redact email-like strings near ordinary fetch prose',
      'fetch the owner from user@example.local:123',
    ],
  ])('%s', (_title, msg) => {
    expect(redactProxyCredentials(msg)).toBe(msg);
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
  const TOKEN_MSG = 'connect ECONNREFUSED token@proxy.local:8080';
  const REDACTED_TOKEN_MSG = 'connect ECONNREFUSED <redacted>@proxy.local:8080';
  const makeReadOnly = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, {
      value,
      writable: false,
      configurable: false,
    });

  it('redacts proxy credentials from Error message and stack in-place', () => {
    const error = new Error(TOKEN_MSG);
    error.stack = `Error: ${TOKEN_MSG}\n    at test`;

    expect(redactProxyError(error)).toBe(error);
    expect(error.message).toBe(REDACTED_TOKEN_MSG);
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

    expect(redactProxyError(error)).toBe(error);
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
    const error = new Error(TOKEN_MSG) as Error & { cause?: unknown };
    error.cause = error;

    expect(() => redactProxyError(error)).not.toThrow();
    expect(error.message).toBe(REDACTED_TOKEN_MSG);
    expect(error.cause).toBe(error);
  });

  it('returns a redacted clone when an error-like object has read-only fields', () => {
    const error: { message?: string; stack?: string } = {};
    makeReadOnly(error, 'message', TOKEN_MSG);
    Object.defineProperty(error, 'status', { value: 407, enumerable: true });

    const result = redactProxyError(error) as {
      message?: string;
      status?: number;
    };

    expect(result).not.toBe(error);
    expect(result.message).toBe(REDACTED_TOKEN_MSG);
    expect(result.status).toBe(407);
    expect(error.message).toBe(TOKEN_MSG);
  });

  it('preserves Error subclass prototype when cloning read-only fields', () => {
    class ProxySdkError extends Error {
      status = 407;
    }

    const error = new ProxySdkError(TOKEN_MSG);
    makeReadOnly(error, 'message', error.message);

    const result = redactProxyError(error) as ProxySdkError;

    expect(result).not.toBe(error);
    expect(result).toBeInstanceOf(ProxySdkError);
    expect(result.status).toBe(407);
    expect(result.message).toBe(REDACTED_TOKEN_MSG);
  });

  it('keeps read-only circular causes on the redacted clone', () => {
    class ProxySdkError extends Error {
      status = 407;
      override cause?: unknown;
    }

    const error = new ProxySdkError(TOKEN_MSG);
    makeReadOnly(error, 'message', error.message);
    makeReadOnly(error, 'cause', error);

    const result = redactProxyError(error) as ProxySdkError;

    expect(result).not.toBe(error);
    expect(result).toBeInstanceOf(ProxySdkError);
    expect(result.status).toBe(407);
    expect(result.message).toBe(REDACTED_TOKEN_MSG);
    expect(result.cause).toBe(result);
    expect((result.cause as Error).message).not.toContain('token@');
  });

  it('redacts nested AggregateError errors', () => {
    const nestedError = new Error(TOKEN_MSG);
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
    expect(redactedNestedError.message).toBe(REDACTED_TOKEN_MSG);
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

describe('requireUndici guard', () => {
  it('throws an actionable error when a sync builder runs before preload', async () => {
    vi.resetModules();
    const fresh = await import('./runtimeFetchOptions.js');
    expect(() =>
      fresh.getOrCreateSharedDispatcher('http://proxy.local'),
    ).toThrow(/undici is not loaded yet; await preloadRuntimeFetchModule\(\)/);
  });
});
