/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  FetchError,
  fetchWithPolicy,
  formatFetchErrorForUser,
  isPermittedRedirect,
  isPrivateHost,
} from './fetch.js';

function makeTlsError(): Error {
  const tlsCause = new Error('unable to verify the first certificate');
  (tlsCause as Error & { code?: string }).code =
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  const fetchError = new TypeError('fetch failed') as TypeError & {
    cause?: unknown;
  };
  fetchError.cause = tlsCause;
  return fetchError;
}

describe('formatFetchErrorForUser', () => {
  const saved = {
    QWEN_TLS_INSECURE: process.env['QWEN_TLS_INSECURE'],
    NODE_TLS_REJECT_UNAUTHORIZED: process.env['NODE_TLS_REJECT_UNAUTHORIZED'],
  };

  beforeEach(() => {
    delete process.env['QWEN_TLS_INSECURE'];
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('includes troubleshooting hints for TLS errors', () => {
    const message = formatFetchErrorForUser(makeTlsError(), {
      url: 'https://chat.qwen.ai',
    });

    expect(message).toContain('fetch failed');
    expect(message).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(message).toContain('Troubleshooting:');
    expect(message).toContain('Confirm you can reach https://chat.qwen.ai');
    expect(message).toContain('--proxy');
    expect(message).toContain('NODE_EXTRA_CA_CERTS');
    expect(message).toContain('--insecure');
  });

  it('omits the --insecure hint when verification is already disabled', () => {
    process.env['QWEN_TLS_INSECURE'] = '1';
    const message = formatFetchErrorForUser(makeTlsError());

    expect(message).toContain('already disabled');
    expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
    expect(message).not.toContain('pass `--insecure`');
  });

  it('includes troubleshooting hints for network codes', () => {
    const fetchError = new FetchError(
      'Request timed out after 100ms',
      'ETIMEDOUT',
    );
    const message = formatFetchErrorForUser(fetchError, {
      url: 'https://example.com',
    });

    expect(message).toContain('Request timed out after 100ms');
    expect(message).toContain('Troubleshooting:');
    expect(message).toContain('Confirm you can reach https://example.com');
    expect(message).toContain('--proxy');
    expect(message).not.toContain('NODE_EXTRA_CA_CERTS');
  });

  it('does not include troubleshooting for non-fetch errors', () => {
    expect(formatFetchErrorForUser(new Error('boom'))).toBe('boom');
  });
});

describe('isPermittedRedirect', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/b', true],
    ['https://example.com/a', 'https://www.example.com/a', true],
    ['https://www.example.com/a', 'https://example.com/a', true],
    ['https://example.com/a', 'https://other.example.org/a', false],
    ['https://example.com/a', 'http://example.com/a', false],
    ['https://example.com/a', 'https://example.com:8443/a', false],
    ['https://example.com/a', 'https://user:pw@example.com/a', false],
    ['https://example.com/a', 'not a url', false],
    ['http://127.0.0.1:8080/a', 'http://localhost:8080/a', false],
  ])('%s -> %s => %s', (original, redirect, expected) => {
    expect(isPermittedRedirect(original, redirect)).toBe(expected);
  });
});

describe('fetchWithPolicy', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 5000, maxBytes: 1000, maxRedirects: 3 };

  function stubFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): void {
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const signal = init?.signal;
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        return handler(url, init);
      },
    ) as typeof fetch;
  }

  it('returns the response body, status and final URL', async () => {
    stubFetch(
      () =>
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const result = await fetchWithPolicy('https://example.com/x', opts);
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.status).toBe(200);
      expect(result.contentType).toBe('text/plain');
      expect(result.body.toString()).toBe('hello');
      expect(result.finalUrl).toBe('https://example.com/x');
    }
  });

  it('follows same-host redirects and reports the final URL', async () => {
    stubFetch((url) => {
      if (url.endsWith('/start')) {
        return new Response(null, {
          status: 302,
          headers: { location: '/target' },
        });
      }
      return new Response('landed', { status: 200 });
    });
    const result = await fetchWithPolicy('https://example.com/start', opts);
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.finalUrl).toBe('https://example.com/target');
      expect(result.body.toString()).toBe('landed');
    }
  });

  it('surfaces cross-host redirects without following them', async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 301,
          headers: { location: 'https://other.example.org/t' },
        }),
    );
    const result = await fetchWithPolicy('https://example.com/start', opts);
    expect(result).toEqual({
      kind: 'cross-host-redirect',
      originalUrl: 'https://example.com/start',
      redirectUrl: 'https://other.example.org/t',
      status: 301,
    });
  });

  it('errors after exceeding the redirect hop limit', async () => {
    let n = 0;
    stubFetch(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `/hop-${n++}` },
        }),
    );
    await expect(
      fetchWithPolicy('https://example.com/start', opts),
    ).rejects.toThrow(/Too many redirects/);
  });

  it('rejects oversized responses via Content-Length before reading', async () => {
    stubFetch(
      () =>
        new Response('irrelevant', {
          status: 200,
          headers: { 'content-length': '999999' },
        }),
    );
    await expect(
      fetchWithPolicy('https://example.com/big', opts),
    ).rejects.toThrow(/Response too large/);
  });

  it('rejects oversized responses while streaming when no Content-Length', async () => {
    const chunk = new Uint8Array(600).fill(120);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 1200 > maxBytes 1000
        controller.close();
      },
    });
    stubFetch(() => new Response(body, { status: 200 }));
    await expect(
      fetchWithPolicy('https://example.com/big-stream', opts),
    ).rejects.toThrow(/exceeded the 1000-byte limit while streaming/);
  });

  it('propagates caller aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    stubFetch(() => new Response('never', { status: 200 }));
    await expect(
      fetchWithPolicy('https://example.com/x', {
        ...opts,
        signal: controller.signal,
      }),
    ).rejects.toThrow('user cancelled');
  });

  it('returns a non-2xx status without buffering its body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      // No data and never closes: a body that would stall a reader until the
      // timeout. The non-2xx path must cancel it, not read it.
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(
      () =>
        new Response(body, {
          status: 500,
          statusText: 'Internal Server Error',
        }),
    );
    const result = await fetchWithPolicy('https://example.com/boom', opts);
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.status).toBe(500);
      expect(result.statusText).toBe('Internal Server Error');
      expect(result.body.length).toBe(0);
    }
    expect(cancelled).toBe(true);
  });

  it('reports the status of an oversized error page, not a size error', async () => {
    // A 404 whose body exceeds maxBytes must surface as 404, not EMSGSIZE:
    // the status is what the caller acts on, and the body is discarded.
    stubFetch(
      () =>
        new Response('x'.repeat(5000), {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-length': '5000' },
        }),
    );
    const result = await fetchWithPolicy('https://example.com/missing', opts);
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.status).toBe(404);
      expect(result.body.length).toBe(0);
    }
  });
});

describe('fetchWithPolicy retry', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 10_000, maxBytes: 1000, maxRedirects: 3 };

  it('retries once on 403 and returns the successful second response', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response('blocked', { status: 403 })
        : new Response('recovered', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/flaky', opts);
    expect(calls).toBe(2);
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.status).toBe(200);
      expect(result.body.toString()).toBe('recovered');
    }
  });

  it('retries once on 429 and returns the successful second response', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response('rate limited', { status: 429 })
        : new Response('recovered', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/limited', opts);
    expect(calls).toBe(2);
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.status).toBe(200);
      expect(result.body.toString()).toBe('recovered');
    }
  });

  it('returns the original 403 when the retry also fails', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/blocked', opts);
    expect(calls).toBe(2);
    if (result.kind === 'response') expect(result.status).toBe(403);
  });

  it('retries once on transient network errors (ECONNRESET)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        const err = new TypeError('fetch failed') as TypeError & {
          cause?: unknown;
        };
        err.cause = Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        });
        throw err;
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/reset', opts);
    expect(calls).toBe(2);
    if (result.kind === 'response') expect(result.status).toBe(200);
  });

  it('does not retry deterministic statuses like 404', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('nope', { status: 404 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/missing', opts);
    expect(calls).toBe(1);
    if (result.kind === 'response') expect(result.status).toBe(404);
  });

  it('does not retry non-transient network errors', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      const err = new TypeError('fetch failed') as TypeError & {
        cause?: unknown;
      };
      err.cause = Object.assign(new Error('cert invalid'), {
        code: 'CERT_HAS_EXPIRED',
      });
      throw err;
    }) as typeof fetch;

    await expect(
      fetchWithPolicy('https://example.com/tls', opts),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
  });
});

describe('fetchWithPolicy retry abort handling', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 10_000, maxBytes: 1000, maxRedirects: 3 };

  it('retries once on undici socket errors (UND_ERR_SOCKET)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        const err = new TypeError('fetch failed') as TypeError & {
          cause?: unknown;
        };
        err.cause = Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        });
        throw err;
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/reset', opts);
    expect(calls).toBe(2);
    if (result.kind === 'response') expect(result.status).toBe(200);
  });

  it('propagates caller abort over the original 403 during the retry window', async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;
    setTimeout(() => controller.abort(new Error('user cancelled')), 100);

    await expect(
      fetchWithPolicy('https://example.com/blocked', {
        ...opts,
        signal: controller.signal,
      }),
    ).rejects.toThrow('user cancelled');
    expect(calls).toBe(1);
  });

  it('propagates timeout over the original 403 during the retry window', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('blocked', { status: 403 }),
    ) as typeof fetch;

    // 200ms budget expires inside the 500ms retry delay.
    await expect(
      fetchWithPolicy('https://example.com/blocked', {
        ...opts,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out after 200ms/);
  });
});

describe('isPrivateHost', () => {
  it.each([
    // Private/internal — never https-upgraded
    ['http://10.0.0.5/x', true],
    ['http://192.168.1.1/x', true],
    ['http://172.16.0.1/x', true],
    ['http://127.0.0.1:8080/x', true],
    ['http://localhost:3000/x', true],
    ['http://app.localhost/x', true],
    ['http://host.docker.internal:9000/x', true],
    ['http://intranet/wiki', true],
    ['http://dev.internal/x', true],
    ['http://nas.local/x', true],
    ['http://169.254.169.254/latest/meta-data', true],
    ['http://100.64.0.1/x', true],
    ['http://100.127.255.255/x', true],
    ['http://0.0.0.0/x', true],
    ['http://[::]/x', true],
    ['http://[::1]/x', true],
    ['http://[::ffff:127.0.0.1]/x', true],
    ['http://[::ffff:7f00:1]/x', true],
    ['http://[::ffff:c0a8:101]/x', true],
    ['http://[fe80::1]/x', true],
    ['http://[fe9f::1]/x', true],
    ['http://[fc00::1]/x', true],
    ['http://[fd00::1]/x', true],
    ['http://[fdff::1]/x', true],
    // Public — eligible for the https upgrade
    ['http://example.com/x', false],
    ['http://93.184.216.34/x', false],
    ['http://100.128.0.1/x', false],
    ['http://169.253.1.1/x', false],
    ['http://[2606:4700:4700::1111]/x', false],
    ['http://[::ffff:5db8:d822]/x', false],
  ])('%s → private=%s', (url, expected) => {
    expect(isPrivateHost(url)).toBe(expected);
  });
});

describe('fetchWithPolicy same-host redirects', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 5000, maxBytes: 1000, maxRedirects: 3 };

  it('follows same-host redirects to completion', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith('/QwenLM/old')) {
        return new Response(null, {
          status: 302,
          headers: { location: '/QwenLM/new' },
        });
      }
      return new Response('landed', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://github.com/QwenLM/old', opts);
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.finalUrl).toBe('https://github.com/QwenLM/new');
      expect(result.body.toString()).toBe('landed');
    }
  });
});
