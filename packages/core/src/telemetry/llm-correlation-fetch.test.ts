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
}): Config {
  return {
    getTelemetryEnabled: () => opts.enabled ?? true,
    getSessionId: () =>
      typeof opts.sessionId === 'function'
        ? opts.sessionId()
        : (opts.sessionId ?? ''),
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
    // propagate and break the LLM request.
    const config = {
      getTelemetryEnabled: () => true,
      getSessionId: () => {
        throw new Error('config bug');
      },
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
  it('returns header when telemetry enabled and sessionId non-empty', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({ enabled: true, sessionId: 'sess-A' }),
      ),
    ).toEqual({ [SESSION_ID_HEADER]: 'sess-A' });
  });

  it('returns {} when telemetry disabled', () => {
    expect(
      staticCorrelationHeaders(
        mockConfig({ enabled: false, sessionId: 'sess-A' }),
      ),
    ).toEqual({});
  });

  it('returns {} when sessionId is empty', () => {
    expect(
      staticCorrelationHeaders(mockConfig({ enabled: true, sessionId: '' })),
    ).toEqual({});
  });

  it('captures session id at call time — caller responsible for re-invoking on reset (Gemini staleness §8.6)', () => {
    // Document by behavior: this helper takes a snapshot. Caller (e.g.
    // geminiContentGenerator/index.ts factory) calls it once and bakes the
    // value into SDK-construction `httpOptions.headers`. A session reset
    // after construction won't update the header — known limitation.
    let current = 'sess-A';
    const config = mockConfig({ enabled: true, sessionId: () => current });
    const snapshot = staticCorrelationHeaders(config);
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
    } as unknown as Config;
    expect(staticCorrelationHeaders(exploding)).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('staticCorrelationHeaders'),
    );
    warnSpy.mockRestore();
  });
});
