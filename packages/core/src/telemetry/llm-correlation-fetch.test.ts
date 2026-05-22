/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { diag } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  SESSION_ID_HEADER,
  staticCorrelationHeaders,
  wrapFetchWithCorrelation,
} from './llm-correlation-fetch.js';

// Local alias for tests; the public helper is generic.
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function mockConfig(opts: {
  enabled?: boolean;
  sessionId?: string | (() => string);
  /**
   * Host allowlist returned by `getTelemetrySessionIdHeaderHosts`.
   *
   * - Key OMITTED: returns `['*']` (broadcast) so the bulk of tests below
   *   — which exercise header-injection mechanics, not host-gating —
   *   keep operating against the `api.example.com` test URLs.
   * - Key PRESENT and `undefined`: returns `undefined`, letting the
   *   wrapper fall back to `DEFAULT_SESSION_ID_HEADER_HOSTS` (the real
   *   default allowlist). Used by host-gate tests.
   * - Key PRESENT and an array: returns that array verbatim.
   */
  hosts?: readonly string[];
}): Config {
  const hostsKeyPresent = 'hosts' in opts;
  return {
    getTelemetryEnabled: () => opts.enabled ?? true,
    getSessionId: () =>
      typeof opts.sessionId === 'function'
        ? opts.sessionId()
        : (opts.sessionId ?? ''),
    getTelemetrySessionIdHeaderHosts: () =>
      hostsKeyPresent ? opts.hosts : ['*'],
  } as unknown as Config;
}

// Typed fetch mock returning a recorded-args view that avoids the
// `mock.calls[0]![1] as RequestInit` cast — calls is properly typed as
// `[input, init?][]` and `init` is optional.
function makeFetchMock(): {
  fetch: FetchLike;
  spy: ReturnType<typeof vi.fn>;
  lastInit: () => RequestInit | undefined;
  lastInput: () => string | URL | Request | undefined;
  callCount: () => number;
} {
  const spy = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(),
  );
  return {
    fetch: spy as unknown as FetchLike,
    spy,
    lastInit: () =>
      spy.mock.calls.length > 0
        ? (spy.mock.calls[spy.mock.calls.length - 1]?.[1] as
            | RequestInit
            | undefined)
        : undefined,
    lastInput: () =>
      spy.mock.calls.length > 0
        ? (spy.mock.calls[spy.mock.calls.length - 1]?.[0] as
            | string
            | URL
            | Request
            | undefined)
        : undefined,
    callCount: () => spy.mock.calls.length,
  };
}

describe('wrapFetchWithCorrelation', () => {
  it('attaches X-Qwen-Code-Session-Id when telemetry is enabled', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({ enabled: true, sessionId: 'sess-A' }),
    );
    await wrapped('https://api.example.com/v1/chat');
    expect((m.lastInit()?.headers as Headers).get(SESSION_ID_HEADER)).toBe(
      'sess-A',
    );
  });

  it('does not attach header when telemetry is disabled (passes init through unchanged)', async () => {
    const m = makeFetchMock();
    const userInit = { method: 'POST', headers: { 'X-Custom': 'keep' } };
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({ enabled: false, sessionId: 'sess-A' }),
    );
    await wrapped('https://api.example.com/v1/chat', userInit);
    expect(m.spy).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat',
      userInit,
    );
  });

  it('does not attach header when sessionId is empty (skips defensively)', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({ enabled: true, sessionId: '' }),
    );
    await wrapped('https://api.example.com/v1/chat');
    expect(m.spy).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat',
      undefined,
    );
  });

  it('overrides existing same-name header on init (server gets real session id, not user-supplied spoof)', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({ enabled: true, sessionId: 'real-sess' }),
    );
    await wrapped('https://api.example.com/v1/chat', {
      headers: { [SESSION_ID_HEADER]: 'spoofed' },
    });
    expect((m.lastInit()?.headers as Headers).get(SESSION_ID_HEADER)).toBe(
      'real-sess',
    );
  });

  it('preserves other headers and init fields when injecting', async () => {
    const m = makeFetchMock();
    const signal = new AbortController().signal;
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({ enabled: true, sessionId: 'sess' }),
    );
    await wrapped('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-xxx',
        'Content-Type': 'application/json',
      },
      body: '{"x":1}',
      signal,
    });
    const init = m.lastInit()!;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"x":1}');
    expect(init.signal).toBe(signal);
    const h = init.headers as Headers;
    expect(h.get('Authorization')).toBe('Bearer sk-xxx');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(h.get(SESSION_ID_HEADER)).toBe('sess');
  });

  it('reads fresh session id after a session reset (staleness regression — design §4.3 critical)', async () => {
    let current = 'sess-A';
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({ enabled: true, sessionId: () => current }),
    );

    await wrapped('https://api.example.com/1');
    expect(
      (
        (m.spy.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as
          | Headers
          | undefined
      )?.get(SESSION_ID_HEADER),
    ).toBe('sess-A');

    // Simulate /clear updating Config.sessionId without recreating SDK clients.
    current = 'sess-B';

    await wrapped('https://api.example.com/2');
    expect(
      (
        (m.spy.mock.calls[1]?.[1] as RequestInit | undefined)?.headers as
          | Headers
          | undefined
      )?.get(SESSION_ID_HEADER),
    ).toBe('sess-B');
  });

  it('propagates baseFetch rejection unchanged', async () => {
    const err = new Error('network unreachable');
    const spy = vi.fn(async () => {
      throw err;
    });
    const wrapped = wrapFetchWithCorrelation(
      spy as unknown as FetchLike,
      mockConfig({ enabled: true, sessionId: 'sess' }),
    );
    await expect(wrapped('https://api.example.com/x')).rejects.toBe(err);
  });

  it('preserves Request input headers when init is undefined (defends Authorization etc.)', async () => {
    // PR #4393 review feedback: previously `new Headers(init?.headers)` with
    // undefined init dropped the Request's own headers (e.g. Authorization)
    // because we then passed `{...init, headers}` which had only our session
    // header. Fix seeds from input.headers when input is a Request.
    const m = makeFetchMock();
    const req = new Request('https://api.example.com/v1/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-xxx',
        'Content-Type': 'application/json',
      },
    });
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({ enabled: true, sessionId: 'sess' }),
    );
    await wrapped(req);
    const init = m.lastInit()!;
    const h = init.headers as Headers;
    expect(h.get('Authorization')).toBe('Bearer sk-xxx');
    expect(h.get('Content-Type')).toBe('application/json');
    expect(h.get(SESSION_ID_HEADER)).toBe('sess');
  });

  it('falls through to baseFetch + diag.warn when header construction throws (telemetry never breaks LLM)', async () => {
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const m = makeFetchMock();
    // Config getter that throws — simulates a runtime bug that must not
    // propagate and break the LLM request. Use a TRUSTED destination
    // (broadcast allowlist) so we reach the throwing getSessionId() — a
    // third-party destination would short-circuit at the host gate before
    // ever calling getSessionId.
    const config = {
      getTelemetryEnabled: () => true,
      getSessionId: () => {
        throw new Error('config bug');
      },
      getTelemetrySessionIdHeaderHosts: () => ['*'],
    } as unknown as Config;
    const wrapped = wrapFetchWithCorrelation(m.fetch, config);
    const userInit = { method: 'POST' };
    const res = await wrapped('https://api.example.com/v1/chat', userInit);
    expect(res).toBeInstanceOf(Response);
    // baseFetch was called with the ORIGINAL init (no correlation header added)
    expect(m.spy).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat',
      userInit,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('correlation header'),
    );
    warnSpy.mockRestore();
  });
});

describe('staticCorrelationHeaders', () => {
  // Tests pass `hosts: ['*']` (broadcast) unless they're specifically
  // exercising the host gate, since broadcast was the original behavior
  // before the LaZzyMan-review-driven scope narrowing.
  const TRUSTED = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  it('returns header when telemetry enabled and sessionId non-empty', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({ enabled: true, sessionId: 'sess-A' }),
        TRUSTED,
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'sess-A' });
  });

  it('returns {} when telemetry disabled', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({ enabled: false, sessionId: 'sess-A' }),
        TRUSTED,
      ),
    ).toEqual({});
  });

  it('returns {} when sessionId is empty', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({ enabled: true, sessionId: '' }),
        TRUSTED,
      ),
    ).toEqual({});
  });

  it('returns {} when destinationUrl is undefined (fail closed)', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({ enabled: true, sessionId: 'sess-A' }),
      ),
    ).toEqual({});
  });

  it('returns {} when destinationUrl host is not on the trusted allowlist', () => {
    // Default allowlist is Alibaba/DashScope only. A vanilla Gemini API call
    // to googleapis.com should NOT receive the header. PR #4390 review
    // (LaZzyMan): "the header should not be broadcast to every LLM provider".
    expect(
      staticCorrelationHeaders(
        mockConfig({
          enabled: true,
          sessionId: 'sess-A',
          hosts: undefined, // use real default allowlist
        }),
        'https://generativelanguage.googleapis.com/v1beta',
      ),
    ).toEqual({});
  });

  it('returns header when destinationUrl host matches the default allowlist (DashScope)', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({
          enabled: true,
          sessionId: 'sess-A',
          hosts: undefined, // use real default allowlist
        }),
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'sess-A' });
  });

  it('returns header when destinationUrl host matches the default allowlist (internal alibaba-inc)', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({
          enabled: true,
          sessionId: 'sess-A',
          hosts: undefined,
        }),
        'https://idealab.alibaba-inc.com/api/openai/v1',
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'sess-A' });
  });

  it('respects ["*"] override to restore broadcast', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({
          enabled: true,
          sessionId: 'sess-A',
          hosts: ['*'],
        }),
        'https://api.openai.com/v1',
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'sess-A' });
  });

  it('respects [] override to fully disable', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({
          enabled: true,
          sessionId: 'sess-A',
          hosts: [],
        }),
        TRUSTED,
      ),
    ).toEqual({});
  });

  it('returns {} when destinationUrl is unparseable', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({
          enabled: true,
          sessionId: 'sess-A',
          hosts: undefined,
        }),
        'not a url',
      ),
    ).toEqual({});
  });

  it('captures session id at call time — caller responsible for re-invoking on reset (Gemini staleness §8.6)', () => {
    // Document by behavior: this helper takes a snapshot. Caller (e.g.
    // geminiContentGenerator/index.ts factory) calls it once and bakes the
    // value into SDK-construction `httpOptions.headers`. A session reset
    // after construction won't update the header — known limitation.
    let current = 'sess-A';
    const config = mockConfig({ enabled: true, sessionId: () => current });
    const snapshot = staticCorrelationHeaders(config, TRUSTED);
    current = 'sess-B';
    expect(snapshot[SESSION_ID_HEADER]).toBe('sess-A');
  });

  it('falls through to {} when config getters throw (telemetry must never break LLM path)', () => {
    // Mirror the safety contract of `wrapFetchWithCorrelation`. This helper
    // is called from the Gemini factory at construction time, so a throw
    // here would propagate up and crash content-generator init for the
    // whole session. PR #4390 review feedback (wenshao).
    const warnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    const exploding = {
      getTelemetryEnabled: () => {
        throw new Error('config exploded');
      },
      getSessionId: () => 'unreached',
      getTelemetrySessionIdHeaderHosts: () => ['*'],
    } as unknown as Config;
    expect(staticCorrelationHeaders(exploding, TRUSTED)).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('staticCorrelationHeaders'),
    );
    warnSpy.mockRestore();
  });
});

describe('wrapFetchWithCorrelation — host allowlist gating', () => {
  // Dedicated block for the LaZzyMan-review-driven host gate. Uses the
  // real default allowlist (no `hosts: ['*']` override) and exercises
  // both the trusted-host pass and the third-party-host skip.

  it('injects header for default-allowlisted host (dashscope.aliyuncs.com)', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: undefined, // real default allowlist
      }),
    );
    await wrapped('https://dashscope.aliyuncs.com/compatible-mode/v1/chat');
    expect((m.lastInit()?.headers as Headers).get(SESSION_ID_HEADER)).toBe(
      'sess-A',
    );
  });

  it('injects header for sub-domain of allowlisted suffix (*.alibaba-inc.com)', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: undefined,
      }),
    );
    await wrapped('https://idealab.alibaba-inc.com/api/openai/v1');
    expect((m.lastInit()?.headers as Headers).get(SESSION_ID_HEADER)).toBe(
      'sess-A',
    );
  });

  it('skips header for third-party host (api.openai.com) under default allowlist', async () => {
    // This is the core LaZzyMan-review fix: the stable session id no longer
    // gets broadcast to third-party LLM providers by default.
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: undefined,
      }),
    );
    await wrapped('https://api.openai.com/v1/chat/completions');
    expect(m.lastInit()?.headers).toBeUndefined();
  });

  it('skips header for third-party host (api.anthropic.com) under default allowlist', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: undefined,
      }),
    );
    await wrapped('https://api.anthropic.com/v1/messages');
    expect(m.lastInit()?.headers).toBeUndefined();
  });

  it('respects ["*"] override to restore broadcast behavior', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: ['*'],
      }),
    );
    await wrapped('https://api.openai.com/v1/chat/completions');
    expect((m.lastInit()?.headers as Headers).get(SESSION_ID_HEADER)).toBe(
      'sess-A',
    );
  });

  it('respects [] override to fully disable injection', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: [],
      }),
    );
    // Even an otherwise-trusted destination is skipped when allowlist is [].
    await wrapped('https://dashscope.aliyuncs.com/compatible-mode/v1');
    expect(m.lastInit()?.headers).toBeUndefined();
  });

  it('respects custom allowlist (operator-supplied host)', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: ['gateway.mycompany.internal'],
      }),
    );
    await wrapped('https://gateway.mycompany.internal/llm/v1');
    expect((m.lastInit()?.headers as Headers).get(SESSION_ID_HEADER)).toBe(
      'sess-A',
    );
    // Default allowlist hosts are NOT included when operator overrides.
    await wrapped('https://dashscope.aliyuncs.com/v1');
    expect(m.lastInit()?.headers).toBeUndefined();
  });

  it('skips header when destination URL is unparseable (fail closed)', async () => {
    const m = makeFetchMock();
    const wrapped = wrapFetchWithCorrelation(
      m.fetch,
      mockConfig({
        enabled: true,
        sessionId: 'sess-A',
        hosts: undefined,
      }),
    );
    await wrapped('not a valid url');
    expect(m.lastInit()?.headers).toBeUndefined();
  });
});
