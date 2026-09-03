/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import {
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
});
