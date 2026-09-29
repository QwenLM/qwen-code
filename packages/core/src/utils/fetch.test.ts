/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CONNECTION_LEVEL_ERROR_CODES,
  FetchError,
  fetchWithPolicy,
  formatFetchErrorForUser,
  isConnectionLevelError,
  isPermittedRedirect,
  isPrivateHost,
  type FetchPolicyOptions,
} from './fetch.js';

/** undici's `fetch failed` TypeError whose `cause` carries a Node `code`. */
function fetchFailed(causeMessage: string, code: string): Error {
  const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
  err.cause = Object.assign(new Error(causeMessage), { code });
  return err;
}

const makeTlsError = () =>
  fetchFailed(
    'unable to verify the first certificate',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  );

const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });

/** Fetches, asserts a `response` result and narrows it for the checks after. */
async function fetchResponse(url: string, options: FetchPolicyOptions) {
  const result = await fetchWithPolicy(url, options);
  expect(result.kind).toBe('response');
  if (result.kind !== 'response') throw new Error(`got ${result.kind}`);
  return result;
}

/** Stubs fetch to answer its n-th call with `respond(n)`; returns a counter. */
function stubByCall(respond: (call: number) => Response): () => number {
  let calls = 0;
  globalThis.fetch = vi.fn(async () => respond(++calls)) as typeof fetch;
  return () => calls;
}

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

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

describe('isConnectionLevelError', () => {
  // The exact expected membership of CONNECTION_LEVEL_ERROR_CODES (fetch.ts).
  // One list drives both the per-code cases below and the membership pin, so
  // dropping a member reddens a named case and adding one reddens the pin.
  const EXPECTED_CONNECTION_LEVEL_CODES = [
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EPROTO',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ];

  it('pins the exact membership of CONNECTION_LEVEL_ERROR_CODES', () => {
    // Widening direction: every member is an https→http downgrade trigger in
    // tools/web-fetch.ts, so an addition — a mid-transfer code, or a TLS code
    // added to TLS_ERROR_CODES only to widen the shouldShowTlsHint message —
    // must be a deliberate change to this list, not a silent one.
    expect([...CONNECTION_LEVEL_ERROR_CODES].sort()).toEqual(
      [...EXPECTED_CONNECTION_LEVEL_CODES].sort(),
    );
  });

  it.each(EXPECTED_CONNECTION_LEVEL_CODES)(
    'treats %s as connection-level (https upgrade may fall back to http)',
    (code) => {
      expect(
        isConnectionLevelError(new FetchError(`connect ${code}`, code)),
      ).toBe(true);
    },
  );

  // Two distinct exclusion classes, not one:
  // - Name resolution (ENOTFOUND, EAI_AGAIN) fails before any socket exists.
  //   The upgrade changes only the scheme, so the http fallback would
  //   re-resolve the same hostname and cannot succeed — a guaranteed-fail
  //   cleartext retry on every unresolvable host. EAI_AGAIN also already gets
  //   one retry inside fetchWithPolicy (RETRYABLE_ERROR_CODES).
  // - Mid-transfer failures on an already-established, healthy connection: a
  //   fallback would re-fetch a stalled-but-live https response over
  //   cleartext, doubling the worst-case wait for an ambiguous gain (same
  //   rationale as the ETIMEDOUT exclusion in fetch.ts).
  it.each([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'EPIPE',
  ])('does not treat %s as connection-level', (code) => {
    expect(isConnectionLevelError(new FetchError(code, code))).toBe(false);
  });

  it('returns false for non-FetchError values and code-less FetchErrors', () => {
    expect(isConnectionLevelError(new Error('boom'))).toBe(false);
    expect(isConnectionLevelError(new FetchError('no code'))).toBe(false);
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
    const result = await fetchResponse('https://example.com/x', opts);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/plain');
    expect(result.body.toString()).toBe('hello');
    expect(result.finalUrl).toBe('https://example.com/x');
  });

  it('follows same-host redirects and reports the final URL', async () => {
    stubFetch((url) =>
      url.endsWith('/start')
        ? redirect(302, '/target')
        : new Response('landed', { status: 200 }),
    );
    const result = await fetchResponse('https://example.com/start', opts);
    expect(result.finalUrl).toBe('https://example.com/target');
    expect(result.body.toString()).toBe('landed');
  });

  it('wraps a malformed Location header in a FetchError', async () => {
    stubFetch(() => redirect(301, 'http://[invalid'));
    await expect(
      fetchWithPolicy('https://example.com/bad-redirect', opts),
    ).rejects.toThrow(/malformed Location header/);
  });

  it('surfaces cross-host redirects without following them', async () => {
    stubFetch(() => redirect(301, 'https://other.example.org/t'));
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
    stubFetch(() => redirect(302, `/hop-${n++}`));
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
    const result = await fetchResponse('https://example.com/boom', opts);
    expect(result.status).toBe(500);
    expect(result.statusText).toBe('Internal Server Error');
    expect(result.body.length).toBe(0);
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
    const result = await fetchResponse('https://example.com/missing', opts);
    expect(result.status).toBe(404);
    expect(result.body.length).toBe(0);
  });
});

describe('fetchWithPolicy retry', () => {
  const opts = { timeoutMs: 10_000, maxBytes: 1000, maxRedirects: 3 };

  it.each([
    [403, 'blocked', 'https://example.com/flaky'],
    [429, 'rate limited', 'https://example.com/limited'],
  ])(
    'retries once on %s and returns the successful second response',
    async (status, body, url) => {
      const calls = stubByCall((call) =>
        call === 1
          ? new Response(body, { status })
          : new Response('recovered', { status: 200 }),
      );

      const result = await fetchResponse(url, opts);
      expect(calls()).toBe(2);
      expect(result.status).toBe(200);
      expect(result.body.toString()).toBe('recovered');
    },
  );

  it('returns the original 403 when the retry also fails', async () => {
    const calls = stubByCall(() => new Response('blocked', { status: 403 }));

    const result = await fetchWithPolicy('https://example.com/blocked', opts);
    expect(calls()).toBe(2);
    if (result.kind === 'response') expect(result.status).toBe(403);
  });

  it.each(['ECONNRESET', 'EAI_AGAIN'])(
    'retries once on transient network errors (%s)',
    async (code) => {
      const calls = stubByCall((call) => {
        if (call === 1) throw fetchFailed('transient failure', code);
        return new Response('ok', { status: 200 });
      });

      const result = await fetchWithPolicy('https://example.com/reset', opts);
      expect(calls()).toBe(2);
      if (result.kind === 'response') expect(result.status).toBe(200);
    },
  );

  it('does not retry deterministic statuses like 404', async () => {
    const calls = stubByCall(() => new Response('nope', { status: 404 }));

    const result = await fetchWithPolicy('https://example.com/missing', opts);
    expect(calls()).toBe(1);
    if (result.kind === 'response') expect(result.status).toBe(404);
  });

  it('does not retry non-transient network errors', async () => {
    const calls = stubByCall(() => {
      throw fetchFailed('cert invalid', 'CERT_HAS_EXPIRED');
    });

    await expect(
      fetchWithPolicy('https://example.com/tls', opts),
    ).rejects.toThrow('fetch failed');
    expect(calls()).toBe(1);
  });
});

describe('fetchWithPolicy retry abort handling', () => {
  const opts = { timeoutMs: 10_000, maxBytes: 1000, maxRedirects: 3 };

  it('retries once on undici socket errors (UND_ERR_SOCKET)', async () => {
    const calls = stubByCall((call) => {
      if (call === 1) throw fetchFailed('other side closed', 'UND_ERR_SOCKET');
      return new Response('ok', { status: 200 });
    });

    const result = await fetchWithPolicy('https://example.com/reset', opts);
    expect(calls()).toBe(2);
    if (result.kind === 'response') expect(result.status).toBe(200);
  });

  it('propagates caller abort over the original 403 during the retry window', async () => {
    const controller = new AbortController();
    const calls = stubByCall(() => new Response('blocked', { status: 403 }));
    setTimeout(() => controller.abort(new Error('user cancelled')), 100);

    await expect(
      fetchWithPolicy('https://example.com/blocked', {
        ...opts,
        signal: controller.signal,
      }),
    ).rejects.toThrow('user cancelled');
    expect(calls()).toBe(1);
  });

  it('propagates timeout over the original 403 during the retry window', async () => {
    stubByCall(() => new Response('blocked', { status: 403 }));

    // 200ms budget expires inside the 500ms retry delay.
    await expect(
      fetchWithPolicy('https://example.com/blocked', {
        ...opts,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out after 200ms/);
  });
});

describe('fetchWithPolicy multi-address (AggregateError) classification', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 5000, maxBytes: 1000, maxRedirects: 3 };

  // Mirrors Node's NodeAggregateError (lib/internal/errors.js): an exhausted
  // dual-stack connect rejects with `TypeError: fetch failed` whose cause is
  // an AggregateError carrying every per-address attempt, and whose top-level
  // `code` is only the FIRST attempted address's code — so reading that one
  // code makes the classification attempt-order dependent (issue #12720).
  function makeDualStackFetchError(codes: string[]): TypeError {
    const attempts = codes.map((code) =>
      Object.assign(new Error(`connect ${code} 203.0.113.1:443`), { code }),
    );
    const aggregate = new AggregateError(
      attempts,
      'connect failed',
    ) as AggregateError & { code?: string };
    aggregate.code = codes[0];
    return new TypeError('fetch failed', { cause: aggregate });
  }

  async function classifyFetchFailure(thrown: Error): Promise<boolean> {
    globalThis.fetch = vi.fn(async () => {
      throw thrown;
    }) as typeof fetch;
    const error = await fetchWithPolicy('https://example.com/x', opts).then(
      () => {
        throw new Error('expected fetchWithPolicy to reject');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FetchError);
    return isConnectionLevelError(error);
  }

  // ENETUNREACH is the issue's scenario; ECONNREFUSED is the same defect with
  // a code already whitelisted before #12705 (maskable on main today).
  it.each(['ENETUNREACH', 'ECONNREFUSED'])(
    'classifies a whitelisted %s attempt as connection-level in either attempt order',
    async (code) => {
      await expect(
        classifyFetchFailure(makeDualStackFetchError(['ETIMEDOUT', code])),
      ).resolves.toBe(true);
      await expect(
        classifyFetchFailure(makeDualStackFetchError([code, 'ETIMEDOUT'])),
      ).resolves.toBe(true);
    },
  );

  it('unwraps per-attempt TypeError wrappers (undici retry shape)', async () => {
    // The same shape as errors.test.ts's AggregateError case: members carry
    // their code one `.cause` deeper, so the aggregate's own top-level code
    // is undefined and even first-match classification found nothing.
    const wrapAttempt = (code: string) =>
      new TypeError('fetch failed', {
        cause: Object.assign(new Error(`connect ${code}`), { code }),
      });
    const aggregate = new AggregateError([
      wrapAttempt('ETIMEDOUT'),
      wrapAttempt('ENETUNREACH'),
    ]);
    await expect(
      classifyFetchFailure(new TypeError('fetch failed', { cause: aggregate })),
    ).resolves.toBe(true);
  });

  it('stays non-connection-level when no attempt is whitelisted', async () => {
    // ETIMEDOUT remains deliberately excluded at the per-attempt level.
    await expect(
      classifyFetchFailure(makeDualStackFetchError(['ETIMEDOUT', 'ETIMEDOUT'])),
    ).resolves.toBe(false);
    await expect(
      classifyFetchFailure(makeDualStackFetchError(['ETIMEDOUT', 'ENOTFOUND'])),
    ).resolves.toBe(false);
  });

  it('keeps the single-error path unchanged', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    });
    await expect(classifyFetchFailure(refused)).resolves.toBe(true);

    const timedOut = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ETIMEDOUT'), {
        code: 'ETIMEDOUT',
      }),
    });
    await expect(classifyFetchFailure(timedOut)).resolves.toBe(false);
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
  const opts = { timeoutMs: 5000, maxBytes: 1000, maxRedirects: 3 };

  it('follows same-host redirects to completion', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      input.toString().endsWith('/QwenLM/old')
        ? redirect(302, '/QwenLM/new')
        : new Response('landed', { status: 200 }),
    ) as typeof fetch;

    const result = await fetchResponse('https://github.com/QwenLM/old', opts);
    expect(result.finalUrl).toBe('https://github.com/QwenLM/new');
    expect(result.body.toString()).toBe('landed');
  });
});
