/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
  SESSION_ID_HEADER,
  staticCorrelationHeaders,
  wrapFetchWithCorrelation,
} from './llm-correlation-fetch.js';

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

describe('wrapFetchWithCorrelation', () => {
  it('attaches X-Qwen-Code-Session-Id when telemetry is enabled', async () => {
    const baseFetch = vi.fn(async () => new Response());
    const wrapped = wrapFetchWithCorrelation(
      baseFetch as unknown as typeof fetch,
      mockConfig({ enabled: true, sessionId: 'sess-A' }),
    );
    await wrapped('https://api.example.com/v1/chat');
    const init = baseFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Headers).get(SESSION_ID_HEADER)).toBe('sess-A');
  });

  it('does not attach header when telemetry is disabled (passes init through unchanged)', async () => {
    const baseFetch = vi.fn(async () => new Response());
    const userInit = { method: 'POST', headers: { 'X-Custom': 'keep' } };
    const wrapped = wrapFetchWithCorrelation(
      baseFetch as unknown as typeof fetch,
      mockConfig({ enabled: false, sessionId: 'sess-A' }),
    );
    await wrapped('https://api.example.com/v1/chat', userInit);
    expect(baseFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat',
      userInit,
    );
  });

  it('does not attach header when sessionId is empty (skips defensively)', async () => {
    const baseFetch = vi.fn(async () => new Response());
    const wrapped = wrapFetchWithCorrelation(
      baseFetch as unknown as typeof fetch,
      mockConfig({ enabled: true, sessionId: '' }),
    );
    await wrapped('https://api.example.com/v1/chat');
    expect(baseFetch).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat',
      undefined,
    );
  });

  it('overrides existing same-name header on init (server gets real session id, not user-supplied spoof)', async () => {
    const baseFetch = vi.fn(async () => new Response());
    const wrapped = wrapFetchWithCorrelation(
      baseFetch as unknown as typeof fetch,
      mockConfig({ enabled: true, sessionId: 'real-sess' }),
    );
    await wrapped('https://api.example.com/v1/chat', {
      headers: { [SESSION_ID_HEADER]: 'spoofed' },
    });
    const init = baseFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Headers).get(SESSION_ID_HEADER)).toBe('real-sess');
  });

  it('preserves other headers and init fields when injecting', async () => {
    const baseFetch = vi.fn(async () => new Response());
    const signal = new AbortController().signal;
    const wrapped = wrapFetchWithCorrelation(
      baseFetch as unknown as typeof fetch,
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
    const init = baseFetch.mock.calls[0]![1] as RequestInit;
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
    const baseFetch = vi.fn(async () => new Response());
    const wrapped = wrapFetchWithCorrelation(
      baseFetch as unknown as typeof fetch,
      mockConfig({ enabled: true, sessionId: () => current }),
    );

    await wrapped('https://api.example.com/1');
    const first = baseFetch.mock.calls[0]![1] as RequestInit;
    expect((first.headers as Headers).get(SESSION_ID_HEADER)).toBe('sess-A');

    // Simulate /clear updating Config.sessionId without recreating SDK clients.
    current = 'sess-B';

    await wrapped('https://api.example.com/2');
    const second = baseFetch.mock.calls[1]![1] as RequestInit;
    expect((second.headers as Headers).get(SESSION_ID_HEADER)).toBe('sess-B');
  });

  it('propagates baseFetch rejection unchanged', async () => {
    const err = new Error('network unreachable');
    const baseFetch = vi.fn(async () => {
      throw err;
    });
    const wrapped = wrapFetchWithCorrelation(
      baseFetch as unknown as typeof fetch,
      mockConfig({ enabled: true, sessionId: 'sess' }),
    );
    await expect(wrapped('https://api.example.com/x')).rejects.toBe(err);
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
});
