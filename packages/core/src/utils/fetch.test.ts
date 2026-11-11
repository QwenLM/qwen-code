/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterAll,
  afterEach,
} from 'vitest';
import * as dnsPromises from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { ENV_AGENT_SDK_ENTRYPOINT } from '../config/brand.js';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import ipaddr from 'ipaddr.js';

const {
  setGlobalDispatcher,
  Agent,
  Pool,
  ProxyAgent,
  buildConnector,
  getCertificateAuthorities,
  mockUndiciFetch,
  mockUndiciRequest,
} = vi.hoisted(() => ({
  setGlobalDispatcher: vi.fn(),
  Agent: vi.fn(),
  Pool: vi.fn(),
  ProxyAgent: vi.fn(),
  buildConnector: vi.fn(() => vi.fn()),
  getCertificateAuthorities: vi.fn<
    () => readonly string[] | undefined
  >(() => undefined),
  mockUndiciFetch: vi.fn(),
  mockUndiciRequest: vi.fn(),
}));

vi.mock('undici/index.js', () => ({
  setGlobalDispatcher,
  Agent,
  Pool,
  ProxyAgent,
  buildConnector,
  fetch: mockUndiciFetch,
  request: mockUndiciRequest,
}));

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

vi.mock('./certificate-store.js', () => ({
  getCertificateAuthorities,
}));

// Import after mocks are established
const {
  isPrivateIp,
  isPrivateIpAsync,
  isGlobalProxyActiveForUrl,
  isProxyActiveForUrl,
  getProxyFromEnvironment,
  resolveProxyFromEnvironment,
  shouldBypassProxy,
  isAddressPrivate,
  fetchWithResolvedIp,
  fetchWithTimeout,
  unmanagedRequest,
  unmanagedStreamRequest,
  proxiedFetch,
  createSafeProxyAgent,
  wrapResponseBodyWithCleanup,
  setGlobalProxy,
  clearGlobalProxy,
  withFetchTimeouts,
  createRequestScopedDispatcher,
  _resetProxyForTesting,
  _resetBunRuntimeCacheForTesting,
} = await import('./fetch.js');

// Mock global fetch
const originalFetch = global.fetch;
const originalBun = (globalThis as { Bun?: unknown }).Bun;
const originalHttpsProxy = process.env['HTTPS_PROXY'];
const originalNoProxy = process.env['NO_PROXY'];
const originalNoProxyLower = process.env['no_proxy'];
const originalSdkEntrypoint = process.env[ENV_AGENT_SDK_ENTRYPOINT];
global.fetch = vi.fn();

interface ErrorWithCode extends Error {
  code?: string;
}

function undiciResponse(
  body: string | Buffer | Readable | null,
  init: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string | string[]>;
  } = {},
) {
  return {
    statusCode: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: init.headers ?? {},
    body:
      body instanceof Readable
        ? body
        : Readable.from(
            body === null
              ? []
              : [typeof body === 'string' ? Buffer.from(body) : body],
          ),
    trailers: {},
    opaque: null,
    context: {},
  };
}

/**
 * Collect process-level uncaught exceptions raised while `run()` executes,
 * draining one tick afterwards so a stream's deferred `'error'` emission lands
 * before the caller asserts on the result.
 */
async function captureUncaughtExceptions(
  run: () => Promise<void>,
): Promise<unknown[]> {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    await run();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  return uncaught;
}

describe('fetch utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Agent).mockReset();
    vi.mocked(Pool).mockReset();
    vi.mocked(ProxyAgent).mockReset();
    vi.mocked(buildConnector).mockReset();
    vi.mocked(buildConnector).mockReturnValue(vi.fn());
    vi.mocked(getCertificateAuthorities).mockReset();
    vi.mocked(getCertificateAuthorities).mockReturnValue(undefined);
    vi.mocked(mockUndiciFetch).mockReset();
    vi.mocked(mockUndiciRequest).mockReset();
    _resetProxyForTesting();
    _resetBunRuntimeCacheForTesting();
    delete process.env['NO_PROXY'];
    delete process.env['no_proxy'];
    delete process.env[ENV_AGENT_SDK_ENTRYPOINT];
    if (originalBun === undefined) {
      delete (globalThis as { Bun?: unknown }).Bun;
    } else {
      (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
    // Default DNS lookup to return a public IP, or the IP itself if valid
    vi.mocked(
      dnsPromises.lookup as (
        hostname: string,
        options: LookupAllOptions,
      ) => Promise<LookupAddress[]>,
    ).mockImplementation(async (hostname: string) => {
      if (ipaddr.isValid(hostname)) {
        return [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }];
      }
      return [{ address: '93.184.216.34', family: 4 }];
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetProxyForTesting();
    _resetBunRuntimeCacheForTesting();
    if (originalNoProxy === undefined) {
      delete process.env['NO_PROXY'];
    } else {
      process.env['NO_PROXY'] = originalNoProxy;
    }
    if (originalNoProxyLower === undefined) {
      delete process.env['no_proxy'];
    } else {
      process.env['no_proxy'] = originalNoProxyLower;
    }
    if (originalHttpsProxy === undefined) {
      delete process.env['HTTPS_PROXY'];
    } else {
      process.env['HTTPS_PROXY'] = originalHttpsProxy;
    }
    if (originalSdkEntrypoint === undefined) {
      delete process.env[ENV_AGENT_SDK_ENTRYPOINT];
    } else {
      process.env[ENV_AGENT_SDK_ENTRYPOINT] = originalSdkEntrypoint;
    }
  });

  describe('SDK proxy environment inheritance', () => {
    it('uses proxy and bypass variables inherited by an SDK child process', () => {
      process.env[ENV_AGENT_SDK_ENTRYPOINT] = 'sdk-ts';
      process.env['HTTPS_PROXY'] = 'http://environment-proxy.test:8080';
      process.env['NO_PROXY'] = 'example.com';

      expect(getProxyFromEnvironment()).toBe(
        'http://environment-proxy.test:8080',
      );
      expect(resolveProxyFromEnvironment()).toEqual({
        proxy: 'http://environment-proxy.test:8080',
        source: 'HTTPS_PROXY',
      });
      expect(shouldBypassProxy(new URL('https://example.com'))).toBe(true);
    });
  });

  describe('createRequestScopedDispatcher', () => {
    const timeouts = {
      connectTimeoutMs: 30_000,
      headersTimeoutMs: 600_000,
      bodyTimeoutMs: 60_000,
    };

    it('creates a fresh direct dispatcher with Core TLS and timeout options', () => {
      const firstAgent = { kind: 'first-direct' };
      const secondAgent = { kind: 'second-direct' };
      const connector = vi.fn();
      vi.mocked(Agent)
        .mockReturnValueOnce(firstAgent)
        .mockReturnValueOnce(secondAgent);
      vi.mocked(buildConnector).mockReturnValue(connector);
      vi.mocked(getCertificateAuthorities).mockReturnValue(['test-ca']);

      const first = createRequestScopedDispatcher(
        new URL('https://oss.example.test/object'),
        timeouts,
      );
      const second = createRequestScopedDispatcher(
        new URL('https://oss.example.test/object'),
        timeouts,
      );

      expect(first).toBe(firstAgent);
      expect(second).toBe(secondAgent);
      expect(first).not.toBe(second);
      expect(Agent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          headersTimeout: 600_000,
          bodyTimeout: 60_000,
          keepAliveTimeout: 55_000,
          keepAliveMaxTimeout: 60_000,
          connect: expect.any(Function),
        }),
      );
      expect(buildConnector).toHaveBeenLastCalledWith({
        keepAlive: true,
        keepAliveInitialDelay: 15_000,
        ca: ['test-ca'],
        timeout: 30_000,
      });
    });

    it('uses the active proxy unless NO_PROXY bypasses the target', () => {
      const globalProxy = { kind: 'global-proxy', close: vi.fn() };
      const proxiedDispatcher = { kind: 'proxied' };
      const directDispatcher = { kind: 'direct' };
      vi.mocked(ProxyAgent)
        .mockReturnValueOnce(globalProxy)
        .mockReturnValueOnce(proxiedDispatcher);
      vi.mocked(Agent).mockReturnValue(directDispatcher);

      setGlobalProxy('http://proxy.example.test:8080');
      const proxied = createRequestScopedDispatcher(
        new URL('https://oss.example.test/object'),
        timeouts,
      );
      process.env['NO_PROXY'] = 'oss.example.test';
      const bypassed = createRequestScopedDispatcher(
        new URL('https://oss.example.test/object'),
        timeouts,
      );

      expect(proxied).toBe(proxiedDispatcher);
      expect(bypassed).toBe(directDispatcher);
      expect(ProxyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          uri: 'http://proxy.example.test:8080',
          headersTimeout: 600_000,
          bodyTimeout: 60_000,
        }),
      );
    });

    it('uses Bun-compatible HTTP/1.1 options for direct dispatchers', () => {
      const dispatcher = { kind: 'bun-direct' };
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(Agent).mockReturnValue(dispatcher);

      const result = createRequestScopedDispatcher(
        new URL('https://oss.example.test/object'),
        timeouts,
      );

      expect(result).toBe(dispatcher);
      expect(Agent).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowH2: false }),
      );
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalBun === undefined) {
      delete (globalThis as { Bun?: unknown }).Bun;
    } else {
      (globalThis as { Bun?: unknown }).Bun = originalBun;
    }
  });

  describe('isAddressPrivate', () => {
    it('should identify private IPv4 addresses', () => {
      expect(isAddressPrivate('10.0.0.1')).toBe(true);
      expect(isAddressPrivate('127.0.0.1')).toBe(true);
      expect(isAddressPrivate('172.16.0.1')).toBe(true);
      expect(isAddressPrivate('192.168.1.1')).toBe(true);
    });

    it('should identify non-routable and reserved IPv4 addresses (RFC 6890)', () => {
      expect(isAddressPrivate('0.0.0.0')).toBe(true);
      expect(isAddressPrivate('100.64.0.1')).toBe(true);
      expect(isAddressPrivate('192.0.0.1')).toBe(true);
      expect(isAddressPrivate('192.0.2.1')).toBe(true);
      expect(isAddressPrivate('192.88.99.1')).toBe(true);
      // Benchmark range (198.18.0.0/15)
      expect(isAddressPrivate('198.18.0.0')).toBe(true);
      expect(isAddressPrivate('198.18.0.1')).toBe(true);
      expect(isAddressPrivate('198.19.255.255')).toBe(true);
      expect(isAddressPrivate('198.51.100.1')).toBe(true);
      expect(isAddressPrivate('203.0.113.1')).toBe(true);
      expect(isAddressPrivate('224.0.0.1')).toBe(true);
      expect(isAddressPrivate('240.0.0.1')).toBe(true);
    });

    it('should identify private IPv6 addresses', () => {
      expect(isAddressPrivate('::1')).toBe(true);
      expect(isAddressPrivate('fc00::')).toBe(true);
      expect(isAddressPrivate('fd00::')).toBe(true);
      expect(isAddressPrivate('fe80::')).toBe(true);
      expect(isAddressPrivate('febf::')).toBe(true);
    });

    it('should identify special local addresses', () => {
      expect(isAddressPrivate('0.0.0.0')).toBe(true);
      expect(isAddressPrivate('::')).toBe(true);
      expect(isAddressPrivate('localhost')).toBe(true);
    });

    it('should identify link-local addresses', () => {
      expect(isAddressPrivate('169.254.169.254')).toBe(true);
    });

    it('should identify IPv4-mapped IPv6 private addresses', () => {
      expect(isAddressPrivate('::ffff:127.0.0.1')).toBe(true);
      expect(isAddressPrivate('::ffff:10.0.0.1')).toBe(true);
      expect(isAddressPrivate('::ffff:169.254.169.254')).toBe(true);
      expect(isAddressPrivate('::ffff:192.168.1.1')).toBe(true);
      expect(isAddressPrivate('::ffff:172.16.0.1')).toBe(true);
      expect(isAddressPrivate('::ffff:0.0.0.0')).toBe(true);
      expect(isAddressPrivate('::ffff:100.64.0.1')).toBe(true);
      expect(isAddressPrivate('::ffff:a9fe:101')).toBe(true); // 169.254.1.1
    });

    it('should identify public addresses as non-private', () => {
      expect(isAddressPrivate('8.8.8.8')).toBe(false);
      expect(isAddressPrivate('93.184.216.34')).toBe(false);
      expect(isAddressPrivate('2001:4860:4860::8888')).toBe(false);
      expect(isAddressPrivate('::ffff:8.8.8.8')).toBe(false);
    });
  });

  describe('isPrivateIp', () => {
    it('should identify private IPs in URLs', () => {
      expect(isPrivateIp('http://10.0.0.1/')).toBe(true);
      expect(isPrivateIp('https://127.0.0.1:8080/')).toBe(true);
      expect(isPrivateIp('http://localhost/')).toBe(true);
      expect(isPrivateIp('http://[::1]/')).toBe(true);
    });

    it('should identify public IPs in URLs as non-private', () => {
      expect(isPrivateIp('http://8.8.8.8/')).toBe(false);
      expect(isPrivateIp('https://google.com/')).toBe(false);
    });
  });

  describe('isPrivateIpAsync', () => {
    it('should identify private IPs directly', async () => {
      expect(await isPrivateIpAsync('http://10.0.0.1/')).toBe(true);
    });

    it('should identify domains resolving to private IPs', async () => {
      vi.mocked(
        dnsPromises.lookup as (
          hostname: string,
          options: LookupAllOptions,
        ) => Promise<LookupAddress[]>,
      ).mockImplementation(async () => [{ address: '10.0.0.1', family: 4 }]);
      expect(await isPrivateIpAsync('http://malicious.com/')).toBe(true);
    });

    it('should identify domains resolving to public IPs as non-private', async () => {
      vi.mocked(
        dnsPromises.lookup as (
          hostname: string,
          options: LookupAllOptions,
        ) => Promise<LookupAddress[]>,
      ).mockImplementation(async () => [{ address: '8.8.8.8', family: 4 }]);
      expect(await isPrivateIpAsync('http://google.com/')).toBe(false);
    });

    it('should throw error if DNS resolution fails (fail closed)', async () => {
      vi.mocked(dnsPromises.lookup).mockRejectedValue(new Error('DNS Error'));
      await expect(isPrivateIpAsync('http://unreachable.com/')).rejects.toThrow(
        'Failed to verify if URL resolves to private IP',
      );
    });

    it('should return false for invalid URLs instead of throwing verification error', async () => {
      expect(await isPrivateIpAsync('not-a-url')).toBe(false);
    });
  });

  describe('isProxyActiveForUrl', () => {
    it('requires a configured proxy and an HTTP(S) target', () => {
      expect(
        isProxyActiveForUrl(undefined, new URL('https://example.com/path')),
      ).toBe(false);
      expect(
        isProxyActiveForUrl(
          'http://proxy.example:8080',
          new URL('https://example.com/path'),
        ),
      ).toBe(true);
      expect(
        isProxyActiveForUrl(
          'http://proxy.example:8080',
          new URL('ftp://example.com/path'),
        ),
      ).toBe(false);
    });

    it('returns false when NO_PROXY matches the target', () => {
      process.env['NO_PROXY'] = 'example.com';
      expect(
        isProxyActiveForUrl(
          'http://proxy.example:8080',
          new URL('https://api.example.com/path'),
        ),
      ).toBe(false);
    });

    it('reflects the shared proxy route used by unmanaged requests', () => {
      const target = new URL('https://approval.internal/hook');

      expect(isGlobalProxyActiveForUrl(target)).toBe(false);
      setGlobalProxy('http://proxy.example:8080');
      expect(isGlobalProxyActiveForUrl(target)).toBe(true);

      process.env['NO_PROXY'] = 'approval.internal';
      expect(isGlobalProxyActiveForUrl(target)).toBe(false);
    });
  });

  describe('fetchWithTimeout', () => {
    it('should handle timeouts', async () => {
      vi.mocked(global.fetch).mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                const error = new Error(
                  'The operation was aborted',
                ) as ErrorWithCode;
                error.name = 'AbortError';
                error.code = 'ABORT_ERR';
                reject(error);
              });
            }
          }),
      );

      await expect(fetchWithTimeout('http://example.com', 50)).rejects.toThrow(
        'Request timed out after 50ms',
      );
    });

    it('distinguishes caller cancellation from a timeout', async () => {
      vi.mocked(global.fetch).mockImplementation(
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );
      const controller = new AbortController();
      const request = fetchWithTimeout('http://example.com', 10_000, {
        signal: controller.signal,
      });

      controller.abort();

      await expect(request).rejects.toMatchObject({
        code: 'ABORT_ERR',
        message: 'Request was aborted',
      });
    });
  });

  describe('setGlobalProxy', () => {
    it('uses the resolved CA collection for direct and proxy TLS', () => {
      vi.mocked(getCertificateAuthorities).mockReturnValue([
        'bundled-ca',
        'system-ca',
      ]);
      vi.mocked(buildConnector).mockClear();

      _resetProxyForTesting();

      expect(buildConnector).toHaveBeenLastCalledWith(
        expect.objectContaining({
          ca: ['bundled-ca', 'system-ca'],
        }),
      );

      setGlobalProxy('http://proxy.example.com');

      expect(ProxyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          proxyTls: expect.objectContaining({
            ca: ['bundled-ca', 'system-ca'],
          }),
          requestTls: expect.objectContaining({
            ca: ['bundled-ca', 'system-ca'],
          }),
        }),
      );
    });

    it('should configure ProxyAgent with the default 300s timeout', () => {
      const proxyUrl = 'http://proxy.example.com';
      setGlobalProxy(proxyUrl);

      expect(ProxyAgent).toHaveBeenCalledWith({
        uri: proxyUrl,
        headersTimeout: 300_000,
        bodyTimeout: 300_000,
        keepAliveTimeout: 55000,
        keepAliveMaxTimeout: 60000,
        maxHeaderSize: 16384,
        proxyTls: expect.objectContaining({ keepAlive: true }),
        requestTls: expect.objectContaining({ keepAlive: true }),
      });
      const options = vi.mocked(ProxyAgent).mock.calls.at(-1)?.[0] as {
        allowH2?: boolean;
        proxyTls?: { allowH2?: boolean };
        requestTls?: { allowH2?: boolean };
      };
      expect(options).not.toHaveProperty('allowH2');
      expect(options.proxyTls).not.toHaveProperty('allowH2');
      expect(options.requestTls).not.toHaveProperty('allowH2');
    });

    it('disables npm undici HTTP/2 for safe proxy agents in Bun', () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      createSafeProxyAgent('http://proxy.example.com');

      expect(ProxyAgent).toHaveBeenLastCalledWith({
        uri: 'http://proxy.example.com',
        keepAliveTimeout: 55_000,
        keepAliveMaxTimeout: 60_000,
        allowH2: false,
        maxHeaderSize: 16_384,
        proxyTls: expect.objectContaining({
          keepAlive: true,
          allowH2: false,
        }),
        requestTls: expect.objectContaining({
          keepAlive: true,
          allowH2: false,
        }),
      });
    });

    it('should pass SOCKS5 proxy URLs to undici ProxyAgent outside Bun', () => {
      const proxyUrl = 'socks5://proxy.example.com:1080';

      setGlobalProxy(proxyUrl);

      expect(ProxyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          uri: proxyUrl,
        }),
      );
    });

    it('should normalize SOCKS5H proxy URLs before creating ProxyAgent outside Bun', () => {
      setGlobalProxy('socks5h://proxy.example.com:1080');

      expect(ProxyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          uri: 'socks5://proxy.example.com:1080',
        }),
      );
    });

    it('does not retain proxy state when ProxyAgent construction fails', async () => {
      const proxyUrl = 'http://proxy.example.com';
      vi.mocked(ProxyAgent).mockImplementationOnce(() => {
        throw new TypeError('Invalid proxy URL');
      });
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));

      expect(() => setGlobalProxy(proxyUrl)).toThrow('Invalid proxy URL');

      await proxiedFetch('https://example.com/path', { method: 'GET' });

      expect(global.fetch).toHaveBeenCalledWith('https://example.com/path', {
        method: 'GET',
      });
    });

    it('preserves the previous proxy state when a new proxy URL is unsupported', async () => {
      const proxyDispatcher = { kind: 'proxy' };
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy('http://proxy.example.com');

      expect(() => setGlobalProxy('socks4://proxy.example.com:1080')).toThrow(
        'proxy must use',
      );

      await proxiedFetch('https://example.com/path', { method: 'GET' });

      expect(mockUndiciFetch).toHaveBeenLastCalledWith(
        new URL('https://example.com/path'),
        expect.objectContaining({
          method: 'GET',
          dispatcher: proxyDispatcher,
        }),
      );
      expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('reinstalls the Bun global fetch proxy after clearing and re-enabling it', () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const nativeFetch = global.fetch;

      setGlobalProxy('http://first-proxy.example.com');
      expect(global.fetch).toBe(proxiedFetch);

      clearGlobalProxy();
      expect(global.fetch).toBe(nativeFetch);

      setGlobalProxy('http://second-proxy.example.com');
      expect(global.fetch).toBe(proxiedFetch);
    });

    it.each([
      'socks5://user:@proxy.example.com:1080',
      'socks5://:password@proxy.example.com:1080',
    ])(
      'rejects incomplete Bun SOCKS5 credentials without replacing the active proxy: %s',
      async (invalidProxyUrl) => {
        (globalThis as { Bun?: unknown }).Bun = {};
        _resetBunRuntimeCacheForTesting();
        vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
        const nativeFetch = global.fetch;
        const activeProxyUrl = 'http://active-proxy.example.com:8080';

        setGlobalProxy(activeProxyUrl);

        expect(() => setGlobalProxy(invalidProxyUrl)).toThrow(
          'SOCKS5 proxy credentials must include both a non-empty username and password',
        );

        await proxiedFetch('https://example.com/path', { method: 'GET' });

        expect(global.fetch).toBe(proxiedFetch);
        expect(nativeFetch).toHaveBeenLastCalledWith(
          'https://example.com/path',
          {
            method: 'GET',
            proxy: activeProxyUrl,
          },
        );
      },
    );
  });

  describe('proxiedFetch', () => {
    it('passes the per-request connect timeout to the Node connector', async () => {
      const timeoutDispatcher = { kind: 'connect-timeout', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(timeoutDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { connectTimeoutMs: 1234, requestTimeoutMs: 10_000 },
        ),
      );

      expect(buildConnector).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout: 1234 }),
      );
    });

    it('uses shared bounded semantics for unmanaged requests', async () => {
      const timeoutDispatcher = { kind: 'unmanaged', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(timeoutDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      await unmanagedRequest(
        'https://example.com/path',
        { method: 'GET' },
        { timeoutMs: 5000, connectTimeoutMs: 750 },
      );

      expect(buildConnector).toHaveBeenLastCalledWith(
        expect.objectContaining({ timeout: 750 }),
      );
      expect(mockUndiciFetch).toHaveBeenLastCalledWith(
        new URL('https://example.com/path'),
        expect.objectContaining({
          method: 'GET',
          signal: expect.any(AbortSignal),
          dispatcher: timeoutDispatcher,
        }),
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('keeps unmanaged stream bodies open after response headers', async () => {
      const streamDispatcher = { kind: 'stream', close: vi.fn() };
      const caller = new AbortController();
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      vi.mocked(Agent).mockReturnValue(streamDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      try {
        await unmanagedStreamRequest(
          'https://example.com/path',
          { method: 'GET', signal: caller.signal },
          { connectTimeoutMs: 750, responseHeadersTimeoutMs: 5000 },
        );

        expect(timeoutSpy).not.toHaveBeenCalled();
        expect(Agent).toHaveBeenLastCalledWith(
          expect.objectContaining({ headersTimeout: 5000, bodyTimeout: 0 }),
        );
        expect(mockUndiciFetch).toHaveBeenLastCalledWith(
          new URL('https://example.com/path'),
          expect.objectContaining({
            method: 'GET',
            signal: caller.signal,
            dispatcher: streamDispatcher,
          }),
        );
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it.each([
      { runtime: 'Node', bun: false },
      { runtime: 'Bun', bun: true },
    ])(
      'prefers the total timeout reason over a response error on $runtime',
      async ({ bun }) => {
        if (bun) {
          (globalThis as { Bun?: unknown }).Bun = {};
        } else {
          delete (globalThis as { Bun?: unknown }).Bun;
        }
        _resetBunRuntimeCacheForTesting();

        const total = new AbortController();
        const timeoutReason = new DOMException(
          'Request timed out after 60000ms',
          'TimeoutError',
        );
        const socketError = Object.assign(new Error('socket closed'), {
          code: 'ECONNRESET',
        });
        const timeoutSpy = vi
          .spyOn(AbortSignal, 'timeout')
          .mockReturnValue(total.signal);
        const rejectWithSocketError = async () => {
          total.abort(timeoutReason);
          throw socketError;
        };
        if (bun) {
          vi.mocked(global.fetch).mockImplementation(rejectWithSocketError);
        } else {
          vi.mocked(mockUndiciFetch).mockImplementation(rejectWithSocketError);
        }

        try {
          await expect(
            unmanagedRequest(
              'https://example.com/path',
              { method: 'GET' },
              { timeoutMs: 60_000 },
            ),
          ).rejects.toBe(timeoutReason);
        } finally {
          timeoutSpy.mockRestore();
        }
      },
    );

    it('preserves a response error when the effective signal is active', async () => {
      const networkError = new Error('TLS handshake failed');
      vi.mocked(mockUndiciFetch).mockRejectedValue(networkError);

      await expect(
        unmanagedRequest(
          'https://example.com/path',
          { method: 'GET' },
          { timeoutMs: 60_000 },
        ),
      ).rejects.toBe(networkError);
    });

    it('returns validation failures as rejected promises', async () => {
      const request = unmanagedRequest(
        'https://example.com/path',
        { method: 'GET' },
        { timeoutMs: 0 },
      );

      await expect(request).rejects.toThrow(RangeError);
    });

    it('combines unmanaged cancellation without AbortSignal.any', async () => {
      const originalAny = AbortSignal.any;
      Object.defineProperty(AbortSignal, 'any', {
        configurable: true,
        value: undefined,
      });
      const caller = new AbortController();
      vi.mocked(mockUndiciFetch).mockImplementation(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(init.signal?.reason),
              { once: true },
            );
          }),
      );

      try {
        const request = unmanagedRequest(
          'https://example.com/path',
          { method: 'GET', signal: caller.signal },
          { timeoutMs: 5000 },
        );
        caller.abort(new DOMException('caller stopped', 'AbortError'));

        await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      } finally {
        Object.defineProperty(AbortSignal, 'any', {
          configurable: true,
          value: originalAny,
        });
      }
    });

    it('enforces the response-header limit on Bun native fetch paths', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(global.fetch).mockResolvedValue(
        new Response('body', {
          headers: { 'x-large': 'x'.repeat(16_384) },
        }),
      );

      await expect(
        proxiedFetch('https://example.com/path'),
      ).rejects.toMatchObject({
        name: 'ProtocolLimitError',
        code: 'protocol_limit',
        phase: 'protocol',
        limitKind: 'http_response_headers',
        limitBytes: 16_384,
      });
    });

    it('uses a per-request timeout dispatcher outside Bun', async () => {
      const timeoutDispatcher = { kind: 'timeout', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(timeoutDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts({ method: 'GET' }, { requestTimeoutMs: 600000 }),
      );

      expect(response.status).toBe(200);
      expect(Agent).toHaveBeenCalledWith({
        headersTimeout: 600000,
        bodyTimeout: 600000,
        keepAliveTimeout: 55000,
        keepAliveMaxTimeout: 60000,
        maxHeaderSize: 16384,
        connect: expect.any(Function),
      });
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://example.com/path'),
        {
          method: 'GET',
          dispatcher: timeoutDispatcher,
        },
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('passes explicit zero to undici to disable the stream body timeout', async () => {
      const streamDispatcher = { kind: 'stream', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(streamDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { connectTimeoutMs: 10_000, bodyIdleTimeoutMs: 0 },
        ),
      );

      expect(Agent).toHaveBeenLastCalledWith({
        headersTimeout: expect.any(Number),
        bodyTimeout: 0,
        keepAliveTimeout: 55_000,
        keepAliveMaxTimeout: 60_000,
        maxHeaderSize: 16_384,
        connect: expect.any(Function),
      });
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://example.com/path'),
        expect.objectContaining({ dispatcher: streamDispatcher }),
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rounds fractional fetch timeouts before creating Node dispatchers', async () => {
      const timeoutDispatcher = { kind: 'timeout', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(timeoutDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1000.1, bodyIdleTimeoutMs: 50.1 },
        ),
      );

      expect(Agent).toHaveBeenCalledWith({
        headersTimeout: 1001,
        bodyTimeout: 51,
        keepAliveTimeout: 55000,
        keepAliveMaxTimeout: 60000,
        maxHeaderSize: 16384,
        connect: expect.any(Function),
      });
    });

    it('applies body idle timeout to Bun direct native fetch responses', async () => {
      vi.useFakeTimers();
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              /* keep body open without chunks */
            },
          }),
        ),
      );

      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1000, bodyIdleTimeoutMs: 50 },
        ),
      );
      const textPromise = response.text();
      const rejection = textPromise.then(
        () => {
          throw new Error('Expected response text to reject');
        },
        (error: unknown) => {
          expect(error).toMatchObject({
            name: 'TimeoutError',
            message: 'Response body idle timeout after 50ms',
          });
        },
      );

      await vi.advanceTimersByTimeAsync(51);

      await rejection;
    });

    it('does not synthesize a Bun body timer when idle timeout is zero', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const nativeResponse = new Response(
        new ReadableStream<Uint8Array>({
          start() {
            /* keep body open without chunks */
          },
        }),
      );
      vi.mocked(global.fetch).mockResolvedValue(nativeResponse);

      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { connectTimeoutMs: 10_000, bodyIdleTimeoutMs: 0 },
        ),
      );

      expect(response).toBe(nativeResponse);
    });

    it('clears the request timeout once Bun response headers arrive when body idle timeout is active', async () => {
      vi.useFakeTimers();
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      const encoder = new TextEncoder();
      let internalSignal: AbortSignal | undefined;
      let chunksSent = 0;
      vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
        internalSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              internalSignal?.addEventListener(
                'abort',
                () => {
                  controller.error(internalSignal?.reason);
                },
                { once: true },
              );
            },
            pull(controller) {
              return new Promise<void>((resolve) => {
                setTimeout(() => {
                  if (internalSignal?.aborted) {
                    controller.error(internalSignal.reason);
                    resolve();
                    return;
                  }
                  if (chunksSent >= 4) {
                    controller.close();
                  } else {
                    chunksSent++;
                    controller.enqueue(encoder.encode('x'));
                  }
                  resolve();
                }, 40);
              });
            },
          }),
        );
      });

      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 100, bodyIdleTimeoutMs: 50 },
        ),
      );

      const textPromise = response.text();
      await vi.advanceTimersByTimeAsync(220);

      await expect(textPromise).resolves.toBe('xxxx');
    });

    it('does not apply body idle timeout before the consumer starts reading', async () => {
      vi.useFakeTimers();
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      const encoder = new TextEncoder();
      let chunksSent = 0;
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (chunksSent === 0) {
                chunksSent++;
                controller.enqueue(encoder.encode('x'));
              }
            },
          }),
        ),
      );

      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1000, bodyIdleTimeoutMs: 50 },
        ),
      );

      await vi.advanceTimersByTimeAsync(51);

      const reader = response.body!.getReader();

      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: encoder.encode('x'),
      });
    });

    it('applies body idle timeout while the next body read is pending', async () => {
      vi.useFakeTimers();
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      const encoder = new TextEncoder();
      let chunksSent = 0;
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (chunksSent === 0) {
                chunksSent++;
                controller.enqueue(encoder.encode('x'));
                return;
              }
              return new Promise<void>(() => {});
            },
          }),
        ),
      );

      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1000, bodyIdleTimeoutMs: 50 },
        ),
      );
      const reader = response.body!.getReader();

      await expect(reader.read()).resolves.toMatchObject({
        done: false,
        value: encoder.encode('x'),
      });
      const pendingRead = reader.read();
      const rejection = pendingRead.then(
        () => {
          throw new Error('Expected reader read to reject');
        },
        (error: unknown) => {
          expect(error).toMatchObject({
            name: 'TimeoutError',
            message: 'Response body idle timeout after 50ms',
          });
        },
      );
      await vi.advanceTimersByTimeAsync(51);

      await rejection;
    });

    it('applies body idle timeout to Bun NO_PROXY bypass responses', async () => {
      vi.useFakeTimers();
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      process.env['NO_PROXY'] = 'example.com';
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              /* keep body open without chunks */
            },
          }),
        ),
      );

      setGlobalProxy(proxyUrl);
      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1000, bodyIdleTimeoutMs: 50 },
        ),
      );
      const textPromise = response.text();
      const rejection = textPromise.then(
        () => {
          throw new Error('Expected response text to reject');
        },
        (error: unknown) => {
          expect(error).toMatchObject({
            name: 'TimeoutError',
            message: 'Response body idle timeout after 50ms',
          });
        },
      );

      await vi.advanceTimersByTimeAsync(51);

      await rejection;
    });

    it('keeps upstream abort wired until a Bun timeout-wrapped body is consumed', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      let internalSignal: AbortSignal | undefined;
      vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
        internalSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              return new Promise<void>((_resolve, reject) => {
                internalSignal?.addEventListener(
                  'abort',
                  () => {
                    const reason =
                      internalSignal?.reason ??
                      new DOMException('Request aborted', 'AbortError');
                    controller.error(reason);
                    reject(reason);
                  },
                  { once: true },
                );
              });
            },
          }),
        );
      });

      const upstream = new AbortController();
      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET', signal: upstream.signal },
          { requestTimeoutMs: 1000 },
        ),
      );

      const textPromise = response.text();
      upstream.abort(new DOMException('User cancelled', 'AbortError'));

      await expect(textPromise).rejects.toMatchObject({
        name: 'AbortError',
        message: 'User cancelled',
      });
    });

    it('does not wait for the underlying body cancel before surfacing upstream abort', async () => {
      vi.useFakeTimers();
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      const cancel = vi.fn(() => new Promise<void>(() => {}));
      vi.mocked(global.fetch).mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => {});
            },
            cancel,
          }),
        ),
      );

      const upstream = new AbortController();
      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET', signal: upstream.signal },
          { requestTimeoutMs: 1000 },
        ),
      );
      const textPromise = response.text();
      const raced = Promise.race([
        textPromise.catch((error) => error),
        new Promise<'pending'>((resolve) =>
          setTimeout(() => resolve('pending'), 1),
        ),
      ]);

      upstream.abort(new DOMException('User cancelled', 'AbortError'));
      await vi.advanceTimersByTimeAsync(1);

      await expect(raced).resolves.toMatchObject({
        name: 'AbortError',
        message: 'User cancelled',
      });
      expect(cancel).toHaveBeenCalledWith(upstream.signal.reason);
    });

    it.each([
      {
        label: 'timeout',
        reason: new DOMException(
          'Request timed out after 60000ms',
          'TimeoutError',
        ),
      },
      {
        label: 'caller cancellation',
        reason: new DOMException('User cancelled', 'AbortError'),
      },
    ])(
      'prefers upstream $label over a competing body stream error',
      async ({ reason }) => {
        const upstream = new AbortController();
        const streamError = new Error('stream aborted');
        let sourceController:
          | ReadableStreamDefaultController<Uint8Array>
          | undefined;
        let markPullStarted: (() => void) | undefined;
        const pullStarted = new Promise<void>((resolve) => {
          markPullStarted = resolve;
        });
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sourceController = controller;
            },
            pull() {
              markPullStarted?.();
              return new Promise<void>(() => {});
            },
          }),
        );
        const cleanup = vi.fn();
        const wrapped = wrapResponseBodyWithCleanup(
          response,
          cleanup,
          upstream.signal,
        );

        const read = wrapped.body!.getReader().read();
        await pullStarted;
        sourceController!.error(streamError);
        upstream.abort(reason);

        await expect(read).rejects.toBe(reason);
        expect(cleanup).toHaveBeenCalledOnce();
      },
    );

    it('preserves a body stream error while the upstream signal is active', async () => {
      const upstream = new AbortController();
      const streamError = new Error('body read failed');
      let sourceController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            sourceController = controller;
          },
        }),
      );
      const cleanup = vi.fn();
      const wrapped = wrapResponseBodyWithCleanup(
        response,
        cleanup,
        upstream.signal,
      );

      const read = wrapped.body!.getReader().read();
      sourceController!.error(streamError);

      await expect(read).rejects.toBe(streamError);
      expect(cleanup).toHaveBeenCalledOnce();
    });

    it('cancels the body before aborting Bun fetch without waiting for cancellation', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.useFakeTimers();
      const upstream = new AbortController();
      const removeListener = vi.spyOn(upstream.signal, 'removeEventListener');
      let finishCancellation!: () => void;
      const cancel = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCancellation = resolve;
          }),
      );
      let internalSignal: AbortSignal | undefined;
      vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
        internalSignal = init!.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              internalSignal!.addEventListener(
                'abort',
                () => {
                  controller.error(internalSignal!.reason);
                },
                { once: true },
              );
            },
            cancel,
          }),
        );
      });
      try {
        const response = await proxiedFetch(
          'https://example.com/path',
          withFetchTimeouts(
            { signal: upstream.signal },
            { requestTimeoutMs: 1000, bodyIdleTimeoutMs: 50 },
          ),
        );
        const cancellation = response.body!.cancel('done');
        void cancellation.catch(() => {});
        expect(cancel).toHaveBeenCalledWith('done');
        expect(internalSignal?.aborted).toBe(true);
        expect(internalSignal?.reason).toBe('done');
        expect(removeListener).toHaveBeenCalledWith(
          'abort',
          expect.any(Function),
        );
        expect(vi.getTimerCount()).toBe(0);
        finishCancellation();
        await expect(cancellation).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves underlying cancellation failures while still aborting Bun fetch', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const error = new Error('body cancellation failed');
      let internalSignal: AbortSignal | undefined;
      vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
        internalSignal = init!.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => Promise.reject(error),
          }),
        );
      });
      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts({}, { bodyIdleTimeoutMs: 50 }),
      );
      await expect(response.body!.cancel()).rejects.toBe(error);
      expect(internalSignal?.aborted).toBe(true);
    });

    it('preserves response metadata through repeated clones of a timeout-wrapped response', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const original = new Response('ok');
      Object.defineProperty(original, 'url', {
        value: 'https://example.com/path',
        configurable: true,
      });
      Object.defineProperty(original, 'redirected', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(original, 'type', {
        value: 'cors',
        configurable: true,
      });
      vi.mocked(global.fetch).mockResolvedValue(original);

      const response = await proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1000, bodyIdleTimeoutMs: 50 },
        ),
      );
      const firstClone = response.clone();
      const secondClone = firstClone.clone();

      expect(firstClone.url).toBe('https://example.com/path');
      expect(firstClone.redirected).toBe(true);
      expect(firstClone.type).toBe('cors');
      expect(secondClone.url).toBe('https://example.com/path');
      expect(secondClone.redirected).toBe(true);
      expect(secondClone.type).toBe('cors');
      response.body?.cancel().catch(() => {});
      firstClone.body?.cancel().catch(() => {});
      secondClone.body?.cancel().catch(() => {});
    });

    it('uses an undici dispatcher for resolved IP fetches outside Bun', async () => {
      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      const response = await fetchWithResolvedIp(
        'https://api2.example.com/path',
        { method: 'GET', headers: { 'x-test': '1' } },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(response.status).toBe(200);
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://api2.example.com/path'),
        {
          method: 'GET',
          headers: {
            'x-test': '1',
            'X-Qwen-HTTPDNS-IP': '203.0.113.20',
          },
          dispatcher: resolvedDispatcher,
        },
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('preserves the resolved IP dispatcher when per-request timeout is set outside Bun', async () => {
      const resolvedDispatcher = { kind: 'resolved-timeout', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(Agent).mockClear();
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));

      const response = await fetchWithResolvedIp(
        'https://api2.example.com/path',
        withFetchTimeouts({ method: 'GET' }, { requestTimeoutMs: 600000 }),
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(response.status).toBe(200);
      expect(Agent).toHaveBeenCalledTimes(1);
      expect(Agent).toHaveBeenCalledWith({
        headersTimeout: 600000,
        bodyTimeout: 600000,
        keepAliveTimeout: 55000,
        keepAliveMaxTimeout: 60000,
        maxHeaderSize: 16384,
        connect: expect.any(Function),
      });
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://api2.example.com/path'),
        {
          method: 'GET',
          headers: {
            'X-Qwen-HTTPDNS-IP': '203.0.113.20',
          },
          dispatcher: resolvedDispatcher,
        },
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('uses the bundled undici request API for resolved IP fetches in Bun', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      const baseConnect = vi.fn();
      vi.mocked(buildConnector).mockReturnValue(baseConnect);
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(mockUndiciRequest).mockResolvedValue(undiciResponse('ok'));

      const response = await fetchWithResolvedIp(
        'https://api2.example.com/path?q=1',
        { method: 'POST', headers: { 'x-test': '1' }, body: 'hi' },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(response.status).toBe(200);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockUndiciRequest).toHaveBeenCalledWith(
        new URL('https://api2.example.com/path?q=1'),
        {
          method: 'POST',
          headers: {
            'x-test': '1',
            'X-Qwen-HTTPDNS-IP': '203.0.113.20',
            'Content-Type': 'text/plain;charset=UTF-8',
          },
          body: 'hi',
          dispatcher: resolvedDispatcher,
          signal: undefined,
        },
      );
      expect(mockUndiciFetch).not.toHaveBeenCalled();

      const agentOptions = vi.mocked(Agent).mock.calls.at(-1)?.[0] as {
        connect(
          options: { servername?: string },
          callback: (...args: unknown[]) => void,
        ): void;
      };
      const callback = vi.fn();
      agentOptions.connect({ servername: 'api2.example.com' }, callback);
      expect(baseConnect).toHaveBeenCalledWith(
        {
          hostname: '203.0.113.20',
          servername: 'api2.example.com',
        },
        expect.any(Function),
      );
      const connectedSocket = { marker: 'original-socket' };
      baseConnect.mock.calls[0][1](null, connectedSocket);
      expect(callback).toHaveBeenCalledWith(null, connectedSocket);
      expect(Agent).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowH2: false }),
      );
      expect(buildConnector).toHaveBeenLastCalledWith(
        expect.objectContaining({ allowH2: false }),
      );
    });

    it('preserves URLSearchParams content type on Bun resolved IP requests', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(mockUndiciRequest)
        .mockResolvedValueOnce(undiciResponse('default'))
        .mockResolvedValueOnce(undiciResponse('custom'));

      await fetchWithResolvedIp(
        'https://api2.example.com/form',
        {
          method: 'POST',
          body: new URLSearchParams({ query: 'hello world' }),
        },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );
      await fetchWithResolvedIp(
        'https://api2.example.com/custom-form',
        {
          method: 'POST',
          headers: { 'content-type': 'application/custom' },
          body: new URLSearchParams({ query: 'custom' }),
        },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(mockUndiciRequest).toHaveBeenNthCalledWith(
        1,
        new URL('https://api2.example.com/form'),
        expect.objectContaining({
          body: 'query=hello+world',
          headers: {
            'X-Qwen-HTTPDNS-IP': '203.0.113.20',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
        }),
      );
      expect(mockUndiciRequest).toHaveBeenNthCalledWith(
        2,
        new URL('https://api2.example.com/custom-form'),
        expect.objectContaining({
          body: 'query=custom',
          headers: {
            'content-type': 'application/custom',
            'X-Qwen-HTTPDNS-IP': '203.0.113.20',
          },
        }),
      );
    });

    it('passes Blob bodies directly to undici on Bun resolved IP requests', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(mockUndiciRequest).mockResolvedValue(undiciResponse('ok'));
      const body = new Blob(['blob-payload'], {
        type: 'application/octet-stream',
      });

      await fetchWithResolvedIp(
        'https://api2.example.com/upload',
        { method: 'POST', body },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(mockUndiciRequest).toHaveBeenCalledWith(
        new URL('https://api2.example.com/upload'),
        expect.objectContaining({ body }),
      );
    });

    it('encodes native FormData before passing it to undici.request in Bun', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(mockUndiciRequest).mockResolvedValue(undiciResponse('ok'));
      const form = new FormData();
      form.append('prompt', 'hello world');

      await fetchWithResolvedIp(
        'https://api2.example.com/upload',
        { method: 'POST', body: form },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      const requestOptions = vi.mocked(mockUndiciRequest).mock
        .calls[0]?.[1] as {
        body: Readable;
        headers: Record<string, string>;
      };
      const contentType = Object.entries(requestOptions.headers).find(
        ([name]) => name.toLowerCase() === 'content-type',
      )?.[1];
      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      const chunks: Buffer[] = [];
      for await (const chunk of requestOptions.body) {
        chunks.push(Buffer.from(chunk));
      }
      const encodedBody = Buffer.concat(chunks).toString('utf8');
      expect(encodedBody).toContain('name="prompt"');
      expect(encodedBody).toContain('hello world');
      expect(encodedBody).toContain(
        `--${contentType?.slice('multipart/form-data; boundary='.length)}`,
      );
    });

    it('surfaces Bun undici request timeouts without waiting for the transport promise', async () => {
      vi.useFakeTimers();
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(mockUndiciRequest).mockReturnValue(new Promise(() => {}));

      const pending = fetchWithResolvedIp(
        'https://api2.example.com/slow',
        withFetchTimeouts(undefined, { requestTimeoutMs: 25 }),
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
        },
      );

      await Promise.all([
        expect(pending).rejects.toMatchObject({
          name: 'TimeoutError',
          phase: 'response_headers',
        }),
        vi.advanceTimersByTimeAsync(25),
      ]);
    });

    it('decodes gzip responses from Bun undici request transports', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      const compressed = gzipSync('decoded-response');
      vi.mocked(mockUndiciRequest).mockResolvedValue(
        undiciResponse(compressed, {
          headers: {
            'content-encoding': 'gzip',
            'content-length': String(compressed.byteLength),
          },
        }),
      );

      const response = await fetchWithResolvedIp(
        'https://api2.example.com/compressed',
        { method: 'GET' },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(await response.text()).toBe('decoded-response');
      expect(response.headers.get('content-encoding')).toBe('gzip');
    });

    it('does not leak an error when response decoding already destroyed the body', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(Agent).mockReturnValue({ kind: 'resolved' });

      const body = new Readable({
        read() {},
      });
      vi.mocked(mockUndiciRequest).mockResolvedValue(
        undiciResponse(body, {
          headers: {
            'content-encoding': 'gzip, gzip, gzip, gzip, gzip, gzip',
          },
        }),
      );

      const uncaught = await captureUncaughtExceptions(async () => {
        await expect(
          fetchWithResolvedIp(
            'https://api2.example.com/over-encoded',
            { method: 'GET' },
            {
              ip: '203.0.113.20',
              originalHostname: 'api2.example.com',
            },
          ),
        ).rejects.toThrow(
          'too many content-encodings in response: 6, maximum allowed is 5',
        );
      });

      expect(body.destroyed).toBe(true);
      expect(uncaught).toEqual([]);
    });

    it('falls back to normal fetch when a Bun resolved IP redirect crosses hosts', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();

      vi.mocked(mockUndiciRequest).mockResolvedValueOnce(
        undiciResponse(null, {
          status: 302,
          headers: { location: 'https://other.example.com/next' },
        }),
      );
      vi.mocked(global.fetch).mockResolvedValue(new Response('redirected'));

      const response = await fetchWithResolvedIp(
        'https://api2.example.com/start',
        { method: 'GET' },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(response.status).toBe(200);
      expect(response.url).toBe('https://other.example.com/next');
      expect(response.redirected).toBe(true);
      expect(mockUndiciRequest).toHaveBeenCalledOnce();
      expect(global.fetch).toHaveBeenCalledWith(
        'https://other.example.com/next',
        {
          method: 'GET',
          headers: {},
        },
      );
    });

    it('uses Bun native fetch proxy for HTTP proxies', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const nativeFetch = global.fetch;
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));

      setGlobalProxy(proxyUrl);

      const response = await proxiedFetch('https://example.com/path', {
        method: 'POST',
        headers: { 'x-test': '1' },
      });

      expect(response.status).toBe(200);
      expect(nativeFetch).toHaveBeenCalledWith('https://example.com/path', {
        method: 'POST',
        headers: { 'x-test': '1' },
        proxy: proxyUrl,
      });
    });

    it('uses Bun native fetch proxy for pinned per-request HTTP proxy routes', async () => {
      const proxyUrl = 'http://selected-proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      process.env['NO_PROXY'] = 'example.com';
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      const response = await proxiedFetch(
        'https://example.com/path',
        { method: 'GET' },
        { proxyUrl },
      );

      expect(response.status).toBe(200);
      expect(nativeFetch).toHaveBeenCalledWith('https://example.com/path', {
        method: 'GET',
        proxy: proxyUrl,
      });
    });

    it('wraps Bun native proxy fetches with request timeout support', async () => {
      vi.useFakeTimers();
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      let internalSignal: AbortSignal | undefined;
      const nativeFetch = global.fetch;
      vi.mocked(global.fetch).mockImplementation(async (_input, init) => {
        internalSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(new DOMException('native fetch aborted', 'AbortError')),
            { once: true },
          );
        });
      });

      setGlobalProxy(proxyUrl);

      const responsePromise = proxiedFetch(
        'https://example.com/path',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1000, bodyIdleTimeoutMs: 50 },
        ),
      );

      expect(nativeFetch).toHaveBeenCalledWith(
        'https://example.com/path',
        expect.objectContaining({
          method: 'GET',
          proxy: proxyUrl,
          signal: expect.any(AbortSignal),
        }),
      );

      const rejection = responsePromise.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1001);
      expect(internalSignal?.aborted).toBe(true);
      await expect(rejection).resolves.toMatchObject({
        name: 'TimeoutError',
        phase: 'response_headers',
      });
    });

    it('patches global fetch in Bun so direct fetch uses native proxy support', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const nativeFetch = global.fetch;
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));

      setGlobalProxy(proxyUrl);

      const response = await fetch('https://example.com/path', {
        method: 'GET',
      });

      expect(response.status).toBe(200);
      expect(nativeFetch).toHaveBeenCalledWith('https://example.com/path', {
        method: 'GET',
        proxy: proxyUrl,
      });
    });

    it('bypasses Bun native proxy support when NO_PROXY matches', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      process.env['NO_PROXY'] = 'example.com';
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      const response = await fetch('https://example.com/path', {
        method: 'GET',
      });

      expect(response.status).toBe(200);
      expect(nativeFetch).toHaveBeenCalledWith('https://example.com/path', {
        method: 'GET',
      });
    });

    it('bypasses the Node proxy dispatcher when NO_PROXY matches', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      const directDispatcher = { kind: 'direct' };
      const proxyDispatcher = { kind: 'proxy' };
      vi.mocked(Agent).mockReturnValue(directDispatcher);
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      process.env['NO_PROXY'] = 'example.com';
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      const response = await proxiedFetch('https://example.com/path', {
        method: 'GET',
      });

      expect(response.status).toBe(200);
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://example.com/path'),
        {
          method: 'GET',
          dispatcher: directDispatcher,
        },
      );
      expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('uses the Node proxy dispatcher when NO_PROXY does not match', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      const proxyDispatcher = { kind: 'proxy' };
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      process.env['NO_PROXY'] = 'internal.example.com';
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      await proxiedFetch('https://example.com/path', { method: 'GET' });

      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://example.com/path'),
        {
          method: 'GET',
          dispatcher: proxyDispatcher,
        },
      );
      expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('uses a per-request proxy URL instead of re-reading global proxy state', async () => {
      const globalProxyDispatcher = { kind: 'global-proxy' };
      const selectedProxyDispatcher = { kind: 'selected-proxy' };
      vi.mocked(ProxyAgent)
        .mockReturnValueOnce(globalProxyDispatcher)
        .mockReturnValueOnce(selectedProxyDispatcher);
      process.env['NO_PROXY'] = 'example.com';
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy('http://global-proxy.example.com:8080');
      await proxiedFetch(
        'https://example.com/path',
        { method: 'GET' },
        { proxyUrl: 'http://selected-proxy.example.com:8080' },
      );

      expect(ProxyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          uri: 'http://selected-proxy.example.com:8080',
        }),
      );
      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://example.com/path'),
        {
          method: 'GET',
          dispatcher: selectedProxyDispatcher,
        },
      );
      expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('bypasses the Node proxy dispatcher for unsupported target protocols', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      const proxyDispatcher = { kind: 'proxy' };
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      await proxiedFetch('file:///tmp/test-test', { method: 'GET' });

      expect(mockUndiciFetch).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ method: 'GET' }),
      );
      const [, callInit] = vi.mocked(mockUndiciFetch).mock.calls.at(-1)!;
      expect((callInit as { dispatcher?: unknown }).dispatcher).not.toBe(
        proxyDispatcher,
      );
      expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('bypasses the Bun proxy when NO_PROXY matches an IPv6 host and port', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      process.env['NO_PROXY'] = '[2001:db8::1]:8443';
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));

      setGlobalProxy(proxyUrl);

      const response = await fetch('https://[2001:db8::1]:8443/path');

      expect(response.status).toBe(200);
    });

    it('passes HTTP targets through Bun native proxy support', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      const response = await proxiedFetch('http://example.com/path?q=1', {
        method: 'POST',
      });

      expect(response.status).toBe(200);
      expect(nativeFetch).toHaveBeenCalledWith('http://example.com/path?q=1', {
        method: 'POST',
        proxy: proxyUrl,
      });
    });

    it('preserves proxy URL credentials for Bun native proxy support', async () => {
      const proxyUrl = 'http://user:pass@proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      await proxiedFetch('https://example.com/path', { method: 'GET' });

      expect(nativeFetch).toHaveBeenCalledWith('https://example.com/path', {
        method: 'GET',
        proxy: proxyUrl,
      });
    });

    it('uses Bun native proxy support for HTTPS proxy URLs', async () => {
      const proxyUrl = 'https://proxy.example.com:8443';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      await proxiedFetch('http://example.com/path', { method: 'GET' });

      expect(nativeFetch).toHaveBeenCalledWith('http://example.com/path', {
        method: 'GET',
        proxy: proxyUrl,
      });
    });

    it('routes SOCKS5 through undici ProxyAgent in Bun', async () => {
      const proxyUrl = 'socks5://proxy.example.com:1080';
      const proxyDispatcher = { kind: 'socks-proxy', close: vi.fn() };
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciRequest).mockResolvedValue(undiciResponse('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      const response = await proxiedFetch(
        'http://example.com/path?q=1',
        withFetchTimeouts({ method: 'GET' }, { requestTimeoutMs: 300_000 }),
      );

      expect(response.status).toBe(200);
      expect(ProxyAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          uri: proxyUrl,
          headersTimeout: 300000,
          bodyTimeout: 300000,
        }),
      );
      expect(Pool).not.toHaveBeenCalled();
      expect(mockUndiciRequest).toHaveBeenCalledWith(
        new URL('http://example.com/path?q=1'),
        {
          method: 'GET',
          headers: undefined,
          body: undefined,
          dispatcher: proxyDispatcher,
          signal: expect.any(AbortSignal),
          headersTimeout: 300000,
          bodyTimeout: 300000,
        },
      );
      // Bun's native fetch ignores undici's dispatcher option, so routing the
      // request through it would silently bypass the proxy.
      expect(nativeFetch).not.toHaveBeenCalled();
    });

    it('passes SOCKS request and body-idle timeouts to ProxyAgent and undici.request', async () => {
      const proxyUrl = 'socks5://proxy.example.com:1080';
      const proxyDispatcher = { kind: 'socks-proxy', close: vi.fn() };
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciRequest).mockResolvedValue(undiciResponse('ok'));

      setGlobalProxy(proxyUrl);

      await proxiedFetch(
        'http://example.com/slow',
        withFetchTimeouts(
          { method: 'GET' },
          { requestTimeoutMs: 1_000, bodyIdleTimeoutMs: 2_000 },
        ),
      );

      expect(ProxyAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          uri: proxyUrl,
          headersTimeout: 1000,
          bodyTimeout: 2000,
        }),
      );
      expect(mockUndiciRequest).toHaveBeenCalledWith(
        new URL('http://example.com/slow'),
        expect.objectContaining({
          dispatcher: proxyDispatcher,
          headersTimeout: 1000,
          bodyTimeout: 2000,
        }),
      );
    });

    it('streams a SOCKS response body without going through Readable.toWeb', async () => {
      const proxyUrl = 'socks5://proxy.example.com:1080';
      const body = new Readable({
        read() {
          // The test controls when the transport body completes.
        },
      });
      const proxyDispatcher = { close: vi.fn() };
      const toWebSpy = vi.spyOn(Readable, 'toWeb');
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciRequest).mockResolvedValue(undiciResponse(body));

      try {
        setGlobalProxy(proxyUrl);
        const response = await proxiedFetch(
          'http://example.com/stream',
          withFetchTimeouts(
            { method: 'GET' },
            { requestTimeoutMs: 300_000, bodyIdleTimeoutMs: 0 },
          ),
        );

        expect(toWebSpy).not.toHaveBeenCalled();

        body.push('payload');
        body.push(null);

        await expect(response.text()).resolves.toBe('payload');
      } finally {
        toWebSpy.mockRestore();
      }
    });

    it('rejects per-request Bun TLS options on SOCKS instead of silently ignoring them', async () => {
      const proxyUrl = 'socks5://proxy.example.com:1080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(ProxyAgent).mockReturnValue({ close: vi.fn() });

      setGlobalProxy(proxyUrl);

      await expect(
        proxiedFetch('http://example.com/path', {
          method: 'GET',
          tls: { rejectUnauthorized: false },
        } as RequestInit),
      ).rejects.toThrow('Per-request tls options are not supported');
    });

    it('strips credentials across cross-origin redirects in Bun', async () => {
      const proxyUrl = 'socks5://proxy.example.com:1080';
      const proxyDispatcher = { kind: 'socks-proxy', close: vi.fn() };
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciRequest)
        .mockResolvedValueOnce(
          undiciResponse(null, {
            status: 302,
            headers: { location: 'http://other.example.com/next' },
          }),
        )
        .mockResolvedValueOnce(undiciResponse('redirected'));

      setGlobalProxy(proxyUrl);
      const response = await proxiedFetch(
        'http://example.com/start',
        withFetchTimeouts(
          {
            method: 'GET',
            headers: {
              authorization: 'Bearer secret',
              cookie: 'session=secret',
            },
          },
          { requestTimeoutMs: 300_000 },
        ),
      );

      expect(await response.text()).toBe('redirected');
      expect(response.url).toBe('http://other.example.com/next');
      expect(response.redirected).toBe(true);
      expect(mockUndiciRequest).toHaveBeenCalledTimes(2);
      expect(mockUndiciRequest).toHaveBeenNthCalledWith(
        2,
        new URL('http://other.example.com/next'),
        {
          method: 'GET',
          headers: {},
          body: undefined,
          dispatcher: proxyDispatcher,
          signal: expect.any(AbortSignal),
          headersTimeout: 300000,
          bodyTimeout: 300000,
        },
      );
    });

    it('converts Bun SOCKS streaming request bodies for undici.request', async () => {
      const proxyUrl = 'socks5://proxy.example.com:1080';
      const proxyDispatcher = { kind: 'socks-proxy', close: vi.fn() };
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciRequest).mockResolvedValue(undiciResponse('ok'));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'));
          controller.close();
        },
      });

      setGlobalProxy(proxyUrl);
      await proxiedFetch(
        'http://example.com/upload',
        withFetchTimeouts(
          {
            method: 'POST',
            body,
            // @ts-expect-error -- Node fetch requires duplex for stream bodies.
            duplex: 'half',
          },
          { requestTimeoutMs: 300_000 },
        ),
      );

      expect(mockUndiciRequest).toHaveBeenCalledWith(
        new URL('http://example.com/upload'),
        {
          method: 'POST',
          headers: undefined,
          body: expect.any(Readable),
          dispatcher: proxyDispatcher,
          signal: expect.any(AbortSignal),
          headersTimeout: 300000,
          bodyTimeout: 300000,
        },
      );
    });

    it('passes Request objects through Bun native proxy support', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      const request = new Request('http://example.com/items', {
        method: 'PUT',
        headers: { 'x-request': '1' },
        body: 'hello',
      });
      const response = await proxiedFetch(request);

      expect(response.status).toBe(200);
      expect(nativeFetch).toHaveBeenCalledWith(request, {
        proxy: proxyUrl,
      });
    });

    it('passes streaming request bodies through Bun native proxy support', async () => {
      const proxyUrl = 'http://proxy.example.com:8080';
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(global.fetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('abc'));
          controller.close();
        },
      });

      const response = await proxiedFetch('http://example.com/upload', {
        method: 'POST',
        body: stream,
        // @ts-expect-error -- Node fetch requires duplex for stream bodies.
        duplex: 'half',
      });

      expect(response.status).toBe(200);
      expect(nativeFetch).toHaveBeenCalledWith('http://example.com/upload', {
        method: 'POST',
        body: stream,
        duplex: 'half',
        proxy: proxyUrl,
      });
    });

    it('keeps the resolved-IP dispatcher across same-host redirects in Bun', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      const resolvedDispatcher = { kind: 'resolved', close: vi.fn() };
      vi.mocked(Agent).mockReturnValue(resolvedDispatcher);
      vi.mocked(mockUndiciRequest)
        .mockResolvedValueOnce(
          undiciResponse(null, {
            status: 302,
            headers: { location: 'http://api2.example.com/next' },
          }),
        )
        .mockResolvedValueOnce(undiciResponse('ok'));

      const response = await fetchWithResolvedIp(
        'http://api2.example.com/start',
        { method: 'POST', body: 'payload' },
        {
          ip: '203.0.113.20',
          originalHostname: 'api2.example.com',
          markerHeader: 'X-Qwen-HTTPDNS-IP',
        },
      );

      expect(response.status).toBe(200);
      expect(response.url).toBe('http://api2.example.com/next');
      expect(response.redirected).toBe(true);
      expect(mockUndiciRequest).toHaveBeenCalledTimes(2);
      expect(mockUndiciRequest).toHaveBeenNthCalledWith(
        2,
        new URL('http://api2.example.com/next'),
        {
          method: 'GET',
          body: undefined,
          headers: {
            'X-Qwen-HTTPDNS-IP': '203.0.113.20',
          },
          dispatcher: resolvedDispatcher,
          signal: undefined,
        },
      );
    });

    it('cancels an unconsumed undici body without leaking an uncaught abort error', async () => {
      (globalThis as { Bun?: unknown }).Bun = {};
      _resetBunRuntimeCacheForTesting();
      vi.mocked(Agent).mockReturnValue({ kind: 'resolved' });

      // Mimic undici's BodyReadable: destroying a body that has not ended
      // synthesizes `AbortError: Request aborted` and emits it as an 'error'
      // event. Without a sink that event escapes as an uncaughtException.
      class SynthesizingAbortBody extends Readable {
        override _read(): void {}
        override _destroy(
          error: Error | null,
          callback: (error: Error | null) => void,
        ): void {
          callback(
            error ??
              Object.assign(new Error('Request aborted'), {
                name: 'AbortError',
                code: 'UND_ERR_ABORTED',
              }),
          );
        }
      }

      const body = new SynthesizingAbortBody();
      vi.mocked(mockUndiciRequest).mockResolvedValue(
        undiciResponse(body, {
          headers: { 'content-type': 'text/event-stream' },
        }),
      );

      const response = await fetchWithResolvedIp(
        'http://api3.example.com/sse',
        { method: 'POST', body: 'payload' },
        { ip: '203.0.113.30', originalHostname: 'api3.example.com' },
      );

      const uncaught = await captureUncaughtExceptions(async () => {
        // The first-payload deadline cancels the response before any iterator
        // consumed it.
        await response.body?.cancel(
          new Error('Model stream timed out before first payload after 60s'),
        );
      });

      expect(uncaught).toEqual([]);
      expect(body.destroyed).toBe(true);
    });

    it('uses a Node dispatcher outside Bun instead of Bun proxy options', async () => {
      const proxyUrl = 'http://proxy.example.com';
      const proxyDispatcher = { kind: 'proxy' };
      vi.mocked(ProxyAgent).mockReturnValue(proxyDispatcher);
      vi.mocked(mockUndiciFetch).mockResolvedValue(new Response('ok'));
      const nativeFetch = global.fetch;

      setGlobalProxy(proxyUrl);
      await proxiedFetch('https://example.com', { method: 'GET' });

      expect(mockUndiciFetch).toHaveBeenCalledWith(
        new URL('https://example.com'),
        {
          method: 'GET',
          dispatcher: proxyDispatcher,
        },
      );
      expect(nativeFetch).not.toHaveBeenCalled();
    });
  });
});
