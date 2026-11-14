/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { retryContext } from '../utils/retryContext.js';
import {
  buildSessionAwareFetch,
  buildSessionIdHeaders,
  SESSION_ID_HEADER,
  wrapFetchWithSessionId,
} from './outbound-session-id.js';

function config(sessionId = 'session-1'): Config {
  return {
    getSessionId: vi.fn().mockReturnValue(sessionId),
  } as unknown as Config;
}

describe('outbound session ID', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    'routify.alibaba-inc.com',
    'routify-online.alibaba-inc.com',
    'routify-pub.alibaba-inc.com',
  ])('matches the documented Routify host %s', (host) => {
    expect(
      buildSessionIdHeaders(config(), `https://${host}/protocol/openai/v1`),
    ).toEqual({ [SESSION_ID_HEADER]: 'session-1' });
  });

  it('uses the current session ID for Routify requests', async () => {
    const cliConfig = config();
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, cliConfig);

    await wrappedFetch(
      'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
      {
        headers: {
          Authorization: 'Bearer token',
          session_id: 'custom-value',
        },
      },
    );
    vi.mocked(cliConfig.getSessionId).mockReturnValue('session-2');
    await wrappedFetch(
      'https://routify-pub.alibaba-inc.com/protocol/anthropic/v1',
    );

    const firstHeaders = new Headers(baseFetch.mock.calls[0][1]?.headers);
    const secondHeaders = new Headers(baseFetch.mock.calls[1][1]?.headers);
    expect(firstHeaders.get('authorization')).toBe('Bearer token');
    expect(firstHeaders.get(SESSION_ID_HEADER)).toBe('session-1');
    expect(secondHeaders.get(SESSION_ID_HEADER)).toBe('session-2');
  });

  it.each([
    'https://sub.routify-pub.alibaba-inc.com/protocol/openai/v1',
    'https://routify-preview.alibaba-inc.com/protocol/openai/v1',
    'https://api.openai.com/v1',
    'http://routify.alibaba-inc.com/protocol/openai/v1',
    'not a URL',
  ])('does not inject the header into %s', async (url) => {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, config());

    await wrappedFetch(url, {
      headers: { 'X-Existing': 'value' },
    });

    expect(baseFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({ headers: { 'X-Existing': 'value' } }),
    );
  });

  it('does not send an empty session ID', () => {
    expect(
      buildSessionIdHeaders(
        config(''),
        'https://routify.alibaba-inc.com/protocol/openai/v1',
      ),
    ).toEqual({});
  });

  it('preserves headers carried by a Request object', async () => {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, config());

    await wrappedFetch(
      new Request('https://routify-pub.alibaba-inc.com/protocol/openai/v1', {
        headers: { Authorization: 'Bearer token' },
      }),
    );

    const headers = new Headers(baseFetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });

  it('merges Request and init headers before adding the session ID', async () => {
    const baseFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const wrappedFetch = wrapFetchWithSessionId(baseFetch, config());

    await wrappedFetch(
      new Request('https://routify-pub.alibaba-inc.com/protocol/openai/v1', {
        headers: {
          Authorization: 'Bearer token',
          'X-Shared': 'request',
        },
      }),
      { headers: { 'X-Extra': 'value', 'X-Shared': 'init' } },
    );

    const headers = new Headers(baseFetch.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer token');
    expect(headers.get('x-extra')).toBe('value');
    expect(headers.get('x-shared')).toBe('init');
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });

  it('wraps a supplied runtime fetch with session ID injection', async () => {
    const runtimeFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const sessionAwareFetch = buildSessionAwareFetch(runtimeFetch, config());

    await sessionAwareFetch(
      'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
    );

    const headers = new Headers(runtimeFetch.mock.calls[0][1]?.headers);
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });

  it.each([
    'https://api.openai.com/v1/chat/completions',
    'https://routify-pub.alibaba-inc.com/protocol/openai/v1/chat/completions',
  ])('rejects redirects only on single-attempt requests to %s', async (url) => {
    const fetchStub = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    const fetch = buildSessionAwareFetch(fetchStub, config());
    const init: RequestInit = { method: 'POST', redirect: 'follow' };

    await retryContext.run(
      {
        attempt: 1,
        retryTotalDelayMs: 0,
        requestSetupMs: 0,
        singleAttempt: true,
      },
      () => fetch(url, init),
    );
    await fetch(url, init);

    expect(fetchStub).toHaveBeenNthCalledWith(
      1,
      url,
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    expect(fetchStub).toHaveBeenNthCalledWith(
      2,
      url,
      expect.objectContaining({ method: 'POST', redirect: 'follow' }),
    );
  });

  it('falls back to globalThis.fetch when no runtime fetch exists', async () => {
    const fetchStub = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(),
    );
    vi.stubGlobal('fetch', fetchStub);
    const sessionAwareFetch = buildSessionAwareFetch(undefined, config());

    await sessionAwareFetch(
      'https://routify-pub.alibaba-inc.com/protocol/openai/v1',
    );

    const headers = new Headers(fetchStub.mock.calls[0][1]?.headers);
    expect(headers.get(SESSION_ID_HEADER)).toBe('session-1');
  });
});
